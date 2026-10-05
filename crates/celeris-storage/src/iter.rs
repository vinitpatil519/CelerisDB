//! Range iteration: per-source iterators and the newest-version-wins merge.

use std::ops::Bound;
use std::sync::Arc;

use crate::entry::Entry;
use crate::error::{Result, StorageError};
use crate::memtable::MemSlot;

pub(crate) type EntryIter = Box<dyn Iterator<Item = Result<Entry>> + Send>;

/// True when no key can satisfy both bounds. `BTreeMap::range` panics on some
/// of these shapes, so callers check first.
pub(crate) fn bounds_empty(start: Bound<&[u8]>, end: Bound<&[u8]>) -> bool {
    use Bound::{Excluded, Included};
    match (start, end) {
        (Included(s), Included(e)) => s > e,
        (Included(s), Excluded(e)) | (Excluded(s), Included(e)) | (Excluded(s), Excluded(e)) => {
            s >= e
        }
        _ => false,
    }
}

pub(crate) fn after_start(key: &[u8], start: &Bound<Vec<u8>>) -> bool {
    match start {
        Bound::Included(s) => key >= s.as_slice(),
        Bound::Excluded(s) => key > s.as_slice(),
        Bound::Unbounded => true,
    }
}

pub(crate) fn before_end(key: &[u8], end: &Bound<Vec<u8>>) -> bool {
    match end {
        Bound::Included(e) => key <= e.as_slice(),
        Bound::Excluded(e) => key < e.as_slice(),
        Bound::Unbounded => true,
    }
}

pub(crate) fn as_slice_bound(b: &Bound<Vec<u8>>) -> Bound<&[u8]> {
    b.as_ref().map(Vec::as_slice)
}

/// Walks a memtable one key at a time, re-taking the read lock per step so a
/// long scan never blocks writers.
pub(crate) struct MemIter {
    slot: Arc<MemSlot>,
    cursor: Bound<Vec<u8>>,
    end: Bound<Vec<u8>>,
    done: bool,
}

impl MemIter {
    pub(crate) fn new(slot: Arc<MemSlot>, start: Bound<Vec<u8>>, end: Bound<Vec<u8>>) -> Self {
        MemIter {
            slot,
            cursor: start,
            end,
            done: false,
        }
    }
}

impl Iterator for MemIter {
    type Item = Result<Entry>;

    fn next(&mut self) -> Option<Self::Item> {
        if self.done {
            return None;
        }
        let next = self
            .slot
            .table
            .read()
            .first_in_range(as_slice_bound(&self.cursor), as_slice_bound(&self.end))
            .cloned();
        match next {
            Some(entry) => {
                self.cursor = Bound::Excluded(entry.key.clone());
                Some(Ok(entry))
            }
            None => {
                self.done = true;
                None
            }
        }
    }
}

/// Merges sorted sources, yielding each key once with its highest-sequence
/// version. Every source must yield strictly increasing keys. Tombstones and
/// expired entries are yielded; callers decide visibility.
pub(crate) struct MergeIter {
    sources: Vec<EntryIter>,
    heads: Vec<Option<Entry>>,
    error: Option<StorageError>,
}

fn pull(source: &mut EntryIter, error: &mut Option<StorageError>) -> Option<Entry> {
    match source.next() {
        Some(Ok(e)) => Some(e),
        Some(Err(e)) => {
            error.get_or_insert(e);
            None
        }
        None => None,
    }
}

impl MergeIter {
    pub(crate) fn new(mut sources: Vec<EntryIter>) -> Self {
        let mut error = None;
        let heads = sources.iter_mut().map(|s| pull(s, &mut error)).collect();
        MergeIter {
            sources,
            heads,
            error,
        }
    }
}

impl Iterator for MergeIter {
    type Item = Result<Entry>;

    fn next(&mut self) -> Option<Self::Item> {
        // A failed source may be hiding newer versions; stop rather than
        // yield possibly stale data.
        if let Some(e) = self.error.take() {
            self.heads.iter_mut().for_each(|h| *h = None);
            return Some(Err(e));
        }
        let mut best: Option<usize> = None;
        for (i, head) in self.heads.iter().enumerate() {
            let Some(e) = head else { continue };
            let better = match best.and_then(|b| self.heads[b].as_ref()) {
                None => true,
                Some(be) => e.key < be.key || (e.key == be.key && e.seq > be.seq),
            };
            if better {
                best = Some(i);
            }
        }
        let b = best?;
        let winner = self.heads[b].take()?;
        self.heads[b] = pull(&mut self.sources[b], &mut self.error);
        // Drop older versions of the same key from the other sources.
        for i in 0..self.heads.len() {
            while self.heads[i].as_ref().is_some_and(|e| e.key == winner.key) {
                self.heads[i] = pull(&mut self.sources[i], &mut self.error);
            }
        }
        Some(Ok(winner))
    }
}

#[cfg(test)]
mod tests {
    use celeris_core::MutationId;

    use super::*;
    use crate::entry::EntryKind;

    fn e(key: &str, seq: u64) -> Entry {
        Entry {
            key: key.as_bytes().to_vec(),
            seq,
            kind: EntryKind::Put,
            timestamp_ms: 0,
            expires_at_ms: None,
            mutation_id: MutationId::from_u128(0),
            value: seq.to_string().into_bytes(),
        }
    }

    fn src(entries: Vec<Entry>) -> EntryIter {
        Box::new(entries.into_iter().map(Ok))
    }

    #[test]
    fn newest_version_wins_and_keys_are_unique() {
        let merged: Vec<_> = MergeIter::new(vec![
            src(vec![e("a", 5), e("c", 7)]),
            src(vec![e("a", 1), e("b", 2), e("c", 9)]),
            src(vec![]),
        ])
        .map(|r| r.map(|e| (String::from_utf8_lossy(&e.key).into_owned(), e.seq)))
        .collect::<Result<_>>()
        .expect("merge");
        assert_eq!(
            merged,
            vec![("a".into(), 5), ("b".into(), 2), ("c".into(), 9)]
        );
    }

    #[test]
    fn source_errors_stop_iteration() {
        let failing: EntryIter = Box::new(
            vec![
                Ok(e("a", 1)),
                Err(StorageError::Internal("disk on fire".into())),
            ]
            .into_iter(),
        );
        let mut m = MergeIter::new(vec![failing, src(vec![e("b", 1), e("z", 1)])]);
        assert!(matches!(m.next(), Some(Ok(_))));
        assert!(matches!(m.next(), Some(Err(_))));
        assert!(m.next().is_none());
    }

    #[test]
    fn empty_bounds() {
        use Bound::*;
        let (a, b): (&[u8], &[u8]) = (b"a", b"b");
        assert!(bounds_empty(Included(b), Included(a)));
        assert!(bounds_empty(Excluded(a), Excluded(a)));
        assert!(bounds_empty(Included(a), Excluded(a)));
        assert!(!bounds_empty(Included(a), Included(a)));
        assert!(!bounds_empty(Unbounded, Excluded(a)));
    }
}
