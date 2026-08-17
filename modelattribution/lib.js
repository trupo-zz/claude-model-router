const fs = require('fs');
const path = require('path');

// Human-readable names for known model IDs (see ~/.claude/skills/claude-api/SKILL.md).
const MODEL_NAMES = {
  'claude-sonnet-5': 'Sonnet 5',
  'claude-opus-5': 'Opus 5',
  'claude-fable-5': 'Fable 5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
};

function displayName(modelId) {
  return MODEL_NAMES[modelId] || modelId;
}

// Detects Bash calls into localmodel/cli.js's "run" subcommand (see
// ~/.claude/tools/localmodel) -- substring match, not a path parse, so it survives
// "cd ... && node cli.js run ..." in either forward- or back-slash form. Known gap: a
// bare "node cli.js run ..." issued from an already-persisted localmodel cwd (no
// repeated "cd .../localmodel") won't match -- undercounts safely rather than guessing.
function isLocalModelCommand(command) {
  if (typeof command !== 'string') return false;
  return command.includes('localmodel') && /cli\.js/.test(command) && /\brun\b/.test(command);
}

// cli.js's own stdout convention: "[model: <id>]\n<response text>" (see cli.js's `run`
// handler). Only place a local model's identity is observable from the transcript.
const LOCAL_MODEL_TAG = /^\[model:\s*([^\]]+)\]/m;

// Ollama's /api/generate response has a real eval_count, but cli.js doesn't print it, so
// the only signal available from a Bash tool_result is response text length. Chars/4 is
// a rough estimate, not a real token count -- good enough for a relative-share breakdown,
// not for precise cost accounting.
function estimateLocalTokens(responseText) {
  return Math.max(1, Math.round(responseText.length / 4));
}

function toolResultText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.map((c) => c.text || '').join('');
  return '';
}

function readEntries(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
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

// "This turn" = everything from the most recent genuine typed human message to the end.
// Real user messages carry origin.kind === "human" with a string content; tool_result
// replies (also type "user") don't -- that's the reliable boundary marker.
function findTurnEntries(transcriptPath) {
  const entries = readEntries(transcriptPath);
  let startIdx = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'user' && e.origin && e.origin.kind === 'human') {
      startIdx = i;
      break;
    }
  }
  return entries.slice(startIdx);
}

function findLastAssistantText(entries) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === 'assistant' && e.isSidechain === false && e.message && Array.isArray(e.message.content)) {
      const textBlock = [...e.message.content].reverse().find((c) => c.type === 'text' && c.text && c.text.trim());
      if (textBlock) return { entry: e, text: textBlock.text };
    }
  }
  return null;
}

function loadSubagentUsage(subagentsDir, toolUseId) {
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

// Weighted by output_tokens: main-model turns tally under message.model, each Agent
// spawn tallies under its subagent transcript's actually-resolved model (not just the
// tier requested -- route-enforcer/model-routing can redirect what actually ran), and
// each localmodel/cli.js Bash call tallies under its resolved local model id (estimated
// tokens, since Bash tool_results carry no real usage numbers). Local entries are marked
// isLocal so formatBreakdown can flag them -- they're real delegated work, but off the
// Claude token budget, so folding them in silently would misrepresent what Claude usage
// this turn actually cost.
function computeBreakdown(entries, subagentsDir) {
  const tally = {};
  const add = (model, tokens, isLocal = false) => {
    if (!model) return;
    if (!tally[model]) tally[model] = { tokens: 0, isLocal: false };
    tally[model].tokens += Math.max(tokens, 1); // floor 1 so a real call always counts for something
    if (isLocal) tally[model].isLocal = true; // sticky true -- one local hit is enough to flag the model
  };

  const localToolUseIds = new Set();

  for (const e of entries) {
    if (e.type === 'assistant' && e.message) {
      if (e.isSidechain === false) {
        const model = e.message.model;
        if (model && model !== '<synthetic>') {
          add(model, (e.message.usage && e.message.usage.output_tokens) || 0);
        }
      }

      if (Array.isArray(e.message.content)) {
        for (const block of e.message.content) {
          if (block.type === 'tool_use' && block.name === 'Agent') {
            const usage = loadSubagentUsage(subagentsDir, block.id);
            if (usage) add(usage.resolvedModel, usage.outputTokens);
          }
          if (block.type === 'tool_use' && block.name === 'Bash' && isLocalModelCommand(block.input && block.input.command)) {
            localToolUseIds.add(block.id);
          }
        }
      }
    }

    if (e.type === 'user' && e.message && Array.isArray(e.message.content)) {
      for (const block of e.message.content) {
        if (block.type !== 'tool_result' || !localToolUseIds.has(block.tool_use_id)) continue;
        const text = toolResultText(block.content);
        const match = LOCAL_MODEL_TAG.exec(text);
        if (!match) continue; // errored/unexpected output shape -- skip rather than guess
        const responseBody = text.slice(match.index + match[0].length).trim();
        add(match[1].trim(), estimateLocalTokens(responseBody), true);
      }
    }
  }
  return tally;
}

function formatBreakdown(tally) {
  const total = Object.values(tally).reduce((a, b) => a + b.tokens, 0);
  if (total === 0) return null;
  const parts = Object.entries(tally)
    .sort((a, b) => b[1].tokens - a[1].tokens)
    .map(([model, info]) => {
      const name = info.isLocal ? `${displayName(model)} (local)` : displayName(model);
      return `${name} ${Math.round((info.tokens / total) * 100)}%`;
    });
  return parts.join(' · ');
}

module.exports = { findTurnEntries, findLastAssistantText, computeBreakdown, formatBreakdown, displayName };
