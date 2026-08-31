#!/usr/bin/env node
// modelweighter/hook.js
//
// *** WIRED LIVE in settings.json as of 2026-07-31, REPLACING ***
// *** ../modelrouting/enforce-model-routing.js on the same Agent-tool ***
// *** PreToolUse matcher (not running alongside it -- that would      ***
// *** double up on warnings for the same event). Safe to swap in      ***
// *** because behavior is IDENTICAL to the static hook until a belief ***
// *** actually gets promoted (mean>=0.75, n>=3) -- and promotion only ***
// *** happens from human-graded outcomes via                         ***
// *** capture-pending.js + `cli.js grade`, never automatically. ***
//
// Runs the same kind of check as enforce-model-routing.js (warn-only,
// never blocks, fails open on any error) but ALSO consults
// modelweighter/lib.js's recommendTier(). When a learned recommendation
// exists for the matched keyword (i.e. a promoted belief), it is preferred
// over the static table's tier for that keyword. When none exists yet,
// this falls back to exactly the static table's logic/tier -- so out of
// the box, before anything has called recordOutcome(), this hook's
// behavior is identical to the static one.
//
// Deliberately requires ../modelrouting/model-routing.json directly and
// reuses its keyword-match loop rather than hand-duplicating the policy,
// so the two hooks can never drift out of sync on what the static table
// says.
const fs = require('fs');
const path = require('path');
const { recommendTier, promotedKeywords } = require('./lib');

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

    const policyPath = path.join(__dirname, '..', 'modelrouting', 'model-routing.json');
    const policy = JSON.parse(fs.readFileSync(policyPath, 'utf8'));

    const haystack = `${toolInput.subagent_type || ''} ${toolInput.description || ''}`.toLowerCase();

    // Same first-rule-wins keyword match as the static hook.
    let staticTier = null;
    let matchedKeyword = null;
    for (const rule of policy.rules || []) {
      const hit = (rule.keywords || []).find((kw) => haystack.includes(kw));
      if (hit) {
        staticTier = rule.tier;
        matchedKeyword = hit;
        break;
      }
    }

    // A keyword can have a promoted belief but no longer appear in the static
    // table (keywords get retired as the policy is tuned). Without this pass,
    // the learned layer is silently gated behind the static one and those
    // beliefs can never fire again -- see promotedKeywords() in lib.js.
    // Longest match wins, so a specific learned keyword beats a shorter
    // substring of it.
    // Guarded separately from the outer catch on purpose: this is the only
    // step that reads the belief store off disk. If that read fails, we want
    // to degrade to static-table-only behavior (fail open to the *existing*
    // nudge), not lose the static nudge too by unwinding to the outer
    // handler. Silent by design -- a hook must never write to stdout except
    // its own JSON protocol.
    if (!matchedKeyword) {
      try {
        const learnedMatch = promotedKeywords()
          .filter((kw) => typeof kw === 'string' && kw && haystack.includes(kw))
          .sort((a, b) => b.length - a.length)[0];
        if (learnedMatch) matchedKeyword = learnedMatch; // staticTier stays null
      } catch {
        // belief store unavailable/corrupt -- fall through to static behavior
      }
    }

    if (!matchedKeyword) return; // no match = no recommendation, same as static hook

    // Learned data takes priority over the static table when a belief for
    // this exact keyword has been promoted; recommendTier() already
    // enforces the confidence bar (mean>=0.75, n>=3) internally, so any
    // non-null result here is by definition "sufficient confidence" --
    // there's no separate threshold to apply on top of it.
    const learned = recommendTier(matchedKeyword);
    const recommended = learned ? learned.tier : staticTier;
    const source = learned
      ? `learned data (mean=${learned.confidence.toFixed(2)}, n=${learned.observations}, belief="${learned.beliefName}")`
      : 'static policy (no promoted belief yet for this keyword)';

    if (!recommended) return;

    let msg;
    if (requestedModel) {
      // Explicit override requested -- original behavior, compare against it.
      if (recommended === requestedModel) return;
      msg =
        `model-routing [modelweighter, learned hook]: ` +
        `requested "${requestedModel}" but "${matchedKeyword}" recommends the "${recommended}" tier per ${source}. ` +
        `Not blocked -- just a heads-up.`;
    } else {
      // No explicit model was requested -- fixed 2026-08-12 (was a total
      // early-return here, so a promoted belief had no path to ever surface
      // on the majority of Agent calls, which don't pass a model param).
      // Deliberately silent unless a belief has actually been PROMOTED
      // (learned is non-null): the static table alone having an opinion on
      // an unspecified default is expected and not worth a message on
      // nearly every Agent call -- that would just be new noise, not a fix.
      if (!learned) return;
      msg =
        `model-routing [modelweighter, learned hook]: no explicit model was requested, but ` +
        `"${matchedKeyword}" has a PROMOTED learned recommendation of "${recommended}" tier per ${source}. ` +
        `Not blocked -- pass model: "${recommended}" explicitly to follow it, or ignore this if the default ` +
        `already resolves to that tier.`;
    }
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
