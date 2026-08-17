// modelweighter/lib.js
//
// A learned/adaptive layer ON TOP of the static keyword->tier table at
// ../modelrouting/model-routing.json -- NOT a replacement for it, and this
// file never modifies that table or its hook. See README.md for the full
// picture, including why there's no real seed data yet.
//
// Belief tracking is entirely delegated to ../selflearning/lib.js (Beta-
// Bernoulli, promotion at mean>=0.75 & n>=3). This module does not
// reimplement any of that math -- it only decides *what name* to observe
// under (`route:<taskKeyword>:<modelUsed>`) and how to read the results
// back out as a routing recommendation.
const fs = require('fs');
const path = require('path');
const selflearning = require('../selflearning/lib');

const HERE = __dirname;
const metricsLogPath = path.join(HERE, 'metrics.jsonl');

function beliefName(taskKeyword, modelUsed) {
  return `route:${taskKeyword}:${modelUsed}`;
}

// Parses a belief name of the form route:<taskKeyword>:<modelUsed> back
// into parts. Returns null for anything that doesn't match -- beliefs.db
// is shared with selflearning's other consumers (e.g. eventlog ingestion,
// which names beliefs after free-text strategy/decision strings), so we
// must not assume every row in the table is one of ours.
function parseBeliefName(name) {
  const m = /^route:(.+):([^:]+)$/.exec(name || '');
  if (!m) return null;
  return { taskKeyword: m[1], modelUsed: m[2] };
}

// Logs an outcome for a (taskKeyword, modelUsed) pair into selflearning as
// belief `route:<taskKeyword>:<modelUsed>`. outcome must be 'worked' or
// 'failed', same contract as selflearning.observe() -- this is meant to be
// called only with an outcome someone (a human, or a rule they trust) has
// actually graded, never a self-reported one. See "never grade your own
// homework" in selflearning/lib.js.
//
// tokensUsed is accepted and recorded but does NOT feed the promotion
// decision -- selflearning's belief is a pure worked/failed Beta-Bernoulli,
// on purpose (reuse, don't reinvent). It's appended to metrics.jsonl
// instead, as a supplementary, non-authoritative log a future scoring pass
// could use to fold token cost/speed into ranking among tiers that are
// already promoted on quality. See README "Limitations".
function recordOutcome({ taskKeyword, modelUsed, tokensUsed = null, outcome }) {
  if (!taskKeyword || !modelUsed) {
    throw new Error('recordOutcome requires both taskKeyword and modelUsed');
  }
  if (outcome !== 'worked' && outcome !== 'failed') {
    throw new Error(`recordOutcome: outcome must be 'worked' or 'failed', got "${outcome}"`);
  }

  const name = beliefName(taskKeyword, modelUsed);
  const belief = selflearning.observe(name, outcome);

  try {
    fs.appendFileSync(
      metricsLogPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        taskKeyword,
        modelUsed,
        tokensUsed,
        outcome,
      }) + '\n'
    );
  } catch {
    // metrics logging is best-effort -- never let it block the belief write
  }

  return belief;
}

// Looks for PROMOTED beliefs matching route:<taskKeyword>:* and, if one or
// more exist, recommends the one with the highest posterior mean. Returns
// null if none is promoted yet -- callers must defer to the static table
// in that case, never invent a recommendation from thin/unpromoted data.
function recommendTier(taskKeyword) {
  if (!taskKeyword) return null;

  const candidates = selflearning
    .listBeliefs('promoted')
    .map((belief) => ({ belief, parsed: parseBeliefName(belief.name) }))
    .filter(({ parsed }) => parsed && parsed.taskKeyword === taskKeyword);

  if (candidates.length === 0) return null;

  candidates.sort(
    (a, b) => selflearning.posteriorMean(b.belief) - selflearning.posteriorMean(a.belief)
  );
  const best = candidates[0];

  return {
    tier: best.parsed.modelUsed,
    confidence: selflearning.posteriorMean(best.belief),
    observations: best.belief.observations,
    beliefName: best.belief.name,
  };
}

module.exports = {
  metricsLogPath,
  beliefName,
  parseBeliefName,
  recordOutcome,
  recommendTier,
};
