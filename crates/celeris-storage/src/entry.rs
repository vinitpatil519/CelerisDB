//! The internal record stored in the WAL, memtable and SSTables.

use celeris_core::MutationId;

use crate::codec::{DecodeError, Decoder, put_bytes, put_u8, put_u64};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum EntryKind {
    Put,
    Delete,
}

impl EntryKind {
    fn tag(self) -> u8 {
        match self {
            EntryKind::Put => 1,
            EntryKind::Delete => 2,
        }
    }

    fn from_tag(tag: u8) -> Result<Self, DecodeError> {
        match tag {
            1 => Ok(EntryKind::Put),
            2 => Ok(EntryKind::Delete),
            _ => Err(DecodeError("unknown entry kind")),
        }
    }
}

/// One version of one key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct Entry {
    pub key: Vec<u8>,
    /// Commit sequence number of the batch that wrote this entry.
    pub seq: u64,
    pub kind: EntryKind,
    /// Wall-clock write time; drives tombstone retention.
    pub timestamp_ms: u64,
    pub expires_at_ms: Option<u64>,
    pub mutation_id: MutationId,
    /// Empty for tombstones.
    pub value: Vec<u8>,
}

/// Fixed-size part of the encoding: kind + seq + timestamp + expiry + id + two length prefixes.
const FIXED_LEN: usize = 1 + 8 + 8 + 8 + 16 + 4 + 4;

impl Entry {
    pub(crate) fn encode(&self, out: &mut Vec<u8>) {
        put_u8(out, self.kind.tag());
        put_u64(out, self.seq);
        put_u64(out, self.timestamp_ms);
        put_u64(out, self.expires_at_ms.unwrap_or(0));
        out.extend_from_slice(&self.mutation_id.to_bytes());
        put_bytes(out, &self.key);
        put_bytes(out, &self.value);
    }

    pub(crate) fn decode(d: &mut Decoder<'_>) -> Result<Self, DecodeError> {
        let kind = EntryKind::from_tag(d.u8()?)?;
        let seq = d.u64()?;
        let timestamp_ms = d.u64()?;
        let expires = d.u64()?;
        let mutation_id = MutationId::from_bytes(d.bytes16()?);
        let key = d.bytes()?.to_vec();
        let value = d.bytes()?.to_vec();
        if key.is_empty() {
            return Err(DecodeError("empty key"));
        }
        if kind == EntryKind::Delete && !value.is_empty() {
            return Err(DecodeError("tombstone with a value"));
        }
        Ok(Entry {
            key,
            seq,
            kind,
            timestamp_ms,
            expires_at_ms: (expires != 0).then_some(expires),
            mutation_id,
            value,
        })
    }

    pub(crate) fn encoded_len(&self) -> usize {
        FIXED_LEN + self.key.len() + self.value.len()
    }

    /// A live entry is a put that has not expired at `now_ms`.
    pub(crate) fn is_live_at(&self, now_ms: u64) -> bool {
        self.kind == EntryKind::Put && self.expires_at_ms.is_none_or(|t| t > now_ms)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Entry {
        Entry {
            key: b"users/42".to_vec(),
            seq: 9,
            kind: EntryKind::Put,
            timestamp_ms: 1_700_000_000_000,
            expires_at_ms: Some(1_700_000_060_000),
            mutation_id: MutationId::from_u128(42),
            value: b"{\"name\":\"Ada\"}".to_vec(),
        }
    }

    #[test]
    fn round_trip() {
        let e = sample();
        let mut buf = Vec::new();
        e.encode(&mut buf);
        assert_eq!(buf.len(), e.encoded_len());
        let decoded = Entry::decode(&mut Decoder::new(&buf)).expect("decode");
        assert_eq!(decoded, e);
    }

    #[test]
    fn liveness() {
        let e = sample();
        assert!(e.is_live_at(1_700_000_000_000));
        assert!(!e.is_live_at(1_700_000_060_000));
        let tomb = Entry {
            kind: EntryKind::Delete,
            value: vec![],
            expires_at_ms: None,
            ..e
        };
        assert!(!tomb.is_live_at(0));
    }

    #[test]
    fn rejects_unknown_kind() {
        let mut buf = Vec::new();
        sample().encode(&mut buf);
        buf[0] = 99;
        assert!(Entry::decode(&mut Decoder::new(&buf)).is_err());
    }
}
