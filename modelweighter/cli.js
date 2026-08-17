#!/usr/bin/env node
const fs = require('fs');
const lib = require('./lib');
const { pendingPath } = require('./capture-pending');

function usage() {
  console.log(`Usage:
  node cli.js record <taskKeyword> <modelUsed> <tokensUsed> <worked|failed>
  node cli.js recommend <taskKeyword>
  node cli.js pending                          -- list ungraded captured usage records
  node cli.js grade <index> <worked|failed>    -- grade a pending record, remove it from the queue`);
}

function readPending() {
  if (!fs.existsSync(pendingPath)) return [];
  return fs
    .readFileSync(pendingPath, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function writePending(records) {
  fs.writeFileSync(pendingPath, records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : ''));
}

function run(cmd, args) {
  switch (cmd) {
    case 'record': {
      const [taskKeyword, modelUsed, tokensUsed, outcome] = args;
      if (!taskKeyword || !modelUsed || !tokensUsed || !outcome) return usage();
      const belief = lib.recordOutcome({
        taskKeyword,
        modelUsed,
        tokensUsed: Number(tokensUsed),
        outcome,
      });
      console.log(
        `"${lib.beliefName(taskKeyword, modelUsed)}": mean=${(belief.alpha / (belief.alpha + belief.beta)).toFixed(2)} ` +
          `n=${belief.observations} status=${belief.status}`
      );
      break;
    }
    case 'recommend': {
      const [taskKeyword] = args;
      if (!taskKeyword) return usage();
      const rec = lib.recommendTier(taskKeyword);
      if (!rec) {
        console.log(
          `no promoted belief for "${taskKeyword}" yet -- defer to the static model-routing.json table`
        );
      } else {
        console.log(
          `recommend "${rec.tier}" for "${taskKeyword}" (confidence=${rec.confidence.toFixed(2)}, ` +
            `n=${rec.observations}, belief="${rec.beliefName}")`
        );
      }
      break;
    }
    case 'pending': {
      const records = readPending();
      if (records.length === 0) {
        console.log('No pending records -- nothing captured yet, or all graded.');
        break;
      }
      records.forEach((r, i) => {
        console.log(`[${i}] ${r.ts}  keyword="${r.taskKeyword}"  model="${r.modelUsed}"  tokens=${r.tokensUsed}`);
      });
      console.log(`\n${records.length} pending. Grade with: node cli.js grade <index> <worked|failed>`);
      break;
    }
    case 'grade': {
      const [idxStr, outcome] = args;
      const idx = Number(idxStr);
      const records = readPending();
      if (!Number.isInteger(idx) || idx < 0 || idx >= records.length) {
        console.log(`No pending record at index ${idxStr}. Run "node cli.js pending" first.`);
        break;
      }
      if (outcome !== 'worked' && outcome !== 'failed') {
        console.log('outcome must be "worked" or "failed"');
        break;
      }
      const r = records[idx];
      const belief = lib.recordOutcome({
        taskKeyword: r.taskKeyword,
        modelUsed: r.modelUsed,
        tokensUsed: r.tokensUsed,
        outcome,
      });
      records.splice(idx, 1);
      writePending(records);
      console.log(
        `Graded "${r.taskKeyword}"/"${r.modelUsed}" as ${outcome}. Belief: mean=` +
          `${(belief.alpha / (belief.alpha + belief.beta)).toFixed(2)} n=${belief.observations} status=${belief.status}`
      );
      break;
    }
    default:
      usage();
  }
}

function main() {
  const [, , cmd, ...args] = process.argv;
  try {
    run(cmd, args);
  } catch (e) {
    console.log(e.message);
    process.exitCode = 1;
  }
}

main();
