//! Immutable sorted table files.
//!
//! Layout (integers little-endian):
//!
//! ```text
//! data block*  : entry* | crc32(entries) u32          (~block_size bytes each)
//! index block  : count u32 | (last_key bytes | offset u64 | len u32)* | crc32 u32
//! bloom block  : k u8 | bit array | crc32 u32
//! footer (64B) : index_offset u64 | index_len u64 | bloom_offset u64 | bloom_len u64
//!                | entry_count u64 | max_seq u64 | format version u32
//!                | crc32(previous 52 bytes) u32 | magic "CELRSSST"
//! ```
//!
//! Each table holds at most one version per key, sorted by key. The index is
//! sparse: one entry per data block, keyed by the block's last key.

use std::fs::{self, File, OpenOptions};
use std::io::{BufWriter, Write};
use std::ops::Bound;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use tracing::warn;

use crate::bloom::{BloomFilter, hash_key};
use crate::cache::{Block, BlockCache};
use crate::codec::{DecodeError, Decoder, put_bytes, put_u32, put_u64};
use crate::entry::Entry;
use crate::error::{Result, StorageError, corruption, io_err};
use crate::fsutil;
use crate::iter::{after_start, before_end};
use crate::manifest::TableMeta;
use crate::metrics::{Metrics, inc};

const TABLE_MAGIC: &[u8; 8] = b"CELRSSST";
/// Current SSTable format version.
pub const TABLE_FORMAT_VERSION: u32 = 1;
const FOOTER_LEN: usize = 64;

#[derive(Debug, Clone)]
struct IndexEntry {
    last_key: Vec<u8>,
    offset: u64,
    len: u32,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Footer {
    index_offset: u64,
    index_len: u64,
    bloom_offset: u64,
    bloom_len: u64,
    entries: u64,
    max_seq: u64,
}

impl Footer {
    fn encode(&self) -> Vec<u8> {
        let mut b = Vec::with_capacity(FOOTER_LEN);
        for v in [
            self.index_offset,
            self.index_len,
            self.bloom_offset,
            self.bloom_len,
            self.entries,
            self.max_seq,
        ] {
            put_u64(&mut b, v);
        }
        put_u32(&mut b, TABLE_FORMAT_VERSION);
        let crc = crc32fast::hash(&b);
        put_u32(&mut b, crc);
        b.extend_from_slice(TABLE_MAGIC);
        b
    }

    fn decode(path: &Path, buf: &[u8; FOOTER_LEN]) -> Result<Self> {
        if &buf[56..64] != TABLE_MAGIC {
            return Err(corruption(path, "bad table magic number"));
        }
        let crc = u32::from_le_bytes([buf[52], buf[53], buf[54], buf[55]]);
        if crc32fast::hash(&buf[..52]) != crc {
            return Err(corruption(path, "footer checksum mismatch"));
        }
        let version = u32::from_le_bytes([buf[48], buf[49], buf[50], buf[51]]);
        if version != TABLE_FORMAT_VERSION {
            return Err(StorageError::UnsupportedFormat {
                what: "SSTable",
                found: version,
                supported: TABLE_FORMAT_VERSION,
            });
        }
        let mut d = Decoder::new(&buf[..48]);
        let mut next = || {
            d.u64()
                .map_err(|e| corruption(path, format!("footer: {e}")))
        };
        Ok(Footer {
            index_offset: next()?,
            index_len: next()?,
            bloom_offset: next()?,
            bloom_len: next()?,
            entries: next()?,
            max_seq: next()?,
        })
    }
}

fn append_crc(buf: &mut Vec<u8>) {
    let crc = crc32fast::hash(buf);
    buf.extend_from_slice(&crc.to_le_bytes());
}

/// Writes a table to `<id>.sst.tmp`, then fsyncs and renames it into place.
/// Dropping an unfinished builder deletes the temp file.
#[derive(Debug)]
pub(crate) struct TableBuilder {
    id: u64,
    level: u8,
    dir: PathBuf,
    tmp_path: PathBuf,
    file: Option<BufWriter<File>>,
    block_size: usize,
    bits_per_key: usize,
    block: Vec<u8>,
    index: Vec<IndexEntry>,
    hashes: Vec<u64>,
    offset: u64,
    entries: u64,
    max_seq: u64,
    min_key: Option<Vec<u8>>,
    last_key: Option<Vec<u8>>,
    finished: bool,
}

impl TableBuilder {
    pub(crate) fn create(
        dir: &Path,
        id: u64,
        level: u8,
        block_size: usize,
        bits_per_key: usize,
    ) -> Result<Self> {
        let tmp_path = fsutil::table_tmp_path(dir, id);
        let file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&tmp_path)
            .map_err(io_err(&tmp_path))?;
        Ok(TableBuilder {
            id,
            level,
            dir: dir.to_path_buf(),
            tmp_path,
            file: Some(BufWriter::with_capacity(64 * 1024, file)),
            block_size,
            bits_per_key,
            block: Vec::with_capacity(block_size + 1024),
            index: Vec::new(),
            hashes: Vec::new(),
            offset: 0,
            entries: 0,
            max_seq: 0,
            min_key: None,
            last_key: None,
            finished: false,
        })
    }

    /// Adds an entry. Keys must be strictly increasing.
    pub(crate) fn add(&mut self, entry: &Entry) -> Result<()> {
        if self
            .last_key
            .as_deref()
            .is_some_and(|last| entry.key.as_slice() <= last)
        {
            return Err(StorageError::Internal(format!(
                "table {}: keys added out of order",
                self.id
            )));
        }
        if self.min_key.is_none() {
            self.min_key = Some(entry.key.clone());
        }
        entry.encode(&mut self.block);
        self.hashes.push(hash_key(&entry.key));
        self.entries += 1;
        self.max_seq = self.max_seq.max(entry.seq);
        self.last_key = Some(entry.key.clone());
        if self.block.len() >= self.block_size {
            self.finish_block()?;
        }
        Ok(())
    }

    pub(crate) fn estimated_size(&self) -> u64 {
        self.offset + self.block.len() as u64
    }

    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        let path = &self.tmp_path;
        let file = self
            .file
            .as_mut()
            .ok_or_else(|| StorageError::Internal("table builder already finished".into()))?;
        file.write_all(bytes).map_err(io_err(path))?;
        self.offset += bytes.len() as u64;
        Ok(())
    }

    fn finish_block(&mut self) -> Result<()> {
        if self.block.is_empty() {
            return Ok(());
        }
        let mut block = std::mem::take(&mut self.block);
        append_crc(&mut block);
        let offset = self.offset;
        self.write(&block)?;
        self.index.push(IndexEntry {
            last_key: self.last_key.clone().unwrap_or_default(),
            offset,
            len: block.len() as u32,
        });
        block.clear();
        self.block = block;
        Ok(())
    }

    /// Writes index, bloom filter and footer, makes the file durable and
    /// renames it to its final name.
    pub(crate) fn finish(mut self) -> Result<TableMeta> {
        self.finish_block()?;
        let (Some(min_key), Some(max_key)) = (self.min_key.clone(), self.last_key.clone()) else {
            return Err(StorageError::Internal(
                "cannot finish an empty table".into(),
            ));
        };

        let index_offset = self.offset;
        let mut index = Vec::new();
        put_u32(&mut index, self.index.len() as u32);
        for ie in &self.index {
            put_bytes(&mut index, &ie.last_key);
            put_u64(&mut index, ie.offset);
            put_u32(&mut index, ie.len);
        }
        append_crc(&mut index);
        self.write(&index)?;

        let bloom_offset = self.offset;
        let mut bloom = Vec::new();
        BloomFilter::build(&self.hashes, self.bits_per_key).encode(&mut bloom);
        append_crc(&mut bloom);
        self.write(&bloom)?;

        let footer = Footer {
            index_offset,
            index_len: index.len() as u64,
            bloom_offset,
            bloom_len: bloom.len() as u64,
            entries: self.entries,
            max_seq: self.max_seq,
        };
        self.write(&footer.encode())?;

        let writer = self
            .file
            .take()
            .ok_or_else(|| StorageError::Internal("table builder already finished".into()))?;
        let file = writer
            .into_inner()
            .map_err(|e| io_err(&self.tmp_path)(e.into_error()))?;
        file.sync_all().map_err(io_err(&self.tmp_path))?;
        drop(file);

        let final_path = fsutil::table_path(&self.dir, self.id);
        fs::rename(&self.tmp_path, &final_path).map_err(io_err(&final_path))?;
        self.finished = true;
        fsutil::sync_dir(&self.dir).map_err(io_err(&self.dir))?;

        Ok(TableMeta {
            id: self.id,
            level: self.level,
            min_key,
            max_key,
            size: self.offset,
            entries: self.entries,
            max_seq: self.max_seq,
        })
    }
}

impl Drop for TableBuilder {
    fn drop(&mut self) {
        if !self.finished {
            drop(self.file.take());
            let _ = fs::remove_file(&self.tmp_path);
        }
    }
}

/// An open, read-only SSTable. Index and bloom filter are held in memory;
/// data blocks are read on demand through the block cache.
#[derive(Debug)]
pub(crate) struct SsTable {
    pub(crate) meta: TableMeta,
    path: PathBuf,
    file: Option<File>,
    index: Vec<IndexEntry>,
    bloom: BloomFilter,
    cache: Arc<BlockCache>,
    metrics: Arc<Metrics>,
    obsolete: AtomicBool,
}

fn read_checked(file: &File, path: &Path, offset: u64, len: u64, what: &str) -> Result<Vec<u8>> {
    if len < 4 {
        return Err(corruption(path, format!("{what} too short")));
    }
    let mut buf = vec![0u8; len as usize];
    fsutil::read_exact_at(file, &mut buf, offset).map_err(io_err(path))?;
    let body_len = buf.len() - 4;
    let stored = u32::from_le_bytes([
        buf[body_len],
        buf[body_len + 1],
        buf[body_len + 2],
        buf[body_len + 3],
    ]);
    if crc32fast::hash(&buf[..body_len]) != stored {
        return Err(corruption(
            path,
            format!("{what} at offset {offset}: checksum mismatch"),
        ));
    }
    buf.truncate(body_len);
    Ok(buf)
}

fn decode_index(body: &[u8]) -> Result<Vec<IndexEntry>, DecodeError> {
    let mut d = Decoder::new(body);
    let count = d.u32()? as usize;
    let mut index = Vec::with_capacity(count.min(1 << 16));
    for _ in 0..count {
        index.push(IndexEntry {
            last_key: d.bytes()?.to_vec(),
            offset: d.u64()?,
            len: d.u32()?,
        });
    }
    if !d.is_empty() {
        return Err(DecodeError("trailing bytes after index"));
    }
    Ok(index)
}

impl SsTable {
    pub(crate) fn open(
        dir: &Path,
        meta: TableMeta,
        cache: Arc<BlockCache>,
        metrics: Arc<Metrics>,
    ) -> Result<Self> {
        let path = fsutil::table_path(dir, meta.id);
        let file = File::open(&path).map_err(io_err(&path))?;
        let len = file.metadata().map_err(io_err(&path))?.len();
        if len < FOOTER_LEN as u64 {
            return Err(corruption(&path, "file is shorter than the footer"));
        }
        let data_end = len - FOOTER_LEN as u64;
        let mut fbuf = [0u8; FOOTER_LEN];
        fsutil::read_exact_at(&file, &mut fbuf, data_end).map_err(io_err(&path))?;
        let footer = Footer::decode(&path, &fbuf)?;

        let in_bounds = |off: u64, l: u64, end: u64| off.checked_add(l).is_some_and(|e| e <= end);
        if !in_bounds(footer.index_offset, footer.index_len, data_end)
            || !in_bounds(footer.bloom_offset, footer.bloom_len, data_end)
        {
            return Err(corruption(&path, "footer offsets out of range"));
        }
        let index_body = read_checked(
            &file,
            &path,
            footer.index_offset,
            footer.index_len,
            "index block",
        )?;
        let index = decode_index(&index_body)
            .map_err(|e| corruption(&path, format!("index block: {e}")))?;
        if index.is_empty()
            || index
                .iter()
                .any(|ie| !in_bounds(ie.offset, u64::from(ie.len), footer.index_offset))
        {
            return Err(corruption(&path, "index entries out of range"));
        }
        let bloom_body = read_checked(
            &file,
            &path,
            footer.bloom_offset,
            footer.bloom_len,
            "bloom block",
        )?;
        let bloom = BloomFilter::decode(&bloom_body)
            .map_err(|e| corruption(&path, format!("bloom block: {e}")))?;
        if footer.entries != meta.entries || len != meta.size {
            return Err(corruption(&path, "table does not match manifest metadata"));
        }
        Ok(SsTable {
            meta,
            path,
            file: Some(file),
            index,
            bloom,
            cache,
            metrics,
            obsolete: AtomicBool::new(false),
        })
    }

    pub(crate) fn get(&self, key: &[u8]) -> Result<Option<Entry>> {
        if !self.bloom.may_contain(key) {
            inc(&self.metrics.bloom_negatives);
            return Ok(None);
        }
        let idx = self.index.partition_point(|b| b.last_key.as_slice() < key);
        if idx >= self.index.len() {
            return Ok(None);
        }
        let block = self.read_block(idx, true)?;
        Ok(block
            .binary_search_by(|e| e.key.as_slice().cmp(key))
            .ok()
            .map(|i| block[i].clone()))
    }

    fn read_block(&self, idx: usize, use_cache: bool) -> Result<Block> {
        if use_cache {
            if let Some(block) = self.cache.get(self.meta.id, idx) {
                inc(&self.metrics.block_cache_hits);
                return Ok(block);
            }
            inc(&self.metrics.block_cache_misses);
        }
        let ie = &self.index[idx];
        let file = self
            .file
            .as_ref()
            .ok_or_else(|| StorageError::Internal("table file already closed".into()))?;
        let body = read_checked(file, &self.path, ie.offset, u64::from(ie.len), "data block")?;
        let mut d = Decoder::new(&body);
        let mut entries: Vec<Entry> = Vec::new();
        while !d.is_empty() {
            let e = Entry::decode(&mut d)
                .map_err(|err| corruption(&self.path, format!("data block {idx}: {err}")))?;
            if entries.last().is_some_and(|prev| prev.key >= e.key) {
                return Err(corruption(
                    &self.path,
                    format!("data block {idx}: keys out of order"),
                ));
            }
            entries.push(e);
        }
        if entries.last().map(|e| e.key.as_slice()) != Some(ie.last_key.as_slice()) {
            return Err(corruption(
                &self.path,
                format!("data block {idx}: does not match index"),
            ));
        }
        let block: Block = Arc::new(entries);
        if use_cache {
            self.cache
                .insert(self.meta.id, idx, Arc::clone(&block), body.len());
        }
        Ok(block)
    }

    /// The table has been replaced by compaction. Its file is deleted once
    /// the last reader drops its handle.
    pub(crate) fn mark_obsolete(&self) {
        self.obsolete.store(true, Ordering::SeqCst);
    }
}

impl Drop for SsTable {
    fn drop(&mut self) {
        if self.obsolete.load(Ordering::SeqCst) {
            drop(self.file.take());
            if let Err(e) = fs::remove_file(&self.path) {
                warn!(path = %self.path.display(), error = %e, "failed to delete obsolete table; it will be removed at next startup");
            }
        }
    }
}

/// Iterates a table's entries within a key range, loading blocks lazily.
pub(crate) struct TableIter {
    table: Arc<SsTable>,
    next_block: usize,
    block: Option<Block>,
    pos: usize,
    start: Bound<Vec<u8>>,
    end: Bound<Vec<u8>>,
    use_cache: bool,
    done: bool,
}

impl TableIter {
    pub(crate) fn new(
        table: Arc<SsTable>,
        start: Bound<Vec<u8>>,
        end: Bound<Vec<u8>>,
        use_cache: bool,
    ) -> Self {
        let next_block = match &start {
            Bound::Unbounded => 0,
            Bound::Included(k) | Bound::Excluded(k) => table
                .index
                .partition_point(|b| b.last_key.as_slice() < k.as_slice()),
        };
        TableIter {
            table,
            next_block,
            block: None,
            pos: 0,
            start,
            end,
            use_cache,
            done: false,
        }
    }
}

impl Iterator for TableIter {
    type Item = Result<Entry>;

    fn next(&mut self) -> Option<Self::Item> {
        loop {
            if self.done {
                return None;
            }
            if let Some(block) = &self.block {
                if let Some(e) = block.get(self.pos) {
                    self.pos += 1;
                    if !after_start(&e.key, &self.start) {
                        continue;
                    }
                    if !before_end(&e.key, &self.end) {
                        self.done = true;
                        return None;
                    }
                    return Some(Ok(e.clone()));
                }
                self.block = None;
            }
            if self.next_block >= self.table.index.len() {
                self.done = true;
                return None;
            }
            match self.table.read_block(self.next_block, self.use_cache) {
                Ok(block) => {
                    self.block = Some(block);
                    self.pos = 0;
                    self.next_block += 1;
                }
                Err(e) => {
                    self.done = true;
                    return Some(Err(e));
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use celeris_core::MutationId;

    use super::*;
    use crate::entry::EntryKind;

    fn entry(i: u32) -> Entry {
        Entry {
            key: format!("key{i:05}").into_bytes(),
            seq: u64::from(i) + 1,
            kind: if i.is_multiple_of(7) {
                EntryKind::Delete
            } else {
                EntryKind::Put
            },
            timestamp_ms: 5,
            expires_at_ms: None,
            mutation_id: MutationId::from_u128(u128::from(i)),
            value: if i.is_multiple_of(7) {
                vec![]
            } else {
                vec![b'x'; (i % 50) as usize]
            },
        }
    }

    fn build(dir: &Path, n: u32) -> Arc<SsTable> {
        let mut b = TableBuilder::create(dir, 1, 0, 256, 10).expect("create");
        for i in 0..n {
            b.add(&entry(i)).expect("add");
        }
        let meta = b.finish().expect("finish");
        assert_eq!(meta.entries, u64::from(n));
        Arc::new(
            SsTable::open(
                dir,
                meta,
                Arc::new(BlockCache::new(1 << 20)),
                Arc::new(Metrics::default()),
            )
            .expect("open"),
        )
    }

    #[test]
    fn point_lookups_find_every_key_and_nothing_else() {
        let dir = tempfile::tempdir().expect("tempdir");
        let t = build(dir.path(), 500);
        assert!(t.index.len() > 10, "small block size yields many blocks");
        for i in 0..500 {
            assert_eq!(t.get(&entry(i).key).expect("get"), Some(entry(i)));
        }
        assert_eq!(t.get(b"key99999").expect("get"), None);
        assert_eq!(t.get(b"a").expect("get"), None);
        assert!(!dir.path().join("00000000000000000001.sst.tmp").exists());
    }

    #[test]
    fn range_iteration_respects_bounds() {
        let dir = tempfile::tempdir().expect("tempdir");
        let t = build(dir.path(), 300);
        let keys = |s, e| -> Vec<Entry> {
            TableIter::new(Arc::clone(&t), s, e, false)
                .collect::<Result<_>>()
                .expect("iter")
        };
        assert_eq!(keys(Bound::Unbounded, Bound::Unbounded).len(), 300);
        let mid = keys(
            Bound::Included(entry(100).key),
            Bound::Excluded(entry(150).key),
        );
        assert_eq!(mid, (100..150).map(entry).collect::<Vec<_>>());
        let open = keys(Bound::Excluded(entry(298).key), Bound::Unbounded);
        assert_eq!(open, vec![entry(299)]);
    }

    #[test]
    fn rejects_out_of_order_keys() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut b = TableBuilder::create(dir.path(), 1, 0, 256, 10).expect("create");
        b.add(&entry(2)).expect("add");
        assert!(b.add(&entry(1)).is_err());
        assert!(b.add(&entry(2)).is_err());
    }

    #[test]
    fn abandoned_builder_removes_temp_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut b = TableBuilder::create(dir.path(), 9, 0, 256, 10).expect("create");
        b.add(&entry(1)).expect("add");
        drop(b);
        assert_eq!(fs::read_dir(dir.path()).expect("ls").count(), 0);
    }

    #[test]
    fn detects_corrupted_data_block() {
        let dir = tempfile::tempdir().expect("tempdir");
        let meta = build(dir.path(), 50).meta.clone();
        let path = fsutil::table_path(dir.path(), 1);
        let mut bytes = fs::read(&path).expect("read");
        bytes[10] ^= 0x55;
        fs::write(&path, &bytes).expect("write");
        let t = SsTable::open(
            dir.path(),
            meta,
            Arc::new(BlockCache::new(0)),
            Arc::new(Metrics::default()),
        )
        .expect("footer, index and bloom are intact");
        assert!(matches!(
            t.get(&entry(1).key),
            Err(StorageError::Corruption { .. })
        ));
    }

    #[test]
    fn detects_corrupted_footer() {
        let dir = tempfile::tempdir().expect("tempdir");
        let meta = build(dir.path(), 50).meta.clone();
        let path = fsutil::table_path(dir.path(), 1);
        let mut bytes = fs::read(&path).expect("read");
        let n = bytes.len();
        bytes[n - 20] ^= 0x01;
        fs::write(&path, &bytes).expect("write");
        let err = SsTable::open(
            dir.path(),
            meta,
            Arc::new(BlockCache::new(0)),
            Arc::new(Metrics::default()),
        )
        .expect_err("corrupt footer");
        assert!(matches!(err, StorageError::Corruption { .. }));
    }

    #[test]
    fn obsolete_table_file_is_deleted_on_last_drop() {
        let dir = tempfile::tempdir().expect("tempdir");
        let t = build(dir.path(), 10);
        let path = fsutil::table_path(dir.path(), 1);
        let reader = Arc::clone(&t);
        t.mark_obsolete();
        drop(t);
        assert!(path.exists(), "still referenced by a reader");
        drop(reader);
        assert!(!path.exists());
    }
}
