//! Secondary indexes on JSON fields (D-031).
//!
//! An index maps one field of the JSON values under a key prefix to the
//! keys holding them. Entries live in the reserved keyspace,
//! `0x00 'x' <name> 0x00 <definition hash> 0x00 <encoded value> <key>`, with
//! empty values. The value encoding preserves order and is prefix-free, so
//! entries sort by value, then key: a prefix scan over one value yields its
//! keys in key order, and a range scan yields values in order (reversed for
//! a descending index). The definition hash keeps the entries of a
//! redefined index apart from the old ones being dropped.
//!
//! The engine maintains entries inside its write path, under the writer
//! lock, from the previous value of each written key; every write path
//! (API, replication, migration, purge) therefore keeps indexes exact.
//! Building an index over existing data, or dropping one, runs in steps
//! ([`crate::Engine::index_step_at`]) so it never blocks writes for long.

use celeris_core::RESERVED_KEY_PREFIX;
use serde_json::Value;

use crate::error::{Result, StorageError};

pub(crate) const INDEX_KEY_TAG: u8 = b'x';
/// Metadata names of index states: `index/<name>`.
pub(crate) const INDEX_META_PREFIX: &[u8] = b"index/";

/// One secondary index: `field` of the JSON values of keys under `prefix`.
#[derive(Debug, Clone, PartialEq, Eq, Hash)]
pub struct IndexSpec {
    /// `[a-z0-9_-]{1,64}`.
    pub name: String,
    /// Only keys starting with this prefix are indexed (empty: all keys).
    pub prefix: Vec<u8>,
    /// Dotted path of the field, split into segments.
    pub field: Vec<String>,
    /// Entries sort by descending value (keys still ascend within a value).
    pub descending: bool,
}

impl IndexSpec {
    pub fn new(name: &str, prefix: &str, field: &str) -> Result<IndexSpec> {
        let valid_name = name
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
            && name.len() <= 64
            && name
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
        if !valid_name {
            return Err(StorageError::InvalidArgument(format!(
                "index name {name:?} must be 1-64 characters of a-z, 0-9, _ and -, starting with a letter or digit"
            )));
        }
        if prefix.as_bytes().first() == Some(&RESERVED_KEY_PREFIX) {
            return Err(StorageError::InvalidArgument(format!(
                "index {name}: the prefix may not start with a 0x00 byte"
            )));
        }
        if field.is_empty() || field.split('.').any(str::is_empty) {
            return Err(StorageError::InvalidArgument(format!(
                "index {name}: invalid field path {field:?}"
            )));
        }
        Ok(IndexSpec {
            name: name.to_owned(),
            prefix: prefix.as_bytes().to_vec(),
            field: field.split('.').map(str::to_owned).collect(),
            descending: false,
        })
    }

    /// The same index, sorted by descending value.
    pub fn descending(mut self) -> IndexSpec {
        self.descending = true;
        self
    }

    pub(crate) fn covers(&self, key: &[u8]) -> bool {
        key.first() != Some(&RESERVED_KEY_PREFIX) && key.starts_with(&self.prefix)
    }

    /// Identifies the definition: a changed prefix, field, order or entry
    /// encoding is a new index.
    pub(crate) fn fingerprint(&self) -> String {
        format!(
            "v2\u{1}{}\u{1}{}\u{1}{}",
            String::from_utf8_lossy(&self.prefix),
            self.field.join("."),
            if self.descending { "desc" } else { "asc" }
        )
    }

    /// The encoded form of a field value, in this index's order.
    pub(crate) fn encode(&self, value: &Value) -> Option<Vec<u8>> {
        let mut out = encode_ordered(value)?;
        if self.descending {
            for b in &mut out {
                *b = !*b;
            }
        }
        Some(out)
    }

    /// Splits an entry's suffix (after the physical prefix) into the
    /// encoded value and the key.
    pub(crate) fn split_suffix<'a>(&self, suffix: &'a [u8]) -> Option<(&'a [u8], &'a [u8])> {
        let flip = |b: u8| if self.descending { !b } else { b };
        let len = match flip(*suffix.first()?) {
            TAG_NULL | TAG_FALSE | TAG_TRUE => 1,
            TAG_NUMBER => 9,
            TAG_STRING => {
                let mut i = 1;
                loop {
                    match (flip(*suffix.get(i)?), suffix.get(i + 1).map(|b| flip(*b))) {
                        (0, Some(1)) => break i + 2,
                        (0, Some(0xFF)) => i += 2,
                        (0, _) => return None,
                        _ => i += 1,
                    }
                }
            }
            _ => return None,
        };
        (suffix.len() >= len).then(|| suffix.split_at(len))
    }

    /// The start of every entry of this definition.
    pub(crate) fn physical_prefix(&self) -> Vec<u8> {
        physical_prefix(&self.name, &self.fingerprint())
    }

    /// The start of the entries for one field value, or `None` for values
    /// that are never indexed (arrays and objects).
    pub(crate) fn value_prefix(&self, value: &Value) -> Option<Vec<u8>> {
        let mut out = self.physical_prefix();
        out.extend_from_slice(&self.encode(value)?);
        Some(out)
    }

    /// The index key of `value` (raw JSON bytes) for `key`, if the field is
    /// present and a scalar.
    pub(crate) fn entry_key(&self, key: &[u8], value: &[u8]) -> Option<Vec<u8>> {
        let doc: Value = serde_json::from_slice(value).ok()?;
        let field = lookup(&doc, &self.field)?;
        let mut out = self.value_prefix(field)?;
        out.extend_from_slice(key);
        Some(out)
    }
}

/// `0x00 'x' <name> 0x00 <hash of the definition> 0x00`.
pub(crate) fn physical_prefix(name: &str, fingerprint: &str) -> Vec<u8> {
    let hash = xxhash_rust::xxh3::xxh3_64(fingerprint.as_bytes());
    let mut out = Vec::with_capacity(name.len() + 20);
    out.push(RESERVED_KEY_PREFIX);
    out.push(INDEX_KEY_TAG);
    out.extend_from_slice(name.as_bytes());
    out.push(0);
    out.extend_from_slice(format!("{hash:016x}").as_bytes());
    out.push(0);
    out
}

fn lookup<'a>(value: &'a Value, path: &[String]) -> Option<&'a Value> {
    path.iter().try_fold(value, |v, segment| match v {
        Value::Object(map) => map.get(segment),
        Value::Array(items) => segment.parse::<usize>().ok().and_then(|i| items.get(i)),
        _ => None,
    })
}

pub(crate) const TAG_NULL: u8 = 0x01;
pub(crate) const TAG_FALSE: u8 = 0x02;
pub(crate) const TAG_TRUE: u8 = 0x03;
pub(crate) const TAG_NUMBER: u8 = 0x04;
pub(crate) const TAG_STRING: u8 = 0x05;

/// An order-preserving, prefix-free encoding of a scalar:
/// `null < false < true < numbers < strings`. A number is its f64 value in
/// 8 sortable bytes (`1` and `1.0` encode the same; integers beyond 2^53
/// may share an encoding, which only widens a lookup, since results are
/// re-checked). A string is its UTF-8 bytes with 0x00 escaped as `00 FF`,
/// terminated by `00 01`.
pub(crate) fn encode_ordered(value: &Value) -> Option<Vec<u8>> {
    match value {
        Value::Null => Some(vec![TAG_NULL]),
        Value::Bool(false) => Some(vec![TAG_FALSE]),
        Value::Bool(true) => Some(vec![TAG_TRUE]),
        Value::Number(n) => {
            let f = n.as_f64()?;
            let f = if f == 0.0 { 0.0 } else { f };
            let bits = f.to_bits();
            let sortable = if bits >> 63 == 1 {
                !bits
            } else {
                bits | (1 << 63)
            };
            let mut out = vec![TAG_NUMBER];
            out.extend_from_slice(&sortable.to_be_bytes());
            Some(out)
        }
        Value::String(s) => {
            let mut out = Vec::with_capacity(s.len() + 3);
            out.push(TAG_STRING);
            for &b in s.as_bytes() {
                out.push(b);
                if b == 0 {
                    out.push(0xFF);
                }
            }
            out.extend_from_slice(&[0, 1]);
            Some(out)
        }
        Value::Array(_) | Value::Object(_) => None,
    }
}

/// Persisted state of an index, stored as metadata `index/<name>`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum IndexState {
    /// Backfilling: keys up to and including `after` are indexed.
    Building {
        fingerprint: String,
        after: Option<Vec<u8>>,
    },
    Ready {
        fingerprint: String,
    },
    /// No longer configured, or redefined: entries up to and including
    /// `after` are deleted. A redefined index is rebuilt once this is done.
    Dropping {
        fingerprint: String,
        after: Option<Vec<u8>>,
    },
}

impl IndexState {
    pub(crate) fn encode(&self) -> Vec<u8> {
        let v = match self {
            IndexState::Building { fingerprint, after } => serde_json::json!({
                "state": "building",
                "fingerprint": fingerprint,
                "after": after.as_ref().map(|a| a.iter().map(|b| format!("{b:02x}")).collect::<String>()),
            }),
            IndexState::Ready { fingerprint } => {
                serde_json::json!({"state": "ready", "fingerprint": fingerprint})
            }
            IndexState::Dropping { fingerprint, after } => serde_json::json!({
                "state": "dropping",
                "fingerprint": fingerprint,
                "after": after.as_ref().map(|a| a.iter().map(|b| format!("{b:02x}")).collect::<String>()),
            }),
        };
        serde_json::to_vec(&v).unwrap_or_default()
    }

    pub(crate) fn decode(bytes: &[u8]) -> Option<IndexState> {
        let v: Value = serde_json::from_slice(bytes).ok()?;
        let fingerprint = || v["fingerprint"].as_str().map(str::to_owned);
        let after = match &v["after"] {
            Value::String(hex) => Some(decode_hex(hex)?),
            _ => None,
        };
        match v["state"].as_str()? {
            "building" => Some(IndexState::Building {
                fingerprint: fingerprint()?,
                after,
            }),
            "dropping" => Some(IndexState::Dropping {
                fingerprint: fingerprint()?,
                after,
            }),
            "ready" => Some(IndexState::Ready {
                fingerprint: fingerprint()?,
            }),
            _ => None,
        }
    }

    pub(crate) fn fingerprint(&self) -> &str {
        match self {
            IndexState::Building { fingerprint, .. }
            | IndexState::Ready { fingerprint }
            | IndexState::Dropping { fingerprint, .. } => fingerprint,
        }
    }
}

fn decode_hex(hex: &str) -> Option<Vec<u8>> {
    if !hex.len().is_multiple_of(2) {
        return None;
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok())
        .collect()
}

/// What an index is doing, as reported by [`crate::Engine::indexes`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexStatus {
    pub name: String,
    /// `building`, `ready`, or `dropping` (stored but no longer configured,
    /// or redefined: its old entries are being deleted).
    pub state: &'static str,
}

/// One entry of [`crate::Engine::index_scan`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexEntry {
    /// The indexed key.
    pub key: Vec<u8>,
    /// Where the entry sits in the index; pass it back as `after` to
    /// continue a scan. Opaque.
    pub position: Vec<u8>,
}

/// The result of one [`crate::Engine::index_step_at`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct IndexStep {
    /// The version the step committed at.
    pub version: u64,
    /// The step did index work; call again until it reports none.
    pub worked: bool,
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn equal_numbers_encode_the_same() {
        for (a, b) in [
            (json!(1), json!(1.0)),
            (json!(10000000000000000000u64), json!(1e19)),
            (json!(-3), json!(-3.0)),
        ] {
            assert_eq!(encode_ordered(&a), encode_ordered(&b), "{a} {b}");
        }
        assert_eq!(encode_ordered(&json!(0)), encode_ordered(&json!(-0.0)));
        assert_ne!(encode_ordered(&json!(1)), encode_ordered(&json!("1")));
        assert_ne!(encode_ordered(&json!(1.5)), encode_ordered(&json!(1)));
        assert_eq!(encode_ordered(&json!([1])), None);
    }

    #[test]
    fn encoding_preserves_order_and_splits_back() {
        let ordered = [
            json!(null),
            json!(false),
            json!(true),
            json!(-1e300),
            json!(-2),
            json!(-0.5),
            json!(0),
            json!(0.25),
            json!(3),
            json!(1e300),
            json!(""),
            json!("a"),
            json!("a\u{0}"),
            json!("a\u{0}b"),
            json!("ab"),
            json!("b"),
        ];
        for spec in [
            IndexSpec::new("i", "", "f").expect("spec"),
            IndexSpec::new("i", "", "f").expect("spec").descending(),
        ] {
            let encoded: Vec<Vec<u8>> = ordered
                .iter()
                .map(|v| spec.encode(v).expect("scalar"))
                .collect();
            for pair in encoded.windows(2) {
                if spec.descending {
                    assert!(pair[0] > pair[1], "{pair:?}");
                } else {
                    assert!(pair[0] < pair[1], "{pair:?}");
                }
            }
            for e in &encoded {
                let suffix = [e.as_slice(), b"key/1"].concat();
                assert_eq!(
                    spec.split_suffix(&suffix),
                    Some((e.as_slice(), &b"key/1"[..]))
                );
            }
        }
    }

    #[test]
    fn entry_keys_group_by_value_then_key() {
        let spec = IndexSpec::new("by_status", "orders/", "meta.status").expect("spec");
        let a = spec
            .entry_key(b"orders/2", br#"{"meta":{"status":"paid"}}"#)
            .expect("indexed");
        let b = spec
            .entry_key(b"orders/1", br#"{"meta":{"status":"paid"}}"#)
            .expect("indexed");
        let prefix = spec.value_prefix(&json!("paid")).expect("scalar");
        assert!(a.starts_with(&prefix) && b.starts_with(&prefix));
        assert!(b < a);
        assert_eq!(spec.entry_key(b"orders/3", br#"{"meta":{}}"#), None);
        assert_eq!(spec.entry_key(b"orders/3", b"not json"), None);
        assert!(spec.covers(b"orders/3") && !spec.covers(b"users/3"));
    }

    #[test]
    fn states_round_trip() {
        for s in [
            IndexState::Building {
                fingerprint: "f".into(),
                after: Some(vec![0, 255, 7]),
            },
            IndexState::Building {
                fingerprint: "f".into(),
                after: None,
            },
            IndexState::Ready {
                fingerprint: "g".into(),
            },
            IndexState::Dropping {
                fingerprint: "h".into(),
                after: Some(vec![1]),
            },
        ] {
            assert_eq!(IndexState::decode(&s.encode()), Some(s));
        }
    }

    #[test]
    fn names_and_fields_are_validated() {
        assert!(IndexSpec::new("Bad Name", "", "a").is_err());
        assert!(IndexSpec::new("_x", "", "a").is_err());
        let a = IndexSpec::new("i", "a/", "f").expect("spec");
        let b = IndexSpec::new("i", "b/", "f").expect("spec");
        assert_ne!(a.physical_prefix(), b.physical_prefix());
        assert!(IndexSpec::new("ok", "", "a..b").is_err());
        assert!(IndexSpec::new("ok", "", "").is_err());
        assert!(IndexSpec::new("ok_1-x", "", "a.b").is_ok());
    }
}
