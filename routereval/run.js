#!/usr/bin/env node
// routereval/run.js
//
// Runs the eval set in tasks.json against one or more free/local tiers and
// reports pass@1 / pass@3 / pass^3 per (keyword, tier).
//
// WHY THIS EXISTS: every routing decision in this stack was, until now, made
// from keyword guesses and a handful of human-graded captures (n=13 total).
// External routing research is unanimous that the eval set is the highest-
// leverage piece of infrastructure in a routing project -- without one you
// cannot tell cost savings from quality loss. This is that eval set.
//
// SCOPE, and why it is local-only: there is no ANTHROPIC_API_KEY in this
// environment (Claude Code authenticates by subscription), so a script cannot
// call Claude models. That is not much of a limitation for the question that
// actually matters. The cascade's first rung -- "can a free local model handle
// this task shape acceptably?" -- is the decision that saves money, and it is
// the one the enforce hook makes automatically and unsupervised. Claude
// remains the escalation target; the point is to measure when we can avoid it.
//
// Report-only by default. --record is opt-in and writes graded outcomes into
// modelweighter. That is deliberate: a deterministic grader is a legitimate
// grader (this is not a model grading its own homework), but promoting a
// belief still stays a decision a human makes on purpose.
const fs = require('fs');
const path = require('path');
const { grade } = require('./graders');

const HERE = __dirname;
const RESULTS_DIR = path.join(HERE, 'results');
const DEFAULT_TIERS = ['custom', 'fast'];
const DEFAULT_TRIALS = 3;
const PER_TASK_TIMEOUT_MS = 120000;

let complete;
try {
  ({ complete } = require('../localmodel/lib'));
} catch (e) {
  console.error(`routereval: cannot load localmodel/lib.js (${e.message})`);
  process.exit(1);
}

// Normalization lives in normalize.js so the runtime cascade applies the exact
// same rules -- see that file for why each one is normalization and not leniency.
const { stripFences, stripWrappingQuotes } = require("./normalize");

function parseArgs(argv) {
  const args = { tiers: DEFAULT_TIERS, trials: DEFAULT_TRIALS, record: false, keyword: null, strict: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--tiers') args.tiers = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--trials') args.trials = Math.max(1, Number(argv[++i]) || DEFAULT_TRIALS);
    else if (a === '--keyword') args.keyword = argv[++i];
    else if (a === '--record') args.record = true;
    // --strict disables stripWrappingQuotes, so the pre-2026-08-31 scoring
    // stays reproducible and the normalization's exact effect is measurable
    // rather than asserted.
    else if (a === '--strict') args.strict = true;
  }
  return args;
}

// pass@k = "at least one success in k attempts"; pass^k = "all k succeeded".
// For an unsupervised routing decision pass^k is the honest bar: the enforce
// hook sends work to a local model with no human checking the result, so
// "usually right" is not the same as safe. pass@k is reported alongside
// because it is what matters when a retry path exists.
function summarize(trialResults) {
  const n = trialResults.length;
  const passes = trialResults.filter(Boolean).length;
  return {
    trials: n,
    passes,
    passAt1: n > 0 ? (trialResults[0] ? 1 : 0) : 0,
    passAtK: passes > 0 ? 1 : 0,
    passPowK: passes === n && n > 0 ? 1 : 0,
  };
}

async function runTask(task, tier, trials, strict = false) {
  const results = [];
  for (let t = 0; t < trials; t++) {
    let out = '';
    let err = null;
    const started = Date.now();
    try {
      const res = await complete({ prompt: task.prompt, tier, timeoutMs: PER_TASK_TIMEOUT_MS });
      out = stripFences(res && res.response);
      if (!strict) out = stripWrappingQuotes(out);
    } catch (e) {
      // A model/transport failure is a FAILED trial, not a crashed run. Losing
      // the whole sweep to one timeout would bias every remaining number.
      err = e && e.message ? e.message : String(e);
    }
    const ms = Date.now() - started;
    const g = err ? { pass: false, reason: `call failed: ${err}` } : grade(task.grader, out);
    results.push({ pass: g.pass, reason: g.reason, ms, output: out.slice(0, 400) });
  }
  return results;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const spec = JSON.parse(fs.readFileSync(path.join(HERE, 'tasks.json'), 'utf8'));
  const tasks = spec.tasks.filter((t) => !args.keyword || t.keyword === args.keyword);

  if (tasks.length === 0) {
    console.log(`No tasks match --keyword "${args.keyword}".`);
    return;
  }

  console.log(`routereval: ${tasks.length} tasks x ${args.tiers.length} tiers x ${args.trials} trials\n`);

  const runRecord = { ts: new Date().toISOString(), tiers: args.tiers, trials: args.trials, rows: [] };

  for (const tier of args.tiers) {
    console.log(`=== tier: ${tier} ===`);
    for (const task of tasks) {
      const results = await runTask(task, tier, args.trials, args.strict);
      const s = summarize(results.map((r) => r.pass));
      const avgMs = Math.round(results.reduce((a, r) => a + r.ms, 0) / results.length);
      const verdict = s.passPowK ? 'STABLE' : s.passAtK ? 'FLAKY ' : 'FAIL  ';
      console.log(
        `  ${verdict} ${task.id.padEnd(20)} ${s.passes}/${s.trials}  ${String(avgMs).padStart(6)}ms  ${
          s.passPowK ? '' : '<- ' + (results.find((r) => !r.pass) || {}).reason
        }`
      );
      runRecord.rows.push({ tier, taskId: task.id, keyword: task.keyword, ...s, avgMs, results });
    }
    console.log('');
  }

  // Roll up to the unit routing actually decides on: the keyword.
  console.log('=== per-keyword rollup (pass^k = safe to auto-route unsupervised) ===');
  const byKey = new Map();
  for (const r of runRecord.rows) {
    const k = `${r.keyword}||${r.tier}`;
    if (!byKey.has(k)) byKey.set(k, { keyword: r.keyword, tier: r.tier, stable: 0, flaky: 0, fail: 0, n: 0 });
    const e = byKey.get(k);
    e.n++;
    if (r.passPowK) e.stable++;
    else if (r.passAtK) e.flaky++;
    else e.fail++;
  }
  for (const e of [...byKey.values()].sort((a, b) => a.keyword.localeCompare(b.keyword))) {
    const safe = e.stable === e.n;
    console.log(
      `  ${e.keyword.padEnd(16)} ${e.tier.padEnd(8)} stable=${e.stable}/${e.n} flaky=${e.flaky} fail=${e.fail}  ${
        safe ? 'OK to hard-deny to local' : 'NOT safe to auto-route -- keyword should not be in the haiku tier'
      }`
    );
  }

  try {
    fs.mkdirSync(RESULTS_DIR, { recursive: true });
    const out = path.join(RESULTS_DIR, `run-${runRecord.ts.replace(/[:.]/g, '-')}.json`);
    fs.writeFileSync(out, JSON.stringify(runRecord, null, 2));
    console.log(`\nresults: ${out}`);
  } catch (e) {
    console.log(`\n(could not persist results: ${e.message})`);
  }

  if (args.record) {
    const { recordOutcome } = require('../modelweighter/lib');
    let recorded = 0;
    for (const e of byKey.values()) {
      const outcome = e.stable === e.n ? 'worked' : 'failed';
      try {
        recordOutcome({ taskKeyword: e.keyword, modelUsed: `local:${e.tier}`, tokensUsed: 0, outcome });
        recorded++;
      } catch (err) {
        console.log(`  (record failed for ${e.keyword}: ${err.message})`);
      }
    }
    console.log(`recorded ${recorded} outcomes into modelweighter`);
  } else {
    console.log('\n(report only -- pass --record to write these outcomes into modelweighter)');
  }
}

main().catch((e) => {
  console.error(`routereval failed: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
