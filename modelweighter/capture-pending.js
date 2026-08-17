// modelweighter/capture-pending.js
//
// Closes the "no consensus yet on the trigger" gap noted in README.md. Does NOT call
// recordOutcome() itself -- that still requires a human-graded worked/failed verdict
// (never grade your own homework, same doctrine as eventlog/selflearning). What this
// does is the automatic, ungraded half: capture (taskKeyword, modelUsed, tokensUsed)
// facts from real Agent-tool usage into pending.jsonl, so grading is a quick review
// pass (`cli.js pending` / `cli.js grade`) instead of manual re-derivation from
// scratch every time.
//
// Reuses the exact same keyword-match loop as ../modelrouting/enforce-model-routing.js
// and ./hook.js so taskKeyword values are never invented independently of the static
// policy's own vocabulary.
const fs = require('fs');
const path = require('path');
const deriveObservations = require('../selflearning/derive-observations');

const HERE = __dirname;
const pendingPath = path.join(HERE, 'pending.jsonl');
const routingPolicyPath = path.join(HERE, '..', 'modelrouting', 'model-routing.json');

function readEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function matchKeyword(haystack, policy) {
  for (const rule of policy.rules || []) {
    const hit = (rule.keywords || []).find((kw) => haystack.includes(kw));
    if (hit) return hit;
  }
  return null;
}

function resolveSubagentUsage(subagentsDir, toolUseId) {
  if (!fs.existsSync(subagentsDir)) return null;
  const metaFiles = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.meta.json'));
  for (const mf of metaFiles) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, mf), 'utf8'));
    } catch {
      continue;
    }
    if (meta.toolUseId !== toolUseId) continue;
    const jsonlPath = path.join(subagentsDir, mf.replace(/\.meta\.json$/, '.jsonl'));
    let resolvedModel = meta.model || null;
    let outputTokens = 0;
    for (const se of readEntries(jsonlPath)) {
      if (se.type === 'assistant' && se.message && se.message.model && se.message.model !== '<synthetic>') {
        resolvedModel = se.message.model;
        outputTokens += (se.message.usage && se.message.usage.output_tokens) || 0;
      }
    }
    return { resolvedModel, outputTokens };
  }
  return null;
}

// entries: the turn's transcript entries (same slice modelattribution computes).
// subagentsDir: path to this session's subagents/ folder.
// Best-effort, silent on any error -- callers should wrap this in try/catch too and
// never let a capture failure affect anything else.
//
// Dedup, keep-LATEST per toolUseId (fixed 2026-08-12, see council decision
// "build order + autonomy boundary..." -- deep-reasoner seat): the Stop hook
// that calls this (../modelattribution/stop-hook.js) can fire several times
// for the SAME turn -- e.g. the model-attribution gate blocks stop and forces
// a retry -- and every firing re-walks the identical Agent tool_use blocks in
// that turn's entries. Before this fix, each firing did a bare appendFileSync,
// so a single real observation could land in pending.jsonl 5x (confirmed: 23
// lines / 6 distinct toolUseIds in production data before cleanup). Since
// belief promotion fires at n>=3, three duplicate copies of ONE observation
// could cross the bar on their own and silently override live routing via
// hook.js -- never a genuine second data point.
//
// keep-FIRST was considered and rejected: resolveSubagentUsage() reads the
// subagent's own transcript, which is still being written mid-turn, so
// modelUsed/tokensUsed resolve progressively across repeated firings (e.g.
// tokensUsed observed going 0 -> 0 -> 0 -> 0 -> 11656 for the same toolUseId
// in the production data this fix cleaned up). Keeping the first capture
// would have permanently frozen in incomplete/zero token counts. Keep-latest
// always reflects the most-resolved usage data available at Stop time.
//
// A toolUseId is a real API-issued id, unique to exactly one Agent call,
// ever -- so "same toolUseId" always means "same underlying event, more
// current usage data," never a legitimate second observation to accumulate.
//
// Known, accepted gap: this checks pending.jsonl's CURRENT contents only. If
// a toolUseId were captured, graded via `cli.js grade` (which deletes it from
// pending.jsonl), and then the Stop hook somehow re-fired for that exact same
// turn again afterward, it could be recaptured as a new ungraded pending
// record. Narrow enough (grading happens well after a turn/session ends,
// normally in a later session) not to warrant a permanent separate seen-log.
function capturePendingFromTurn(entries, subagentsDir) {
  let policy;
  try {
    policy = JSON.parse(fs.readFileSync(routingPolicyPath, 'utf8'));
  } catch {
    return 0;
  }

  // toolUseId -> record, preserving first-seen position but always holding
  // the most-recently-computed value for that id (Map.set on an existing key
  // updates the value without moving its position).
  const byToolUseId = new Map(readEntries(pendingPath).map((r) => [r.toolUseId, r]));
  const sizeBefore = byToolUseId.size;

  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (block.type !== 'tool_use' || block.name !== 'Agent') continue;
      const toolInput = block.input || {};
      const haystack = `${toolInput.subagent_type || ''} ${toolInput.description || ''}`.toLowerCase();
      const taskKeyword = matchKeyword(haystack, policy);
      if (!taskKeyword) continue; // no static-table match = nothing to learn against

      const usage = resolveSubagentUsage(subagentsDir, block.id);
      if (!usage || !usage.resolvedModel) continue;

      byToolUseId.set(block.id, {
        ts: new Date().toISOString(),
        taskKeyword,
        modelUsed: usage.resolvedModel,
        tokensUsed: usage.outputTokens,
        toolUseId: block.id,
      });

      // Council item (c): best-effort, non-subjective derived signals for
      // this same Agent call (edits kept/reverted, turn errored, respawned
      // soon) -- lands in selflearning's separate derived-observations.jsonl,
      // never in pending.jsonl/beliefs.db/eventlog. Never affects the pending
      // capture above; wrapped so a derive failure can't touch it either.
      try {
        const itemId = `modelweighter:pending:${block.id}`;
        const result = deriveObservations.deriveSignalsForToolUse({
          toolUseId: block.id,
          taskKeyword,
          subagentType: toolInput.subagent_type || '',
          entries,
          subagentsDir,
        });
        deriveObservations.recordDerivedObservation(itemId, result);
      } catch {
        // best-effort -- never let derived-observation capture affect anything else
      }
    }
  }

  try {
    const lines = [...byToolUseId.values()].map((r) => JSON.stringify(r));
    fs.writeFileSync(pendingPath, lines.length ? lines.join('\n') + '\n' : '');
  } catch {
    // best-effort -- skip on write failure
  }

  return byToolUseId.size - sizeBefore;
}

module.exports = { capturePendingFromTurn, pendingPath };
