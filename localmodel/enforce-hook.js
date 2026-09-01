#!/usr/bin/env node
// PreToolUse hook on the Agent tool. DENIES spawning a Claude subagent for
// work that the existing static routing table (modelrouting/model-routing.json)
// already classifies as "haiku" tier -- narrow, checklist-shaped, high-volume --
// on the grounds that this class of work doesn't need Claude at all and should
// go to a free local model via ~/.claude/tools/localmodel instead.
//
// Built 2026-07-30 after the user hit their daily Claude usage limit from
// spawning many parallel subagents for exactly this kind of narrow work, and
// explicitly asked for this to be enforced, not just suggested.
//
// Escape hatch: an Agent call whose description contains the literal marker
// "[claude-required]" is always allowed through, no matter what it matches --
// this is deliberate. A keyword table is a heuristic, not a judge of whether
// a given call genuinely needs Claude's reasoning; the marker lets a real
// override survive contact with a wrong classification, matching this
// project's repeated preference for a manual escape hatch over a hard,
// un-overridable gate (see destructiveguard's docs for the same argument
// about false-positive risk).
//
// Fails open on any error, missing/malformed stdin, or non-Bash/non-Agent
// tool_name -- same convention as every other hook in this project.
const fs = require('fs');
const path = require('path');

const ROUTING_TABLE_PATH = path.join(__dirname, '..', 'modelrouting', 'model-routing.json');
const OVERRIDE_MARKER = '[claude-required]';

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

function matchesTier(haystack, routingTable, tierName) {
  const rule = (routingTable.rules || []).find((r) => r.tier === tierName);
  if (!rule) return null;
  const hit = (rule.keywords || []).find((kw) => haystack.includes(kw));
  return hit || null;
}

async function main() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    if (input.tool_name !== 'Agent') return;

    const toolInput = input.tool_input || {};
    const description = toolInput.description || '';
    const subagentType = toolInput.subagent_type || '';

    if (description.includes(OVERRIDE_MARKER)) return; // explicit override, always allow

    const haystack = `${subagentType} ${description}`.toLowerCase();
    const routingTable = JSON.parse(fs.readFileSync(ROUTING_TABLE_PATH, 'utf8'));

    const haikuKeyword = matchesTier(haystack, routingTable, 'haiku');
    if (haikuKeyword) {
      const reason =
        `route-enforcer: this task matched "${haikuKeyword}" (narrow/checklist-shaped, ` +
        `haiku tier). That class of work doesn't need Claude -- use the free local cascade ` +
        `instead: node "C:\\Users\\strupo\\.claude\\tools\\cascade\\run.js" --task "<prompt>" ` +
        `--check '<spec>'  (runs the local tiers in order, verifies each answer, retries with a ` +
        `corrective nudge, and exits 2 with NOTHING on stdout if no tier can satisfy the check -- ` +
        `that exit code is your signal to take the task back yourself). --check accepts json | ` +
        `oneword | bullets:N | sentences:N, or a grader spec like ` +
        `'{"type":"contains","value":"..."}'. PREFER THIS over a bare ` +
        `localmodel/cli.js call: that path is single-shot with no verification, so a wrong local ` +
        `answer comes back looking exactly like a right one. If Claude is genuinely ` +
        `required here despite the match, add the literal text "${OVERRIDE_MARKER}" to the Agent ` +
        `call's description and retry -- that always overrides this hook.`;

      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'deny',
            permissionDecisionReason: reason,
          },
        })
      );
      return;
    }

    // Kimi tier is a soft nudge only, never a deny: it's China-hosted, so
    // whether data is sensitive enough to keep off it is a judgment call
    // only the caller can make -- this hook can suggest it, not enforce it.
    const kimiKeyword = matchesTier(haystack, routingTable, 'kimi');
    if (kimiKeyword) {
      const msg =
        `route-enforcer: this task matched "${kimiKeyword}" (long-horizon/multi-step/tool-heavy ` +
        `coding work that may not need Claude specifically). Consider Kimi instead, if the data ` +
        `involved is non-sensitive (it's China-hosted): node "C:\\Users\\strupo\\.claude\\tools\\kimi\\call.js" ` +
        `"<prompt>". Not blocked -- your call.`;
      process.stdout.write(
        JSON.stringify({
          systemMessage: msg,
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: 'allow',
            additionalContext: msg,
          },
        })
      );
    }
  } catch {
    // fail open -- never block Agent spawns because this hook broke
  }
}

main();
