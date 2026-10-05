//! Cluster control: membership and failure detection.
//!
//! Everything here is a deterministic state machine with no I/O and no
//! clocks of its own. Callers feed in messages and the current time, and get
//! back messages to send. That makes every distributed behaviour testable
//! under a simulated network with drops, duplicates, delays, reordering,
//! partitions and crashes (see the tests in `membership.rs`).

pub mod membership;
pub mod raft;

pub use membership::{
    MemberDigest, MemberState, Membership, MembershipConfig, MembershipEvent, Message, Outgoing,
};
