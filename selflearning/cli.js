#!/usr/bin/env node
const lib = require('./lib');

function usage() {
  console.log(`Usage:
  node cli.js observe "<name>" <worked|failed>
  node cli.js list [active|promoted|retracted|pruned]
  node cli.js prune [maxAgeDays]
  node cli.js ingest`);
}

function run(cmd, args) {
  switch (cmd) {
    case 'observe': {
      const [name, outcome] = args;
      if (!name || !outcome) return usage();
      const belief = lib.observe(name, outcome);
      console.log(
        `"${name}": mean=${lib.posteriorMean(belief).toFixed(2)} n=${belief.observations} status=${belief.status}`
      );
      break;
    }
    case 'list': {
      const [status] = args;
      console.table(
        lib.listBeliefs(status || null).map((b) => ({
          ...b,
          mean: lib.posteriorMean(b).toFixed(2),
        }))
      );
      break;
    }
    case 'prune': {
      const [days] = args;
      const pruned = lib.prune(days ? Number(days) : undefined);
      console.log(pruned.length ? `pruned: ${pruned.join(', ')}` : 'nothing to prune');
      break;
    }
    case 'ingest': {
      const count = lib.ingestFromEventlog();
      console.log(`ingested ${count} human-graded outcomes from eventlog`);
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
