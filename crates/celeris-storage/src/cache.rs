//! Byte-bounded LRU cache of decoded SSTable data blocks.

use std::sync::Arc;

use lru::LruCache;
use parking_lot::Mutex;

use crate::entry::Entry;

/// A decoded data block: entries sorted by key.
pub(crate) type Block = Arc<Vec<Entry>>;

/// (table id, block index)
type BlockKey = (u64, usize);

#[derive(Debug)]
pub(crate) struct BlockCache {
    capacity_bytes: usize,
    inner: Mutex<Inner>,
}

#[derive(Debug)]
struct Inner {
    lru: LruCache<BlockKey, (Block, usize)>,
    bytes: usize,
}

impl BlockCache {
    /// A capacity of zero disables caching.
    pub(crate) fn new(capacity_bytes: usize) -> Self {
        BlockCache {
            capacity_bytes,
            inner: Mutex::new(Inner {
                lru: LruCache::unbounded(),
                bytes: 0,
            }),
        }
    }

    pub(crate) fn get(&self, table_id: u64, block: usize) -> Option<Block> {
        self.inner
            .lock()
            .lru
            .get(&(table_id, block))
            .map(|(b, _)| Arc::clone(b))
    }

    pub(crate) fn insert(&self, table_id: u64, block_idx: usize, block: Block, charge: usize) {
        if charge > self.capacity_bytes {
            return;
        }
        let mut inner = self.inner.lock();
        if let Some((_, old)) = inner.lru.put((table_id, block_idx), (block, charge)) {
            inner.bytes -= old;
        }
        inner.bytes += charge;
        while inner.bytes > self.capacity_bytes {
            match inner.lru.pop_lru() {
                Some((_, (_, c))) => inner.bytes -= c,
                None => break,
            }
        }
    }

    #[cfg(test)]
    fn used_bytes(&self) -> usize {
        self.inner.lock().bytes
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn evicts_least_recently_used_to_stay_within_capacity() {
        let cache = BlockCache::new(100);
        let block: Block = Arc::new(Vec::new());
        cache.insert(1, 0, Arc::clone(&block), 40);
        cache.insert(1, 1, Arc::clone(&block), 40);
        assert!(cache.get(1, 0).is_some()); // 1/0 is now most recent
        cache.insert(1, 2, Arc::clone(&block), 40);
        assert!(cache.get(1, 1).is_none(), "LRU entry evicted");
        assert!(cache.get(1, 0).is_some());
        assert!(cache.used_bytes() <= 100);
    }

    #[test]
    fn zero_capacity_disables_cache() {
        let cache = BlockCache::new(0);
        cache.insert(1, 0, Arc::new(Vec::new()), 1);
        assert!(cache.get(1, 0).is_none());
    }
}
