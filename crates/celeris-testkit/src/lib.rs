//! Shared helpers for Celeris failure-injection tests.
//!
//! The crash writer (`celeris-crash-writer`) and the tests that kill it must
//! agree on which key/value pair index `i` produces.
//!
//! [`linearizability`] checks client histories against a register model.

pub mod linearizability;

/// Key written at position `i`. Zero-padded so key order equals write order.
pub fn crash_key(i: u64) -> String {
    format!("k{i:010}")
}

/// Value written at position `i`. Length varies so blocks and memtables fill unevenly.
pub fn crash_value(i: u64) -> String {
    format!("value-{i}-{}", "x".repeat((i % 97) as usize))
}
