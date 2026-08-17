'use strict';
// selflearning/derive-observations.js
//
// Captures EXOGENOUS/derived observations about Agent subagent calls --
// signals computable from transcript data alone, with no subjective question
// asked of a human. Per the council decision this closes (topic "build order
// + autonomy boundary for self-improving Claude stack...", T3 scope item (c)):
//
//   - NEVER writes to eventlog. Its `graded_by CHECK(IN ('human'))` invariant
//     on decisions/repair_strategies is load-bearing (a prior council ruled
//     it protects exactly against synthetic/derived evidence masquerading as
//     human-graded) and this module doesn't touch eventlog at all.
//   - NEVER writes into selflearning's own beliefs.db, and never calls
//     ../modelweighter/lib.js's recordOutcome() -- that path is
//     human-verdict-only, same "never grade your own homework" doctrine.
//   - Lands in a NEW, separate store (derivedObservationsPath below), kept
//     out of every other store on purpose, so it stays clearly labeled
//     machine-derived-and-unconfirmed until a human acts on it.
//   - Only ever used to PRE-FILL a suggested verdict in
//     session-start-grading.js's batched human prompt -- never to promote or
//     auto-apply anything on its own. status is always 'unconfirmed'; this
//     module has no code path that ever writes anything else there. Turning
//     a suggestion into a real graded outcome only happens via a human
//     answering the batched prompt, which writes through session-start-
//     grading.js's applyGradingAnswers() into eventlog/modelweighter's real
//     human-gated paths -- never through this file.
//
// Best-effort throughout: every detector fails open (returns no signal on
// any read/parse error, or when the underlying data just isn't there)
// rather than fabricate one. A signal being absent is not evidence of
// anything -- it just means this cheap heuristic didn't fire this time.
//
// Real, documented limitation (same honesty convention as this project's
// other tools' README "Limitations" sections): every detector here only
// looks at the SAME "current turn" entries slice modelattribution already
// computes (everything since the last real human message) -- a respawn or a
// reverting edit that happens in a LATER turn or a later session is not
// detected. That's a deliberate scope boundary, not an oversight: reading
// beyond what's already in hand would mean re-walking arbitrary transcript
// history on every Stop-hook firing, which is exactly the kind of
// unbounded-cost mistake capture-pending.js's own dedup fix just closed.
const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const derivedObservationsPath = path.join(HERE, 'derived-observations.jsonl');

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

function subagentTranscriptFor(subagentsDir, toolUseId) {
  if (!subagentsDir || !fs.existsSync(subagentsDir)) return null;
  let metaFiles;
  try {
    metaFiles = fs.readdirSync(subagentsDir).filter((f) => f.endsWith('.meta.json'));
  } catch {
    return null;
  }
  for (const mf of metaFiles) {
    let meta;
    try {
      meta = JSON.parse(fs.readFileSync(path.join(subagentsDir, mf), 'utf8'));
    } catch {
      continue;
    }
    if (meta.toolUseId !== toolUseId) continue;
    const jsonlPath = path.join(subagentsDir, mf.replace(/\.meta\.json$/, '.jsonl'));
    return readEntries(jsonlPath);
  }
  return null;
}

// Signal: did the subagent's own transcript hit a tool error?
function detectTurnErrored(subagentTranscript) {
  if (!subagentTranscript) return false;
  for (const e of subagentTranscript) {
    if (e.type !== 'user' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (block.type === 'tool_result' && block.is_error) return true;
    }
  }
  return false;
}

// Signal: was a task with the same taskKeyword + subagent_type spawned again
// LATER in the same turn's entries? A same-turn re-spawn of the same kind of
// work is a plausible (not certain -- could be legitimate follow-up work,
// not a retry) proxy for "the first attempt didn't land."
function detectRespawnedSoon(entries, thisBlockId, taskKeyword, subagentType) {
  let seenThis = false;
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (block.type !== 'tool_use' || block.name !== 'Agent') continue;
      if (block.id === thisBlockId) {
        seenThis = true;
        continue;
      }
      if (!seenThis) continue; // only count spawns AFTER this one
      const input = block.input || {};
      if ((input.subagent_type || '') !== subagentType) continue;
      const haystack = `${input.subagent_type || ''} ${input.description || ''}`.toLowerCase();
      if (haystack.includes(taskKeyword)) return true;
    }
  }
  return false;
}

function filesTouchedBy(transcript) {
  const files = new Set();
  if (!transcript) return files;
  for (const e of transcript) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (block.type !== 'tool_use') continue;
      if (['Edit', 'Write', 'MultiEdit'].includes(block.name) && block.input && block.input.file_path) {
        files.add(block.input.file_path);
      }
    }
  }
  return files;
}

// Signal: files the subagent edited -- did the main turn (or a later
// subagent) touch the SAME file path again afterward? That's the honestly-
// derivable proxy for "kept vs reverted" available from transcript data
// alone. A later edit to the exact same file is NOT proof of a revert (could
// be unrelated follow-up work) -- deliberately weak evidence, never treated
// as confirmation. Returns 'reverted' | 'kept' | null (null = subagent
// touched no files, nothing to say either way).
function detectEditsRevertedOrKept(entries, thisBlockId, subagentFiles, subagentsDir) {
  if (subagentFiles.size === 0) return null;
  let seenThis = false;
  const laterFiles = new Set();
  for (const e of entries) {
    if (e.type !== 'assistant' || !e.message || !Array.isArray(e.message.content)) continue;
    for (const block of e.message.content) {
      if (block.type === 'tool_use' && block.name === 'Agent' && block.id === thisBlockId) {
        seenThis = true;
        continue;
      }
      if (!seenThis) continue;
      if (block.type === 'tool_use' && ['Edit', 'Write', 'MultiEdit'].includes(block.name) && block.input && block.input.file_path) {
        laterFiles.add(block.input.file_path);
      }
      if (block.type === 'tool_use' && block.name === 'Agent' && block.id !== thisBlockId) {
        const laterTranscript = subagentTranscriptFor(subagentsDir, block.id);
        for (const f of filesTouchedBy(laterTranscript)) laterFiles.add(f);
      }
    }
  }
  for (const f of subagentFiles) {
    if (laterFiles.has(f)) return 'reverted';
  }
  return 'kept';
}

// Combines whatever signals fired into one suggestion. Ties / no signal at
// all resolve to suggestedVerdict: null -- an honest "no opinion," never a
// guess. Any negative (failed-polarity) signal wins over a positive one on
// the theory that a false "worked" pre-fill is worse to rubber-stamp past
// than a false "failed" one (the human is reviewing either way -- but a
// human skimming fast is more likely to accept a suggestion than
// investigate a contradiction).
function deriveSignalsForToolUse({ toolUseId, taskKeyword, subagentType, entries, subagentsDir }) {
  try {
    const subagentTranscript = subagentTranscriptFor(subagentsDir, toolUseId);
    const signals = [];

    if (detectTurnErrored(subagentTranscript)) {
      signals.push({ name: 'turn-errored', polarity: 'failed', weight: 'medium' });
    }
    if (detectRespawnedSoon(entries, toolUseId, taskKeyword, subagentType)) {
      signals.push({ name: 'respawned-soon', polarity: 'failed', weight: 'low' });
    }
    const subagentFiles = filesTouchedBy(subagentTranscript);
    const editsResult = detectEditsRevertedOrKept(entries, toolUseId, subagentFiles, subagentsDir);
    if (editsResult === 'reverted') {
      signals.push({ name: 'edits-reverted', polarity: 'failed', weight: 'medium' });
    } else if (editsResult === 'kept') {
      signals.push({ name: 'edits-kept', polarity: 'worked', weight: 'low' });
    }

    if (signals.length === 0) return null;

    const failedSignals = signals.filter((s) => s.polarity === 'failed');
    const workedSignals = signals.filter((s) => s.polarity === 'worked');

    let suggestedVerdict = null;
    let confidence = 'low';
    if (failedSignals.length > 0) {
      suggestedVerdict = 'failed';
      confidence = failedSignals.some((s) => s.weight === 'medium' || s.weight === 'high') ? 'medium' : 'low';
    } else if (workedSignals.length > 0) {
      suggestedVerdict = 'worked';
      confidence = 'low';
    }

    return {
      signals: signals.map((s) => s.name),
      suggestedVerdict,
      confidence,
      detail: signals.map((s) => s.name).join(', '),
    };
  } catch {
    return null; // fail open -- never fabricate a signal on error
  }
}

// Persists (or updates) the derived observation for one itemId. Keep-latest
// dedup by itemId, same pattern (and same reason) as
// ../modelweighter/capture-pending.js's toolUseId dedup: the Stop hook this
// rides can fire multiple times for one turn, and each firing should
// overwrite with the most-current derived read, never pile up duplicates.
// Best-effort: never throws, never blocks anything else on failure.
function recordDerivedObservation(itemId, result) {
  if (!result) return;
  try {
    const existing = new Map(readEntries(derivedObservationsPath).map((r) => [r.itemId, r]));
    existing.set(itemId, {
      ts: new Date().toISOString(),
      itemId,
      signals: result.signals,
      suggestedVerdict: result.suggestedVerdict,
      confidence: result.confidence,
      detail: result.detail,
      status: 'unconfirmed', // always -- this module has no path that ever writes anything else
    });
    const lines = [...existing.values()].map((r) => JSON.stringify(r));
    fs.writeFileSync(derivedObservationsPath, lines.length ? lines.join('\n') + '\n' : '');
  } catch {
    // best-effort -- never let derived-observation logging block anything
  }
}

function getDerivedObservation(itemId) {
  return readEntries(derivedObservationsPath).find((r) => r.itemId === itemId) || null;
}

function listDerivedObservations() {
  return readEntries(derivedObservationsPath);
}

module.exports = {
  derivedObservationsPath,
  deriveSignalsForToolUse,
  recordDerivedObservation,
  getDerivedObservation,
  listDerivedObservations,
};
