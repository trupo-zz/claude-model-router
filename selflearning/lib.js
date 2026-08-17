const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const eventlog = require('../eventlog/lib');

const HERE = __dirname;
const dbPath = path.join(HERE, 'beliefs.db');

// Implements the 5 fundamental rules from the source design doc:
// 1. Structured distrust of the first answer -- a belief starts at a
//    uniform prior (alpha=1, beta=1, mean 0.5) and only earns confidence
//    through repeated observation.
// 2. Everything fails open -- see ingestFromEventlog/prune, both skip
//    unusable rows rather than throwing.
// 3. Never grade your own homework -- observe() only accepts outcomes
//    that came from eventlog's already-human-graded repairs/decisions
//    (graded_by='human'). This module has no path that grades anything
//    itself.
// 4. Loosening is human-only; tightening can auto -- promotion (belief
//    crosses the confidence bar) happens automatically here. There is no
//    automatic un-prune or automatic re-promotion after a manual
//    retraction; only observe() and prune() change status, and both only
//    ever move a belief toward stricter (retracted/pruned) or based on
//    real evidence (promoted), never loosen a human's explicit call.
// 5. Learning is visible and reversible, not silent -- every state change
//    prints [learned]/[unlearned]/[retracted], and prune() is non-destructive
//    (marks status, does not delete rows).

const SCHEMA = `
CREATE TABLE IF NOT EXISTS beliefs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  alpha REAL NOT NULL DEFAULT 1,
  beta REAL NOT NULL DEFAULT 1,
  observations INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','promoted','retracted','pruned')),
  created_ts TEXT NOT NULL DEFAULT (datetime('now')),
  last_updated TEXT NOT NULL DEFAULT (datetime('now'))
);
`;

const PROMOTION_MEAN = 0.75;
const PROMOTION_MIN_OBS = 3;
const PRUNE_DAYS = 90;

let _db = null;
function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(dbPath);
  _db.exec(SCHEMA);
  return _db;
}

function posteriorMean(belief) {
  return belief.alpha / (belief.alpha + belief.beta);
}

function getOrCreateBelief(name) {
  const db = getDb();
  let belief = db.prepare('SELECT * FROM beliefs WHERE name = ?').get(name);
  if (!belief) {
    db.prepare('INSERT INTO beliefs (name) VALUES (?)').run(name);
    belief = db.prepare('SELECT * FROM beliefs WHERE name = ?').get(name);
  }
  return belief;
}

// outcome must be 'worked' or 'failed' -- this is meant to be called only
// with already human-graded eventlog outcomes, never a self-reported one.
function observe(name, outcome) {
  if (outcome !== 'worked' && outcome !== 'failed') {
    throw new Error(`observe: outcome must be 'worked' or 'failed', got "${outcome}"`);
  }
  const db = getDb();
  const belief = getOrCreateBelief(name);
  const alpha = belief.alpha + (outcome === 'worked' ? 1 : 0);
  const beta = belief.beta + (outcome === 'failed' ? 1 : 0);
  const observations = belief.observations + 1;

  let status = belief.status;
  const events = [];

  // Rule 5 / auto-retract: contradicting evidence on a promoted belief
  // immediately demotes it back to active -- promotion isn't sticky
  // against new failures.
  if (status === 'promoted' && outcome === 'failed') {
    status = 'active';
    events.push({ type: 'retracted', name });
  }

  const mean = alpha / (alpha + beta);
  if (status === 'active' && mean >= PROMOTION_MEAN && observations >= PROMOTION_MIN_OBS) {
    status = 'promoted';
    events.push({ type: 'learned', name, mean, observations });
  }

  db.prepare(
    'UPDATE beliefs SET alpha = ?, beta = ?, observations = ?, status = ?, last_updated = datetime(\'now\') WHERE id = ?'
  ).run(alpha, beta, observations, status, belief.id);

  for (const e of events) {
    if (e.type === 'learned') {
      console.log(`[learned] "${name}" promoted (mean=${mean.toFixed(2)}, n=${observations})`);
    } else if (e.type === 'retracted') {
      console.log(`[unlearned] "${name}" retracted after contradicting evidence`);
    }
  }

  return db.prepare('SELECT * FROM beliefs WHERE id = ?').get(belief.id);
}

// Non-destructive: marks status, never deletes rows. Rule 5: reversible,
// not silent.
function prune(maxAgeDays = PRUNE_DAYS) {
  const db = getDb();
  const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
  const stale = db
    .prepare(`SELECT * FROM beliefs WHERE status != 'pruned' AND last_updated < ?`)
    .all(cutoff.replace('T', ' ').slice(0, 19));
  for (const b of stale) {
    db.prepare(`UPDATE beliefs SET status = 'pruned' WHERE id = ?`).run(b.id);
    console.log(`[unlearned] "${b.name}" pruned (unreinforced for >${maxAgeDays}d)`);
  }
  return stale.map((b) => b.name);
}

function listBeliefs(status = null) {
  const db = getDb();
  if (status) {
    return db.prepare('SELECT * FROM beliefs WHERE status = ? ORDER BY id DESC').all(status);
  }
  return db.prepare('SELECT * FROM beliefs ORDER BY id DESC').all();
}

// Naive first pass: uses the repair's strategy text / decision's decision
// text, trimmed, as the belief name. This only accumulates multiple
// observations against the SAME belief when that free text matches
// exactly across entries -- it does not cluster or categorize similar-but-
// differently-worded strategies. That's real future work (needs either an
// LLM-assisted categorization step or a human-assigned rule name at
// grading time), not pretended to be solved here.
function ingestFromEventlog(limit = 200) {
  const repairs = eventlog
    .listRecent('repair_strategies', limit)
    .filter((r) => r.graded_by === 'human' && (r.outcome === 'worked' || r.outcome === 'failed'));
  const decisions = eventlog
    .listRecent('decisions', limit)
    .filter((d) => d.graded_by === 'human' && (d.outcome === 'worked' || d.outcome === 'failed'));

  let count = 0;
  for (const r of repairs) {
    observe(r.strategy.trim(), r.outcome);
    count++;
  }
  for (const d of decisions) {
    observe(d.decision.trim(), d.outcome);
    count++;
  }
  return count;
}

module.exports = {
  dbPath,
  getDb,
  posteriorMean,
  getOrCreateBelief,
  observe,
  prune,
  listBeliefs,
  ingestFromEventlog,
  PROMOTION_MEAN,
  PROMOTION_MIN_OBS,
  PRUNE_DAYS,
};
