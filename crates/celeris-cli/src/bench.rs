//! `celeris bench`: a closed-loop HTTP load generator.
//!
//! It measures; it never invents numbers. Results depend on the machine, the
//! storage sync mode and client overhead, and are only comparable between
//! runs on the same setup.

use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, anyhow, ensure};
use celeris_core::MutationId;
use clap::ValueEnum;
use serde_json::json;

use crate::client::{Client, WriteResult};

#[derive(Debug, Clone, Copy, PartialEq, Eq, ValueEnum)]
pub enum Workload {
    /// Every operation writes a new key.
    Put,
    /// Every operation reads a pre-loaded key.
    Get,
    /// 70% reads, 30% overwrites of pre-loaded keys.
    Mixed,
}

#[derive(Debug, clap::Args)]
pub struct Args {
    /// Total operations to run.
    #[arg(long, default_value_t = 10_000)]
    ops: usize,
    /// Concurrent client threads.
    #[arg(long, short = 'c', default_value_t = 8)]
    concurrency: usize,
    /// Approximate value size in bytes.
    #[arg(long, default_value_t = 100)]
    value_size: usize,
    /// Distinct keys pre-loaded for the get and mixed workloads.
    #[arg(long, default_value_t = 1000)]
    keys: usize,
    #[arg(long, value_enum, default_value_t = Workload::Mixed)]
    workload: Workload,
}

pub fn run(addr: &str, args: &Args, json_out: bool) -> anyhow::Result<()> {
    ensure!(
        args.ops > 0 && args.concurrency > 0 && args.keys > 0,
        "ops, concurrency and keys must be positive"
    );
    Client::new(addr)
        .get("/health")
        .context("benchmark target")?;
    // A JSON string of roughly `value_size` bytes including quotes.
    let value = serde_json::to_vec(&"x".repeat(args.value_size.saturating_sub(2)))?;
    if args.workload != Workload::Put {
        preload(addr, args.keys, &value, args.concurrency)?;
    }

    let per_thread = args.ops.div_ceil(args.concurrency);
    let started = Instant::now();
    let workers: Vec<_> = (0..args.concurrency)
        .map(|t| {
            let (addr, value) = (addr.to_owned(), value.clone());
            let (workload, keys) = (args.workload, args.keys);
            thread::spawn(move || worker(&addr, t, per_thread, keys, workload, &value))
        })
        .collect();
    let mut latencies = Vec::with_capacity(per_thread * args.concurrency);
    let mut errors = 0;
    for w in workers {
        let (lat, err) = w.join().map_err(|_| anyhow!("benchmark thread panicked"))?;
        latencies.extend(lat);
        errors += err;
    }
    let elapsed = started.elapsed();
    latencies.sort_unstable();
    let pct = |p: f64| {
        let i = ((latencies.len() - 1) as f64 * p).round() as usize;
        latencies[i]
    };
    let throughput = latencies.len() as f64 / elapsed.as_secs_f64();

    if json_out {
        let us = |d: Duration| d.as_micros() as u64;
        println!(
            "{}",
            json!({
                "workload": format!("{:?}", args.workload).to_lowercase(),
                "ops": latencies.len(),
                "concurrency": args.concurrency,
                "value_size": args.value_size,
                "elapsed_secs": elapsed.as_secs_f64(),
                "throughput_ops_per_sec": throughput,
                "errors": errors,
                "latency_us": {
                    "p50": us(pct(0.50)), "p95": us(pct(0.95)),
                    "p99": us(pct(0.99)), "max": us(pct(1.0)),
                },
            })
        );
    } else {
        println!(
            "workload    {:?}  ops={}  concurrency={}  value≈{}B",
            args.workload,
            latencies.len(),
            args.concurrency,
            args.value_size
        );
        println!(
            "elapsed     {:.2}s   throughput {:.0} ops/s   errors {errors}",
            elapsed.as_secs_f64(),
            throughput
        );
        println!(
            "latency     p50 {}  p95 {}  p99 {}  max {}",
            fmt(pct(0.50)),
            fmt(pct(0.95)),
            fmt(pct(0.99)),
            fmt(pct(1.0))
        );
        println!(
            "note: closed-loop HTTP benchmark from this machine; compare only runs on the same hardware, OS and sync mode."
        );
    }
    Ok(())
}

fn preload(addr: &str, keys: usize, value: &[u8], concurrency: usize) -> anyhow::Result<()> {
    let chunk = keys.div_ceil(concurrency);
    let loaders: Vec<_> = (0..concurrency)
        .map(|t| {
            let (addr, value) = (addr.to_owned(), value.to_vec());
            thread::spawn(move || -> anyhow::Result<()> {
                let client = Client::new(&addr);
                for k in (t * chunk)..((t + 1) * chunk).min(keys) {
                    match client.write(
                        "PUT",
                        &format!("/v1/kv/bench/k{k}"),
                        Some(&value),
                        MutationId::random(),
                    ) {
                        WriteResult::Done(r) if r.is_success() => {}
                        other => anyhow::bail!("preloading bench/k{k} failed: {other:?}"),
                    }
                }
                Ok(())
            })
        })
        .collect();
    for l in loaders {
        l.join().map_err(|_| anyhow!("preload thread panicked"))??;
    }
    Ok(())
}

fn worker(
    addr: &str,
    thread_id: usize,
    ops: usize,
    keys: usize,
    workload: Workload,
    value: &[u8],
) -> (Vec<Duration>, usize) {
    let client = Client::new(addr);
    let mut rng =
        0x9E37_79B9_7F4A_7C15_u64 ^ (thread_id as u64 + 1).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    let mut latencies = Vec::with_capacity(ops);
    let mut errors = 0;
    for i in 0..ops {
        rng ^= rng << 13;
        rng ^= rng >> 7;
        rng ^= rng << 17;
        let key_index = rng % keys as u64;
        let write = match workload {
            Workload::Put => true,
            Workload::Get => false,
            Workload::Mixed => rng % 10 < 3,
        };
        let started = Instant::now();
        let ok = if write {
            let key = match workload {
                Workload::Put => format!("bench/t{thread_id}/{i}"),
                _ => format!("bench/k{key_index}"),
            };
            matches!(
                client.write("PUT", &format!("/v1/kv/{key}"), Some(value), MutationId::random()),
                WriteResult::Done(r) if r.is_success()
            )
        } else {
            client
                .send("GET", &format!("/v1/kv/bench/k{key_index}"), &[], None)
                .is_ok_and(|r| r.is_success())
        };
        latencies.push(started.elapsed());
        if !ok {
            errors += 1;
        }
    }
    (latencies, errors)
}

fn fmt(d: Duration) -> String {
    let us = d.as_secs_f64() * 1e6;
    if us < 1000.0 {
        format!("{us:.0}µs")
    } else {
        format!("{:.2}ms", us / 1000.0)
    }
}
