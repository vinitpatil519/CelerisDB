//! In-memory sorted write buffer.

use std::collections::BTreeMap;
use std::ops::Bound;

use parking_lot::RwLock;

use crate::entry::Entry;
use crate::iter::bounds_empty;

/// Rough per-entry bookkeeping cost on top of key and value bytes.
const ENTRY_OVERHEAD: usize = 64;

/// Newest version of each key written since the last rotation.
///
/// Older versions of a key are replaced in place: within one memtable only
/// the latest committed version can ever be read.
#[derive(Debug, Default)]
pub(crate) struct Memtable {
    map: BTreeMap<Vec<u8>, Entry>,
    approx_bytes: usize,
    max_seq: u64,
}

impl Memtable {
    pub(crate) fn insert(&mut self, entry: Entry) {
        let size = entry.encoded_len() + ENTRY_OVERHEAD;
        self.max_seq = self.max_seq.max(entry.seq);
        if let Some(old) = self.map.insert(entry.key.clone(), entry) {
            self.approx_bytes -= old.encoded_len() + ENTRY_OVERHEAD;
        }
        self.approx_bytes += size;
    }

    pub(crate) fn get(&self, key: &[u8]) -> Option<&Entry> {
        self.map.get(key)
    }

    pub(crate) fn first_in_range(&self, start: Bound<&[u8]>, end: Bound<&[u8]>) -> Option<&Entry> {
        if bounds_empty(start, end) {
            return None;
        }
        self.map
            .range::<[u8], _>((start, end))
            .next()
            .map(|(_, e)| e)
    }

    pub(crate) fn iter(&self) -> impl Iterator<Item = &Entry> {
        self.map.values()
    }

    pub(crate) fn approx_bytes(&self) -> usize {
        self.approx_bytes
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.map.len()
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.map.is_empty()
    }

    pub(crate) fn max_seq(&self) -> u64 {
        self.max_seq
    }
}

/// A memtable plus the WAL files whose contents it holds. The WAL files can
/// be deleted once the memtable is durably flushed.
#[derive(Debug)]
pub(crate) struct MemSlot {
    pub table: RwLock<Memtable>,
    pub wal_ids: Vec<u64>,
}

impl MemSlot {
    pub(crate) fn new(table: Memtable, wal_ids: Vec<u64>) -> Self {
        MemSlot {
            table: RwLock::new(table),
            wal_ids,
        }
    }
}

#[cfg(test)]
mod tests {
    use celeris_core::MutationId;

    use super::*;
    use crate::entry::EntryKind;

    fn put(key: &str, seq: u64, value: &str) -> Entry {
        Entry {
            key: key.as_bytes().to_vec(),
            seq,
            kind: EntryKind::Put,
            timestamp_ms: 0,
            expires_at_ms: None,
            mutation_id: MutationId::from_u128(0),
            value: value.as_bytes().to_vec(),
        }
    }

    #[test]
    fn newer_versions_replace_older_and_size_tracks() {
        let mut m = Memtable::default();
        m.insert(put("a", 1, "xxxx"));
        let after_one = m.approx_bytes();
        m.insert(put("a", 2, "y"));
        assert_eq!(m.get(b"a").map(|e| e.seq), Some(2));
        assert_eq!(m.len(), 1);
        assert_eq!(m.approx_bytes(), after_one - 3);
        assert_eq!(m.max_seq(), 2);
    }

    #[test]
    fn range_lookup_handles_degenerate_bounds() {
        let mut m = Memtable::default();
        m.insert(put("b", 1, "v"));
        let b: &[u8] = b"b";
        assert!(
            m.first_in_range(Bound::Excluded(b), Bound::Excluded(b))
                .is_none()
        );
        assert!(
            m.first_in_range(Bound::Excluded(b), Bound::Included(b))
                .is_none()
        );
        assert!(
            m.first_in_range(Bound::Included(b"c"), Bound::Included(b))
                .is_none()
        );
        assert_eq!(
            m.first_in_range(Bound::Included(b), Bound::Included(b))
                .map(|e| e.seq),
            Some(1)
        );
    }
}
