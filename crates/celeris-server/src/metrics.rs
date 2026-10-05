//! Prometheus text exposition for HTTP, consistency and storage metrics.

use std::collections::BTreeMap;
use std::fmt::Write;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Mutex, PoisonError};
use std::time::Duration;

use celeris_core::Consistency;
use celeris_storage::{EngineStats, MetricsSnapshot};

/// Latency histogram bucket upper bounds, in seconds.
const BUCKETS: [f64; 12] = [
    0.0005, 0.001, 0.0025, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5,
];

#[derive(Debug, Default)]
struct Histogram {
    /// Non-cumulative counts per bucket; the last slot is +Inf.
    counts: [u64; BUCKETS.len() + 1],
    sum_secs: f64,
    count: u64,
}

impl Histogram {
    fn observe(&mut self, secs: f64) {
        let slot = BUCKETS
            .iter()
            .position(|&b| secs <= b)
            .unwrap_or(BUCKETS.len());
        self.counts[slot] += 1;
        self.sum_secs += secs;
        self.count += 1;
    }
}

#[derive(Debug, Default)]
struct Requests {
    /// (route, method, status) → count
    totals: BTreeMap<(String, String, u16), u64>,
    /// (route, method) → latency
    latency: BTreeMap<(String, String), Histogram>,
}

#[derive(Debug, Default)]
pub(crate) struct HttpMetrics {
    requests: Mutex<Requests>,
    /// [mode][0 = read, 1 = write]
    consistency: [[AtomicU64; 2]; Consistency::ALL.len()],
}

impl HttpMetrics {
    pub(crate) fn record_request(&self, route: &str, method: &str, status: u16, elapsed: Duration) {
        let mut r = self.requests.lock().unwrap_or_else(PoisonError::into_inner);
        *r.totals
            .entry((route.to_owned(), method.to_owned(), status))
            .or_default() += 1;
        r.latency
            .entry((route.to_owned(), method.to_owned()))
            .or_default()
            .observe(elapsed.as_secs_f64());
    }

    pub(crate) fn record_consistency(&self, mode: Consistency, write: bool) {
        let i = Consistency::ALL
            .iter()
            .position(|m| *m == mode)
            .unwrap_or(0);
        self.consistency[i][usize::from(write)].fetch_add(1, Ordering::Relaxed);
    }

    pub(crate) fn render(
        &self,
        node_id: &str,
        uptime: Duration,
        storage: &MetricsSnapshot,
        stats: &EngineStats,
    ) -> String {
        let mut out = String::with_capacity(8 * 1024);
        header(
            &mut out,
            "celeris_node_info",
            "gauge",
            "Node identity and build version.",
        );
        let _ = writeln!(
            out,
            "celeris_node_info{{node_id=\"{}\",version=\"{}\"}} 1",
            escape(node_id),
            env!("CARGO_PKG_VERSION")
        );
        header(
            &mut out,
            "celeris_uptime_seconds",
            "gauge",
            "Seconds since the node started.",
        );
        let _ = writeln!(out, "celeris_uptime_seconds {}", uptime.as_secs_f64());

        {
            let r = self.requests.lock().unwrap_or_else(PoisonError::into_inner);
            header(
                &mut out,
                "celeris_http_requests_total",
                "counter",
                "HTTP requests by route, method and status.",
            );
            for ((route, method, status), n) in &r.totals {
                let _ = writeln!(
                    out,
                    "celeris_http_requests_total{{route=\"{}\",method=\"{}\",status=\"{status}\"}} {n}",
                    escape(route),
                    escape(method)
                );
            }
            header(
                &mut out,
                "celeris_http_request_duration_seconds",
                "histogram",
                "HTTP request latency.",
            );
            for ((route, method), h) in &r.latency {
                let labels = format!("route=\"{}\",method=\"{}\"", escape(route), escape(method));
                let mut cumulative = 0;
                for (i, bound) in BUCKETS.iter().enumerate() {
                    cumulative += h.counts[i];
                    let _ = writeln!(
                        out,
                        "celeris_http_request_duration_seconds_bucket{{{labels},le=\"{bound}\"}} {cumulative}"
                    );
                }
                let _ = writeln!(
                    out,
                    "celeris_http_request_duration_seconds_bucket{{{labels},le=\"+Inf\"}} {}",
                    h.count
                );
                let _ = writeln!(
                    out,
                    "celeris_http_request_duration_seconds_sum{{{labels}}} {}",
                    h.sum_secs
                );
                let _ = writeln!(
                    out,
                    "celeris_http_request_duration_seconds_count{{{labels}}} {}",
                    h.count
                );
            }
        }

        header(
            &mut out,
            "celeris_operations_by_consistency_total",
            "counter",
            "Client operations by requested consistency mode.",
        );
        for (i, mode) in Consistency::ALL.iter().enumerate() {
            for (j, kind) in ["read", "write"].iter().enumerate() {
                let _ = writeln!(
                    out,
                    "celeris_operations_by_consistency_total{{mode=\"{mode}\",kind=\"{kind}\"}} {}",
                    self.consistency[i][j].load(Ordering::Relaxed)
                );
            }
        }

        for (name, value) in storage.counters() {
            let metric = format!("celeris_storage_{name}_total");
            header(&mut out, &metric, "counter", "Storage engine counter.");
            let _ = writeln!(out, "{metric} {value}");
        }
        let gauges: [(&str, &str, u64); 7] = [
            (
                "celeris_storage_last_version",
                "Highest committed sequence number.",
                stats.last_version,
            ),
            (
                "celeris_storage_memtable_bytes",
                "Approximate bytes in the active memtable.",
                stats.memtable_bytes as u64,
            ),
            (
                "celeris_storage_immutable_memtables",
                "Memtables waiting to be flushed.",
                stats.immutable_memtables as u64,
            ),
            (
                "celeris_storage_l0_tables",
                "Tables in level 0.",
                stats.l0_tables as u64,
            ),
            (
                "celeris_storage_l1_tables",
                "Tables in level 1.",
                stats.l1_tables as u64,
            ),
            (
                "celeris_storage_table_bytes",
                "Bytes in live SSTables.",
                stats.table_bytes,
            ),
            (
                "celeris_storage_read_only",
                "1 if a WAL failure made the node read-only.",
                u64::from(stats.poisoned.is_some()),
            ),
        ];
        for (name, help, value) in gauges {
            header(&mut out, name, "gauge", help);
            let _ = writeln!(out, "{name} {value}");
        }
        out
    }
}

fn header(out: &mut String, name: &str, kind: &str, help: &str) {
    let _ = writeln!(out, "# HELP {name} {help}");
    let _ = writeln!(out, "# TYPE {name} {kind}");
}

fn escape(label: &str) -> String {
    label
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn histogram_is_cumulative_and_counts_overflow() {
        let m = HttpMetrics::default();
        m.record_request("/r", "GET", 200, Duration::from_micros(300));
        m.record_request("/r", "GET", 200, Duration::from_millis(3));
        m.record_request("/r", "GET", 500, Duration::from_secs(10));
        m.record_consistency(Consistency::Strict, true);
        let text = m.render(
            "n\"1",
            Duration::from_secs(1),
            &MetricsSnapshot::default(),
            &EngineStats {
                last_version: 0,
                memtable_bytes: 0,
                immutable_memtables: 0,
                l0_tables: 0,
                l1_tables: 0,
                table_bytes: 0,
                poisoned: None,
                background_error: None,
            },
        );
        assert!(text.contains("route=\"/r\",method=\"GET\",le=\"0.0005\"} 1"));
        assert!(text.contains("route=\"/r\",method=\"GET\",le=\"0.005\"} 2"));
        assert!(text.contains("route=\"/r\",method=\"GET\",le=\"+Inf\"} 3"));
        assert!(text.contains("status=\"500\"} 1"));
        assert!(text.contains("mode=\"strict\",kind=\"write\"} 1"));
        assert!(text.contains("node_id=\"n\\\"1\""));
        assert!(text.contains("celeris_storage_write_batches_total 0"));
    }
}
