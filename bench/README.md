# Comparative benchmarks

`run.sh` runs YCSB core workloads against eight databases on one machine, one
at a time, each in a fresh container with a fresh volume and its durable mode
turned on. `harness/` is the Go load generator. `summarize.mjs` turns the raw
JSON lines into `website/src/data/benchmarks.json`, which the landing page renders.

## Published results

`results/2026-11-05-quick/raw.jsonl` is a quick run, not a final result:

```bash
bench/run.sh --reps 1 --keys 2000 --warmup 1s --duration 2s \
  --cells a:32,b:32,c:32,load:32 --out raw.jsonl
```

2,000 keys, 2 seconds per cell, one repetition, AMD Ryzen 5 4600H laptop on
battery with other software running. Small differences may not hold up.

## Full run

`bench/run.sh` with no flags uses 100,000 keys, three repetitions with fresh
containers and 15-second cells, and adds concurrency 1 and 128 for workload A.
It takes about 80 minutes. Run it on mains power, then:

```bash
node bench/summarize.mjs bench/results/raw.jsonl website/src/data/benchmarks.json
```

The image `celeris:bench` is built from the repository `Dockerfile`:
`docker build -t celeris:bench .`
