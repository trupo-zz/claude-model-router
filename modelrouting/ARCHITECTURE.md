# Model routing architecture -- the map that didn't exist

Written 2026-08-12 after an explicit user flag: "organized way of model
routing and utilizing local models" was unclear. Verdict up front: **the
three components below have genuinely clean separation of concerns -- this
was an undocumented-map problem, not a rearchitecture problem.** One real
piece of stale/misleading state was found and fixed (see "Fixed" at the
bottom); everything else here is documentation of behavior that was already
correct but scattered across three READMEs, a memory file, and settings.json
with no single place tying them together.

## The three components, one line each

| Component | Owns | Authoritative for |
|---|---|---|
| `modelrouting/model-routing.json` | The static keyword -> tier data | The **only** copy of the keyword->tier table. Every other component reads this file directly; none duplicates it. |
| `modelweighter/hook.js` (+ `lib.js`, `capture-pending.js`, `cli.js`) | Learning loop + the **live** PreToolUse hook for Claude-tier routing | Whether a *promoted, human-graded* belief should override the static table's tier recommendation for a given keyword. Falls back to the static table exactly when no belief is promoted. |
| `localmodel/` (`cli.js`, `lib.js`, `enforce-hook.js`, `config.json`) | Actually dispatching work to local Ollama models, and the **live** PreToolUse hook that keeps narrow work off Claude entirely | Which local tier/model a dispatched task actually runs against; whether an Agent call for narrow/checklist-shaped work is allowed to spawn Claude at all. |

None of the three duplicates another's data. `model-routing.json` is read
directly (via `require`/`readFileSync` of the literal file, not a copy) by
both `modelweighter/hook.js` and `localmodel/enforce-hook.js` -- confirmed by
reading both files: each does
`path.join(__dirname, '..', 'modelrouting', 'model-routing.json')`.

## Call flow: "Claude is about to spawn an Agent" -> "which model/tier actually runs"

This only covers the **Agent tool** path (spawning a Claude subagent).
Local/Kimi/Groq dispatch via direct shell-out (`localmodel/cli.js`,
`kimi/call.js`, `groq/call.js`) never goes through the Agent tool at all --
see the "cascade enforcement" section below for why that matters.

```
Claude decides to call the Agent tool
        |
        v
PreToolUse fires on matcher "Agent" -- TWO hooks run, both from settings.json,
in this order (both always run; a deny from either blocks the call):

  1. modelweighter/hook.js
     - No-ops immediately if tool_input.model was NOT explicitly set.
       (Most Agent calls omit `model` and inherit a default -- see
       "known limitation" below.)
     - If a model WAS requested: keyword-matches subagent_type+description
       against model-routing.json (first rule wins). If matched keyword
       has a PROMOTED belief (mean>=0.75, n>=3, via modelweighter/lib.js
       recommendTier()), that tier is the recommendation; otherwise the
       static table's tier is used unchanged.
     - If recommendation != requested model: emits a non-blocking
       systemMessage/additionalContext. NEVER denies.

  2. localmodel/enforce-hook.js
     - Always runs, regardless of whether `model` was set.
     - Keyword-matches subagent_type+description against model-routing.json's
       "haiku" tier list specifically (narrow/checklist-shaped work).
     - Match + no "[claude-required]" escape hatch in description -> HARD
       DENY. The Agent call never spawns; zero Claude tokens spent. Deny
       reason names the exact localmodel CLI command to use instead.
     - Separately, a "kimi" tier match gets a soft non-blocking nudge
       (same shape as modelweighter's message) -- Kimi is China-hosted, so
       this hook won't force it, only suggest it.
        |
        v (if neither hook denied)
Agent call proceeds, spawns a real Claude subagent at whatever model was
requested (or the harness default if none was), independent of anything
either hook recommended -- both are warn-or-deny, neither one substitutes
a model for you.
```

A third hook, `enforcement/hook.js`, also runs on the Agent matcher (it's
registered on the broader `Bash|Edit|MultiEdit|Write|Agent` matcher). It is
**not part of model routing** -- it checks tool-call JSON against
`learned-rules.json` (arbitrary free-text repair-strategy beliefs from
`selflearning`'s eventlog ingestion), a different axis entirely. Mentioned
here only so it isn't mistaken for a fourth routing component when reading
`settings.json`.

## Where the CLAUDE.md cascade (free/local -> Kimi -> Claude tiers) is actually enforced vs. just documented

CLAUDE.md's cascade policy has **two very different enforcement stories**
depending on which leg of it you're asking about:

- **"Route narrow work off Claude to local first" -- enforced in code.**
  `localmodel/enforce-hook.js` hard-denies Agent-tool spawns for
  haiku-tier-shaped work, live in `settings.json`. This is a real gate, not
  a norm: a matching call cannot spawn a Claude subagent without either
  going local or adding the `[claude-required]` escape hatch.
- **"Prefer Kimi for heavy delegated work free/local can't handle" --
  documented as a norm only, soft-nudged in code.** `localmodel/enforce-hook.js`
  emits a non-blocking suggestion on a "kimi" keyword match; nothing denies
  or redirects. Whether to actually use Kimi over Claude is left to
  judgment, on purpose (China-hosted, so a human/Claude sensitivity check is
  required before routing there -- see `model-routing.json`'s own `note`
  field).
- **Which local tier a dispatched task actually runs on (`custom` first for
  coding, `fast` for narrow non-coding, etc.) -- enforced by `localmodel/cli.js`
  + `config.json` at the point of dispatch, not by a hook.** There's no
  PreToolUse gate that picks the tier for you; the deny message from
  `enforce-hook.js` names a suggested command but whoever runs it chooses
  the tier.
- **The `sonnet`/`opus`/`haiku`/`fable` split among Claude tiers themselves
  -- enforced as a nudge, not a gate.** `modelweighter/hook.js` (or the
  unwired `enforce-model-routing.js` before it) only ever warns; it never
  blocks a Claude-tier choice. Deliberate: CLAUDE.md's own cascade language
  frames Claude-tier choice as "judgment," not a mechanical rule the way
  "should this go to Claude at all" is.
- **Kimi/Groq being reachable only via direct shell-out, never via the
  Agent tool -- true by omission, not by a gate.** Confirmed: `settings.json`
  contains no reference to `kimi/call.js` or `groq/call.js` anywhere. There
  is no hook preventing an Agent call from doing Kimi-shaped work on Claude
  instead; the cascade only steers *away* from Claude for haiku-tier work,
  it doesn't steer *toward* Kimi for anything. That gap is intentional per
  CLAUDE.md ("non-Agent shell-outs aren't invoked through Agent at all") but
  worth naming plainly: nothing in code stops Claude from just doing
  Kimi-shaped work itself if it doesn't route through Agent's haiku keyword
  match.

**Bottom line**: only one rung of the cascade (local-vs-Claude for
narrow/checklist work) is a real enforced gate. Every other rung
(Claude-tier choice, Kimi preference, which local tier to pick) is a
warn/suggest/norm layer that something can silently skip by not matching a
keyword, not setting `model` explicitly, or just not going through the
Agent tool at all.

## The two Agent-matcher hooks: overlap check (explicitly requested)

Read both `modelweighter/hook.js` and `localmodel/enforce-hook.js` in full.
**No conflict, and the overlap that exists is by design, not accidental:**

- They gate on different questions. `localmodel/enforce-hook.js` asks
  "should this go to Claude at all" (deny-capable). `modelweighter/hook.js`
  asks "given it's going to Claude, is the requested tier right"
  (warn-only, never deny). A haiku-tier match gets caught by #1 before #2's
  answer matters.
- Both independently `require`/read the exact same `model-routing.json`
  rather than each other, so they can't drift apart on what the static
  table says -- confirmed by direct code read, not just README claims.
- If both were to fire on the same call (an explicit `model` override on a
  haiku-tier-matched description with `[claude-required]` set, so the deny
  is bypassed but the tier mismatch still applies), the outputs are a
  systemMessage/allow from `modelweighter/hook.js` and nothing from
  `localmodel/enforce-hook.js` (its own haiku branch already returned once
  the escape hatch was seen) -- no doubled or contradictory messaging in
  that case either. This was checked as a real scenario, not assumed.

**One real asymmetry worth flagging, not fixed here (read-only ownership,
posted to blackboard instead):** `modelweighter/hook.js` returns
immediately if `tool_input.model` was never set (`if (!requestedModel) return;`).
Most Agent calls in practice omit `model` and inherit a default rather than
setting it explicitly. That means the *learned-belief* layer -- the actual
point of `modelweighter`'s closed loop -- only ever gets a chance to speak
up when the caller already typed an explicit model override that turns out
to mismatch. A promoted belief that Claude should prefer a *different*
default tier for some keyword currently has no path to surface unless
someone happens to pass `model` explicitly. This mirrors the original
static hook's behavior (same early-return existed in
`enforce-model-routing.js` before it was superseded), so it isn't a
regression modelweighter introduced -- but it is a real limit on how much
the learning loop can influence routing until closed. Flagged to
`modelweighter`'s owner via blackboard rather than edited here, per this
task's ownership boundary.

## Fixed during this pass (tools/modelrouting/** only)

- `enforce-model-routing.js` was sitting in this directory with no
  indication it had been superseded and unwired from `settings.json` since
  2026-07-31 -- confirmed live by reading `settings.json` directly (zero
  references to `modelrouting` or `enforce-model-routing` anywhere in it).
  This is exactly the kind of thing that reads as "disorganized": a file
  that looks like the live hook, sitting in the directory a reasonable
  person would check first, silently doing nothing. Added a clear
  deprecation header pointing at the real live hook
  (`../modelweighter/hook.js`) and this doc. Verified the file still parses
  and runs correctly stand-alone after the edit (`node -c`, plus a live
  stdin test reproducing its original warn behavior) -- comment-only
  change, no behavior touched.
- Added this directory's first `README.md` -- it previously had none,
  despite being the one component whose data file (`model-routing.json`)
  every other routing component depends on.
