//! Storage engine errors.

use std::io;
use std::path::{Path, PathBuf};

use celeris_core::{KeyError, MutationId};

use crate::batch::Condition;

pub type Result<T, E = StorageError> = std::result::Result<T, E>;

#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StorageError {
    #[error("I/O error on {}: {source}", .path.display())]
    Io {
        path: PathBuf,
        #[source]
        source: io::Error,
    },

    #[error("corruption detected in {}: {detail}", .path.display())]
    Corruption { path: PathBuf, detail: String },

    #[error(
        "{what} format version {found} is not supported (this build reads version {supported})"
    )]
    UnsupportedFormat {
        what: &'static str,
        found: u32,
        supported: u32,
    },

    #[error("data directory {} is locked by another process", .0.display())]
    Locked(PathBuf),

    #[error(transparent)]
    InvalidKey(#[from] KeyError),

    #[error("invalid argument: {0}")]
    InvalidArgument(String),

    #[error(
        "condition `{expected}` failed for key `{}`: current version is {}",
        String::from_utf8_lossy(.key),
        fmt_version(.actual)
    )]
    ConditionFailed {
        key: Vec<u8>,
        expected: Condition,
        actual: Option<u64>,
    },

    #[error("mutation id {0} was already used for a different mutation")]
    MutationIdReused(MutationId),

    /// The WAL append or fsync failed. The write may or may not be durable;
    /// the engine refuses further writes.
    #[error("write-ahead log failure, outcome of this write is unknown: {0}")]
    WalFailure(String),

    /// An earlier WAL failure made the engine read-only.
    #[error("engine is read-only after an earlier write-ahead log failure: {0}")]
    Poisoned(String),

    #[error("internal error: {0}")]
    Internal(String),
}

impl StorageError {
    /// True when the caller cannot know whether the mutation was applied.
    /// Callers must resolve the outcome (for example via
    /// [`crate::Engine::mutation_status`] after restart) instead of assuming
    /// failure.
    pub fn is_outcome_unknown(&self) -> bool {
        matches!(self, StorageError::WalFailure(_))
    }
}

fn fmt_version(v: &Option<u64>) -> String {
    match v {
        Some(v) => v.to_string(),
        None => "absent".to_owned(),
    }
}

pub(crate) fn io_err(path: &Path) -> impl FnOnce(io::Error) -> StorageError + '_ {
    move |source| StorageError::Io {
        path: path.to_path_buf(),
        source,
    }
}

pub(crate) fn corruption(path: &Path, detail: impl Into<String>) -> StorageError {
    StorageError::Corruption {
        path: path.to_path_buf(),
        detail: detail.into(),
    }
}
