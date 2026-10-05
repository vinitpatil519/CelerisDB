//! Per-operation consistency modes.
//!
//! Celeris does not claim to escape CAP. Each mode states what it gives up
//! during a network partition; see `docs/CONSISTENCY.md`.

use std::fmt;
use std::str::FromStr;

/// Consistency mode selected per operation.
///
/// Ordered from strongest to weakest guarantee.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub enum Consistency {
    /// Linearizable per key. Requires a quorum; may reject or wait when one
    /// is not reachable. Never silently downgraded.
    Strict,
    /// Read-your-writes and monotonic reads within a client session.
    Session,
    /// Reads may be stale, but never older than a caller-supplied bound.
    /// Fails rather than serving data older than the bound.
    Bounded,
    /// Writes accepted by any reachable replica and reconciled later.
    /// Concurrent writes are surfaced as conflicts.
    Available,
    /// Weakest mode: accept anywhere, converge eventually.
    Eventual,
}

impl Consistency {
    /// All modes, strongest first.
    pub const ALL: [Consistency; 5] = [
        Consistency::Strict,
        Consistency::Session,
        Consistency::Bounded,
        Consistency::Available,
        Consistency::Eventual,
    ];

    /// Wire name used by the HTTP API and SDKs.
    pub fn as_str(self) -> &'static str {
        match self {
            Consistency::Strict => "strict",
            Consistency::Session => "session",
            Consistency::Bounded => "bounded",
            Consistency::Available => "available",
            Consistency::Eventual => "eventual",
        }
    }

    /// Whether a write in this mode must reach a quorum before it is
    /// acknowledged. Only quorum modes can promise linearizability.
    pub fn requires_quorum(self) -> bool {
        matches!(self, Consistency::Strict)
    }

    /// Whether this mode may acknowledge a write that has not yet been
    /// replicated, and therefore may produce concurrent conflicting versions.
    pub fn may_diverge(self) -> bool {
        matches!(self, Consistency::Available | Consistency::Eventual)
    }
}

impl fmt::Display for Consistency {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Returned when a string does not name a consistency mode.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error(
    "unknown consistency mode `{0}` (expected strict, session, bounded, available or eventual)"
)]
pub struct ParseConsistencyError(pub String);

impl FromStr for Consistency {
    type Err = ParseConsistencyError;

    /// Parses a mode name, ignoring ASCII case (`STRICT` and `strict` both work).
    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Consistency::ALL
            .into_iter()
            .find(|mode| mode.as_str().eq_ignore_ascii_case(s))
            .ok_or_else(|| ParseConsistencyError(s.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_through_strings() {
        for mode in Consistency::ALL {
            assert_eq!(mode.as_str().parse::<Consistency>(), Ok(mode));
            assert_eq!(
                mode.to_string().to_uppercase().parse::<Consistency>(),
                Ok(mode)
            );
        }
    }

    #[test]
    fn rejects_unknown_names() {
        assert!("linearizable".parse::<Consistency>().is_err());
        assert!("".parse::<Consistency>().is_err());
    }

    #[test]
    fn only_strict_requires_quorum() {
        let quorum: Vec<_> = Consistency::ALL
            .into_iter()
            .filter(|m| m.requires_quorum())
            .collect();
        assert_eq!(quorum, vec![Consistency::Strict]);
        assert!(!Consistency::Strict.may_diverge());
        assert!(Consistency::Available.may_diverge());
    }

    #[test]
    fn ordered_strongest_first() {
        assert!(Consistency::Strict < Consistency::Eventual);
    }
}
