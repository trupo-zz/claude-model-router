# selflearning

Phase 2, step 7 of the agent-tooling backlog: the actual learning loop —
Beta-Bernoulli belief tracking per named rule/strategy, promotion past a
confidence bar, auto-retraction on contradicting evidence, and
non-destructive decay-pruning. This is the concrete implementation of the
5 fundamental rules from the source design doc (see comments at the top of
`lib.js` for how each one maps to code).

This is the shared *doctrine* — Evolve (mutate an artifact, keep the
version that scores higher, repeat) is meant to reuse these same rules but
is a genuinely different concrete mechanism (iterating artifacts, not
tracking named-rule confidence) and has **not** been built yet. Don't
confuse "shares the doctrine" with "built."

## How it works

A belief starts at a uniform prior (alpha=1, beta=1 → mean 0.5). Each
`worked`/`failed` observation updates alpha/beta. A belief **promotes**
once its posterior mean ≥ 0.75 **and** it has ≥ 3 observations — both
conditions, not either. A promoted belief that gets a `failed` observation
**immediately retracts** back to active — promotion isn't sticky against
new contradicting evidence. `prune()` marks (never deletes) beliefs
unreinforced for >90 days as `pruned`.

Every state change prints `[learned]` / `[unlearned]` — visible, not
silent, per rule 5.

## Usage

```
node cli.js observe "<name>" <worked|failed>
node cli.js list [active|promoted|retracted|pruned]
node cli.js prune [maxAgeDays]
node cli.js ingest
```

`ingest` pulls human-graded outcomes from eventlog's `repair_strategies`
and `decisions` tables and observes each one.

## Batched grading prompt (2026-08-12) -- closes the "nobody runs the grading CLI" gap

Before this: grading only happened via CLIs (`eventlog`'s
`grade-decision`/`grade-repair --human`, `../modelweighter/cli.js
pending`/`grade`) nobody remembered to run. Measured at the time this was
built: 10 ungraded autopilot decisions sitting in eventlog, and only 5
grades EVER logged, all positive, all from a single day (2026-08-02) -- a
real non-adoption problem, not a hypothetical one.

`session-start-grading.js` collapses both grading gates into ONE batched,
one-keystroke-per-item prompt instead. Three exports:

- `getUngradedBatch()` -> `{ items, promptText } | null` -- reads every
  ungraded eventlog decision/repair and every ungraded
  `../modelweighter/pending.jsonl` record, pre-filling `suggestedVerdict`
  for modelweighter items from `derive-observations.js`'s store where a
  signal exists (eventlog items never get a pre-fill -- a free-text
  decision/strategy string carries no non-subjective derivable signal).
  Returns `null` when nothing's ungraded, so a caller can no-op cleanly.
- `parseGradingReply(replyText, items)` -> `{ answers, unparsed }` --
  parses a human's one-line reply like `"1w 2f 3s 4w"` (item number +
  w=worked/f=failed/s=skip) or `"skip all"`. Items not mentioned stay
  ungraded for next time.
- `applyGradingAnswers(answers)` -> `{ applied, skipped, errors }` --
  routes each non-skip answer to the real backing store: eventlog's
  `gradeDecision`/`gradeRepair` (`gradedBy: 'human'`, since a real human
  keystroke drove the reply -- same doctrine the CLI enforced, just no
  longer requiring the human to remember to invoke it) or
  `../modelweighter/lib.js`'s `recordOutcome()` + removal from
  `pending.jsonl`.

Meant to be called from `../sessionrecovery`'s SessionStart hook -- this
module owns no hook of its own and never touches `settings.json`. Also
runnable standalone: `node session-start-grading.js batch` prints the
current prompt, `node session-start-grading.js apply "<reply>"` parses and
applies one, for when a live `require()` can't span the conversational turn
where the human actually replies.

Verified 2026-08-12: seeded one synthetic eventlog decision and one
synthetic modelweighter pending record (with a matching synthetic derived
observation), graded both by explicit itemId (never through the real batch
of genuinely-ungraded production items -- grading those would mean writing
a fake human verdict into real data), confirmed the decision row landed
`outcome=worked graded_by=human`, confirmed the pending record's belief was
recorded and the record removed from `pending.jsonl`, confirmed
`getUngradedBatch()` surfaced the pre-filled suggestion from the derived
observation, then deleted every synthetic row/line so no test data was
left behind.

## Derived, exogenous observations -- pre-fill only, never auto-promote

`derive-observations.js` computes non-subjective signals about Agent
subagent calls straight from transcript data -- no question asked of a
human:

- **turn-errored** -- the subagent's own transcript hit a tool error.
- **respawned-soon** -- the same `taskKeyword` + `subagent_type` got
  spawned again later in the same turn (weak signal -- could be legitimate
  follow-up work, not a retry).
- **edits-reverted** / **edits-kept** -- a file the subagent edited did / did
  not get touched again afterward in the same turn (weak signal either way
  -- a later edit to the same file isn't proof of a revert).

These combine into one `{ signals, suggestedVerdict, confidence, detail }`
per Agent call and land in a **new, separate** store,
`derived-observations.jsonl` -- never in `beliefs.db`, never in eventlog's
`claude.db`, never merged into `../modelweighter`'s `pending.jsonl` or
belief-evidence path. Every row's `status` is always `'unconfirmed'`; this
file has no code path that ever writes anything else. The only thing that
ever happens to a derived observation is `session-start-grading.js` reading
it to pre-fill a suggestion the human then confirms or flips with one
keystroke -- it never promotes a belief or writes a graded outcome by
itself. This is deliberate, not a missing feature: eventlog's
`graded_by CHECK(IN ('human'))` invariant was ruled load-bearing by a prior
council specifically to keep synthetic/derived evidence out of the
human-only grading path, and this store exists precisely so derived signals
stay visibly separate from it instead of eroding it.

Wired into `../modelweighter/capture-pending.js`'s existing per-Agent-call
loop (same Stop-hook firing, same transcript data already in hand) rather
than a new hook -- best-effort, wrapped so a derive failure can never affect
the pending-capture write next to it. Same keep-latest-per-`itemId` dedup
discipline as `capture-pending.js`'s own fix, for the same reason: the Stop
hook can re-fire multiple times per turn.

Real, documented limitation (same honesty convention as this project's
other tools): every detector only sees the current turn's entries slice
(everything since the last real human message, same boundary
`modelattribution` itself uses) -- a respawn or a reverting edit in a LATER
turn or session is not detected. Reading beyond that would mean re-walking
arbitrary transcript history on every Stop-hook firing, exactly the kind of
unbounded-cost mistake the dedup fix above just closed.

## A real, documented limitation

`ingest` uses the repair's `strategy` text or decision's `decision` text,
trimmed, as the belief name. This only accumulates multiple observations
against the *same* belief when that free text matches **exactly** across
entries — it does not cluster semantically similar strategies worded
differently. That's real future work (needs either LLM-assisted
categorization or a human-assigned rule name at grading time), not solved
here. Verified during testing: promotion/retraction/decay all work
correctly on the underlying math; what's naive is only the name-grouping
step in `ingestFromEventlog()`.
