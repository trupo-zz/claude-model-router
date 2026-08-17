# modelattribution

Built 2026-07-31 after the user escalated a soft preference ("append a model % line to every
response") into an explicit enforcement request ("no i want you to enforce"). A memory note alone
is something the assistant can forget or estimate sloppily; this makes it structurally guaranteed
and grounded in real data instead of a guess.

## What it does

`stop-hook.js` is a `Stop` hook (wired live in `~/.claude/settings.json`). Every time the assistant
tries to end a turn, it:

1. Finds "this turn" in the session transcript — everything since the most recent genuine typed
   user message (`origin.kind === "human"`, not a tool-result reply, which is also `type: "user"`
   in the transcript but structurally different).
2. Finds the last real text block the assistant is about to show the user. Skips turns with no
   text (pure tool-call turns) or trivial text (<40 chars) — no point forcing a line onto a
   one-word ack.
3. If that text already contains a `Model:...%`-shaped line, allows the stop.
4. If not, **blocks** and hands back a computed ground-truth breakdown: `message.model` for the
   main conversation's own turns, plus — for every `Agent` tool call this turn — the *actually
   resolved* model from that subagent's own transcript (`subagents/agent-<id>.jsonl` +
   `.meta.json`), not just the tier that was requested (routing hooks can redirect what really
   ran, so the request isn't ground truth, the subagent's own transcript is).

The assistant's next turn appends the line (using the real numbers handed back, not a fresh guess)
and stops cleanly.

## Local model calls (added 2026-08-11)

`localmodel/cli.js run ...` calls (see `~/.claude/tools/localmodel`) go through Bash, not Agent, so
they have no subagent transcript to read `message.model`/usage from. `lib.js` detects them a
different way: any `Bash` `tool_use` whose command string contains `localmodel`, `cli.js`, and
`run` is tracked, then its matching `tool_result` is parsed for cli.js's own
`[model: <id>]\n<response>` stdout convention. Token count is estimated from response length
(chars/4) since Ollama's real `eval_count` isn't printed by `cli.js` — good enough for a relative
share, not for precise cost accounting. These entries are tagged `isLocal: true` internally and
rendered with a `(local)` suffix (e.g. `Sonnet 5 92% · qwen2.5-coder-custom-v3:latest (local) 8%`)
so the line doesn't quietly conflate real Claude spend with free local compute.

**Known gap**: only catches commands that repeat `cd .../localmodel && node cli.js run ...` (the
pattern actually used so far) — a bare `node cli.js run ...` issued from an already-persisted
`localmodel` cwd, with no `cd` in that same command string, won't match. Undercounts safely in that
case rather than guessing from shell state the hook can't see.

Verified 2026-08-11: ran a real `cli.js run custom` call mid-turn, re-ran `computeBreakdown` against
the live transcript, confirmed the local call was picked up and tagged (`Sonnet 5 100% ·
qwen2.5-coder-custom-v3:latest (local) 0%` — 0% because the test response was tiny relative to the
turn's Claude token count, not a detection failure). Later ran all 5 configured tiers plus 5
unwrapped models (`qwen3:8b`, `deepseek-r1:8b`, `glm-4.7-flash`, both older `custom` fine-tune
versions) directly by model name alongside all 4 Claude tiers via real Agent calls -- all 14
correctly detected and tallied in one breakdown.

A `qwen3-coder:30b` code-review pass (itself run through this same local pipeline, dogfooding it)
caught a real defect in `add()`: `isLocal` was only set on a tally entry's *first* insert and never
updated on later calls for the same model, so if a model were ever added first as non-local then
later as local (or vice versa), the flag would silently lock to the first value. In this codebase
it was unreachable in practice -- Claude model IDs and local Ollama IDs never collide -- but fixed
anyway (2026-08-11): `isLocal` now starts `false` and is set sticky-`true` on any local hit,
regardless of call order.

## Why this can't trap a session

Same fail-open convention as every hook in this project, plus one Stop-hook-specific guard:

- Checks `input.stop_hook_active` first and returns immediately if true — this is the harness's
  own signal that a Stop hook already blocked once in this stop sequence. Never blocks twice in a
  row, so the worst case is exactly one extra short follow-up message, never a loop.
- Wrapped in try/catch; any error (malformed transcript, missing file, JSON parse failure) falls
  through to allowing the stop.
- Doesn't touch turns with no/trivial text output at all.

## Tested

2026-07-31: ran `lib.computeBreakdown` against this session's real transcript mid-build — correctly
found 105 entries in the then-current turn, tallied 37,170 output tokens under `claude-sonnet-5`
(no subagents spawned that turn), formatted as `Sonnet 5 100%`. Confirmed the subagent path
separately against an already-completed fact-check subagent call earlier in the same session:
its `meta.json` requested tier `haiku`, its own transcript's `message.model` resolved to
`claude-haiku-4-5-20251001` — confirming the "actually resolved, not just requested" design point
is real, not theoretical (the meta.json alone would have been enough here, but won't always be if
a routing hook ever redirects a call to a different model than requested).

Not yet observed live in production (i.e. this hook has not yet actually fired and blocked a real
stop) as of the commit that built it — first real trigger will be the first time a response ships
without the line, which should be rare since the assistant appends it proactively regardless of
the hook's existence.
