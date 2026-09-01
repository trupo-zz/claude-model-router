# cascade

The **post-response retry** rung of the model-routing cascade: run a task on the cheapest
local tier, *check the answer*, retry with a corrective nudge, escalate to a stronger tier —
and when the local ladder is exhausted, say so loudly instead of returning a wrong answer.

## Why this exists

`localmodel/enforce-hook.js` hard-denies `haiku`-tier work and pointed the caller at a
single-shot `localmodel/cli.js run custom "<prompt>"`. That call has **no verification and no
escalation**: if the local model got it wrong, nothing caught it, and the wrong answer was
what the caller used.

That risk is measured, not hypothetical — `routereval` found on 2026-08-31 that the `fast`
tier is 1/3 on `docstring` and `checklist` where `custom` is 3/3.

Routing guidance frames three mechanisms: pre-request rules are cheapest, at-inference
cascades most accurate, **post-response retry is the safety net**. This stack had only the
first. This is the third.

## Usage

```
node run.js --task "<prompt>" [--check <spec>] [--tiers custom,code]
            [--retries N] [--timeout MS] [--json] [--strict]
```

`--check` accepts either vocabulary, so there's no third syntax to learn:

- **shorthand format checks** (from `ollama-verify`): `json`, `oneword`, `bullets:N`, `sentences:N`
- **grader specs** (from `routereval/graders.js`): `contains`, `notContains`, `regex`, `json`,
  `maxWords`, `maxLines`, `all` — e.g.
  `'{"type":"all","of":[{"type":"json"},{"type":"contains","value":"name"}]}'`

Omitting `--check` reproduces the old single-shot behavior with no safety net. It is
deliberately nothing's default.

## Exit codes — the whole point

| Code | Meaning |
|---|---|
| `0` | A tier produced a passing answer. **stdout is the answer only**, so it pipes cleanly; diagnostics go to stderr. |
| `2` | **Local cascade exhausted — escalate to Claude.** stdout is deliberately empty. |
| `1` | Usage/config error. |

Exit 2 emitting nothing on stdout is a safety property, not a formatting choice: a failing
answer must never be mistakable for a working one.

## Honest limit on the top rung

There is no `ANTHROPIC_API_KEY` in this environment (Claude Code authenticates by
subscription), so **this script cannot escalate to Claude itself**. The final rung is an
explicit, machine-detectable "escalate" verdict that hands the task back. That is still the
entire value: it converts a silently wrong local answer into a loud escalation.

## The answer-leak fix (read before changing the nudge)

Grader reasons name the exact string that was missing or forbidden. Feeding that verbatim
into a retry prompt **leaks the answer**. Caught live on 2026-09-01 with a deliberately
impossible check: the model copied the required token straight out of the failure reason and
"passed" on attempt 1 without doing the task at all.

So reasons from **content** checks (`contains`, `notContains`, `regex`) are replaced with a
shape-only description before they reach the model. **Format** checks (JSON validity,
word/line/bullet/sentence counts) are *not* redacted — "expected 3 bullets, got 5" is
legitimate corrective feedback that gives away no content. 7 unit cases cover the split.

If you extend the grader types, classify each new one as leaky or safe. Getting this wrong
doesn't cause an error — it silently inflates how capable the cascade looks.

## Reuse

Grading (`graders.js`) and normalization (`normalize.js`) are imported from `../routereval`,
never reimplemented. If the runtime checked outputs differently from the eval harness, eval
results would stop predicting real behavior and the eval would be worthless. Dependency
direction is deliberate: cascade → routereval, never the reverse.

## Known limits

- **A check is only as good as you write it.** A weak `contains` check passes weak answers.
  The cascade verifies against your spec; it does not judge quality in general.
- **No semantic checking.** Deterministic graders only, for the same anti-circularity reason
  `routereval` documents. Open-ended work has no automatic check and shouldn't be routed here.
- **Retries cost latency.** Each failed attempt is a full generation. `--retries 2` across two
  tiers is up to 6 calls before escalation.
- Per `ollama-verify`'s own honest note: corrective retries do **not** guarantee success. A
  model can fail an exact-count check all three times. That is reported, never papered over.
