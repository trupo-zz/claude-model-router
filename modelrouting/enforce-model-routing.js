#!/usr/bin/env node
// *** SUPERSEDED, NOT WIRED IN settings.json (since 2026-07-31). ***
// *** Kept for reference only -- do not re-wire without also removing   ***
// *** ../modelweighter/hook.js from the same Agent PreToolUse matcher,  ***
// *** or both will double-fire on the same event.                      ***
//
// The live hook for this exact check is ../modelweighter/hook.js, which
// requires model-routing.json (below) directly and reuses this file's
// keyword-match loop verbatim, then layers a learned-belief override on
// top. See ../modelrouting/ARCHITECTURE.md for the full picture of which
// component owns what. This file still runs correctly stand-alone (it has
// no dependency on modelweighter), it's just not in the live PreToolUse
// chain -- confirmed by reading settings.json directly, 2026-08-12.
//
// PreToolUse hook on the Agent tool. Static/heuristic model-routing check --
// warns when an explicit model override doesn't match what the policy
// recommends for that task shape. Never blocks: this is a nudge, not a
// gate. Any error (bad stdin, missing/malformed policy file) fails open --
// exits with no output, which Claude Code treats as a silent allow.
const fs = require('fs');
const path = require('path');

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk) => (data += chunk));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);
    if (input.tool_name !== 'Agent') return;

    const toolInput = input.tool_input || {};
    const requestedModel = toolInput.model;
    if (!requestedModel) return; // no override requested -- nothing to check

    const policyPath = path.join(__dirname, 'model-routing.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

    const haystack = `${toolInput.subagent_type || ''} ${toolInput.description || ''}`.toLowerCase();

    let recommended = null;
    let matchedKeyword = null;
    for (const rule of policy.rules || []) {
      const hit = (rule.keywords || []).find((kw) => haystack.includes(kw));
      if (hit) {
        recommended = rule.tier;
        matchedKeyword = hit;
        break;
      }
    }

    if (!recommended || recommended === requestedModel) return;

    const msg = `model-routing: requested "${requestedModel}" but "${matchedKeyword}" matches the policy's "${recommended}" tier. Not blocked -- just a heads-up.`;
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
  } catch {
    // fail open -- never block on our own errors
  }
}

main();
