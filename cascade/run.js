#!/usr/bin/env node
// cascade/run.js
//
// The post-response retry rung of the routing cascade: run a task on the
// cheapest local tier, CHECK the result, retry with a corrective nudge, then
// escalate to a stronger tier -- and when the local ladder is exhausted, say
// so loudly instead of returning a wrong answer.
//
// WHY THIS EXISTS
// localmodel/enforce-hook.js hard-denies haiku-tier work and points the caller
// at a single-shot `localmodel/cli.js run custom "<prompt>"`. That call has no
// verification and no escalation: if the local model gets it wrong, nothing
// catches it, and the wrong answer is what the caller uses. routereval
// measured that risk concretely on 2026-08-31 (the `fast` tier is 1/3 on
// docstring and checklist where `custom` is 3/3), so it is not hypothetical.
//
// External routing guidance frames three mechanisms: pre-request rules are the
// cheapest, at-inference cascades the most accurate, post-response retry the
// safety net. This stack had only the first. This file is the third.
//
// HONEST LIMIT ON THE TOP RUNG
// There is no ANTHROPIC_API_KEY in this environment (Claude Code authenticates
// by subscription), so this script CANNOT escalate to Claude itself. The final
// rung is therefore an explicit, machine-detectable "local cascade exhausted"
// verdict on exit code 2 -- handing the task back to Claude deliberately. That
// is still the whole point: it converts a silently wrong local answer into a
// loud escalation. Never pretend the last rung succeeded.
//
// Grading and normalization are REUSED from ../routereval (graders.js,
// normalize.js) rather than reimplemented. If the runtime checked outputs
// differently from the eval harness, eval results would stop predicting real
// behavior and the eval would be worthless.
const path = require('path');

const { grade } = require('../routereval/graders');
const { normalize } = require('../routereval/normalize');

let complete;
try {
  ({ complete } = require('../localmodel/lib'));
} catch (e) {
  console.error(`cascade: cannot load localmodel/lib.js (${e.message})`);
  process.exit(1);
}

let verify = null;
try {
  ({ verify } = require('../ollama-verify/call'));
} catch {
  // optional -- shorthand format checks degrade to unsupported, see toSpec()
}

const DEFAULT_TIERS = ['custom', 'code'];
const DEFAULT_RETRIES = 2;
const DEFAULT_TIMEOUT_MS = 120000;

const EXIT_OK = 0;
const EXIT_ESCALATE = 2; // local ladder exhausted -- caller (Claude) must take it
const EXIT_USAGE = 1;

function usage() {
  console.error(`Usage:
  node run.js --task "<prompt>" [--check <spec>] [--tiers custom,code]
              [--retries N] [--timeout MS] [--json] [--strict]

--check accepts either:
  a shorthand format check  : json | oneword | bullets:N | sentences:N
  a deterministic grader spec as JSON, e.g.
    '{"type":"contains","value":"return"}'
    '{"type":"all","of":[{"type":"json"},{"type":"contains","value":"name"}]}'
  (grader types: contains, notContains, regex, json, maxWords, maxLines, all)

Omitting --check runs the cheapest tier once with NO verification. That is the
old single-shot behavior and is deliberately not the default of anything --
pass a check, or you are not using the safety net at all.

Exit codes: 0 = a tier produced a passing result, 2 = local cascade exhausted
(escalate to Claude), 1 = usage/config error.`);
}

// Bridges the two check vocabularies. ollama-verify's shorthand covers the
// format constraints local fine-tunes are known to miss (see
// project_finetune_own_model: exact-count instruction-following is a hard
// limit); routereval's grader spec covers content checks. Accepting both means
// callers don't have to learn a third syntax.
function toSpec(check) {
  if (!check) return null;
  const trimmed = String(check).trim();
  if (trimmed.startsWith('{')) {
    try {
      return { kind: 'grader', spec: JSON.parse(trimmed) };
    } catch (e) {
      console.error(`cascade: --check is not valid JSON (${e.message})`);
      process.exit(EXIT_USAGE);
    }
  }
  return { kind: 'shorthand', check: trimmed };
}

function applyCheck(checkObj, out) {
  if (!checkObj) return { pass: true, reason: 'no check requested' };
  if (checkObj.kind === 'grader') return grade(checkObj.spec, out);
  if (!verify) {
    return { pass: false, reason: `shorthand check "${checkObj.check}" unavailable (ollama-verify not loadable)` };
  }
  const r = verify(out, checkObj.check);
  return { pass: Boolean(r && r.ok), reason: (r && r.detail) || 'no detail' };
}

// Content-check reasons name the exact string that was missing or forbidden.
// Feeding that verbatim into a retry prompt LEAKS THE ANSWER -- caught live on
// 2026-09-01 by a deliberately impossible check: the model simply copied the
// required token out of the failure reason and "passed" on attempt 1, without
// doing the task at all. That is reward hacking, and unfixed it would make
// every cascade retry look far more capable than it is.
//
// So reasons from content checks are replaced with a shape-only description.
// Format checks (JSON validity, word/line/bullet/sentence counts) are NOT
// redacted: telling a model "expected 3 bullets, got 5" is legitimate
// corrective feedback and gives away no answer content.
const LEAKY_GRADER_TYPES = new Set(['contains', 'notContains', 'regex']);

const SAFE_SUBSTITUTES = {
  contains: 'the answer is missing required content',
  notContains: 'the answer includes content that must not appear',
  regex: 'the answer does not match the required format',
};

function safeReasonForNudge(reason, checkObj) {
  if (!checkObj || checkObj.kind !== 'grader') return reason; // shorthand checks are format-only
  const spec = checkObj.spec || {};
  // An 'all' spec reports as "<failingSubtype>: <detail>", so read the subtype
  // off the reason itself rather than the top-level spec.
  const type = spec.type === 'all' ? String(reason).split(':')[0].trim() : spec.type;
  if (LEAKY_GRADER_TYPES.has(type)) {
    return SAFE_SUBSTITUTES[type] || 'the answer did not satisfy a required content check';
  }
  return reason;
}

// The corrective nudge. Deliberately restates the ORIGINAL task rather than
// only sending the complaint: a small model given just "that was wrong, try
// again" frequently drifts off the task entirely.
function nudgedPrompt(task, reason, previous) {
  return (
    `${task}\n\n` +
    `--- CORRECTION ---\n` +
    `Your previous answer was rejected by an automated check.\n` +
    `Reason: ${reason}\n` +
    `Previous answer was:\n${String(previous).slice(0, 600)}\n\n` +
    `Produce a corrected answer that satisfies the requirement. Output only the answer.`
  );
}

function parseArgs(argv) {
  const args = {
    task: null,
    check: null,
    tiers: DEFAULT_TIERS,
    retries: DEFAULT_RETRIES,
    timeout: DEFAULT_TIMEOUT_MS,
    json: false,
    strict: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--task') args.task = argv[++i];
    else if (a === '--check') args.check = argv[++i];
    else if (a === '--tiers') args.tiers = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--retries') args.retries = Math.max(0, Number(argv[++i]) || 0);
    else if (a === '--timeout') args.timeout = Math.max(1000, Number(argv[++i]) || DEFAULT_TIMEOUT_MS);
    else if (a === '--json') args.json = true;
    else if (a === '--strict') args.strict = true;
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.task) {
    usage();
    process.exit(EXIT_USAGE);
  }
  if (args.tiers.length === 0) {
    console.error('cascade: --tiers resolved to an empty list');
    process.exit(EXIT_USAGE);
  }

  const checkObj = toSpec(args.check);
  const trail = [];

  for (const tier of args.tiers) {
    // attempt 0 is the plain task; attempts 1..retries add the corrective nudge
    let lastOut = '';
    let lastReason = '';
    for (let attempt = 0; attempt <= args.retries; attempt++) {
      const prompt =
        attempt === 0
          ? args.task
          : nudgedPrompt(args.task, safeReasonForNudge(lastReason, checkObj), lastOut);
      const started = Date.now();
      let out = '';
      let callError = null;
      try {
        const res = await complete({ prompt, tier, timeoutMs: args.timeout });
        out = normalize(res && res.response, { strict: args.strict });
      } catch (e) {
        // A transport/timeout failure is a failed ATTEMPT, not a crashed run --
        // the whole purpose here is to survive a bad rung and keep climbing.
        callError = e && e.message ? e.message : String(e);
      }
      const ms = Date.now() - started;

      const result = callError ? { pass: false, reason: `call failed: ${callError}` } : applyCheck(checkObj, out);
      trail.push({ tier, attempt, ms, pass: result.pass, reason: result.reason, preview: out.slice(0, 200) });

      if (result.pass) {
        if (args.json) {
          console.log(JSON.stringify({ status: 'ok', tier, attempt, output: out, trail }, null, 2));
        } else {
          console.error(`cascade: PASSED on tier "${tier}" attempt ${attempt} (${ms}ms) -- ${result.reason}`);
          process.stdout.write(out + '\n'); // stdout = the answer only, so it pipes cleanly
        }
        process.exit(EXIT_OK);
      }

      lastOut = out;
      lastReason = result.reason;
      console.error(`cascade: tier "${tier}" attempt ${attempt} failed (${ms}ms) -- ${result.reason}`);
    }
  }

  // Every local rung exhausted. Report honestly and hand back to Claude.
  const summary = {
    status: 'escalate',
    reason: 'local cascade exhausted -- no tier produced output passing the check',
    tiersTried: args.tiers,
    retriesPerTier: args.retries,
    trail,
  };
  if (args.json) {
    console.log(JSON.stringify(summary, null, 2));
  } else {
    console.error(
      `\ncascade: ESCALATE -- tried [${args.tiers.join(', ')}] with ${args.retries} retries each, ` +
        `none passed. This task needs Claude. Nothing was returned on stdout on purpose: ` +
        `a failing answer must not be mistaken for a working one.`
    );
  }
  process.exit(EXIT_ESCALATE);
}

main().catch((e) => {
  console.error(`cascade failed: ${e && e.message ? e.message : e}`);
  process.exit(EXIT_USAGE);
});
