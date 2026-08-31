# routereval

An eval set for the model-routing stack. Answers one question with evidence instead of
keyword guesses: **can a free local model actually handle this task shape?**

## Why this exists

Every routing decision in `~/.claude/tools/modelrouting` + `modelweighter` was, until
2026-08-31, made from two things: a hand-written keyword table, and 13 human-graded
captures. That is not enough to tell cost savings from quality loss.

External routing research is unanimous on this point — the eval set is the highest-leverage
piece of infrastructure in a routing project, and cascade results (RouteLLM's >85% cost cut
at 95% quality, FrugalGPT's up to 98%) all depend on being able to measure when the cheap
model is good enough. Without an eval you are not routing, you are guessing.

## What it measures, and why the haiku tier specifically

`localmodel/enforce-hook.js` **hard-denies** anything matching the `haiku` tier and redirects
it to a free local model. Those tasks run unsupervised, with no human checking the result.
That makes them the only routing decisions where being wrong is both silent and automatic —
so they are measured first.

Seven of those keywords (`rename`, `typo`, `docstring`, `commit message`, `boilerplate`,
`reformat`, `lint fix`) were added to that blocking tier on 2026-08-30 **on judgment alone,
with zero supporting evidence**. This eval set exists first and foremost to check whether
that change was safe.

## Scope: local-only, on purpose

There is no `ANTHROPIC_API_KEY` in this environment (Claude Code authenticates by
subscription), so a script cannot call Claude models. That matters less than it sounds.
The cascade's first rung — "can the free tier handle this?" — is the decision that saves
money and the one the enforce hook makes automatically. Claude stays the escalation target;
the point is measuring when we can avoid needing it.

## Usage

```
node run.js                                  # all tasks, tiers custom+fast, 3 trials
node run.js --keyword rename                 # one keyword
node run.js --tiers custom,fast,code         # pick tiers (names from localmodel/config.json)
node run.js --trials 5                       # more trials = tighter pass^k
node run.js --record                         # ALSO write outcomes into modelweighter
```

Report-only by default. `--record` is opt-in because promoting a belief should stay a
deliberate act, even though a deterministic grader is a legitimate one.

## Metrics

- `pass@1` — first-attempt success.
- `pass@k` — at least one success in k. What matters **if a retry path exists**.
- `pass^k` — all k succeeded. **The bar used for routing verdicts**, because the enforce hook
  sends work to a local model with nobody checking the output; "usually right" is not safe.

A keyword is reported `OK to hard-deny to local` only when every task under it is `pass^k`
stable.

## Graders

Deterministic only (`contains`, `notContains`, `regex`, `json`, `maxWords`, `maxLines`,
`all`). No LLM-as-judge: using a model to grade whether a model is good enough to route to
is circular, and ECC's eval-harness guidance is deterministic-over-probabilistic. A model
grader may be added later as a separate, clearly-labeled type — it must never silently
stand in for these.

`grade()` never throws, for any spec or output. A grader that throws would abort a sweep
partway and bias every number collected before the crash. 19 unit cases cover that contract.

Model output is stripped of markdown fences before grading. That is normalization, not
leniency — a caller piping the output would strip them too. Nothing further is trimmed.

## Known limits

- **Small n.** Ten tasks, roughly one per keyword. Enough to catch a keyword that is
  outright wrong for local; not enough to certify one as universally safe.
- **Deterministic graders only**, so task design skews toward checkable outputs. Genuinely
  open-ended work (a code review, a council seat) cannot be graded this way and is
  deliberately absent — those keywords are not in the blocking tier anyway.
- **Overfitting risk.** These prompts are fixed and visible. Do not tune a local model
  against them and then treat the result as a general capability claim; that is the first
  eval anti-pattern.
- Results are a snapshot of the tier→model mapping in `localmodel/config.json` at run time.
  Re-run after any tier is repointed at a different model.
