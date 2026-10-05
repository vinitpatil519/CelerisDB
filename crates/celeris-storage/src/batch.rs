//! Write batches: the unit of atomicity and idempotency.

use std::fmt;
use std::time::Duration;

use celeris_core::{MAX_VALUE_LEN, MutationId, validate_key};
use xxhash_rust::xxh3::Xxh3;

use crate::error::{Result, StorageError};

/// Maximum operations in one batch.
pub const MAX_BATCH_OPS: usize = 10_000;

/// Maximum total key + value bytes in one batch (32 MiB).
pub const MAX_BATCH_BYTES: usize = 32 * 1024 * 1024;

/// Precondition on the current version of a key, evaluated atomically with
/// the batch. Expired keys count as absent.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Condition {
    /// The key must not currently exist.
    Absent,
    /// The key's current version must equal this value.
    Version(u64),
}

impl fmt::Display for Condition {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Condition::Absent => f.write_str("absent"),
            Condition::Version(v) => write!(f, "version == {v}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Op {
    Put {
        key: Vec<u8>,
        value: Vec<u8>,
        ttl: Option<Duration>,
        condition: Option<Condition>,
    },
    Delete {
        key: Vec<u8>,
        condition: Option<Condition>,
    },
}

impl Op {
    pub fn key(&self) -> &[u8] {
        match self {
            Op::Put { key, .. } | Op::Delete { key, .. } => key,
        }
    }

    pub fn condition(&self) -> Option<Condition> {
        match self {
            Op::Put { condition, .. } | Op::Delete { condition, .. } => *condition,
        }
    }
}

/// An atomic group of operations sharing one [`MutationId`].
///
/// All conditions are checked against the state before the batch. If two
/// operations touch the same key, the later one wins.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteBatch {
    mutation_id: MutationId,
    ops: Vec<Op>,
    /// Internal metadata records (`name`, value or `None` to remove),
    /// committed atomically with `ops`. See [`WriteBatch::set_meta`].
    meta: Vec<(Vec<u8>, Option<Vec<u8>>)>,
}

/// Longest metadata record name.
pub const MAX_META_NAME_LEN: usize = 2048;

impl WriteBatch {
    pub fn new(mutation_id: MutationId) -> Self {
        WriteBatch {
            mutation_id,
            ops: Vec::new(),
            meta: Vec::new(),
        }
    }

    /// Sets (or, with `None`, removes) an internal metadata record. Metadata
    /// lives outside the user key space: scans never see it, but it is
    /// replicated, included in snapshots and read with
    /// [`crate::Engine::meta`].
    pub fn set_meta(mut self, name: impl Into<Vec<u8>>, value: Option<Vec<u8>>) -> Self {
        self.meta.push((name.into(), value));
        self
    }

    pub fn meta(&self) -> &[(Vec<u8>, Option<Vec<u8>>)] {
        &self.meta
    }

    pub fn put(self, key: impl Into<Vec<u8>>, value: impl Into<Vec<u8>>) -> Self {
        self.push(Op::Put {
            key: key.into(),
            value: value.into(),
            ttl: None,
            condition: None,
        })
    }

    pub fn put_with_ttl(
        self,
        key: impl Into<Vec<u8>>,
        value: impl Into<Vec<u8>>,
        ttl: Duration,
    ) -> Self {
        self.push(Op::Put {
            key: key.into(),
            value: value.into(),
            ttl: Some(ttl),
            condition: None,
        })
    }

    pub fn delete(self, key: impl Into<Vec<u8>>) -> Self {
        self.push(Op::Delete {
            key: key.into(),
            condition: None,
        })
    }

    pub fn push(mut self, op: Op) -> Self {
        self.ops.push(op);
        self
    }

    pub fn mutation_id(&self) -> MutationId {
        self.mutation_id
    }

    pub fn ops(&self) -> &[Op] {
        &self.ops
    }

    pub(crate) fn validate(&self) -> Result<()> {
        if self.ops.is_empty() && self.meta.is_empty() {
            return Err(StorageError::InvalidArgument(
                "batch has no operations".into(),
            ));
        }
        for (name, _) in &self.meta {
            if name.is_empty() || name.len() > MAX_META_NAME_LEN {
                return Err(StorageError::InvalidArgument(format!(
                    "metadata names must be 1..={MAX_META_NAME_LEN} bytes"
                )));
            }
        }
        if self.ops.len() > MAX_BATCH_OPS {
            return Err(StorageError::InvalidArgument(format!(
                "batch has {} operations; maximum is {MAX_BATCH_OPS}",
                self.ops.len()
            )));
        }
        let mut total = 0usize;
        for op in &self.ops {
            validate_key(op.key())?;
            total += op.key().len();
            if let Op::Put { value, ttl, .. } = op {
                if value.len() > MAX_VALUE_LEN {
                    return Err(StorageError::InvalidArgument(format!(
                        "value for key `{}` is {} bytes; maximum is {MAX_VALUE_LEN}",
                        String::from_utf8_lossy(op.key()),
                        value.len()
                    )));
                }
                if ttl.is_some_and(|t| t.as_millis() == 0) {
                    return Err(StorageError::InvalidArgument(
                        "ttl must be at least 1 ms".into(),
                    ));
                }
                total += value.len();
            }
        }
        if total > MAX_BATCH_BYTES {
            return Err(StorageError::InvalidArgument(format!(
                "batch carries {total} bytes; maximum is {MAX_BATCH_BYTES}"
            )));
        }
        Ok(())
    }

    /// Stable hash of the batch contents, stored with the mutation ID so a
    /// reused ID with a different payload is detected instead of silently
    /// returning the old outcome.
    pub(crate) fn fingerprint(&self) -> u64 {
        let mut h = Xxh3::new();
        let mut bytes = |b: &[u8]| {
            h.update(&(b.len() as u64).to_le_bytes());
            h.update(b);
        };
        for op in &self.ops {
            match op {
                Op::Put {
                    key,
                    value,
                    ttl,
                    condition,
                } => {
                    bytes(b"put");
                    bytes(key);
                    bytes(value);
                    bytes(&ttl.map_or(u64::MAX, duration_ms).to_le_bytes());
                    bytes(&condition_bytes(*condition));
                }
                Op::Delete { key, condition } => {
                    bytes(b"delete");
                    bytes(key);
                    bytes(&condition_bytes(*condition));
                }
            }
        }
        for (name, value) in &self.meta {
            bytes(b"meta");
            bytes(name);
            match value {
                Some(v) => {
                    bytes(b"set");
                    bytes(v);
                }
                None => bytes(b"remove"),
            }
        }
        h.digest()
    }
}

fn condition_bytes(c: Option<Condition>) -> [u8; 9] {
    let (tag, v) = match c {
        None => (0, 0),
        Some(Condition::Absent) => (1, 0),
        Some(Condition::Version(v)) => (2, v),
    };
    let mut out = [0u8; 9];
    out[0] = tag;
    out[1..].copy_from_slice(&v.to_le_bytes());
    out
}

pub(crate) fn duration_ms(d: Duration) -> u64 {
    u64::try_from(d.as_millis()).unwrap_or(u64::MAX)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn id() -> MutationId {
        MutationId::from_u128(1)
    }

    #[test]
    fn validation() {
        assert!(WriteBatch::new(id()).validate().is_err());
        assert!(WriteBatch::new(id()).put("", "v").validate().is_err());
        assert!(WriteBatch::new(id()).put("\0x", "v").validate().is_err());
        assert!(
            WriteBatch::new(id())
                .put_with_ttl("k", "v", Duration::ZERO)
                .validate()
                .is_err()
        );
        assert!(
            WriteBatch::new(id())
                .put("k", vec![0u8; MAX_VALUE_LEN + 1])
                .validate()
                .is_err()
        );
        assert!(
            WriteBatch::new(id())
                .put("k", "v")
                .delete("j")
                .validate()
                .is_ok()
        );
    }

    #[test]
    fn fingerprint_distinguishes_payloads() {
        let a = WriteBatch::new(id()).put("k", "v1").fingerprint();
        let b = WriteBatch::new(id()).put("k", "v2").fingerprint();
        let c = WriteBatch::new(id()).put("k", "v1").fingerprint();
        let d = WriteBatch::new(id()).put("kv", "1").fingerprint();
        assert_ne!(a, b);
        assert_eq!(a, c);
        assert_ne!(a, d, "length prefixes keep key/value boundaries distinct");
    }
}
