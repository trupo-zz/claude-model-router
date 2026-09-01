# claude-model-router

A small, self-hosted system for routing coding/agent tasks to the cheapest model tier that
can actually do the job — local Ollama models first, then a hosted fallback, with Claude
reserved for orchestration and genuine judgment calls. Built to run inside
[Claude Code](https://claude.com/claude-code) as a pair of hooks plus a lightweight belief store
that learns from graded outcomes over time.

## Why

Running every task through the most capable model is wasteful when a free local model can do
it just as well. The reverse — always routing down to save cost — is also wrong when the task
needs real judgment and a wrong answer is expensive. This system encodes a cascade policy
(cheapest tier first, escalate only when needed) and then *learns* which keyword → tier
pairings actually work, instead of trusting the static policy forever.

## How it fits together

```
 task description
       |
       v
 modelrouting/model-routing.json   <- static keyword -> tier policy (source of truth)
       |
       v
 modelweighter/hook.js             <- PreToolUse hook on Claude Code's Agent tool
       |                              keyword-matches the task, checks selflearning for a
       |                              promoted belief that overrides the static tier,
       |                              emits a non-blocking nudge (never blocks the call)
       v
 [Agent call proceeds on whichever model was actually chosen]
       |
       v
 modelattribution/stop-hook.js     <- Stop hook, fires every turn
       |                              walks that turn's Agent calls, resolves which model
       |                              actually ran, calls capture-pending.js
       v
 modelweighter/capture-pending.js  <- appends {taskKeyword, modelUsed, tokensUsed} to a
                                       pending queue -- capture only, no grading yet
       |
       v
 (human grades each pending capture: worked / failed)
       |
       v
 selflearning/lib.js               <- Beta-Bernoulli belief per "route:<keyword>:<model>"
                                       pair; promoted once mean >= 0.75 and n >= 3
       |
       v
 modelweighter/hook.js prefers the promoted belief's tier over the static table,
 for that keyword, from then on
```

### The three mechanisms

Routing guidance distinguishes three, in increasing accuracy and cost: **pre-request rules**
are cheapest, **at-inference cascades** most accurate, **post-response retry** the safety net.
This repo now implements the first and third:

| Mechanism | Where | What it does |
|---|---|---|
| Pre-request rules | `modelrouting/` + `modelweighter/` | Keyword → tier, nudged or hard-denied before the call |
| Post-response retry | `cascade/` | Runs cheap, **checks the answer**, retries, escalates, and fails loudly |
| Measurement | `routereval/` | Says which keywords a free tier can actually handle, with numbers |

### The pieces

- **`modelrouting/`** — the static policy. `model-routing.json` maps task keywords to tiers
  (opus / kimi / haiku / fable, default sonnet). `enforce-model-routing.js` is an earlier,
  simpler version of the hook that only reads this static table (kept for reference /
  as a minimal starting point if you don't want the learning loop).
- **`modelweighter/`** — the live hook. `hook.js` is what's actually wired into
  `settings.json`'s `PreToolUse` matcher on the `Agent` tool. Warn-only: it never blocks a
  call, and fails open on any internal error. `capture-pending.js` is the other half — it's
  called from the Stop hook, not from `hook.js` itself.
- **`modelattribution/`** — a `Stop` hook (`stop-hook.js`) that resolves which model actually
  handled each Agent call this turn (from the subagent's own transcript) and hands the fact
  off to `modelweighter/capture-pending.js` for logging.
- **`selflearning/`** — a generic Beta-Bernoulli belief store (`lib.js`) plus
  `derive-observations.js`, which turns graded pending captures into belief updates. Not
  specific to model routing — it's a reusable "grade an outcome, update a belief" primitive.

- **`routereval/`** — the eval set. Measures whether a free local tier can actually
  handle a given keyword (pass^k bar, deterministic graders). Owns the grading and
  normalization primitives that `cascade/` reuses.
- **`cascade/`** — the post-response retry safety net. Runs local tiers in order, checks each
  answer, retries with a corrective nudge, and exits 2 with empty stdout when the local ladder
  is exhausted so the caller escalates instead of trusting a wrong answer.
- **`localmodel/enforce-hook.js`** — the hard-deny half: blocks haiku-tier work from spawning
  a Claude subagent and points it at `cascade/`. Has a `[claude-required]` escape hatch.

## Grading loop

Captures accumulate ungraded until a human reviews them:

```
node modelweighter/cli.js pending                  # list ungraded captures
node modelweighter/cli.js grade <index> worked      # or: failed
```

Only graded outcomes move a belief. Nothing is promoted automatically from raw usage.

## What's NOT included here

This repo ships code only, not accumulated personal data: usage logs (`*.jsonl`), the belief
database (`*.db`), and any unrelated binaries that lived alongside these tools in their
original location are excluded (see `.gitignore`). The code assumes a Claude Code
installation with hooks wired into `settings.json` — it's published as a reference
implementation / starting point, not a drop-in package.

## Status

Live and in daily use as of August 2026. The static policy is still the fallback for any
keyword that hasn't accumulated enough graded outcomes to promote a belief.
