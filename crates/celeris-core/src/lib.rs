//! Shared types used by every Celeris crate.
//!
//! This crate holds vocabulary only: consistency modes, mutation identity and
//! key/value limits. It has no I/O and no runtime state.

pub mod consistency;
pub mod key;
pub mod mutation;
pub mod partition;

pub use consistency::{Consistency, ParseConsistencyError};
pub use key::{KeyError, MAX_KEY_LEN, MAX_VALUE_LEN, RESERVED_KEY_PREFIX, validate_key};
pub use mutation::{MutationId, ParseMutationIdError};
