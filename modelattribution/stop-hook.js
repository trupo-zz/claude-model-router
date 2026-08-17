#!/usr/bin/env node
// Stop hook. Enforces the user's explicit request (2026-07-31): every turn with real
// text output must end with a "Model: ... %" attribution line. Ground truth is pulled
// from the transcript itself (message.model per turn, resolved model per subagent
// spawn via subagents/*.meta.json + its own transcript) rather than trusting a
// self-reported guess -- the hook computes the real breakdown and hands it back so
// the assistant doesn't have to re-derive it.
//
// Safety: checks stop_hook_active first and never blocks twice in the same stop
// sequence -- this is the documented Claude Code mechanism for preventing a Stop hook
// from looping a session indefinitely. Skips trivial output (<40 chars) so it doesn't
// force a line onto a one-word ack. Fails open on any error, missing transcript, or
// malformed JSON -- same convention as every other hook in this project.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');
const modelweighter = require('../modelweighter/capture-pending');

const MIN_LENGTH = 40;
const ATTRIBUTION_PATTERN = /Model:.*\d+%/i;

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(''));
  });
}

async function main() {
  try {
    const raw = await readStdin();
    const input = JSON.parse(raw);

    if (input.stop_hook_active) return; // already blocked once this stop sequence -- never loop

    const transcriptPath = input.transcript_path;
    if (!transcriptPath || !fs.existsSync(transcriptPath)) return;

    const entries = lib.findTurnEntries(transcriptPath);
    const subagentsDirForCapture = transcriptPath.replace(/\.jsonl$/, path.sep + 'subagents');
    try {
      modelweighter.capturePendingFromTurn(entries, subagentsDirForCapture);
    } catch {
      // best-effort -- never let modelweighter capture affect the attribution gate
    }

    const last = lib.findLastAssistantText(entries);
    if (!last) return; // no real text output this turn (pure tool-call turn) -- nothing to attribute
    if (last.text.trim().length < MIN_LENGTH) return; // trivial output, don't force it on a one-liner

    if (ATTRIBUTION_PATTERN.test(last.text)) return; // already present, allow stop

    const subagentsDir = transcriptPath.replace(/\.jsonl$/, path.sep + 'subagents');
    const tally = lib.computeBreakdown(entries, subagentsDir);
    const suggested = lib.formatBreakdown(tally);

    const reason = suggested
      ? `model-attribution-gate: missing the required "Model: ... %" line (standing user ` +
        `instruction). Ground truth from this turn's transcript: ${suggested}. Send a short ` +
        `follow-up appending a "Model: ..." line in that shape, then stop is allowed.`
      : `model-attribution-gate: missing the required "Model: ... %" line (standing user ` +
        `instruction), and no model usage could be reconstructed from the transcript this ` +
        `time -- state your best honest estimate instead.`;

    process.stdout.write(
      JSON.stringify({
        decision: 'block',
        reason,
        continue: false,
        stopReason: reason,
        suppressOutput: true,
      })
    );
  } catch {
    // fail open -- never trap a session because this hook broke
  }
}

main();
