//! A Celeris node: the HTTP/JSON client API on top of the storage engine.
//!
//! Browsers and SDKs talk HTTP/JSON only; they never see internal cluster
//! protocols. See `docs/API.md` for the wire contract.

mod anti_entropy;
pub mod api;
pub mod auth;
mod available;
mod cluster;
pub mod cluster_tls;
pub mod config;
mod error;
pub mod events;
pub mod groups;
mod indexing;
mod metrics;
mod migration;
pub mod node;
pub mod query;
mod raft_log;
mod replicated;
pub mod tls;

pub use config::Config;
pub use error::{ApiError, Outcome};
pub use node::{Node, serve, serve_with_tls};
