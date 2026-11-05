#!/usr/bin/env node
// Turns bench/results/raw.jsonl into the JSON the website renders. For every
// system and cell it reports the median of the repetitions plus the lowest and
// highest throughput seen, so the page can show how much a result moved.
//
//   node bench/summarize.mjs bench/results/raw.jsonl website/src/data/benchmarks.json
import { readFileSync, writeFileSync } from "node:fs";

const [input, output] = process.argv.slice(2);
if (!input || !output) {
  console.error("usage: summarize.mjs <raw.jsonl> <out.json>");
  process.exit(2);
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = readFileSync(input, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const groups = new Map();
for (const r of rows) {
  const id = `${r.system}|${r.workload}|${r.concurrency}`;
  if (!groups.has(id)) groups.set(id, []);
  groups.get(id).push(r);
}

const results = [...groups.values()].map((runs) => {
  const pick = (k) => median(runs.map((r) => r[k]));
  const ops = runs.map((r) => r.ops_per_sec);
  return {
    system: runs[0].system,
    workload: runs[0].workload,
    concurrency: runs[0].concurrency,
    reps: runs.length,
    opsPerSec: Math.round(pick("ops_per_sec")),
    opsMin: Math.round(Math.min(...ops)),
    opsMax: Math.round(Math.max(...ops)),
    p50: pick("p50_us"),
    p99: pick("p99_us"),
    errors: runs.reduce((n, r) => n + r.errors, 0),
  };
});

const failed = results.filter((r) => r.errors > 0);
if (failed.length) console.warn("cells with errors:", failed.map((r) => `${r.system}/${r.workload}/${r.concurrency}=${r.errors}`));

writeFileSync(output, `${JSON.stringify({ results }, null, 2)}\n`);
console.log(`${rows.length} runs, ${results.length} cells written to ${output}`);
