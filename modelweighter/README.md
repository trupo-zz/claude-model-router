# modelweighter

The "Internal model weighter" from `~/TODO.md`: a learned/adaptive layer
**on top of** the existing static keyword->tier table at
`../modelrouting/model-routing.json` and its live hook
`../modelrouting/enforce-model-routing.js` -- **not a replacement for
either of those files**, and neither is modified here.

## The loop is now closed (2026-07-31)

Previously: nothing ever called `recordOutcome()` in production, and there
was no consensus on what should trigger it. That gap is closed, in two
halves that respect "never grade your own homework":

1. **Automatic capture (no grading, just facts)** --
   `capture-pending.js` is called from `~/.claude/tools/modelattribution`'s
   Stop hook (wired live) every turn. It walks the turn's Agent-tool calls,
   matches each one against the same static keyword table `hook.js` itself
   uses, resolves the *actually-used* model from that subagent's own
   transcript (not just the tier requested -- routing hooks can redirect
   what really ran), and appends `{taskKeyword, modelUsed, tokensUsed}` to
   `pending.jsonl`. Silent, best-effort, never blocks anything.
2. **Human-gated grading** -- `node cli.js pending` lists ungraded
   captures; `node cli.js grade <index> <worked|failed>` calls
   `recordOutcome()` with your verdict and removes it from the queue. This
   is the only place a `worked`/`failed` verdict enters the system --
   exactly the same human-gate pattern as `eventlog`'s
   `gradeDecision`/`gradeRepair`.

`hook.js` is now **wired live** in `settings.json`, replacing the static
`../modelrouting/enforce-model-routing.js` on the same Agent-tool
PreToolUse matcher. Safe to have swapped in: behavior is identical to the
static hook until a belief is actually promoted (mean>=0.75, n>=3), and
promotion only happens from verdicts you gave via `cli.js grade` -- there
is no path from capture to promotion that skips your review.

Tested 2026-07-31: captured a real record from this session (an
"architecture"-keyword Agent call that the static table said should be
`opus` but actually ran as `claude-sonnet-5`) via the live capture path,
verified `cli.js pending`/`grade` end-to-end with an isolated synthetic
record (graded, belief written correctly at n=1, then deleted from
`beliefs.db` + `metrics.jsonl` to avoid seeding fake data), left the real
captured record in the queue for genuine future grading.

## Dedup bug fixed (2026-08-12) -- was actively at risk of corrupting live routing

Found by the deep-reasoner seat of the council decision "build order +
autonomy boundary for self-improving Claude stack...": `pending.jsonl` had
23 lines but only 6 distinct `toolUseId`s. Root cause: `capturePendingFromTurn`
is called from `../modelattribution`'s Stop hook, and that hook can fire
**multiple times for the same turn** -- e.g. the model-attribution gate
blocks stop (missing the required "Model: ...%" line) and forces a retry,
which re-fires the Stop hook, which re-walks the identical Agent tool_use
blocks in that turn's transcript slice. The old code did a bare
`appendFileSync` per match, so one real observation could land 5x. Since
belief promotion fires at `mean>=0.75 AND n>=3`, three duplicate copies of
ONE observation could cross the bar on their own -- silently overriding
live routing via `hook.js`, which is wired live in `settings.json` on the
Agent-tool PreToolUse matcher.

**Fix**: `capturePendingFromTurn` now dedups on `toolUseId`, keep-**latest**
(not keep-first -- rejected because `resolveSubagentUsage()` reads the
subagent's own transcript, which is still being written mid-turn, so
`modelUsed`/`tokensUsed` resolve progressively across repeated firings;
confirmed in the production data this fix cleaned up, e.g. `tokensUsed`
observed going `0 -> 0 -> 0 -> 0 -> 11656` for one `toolUseId`. Keeping the
first capture would have permanently frozen in incomplete/zero counts).
Each call now reads the current file into a `toolUseId -> record` map,
updates/inserts, and rewrites the whole file -- rather than appending.

Cleaned the existing file from 23 lines / 6 distinct ids down to 6 lines (one
per id, latest values kept). Verified: re-running the capture path against
identical entries 3x in a row (simulating 3 Stop-hook re-fires on one turn)
produces exactly 1 line per `toolUseId`, always holding the most-resolved
usage data.

Known, accepted gap (unchanged by this fix): dedup only checks
`pending.jsonl`'s CURRENT contents. If a `toolUseId` were captured, graded
via `cli.js grade` (which deletes it from the file), and the Stop hook
somehow re-fired for that exact same turn again afterward, it could be
recaptured as a new ungraded record. Narrow enough (grading normally happens
in a later session, well after a turn ends) not to warrant a permanent
separate seen-log.

## Derived observations (2026-08-12) -- feeds session-start-grading, not this file

`capture-pending.js` now also calls
`../selflearning/derive-observations.js` for each captured Agent call,
recording non-subjective signals (turn errored, same task re-spawned soon,
subagent's edited files touched again afterward) into a **separate** store,
`../selflearning/derived-observations.jsonl` -- never into `pending.jsonl`,
`beliefs.db`, or `metrics.jsonl`. See that file's header and
`../selflearning/session-start-grading.js` for how those signals only ever
PRE-FILL a suggested verdict a human confirms or flips -- they never
promote or grade anything on their own.

## Grading is now also reachable via the batched SessionStart prompt

`cli.js pending`/`grade` still work exactly as documented above. As of
2026-08-12, `../selflearning/session-start-grading.js` additionally surfaces
every ungraded `pending.jsonl` record (alongside eventlog's ungraded
decisions/repairs) in one batched, one-keystroke-per-item prompt riding
`../sessionrecovery`'s SessionStart hook -- closing the "nobody runs the
grading CLI" gap this tool's own limitation used to have. Both paths write
through the same `recordOutcome()` -- there is still only one way a
`worked`/`failed` verdict enters the system, a human's.

## How it works

- `lib.js`
  - `recordOutcome({ taskKeyword, modelUsed, tokensUsed, outcome })` --
    logs into `../selflearning/lib.js` as a belief named
    `route:<taskKeyword>:<modelUsed>`, via `selflearning.observe()`. No
    belief-tracking math is reimplemented here; this module only decides
    the naming scheme and reads results back out.
  - `recommendTier(taskKeyword)` -- looks at `listBeliefs('promoted')` for
    any belief matching `route:<taskKeyword>:*`. If one or more are
    promoted, returns the highest-confidence one as
    `{ tier, confidence, observations, beliefName }`. If none are promoted
    yet, returns `null` -- callers must defer to the static table, never
    invent a recommendation from thin/unpromoted data.
- `hook.js` -- a **separate, new** PreToolUse hook, not wired into
  `settings.json`. Requires `../modelrouting/model-routing.json` directly
  and reuses its exact keyword-match loop (first rule with a hit wins) so
  it can never drift from the static policy's own logic. For whichever
  keyword matches, it calls `recommendTier(keyword)`: if a promoted belief
  exists, its tier wins over the static table's tier for that keyword;
  otherwise the static tier is used, unchanged. Same fail-open,
  warn-only, never-block contract as the static hook.

  **This is a drop-in replacement candidate for
  `../modelrouting/enforce-model-routing.js`, not an addition to run
  alongside it.** Running two competing PreToolUse hooks on the same Agent
  matcher would double up on warnings for the same event. Swapping which
  one is live in `settings.json` is left as the user's decision.
- `cli.js`
  - `node cli.js record <taskKeyword> <modelUsed> <tokensUsed> <worked|failed>`
    -- seed/test a single outcome.
  - `node cli.js recommend <taskKeyword>` -- shows what would be
    recommended right now for that keyword.

## Limitations

- **`tokensUsed` doesn't feed the promotion decision.** The spec asks this
  to optimize for "token usage, quality, and speed together," but the
  underlying belief (`selflearning.observe()`) is a pure worked/failed
  Beta-Bernoulli, on purpose -- reuse, don't reinvent. `tokensUsed` is
  recorded to `metrics.jsonl` (one JSON line per `recordOutcome()` call)
  as a supplementary, non-authoritative log. A future scoring pass could
  fold token cost/speed into *ranking among tiers that are already
  promoted on quality* (e.g. prefer the cheaper of two promoted tiers for
  the same keyword) -- not built here, since there's no real data yet to
  design that ranking against.
- **Keyword granularity matches the static table's vocabulary.**
  `hook.js` only ever queries `recommendTier()` with a keyword the static
  table itself matched (e.g. `"architecture"`, `"scan"`), not arbitrary
  free text. `recordOutcome()` itself doesn't enforce this -- it will
  happily record any `taskKeyword` string -- but keeping to the static
  vocabulary is what makes learned recommendations interchangeable with
  the static table's tiers.
- **`beliefs.db` is shared** with `selflearning`'s other consumers (e.g.
  `eventlog` ingestion, which names beliefs after free-text
  strategy/decision strings). `parseBeliefName()` defensively ignores any
  belief name that doesn't match `route:<taskKeyword>:<modelUsed>`, so
  unrelated beliefs never leak into a recommendation.

## Tested

Seeded a fake keyword `test-classify` past the promotion bar (mean>=0.75,
n>=3, mirroring selflearning's own proven test pattern), confirmed
`recommend` returns the learned tier, confirmed it returns null/defers for
an untouched keyword, then deleted the seeded test rows from
`../selflearning/beliefs.db` and the corresponding lines from
`metrics.jsonl` so the tool ships with a clean slate.
