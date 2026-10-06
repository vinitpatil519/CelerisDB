//! Write-ahead log.
//!
//! File layout (all integers little-endian):
//!
//! ```text
//! header : magic "CELRSWAL" (8) | format version u32 | reserved u32
//! frame* : payload length u32 | crc32(length bytes ++ payload) u32 | payload
//! payload: record type u8 (1 = batch) | entry count u32 | entry*
//! ```
//!
//! One frame holds one whole batch, so a batch is recovered entirely or not
//! at all. A frame that is short or fails its checksum marks the torn tail of
//! the log; everything before it is valid.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use crate::codec::{DecodeError, Decoder, put_u8, put_u32};
use crate::entry::Entry;
use crate::error::{Result, StorageError, corruption, io_err};
use crate::fsutil;

const WAL_MAGIC: &[u8; 8] = b"CELRSWAL";
/// Current WAL format version.
pub const WAL_FORMAT_VERSION: u32 = 1;
pub(crate) const WAL_HEADER_LEN: usize = 16;
const FRAME_HEADER_LEN: usize = 8;
/// Upper bound on one frame; anything larger is treated as a torn length field.
const MAX_RECORD_LEN: usize = 64 * 1024 * 1024;
const RECORD_BATCH: u8 = 1;

#[derive(Debug)]
pub(crate) struct WalWriter {
    path: PathBuf,
    /// Shared so a group commit can fsync without holding the writer.
    file: Arc<File>,
    sync_on_append: bool,
}

impl WalWriter {
    /// Creates a new, empty WAL file and makes its existence durable.
    pub(crate) fn create(dir: &Path, id: u64, sync_on_append: bool) -> Result<Self> {
        let path = fsutil::wal_path(dir, id);
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(io_err(&path))?;
        let mut header = Vec::with_capacity(WAL_HEADER_LEN);
        header.extend_from_slice(WAL_MAGIC);
        put_u32(&mut header, WAL_FORMAT_VERSION);
        put_u32(&mut header, 0);
        file.write_all(&header).map_err(io_err(&path))?;
        file.sync_all().map_err(io_err(&path))?;
        fsutil::sync_dir(dir).map_err(io_err(dir))?;
        Ok(WalWriter {
            path,
            file: Arc::new(file),
            sync_on_append,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    /// Appends one batch payload as a single frame. Returns bytes written.
    ///
    /// On error the file contents are unknown: the frame may be absent,
    /// partially written, or fully written but not durable.
    pub(crate) fn append(&mut self, payload: &[u8]) -> io::Result<usize> {
        let len = u32::try_from(payload.len())
            .ok()
            .filter(|&l| l as usize <= MAX_RECORD_LEN)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "WAL record too large"))?;
        let len_bytes = len.to_le_bytes();
        let mut frame = Vec::with_capacity(FRAME_HEADER_LEN + payload.len());
        frame.extend_from_slice(&len_bytes);
        frame.extend_from_slice(&frame_crc(&len_bytes, payload).to_le_bytes());
        frame.extend_from_slice(payload);
        (&*self.file).write_all(&frame)?;
        if self.sync_on_append {
            self.file.sync_data()?;
        }
        Ok(frame.len())
    }

    /// Like [`WalWriter::append`], but never syncs; the caller makes the
    /// frame durable later (group commit).
    pub(crate) fn append_unsynced(&mut self, payload: &[u8]) -> io::Result<usize> {
        let sync = std::mem::replace(&mut self.sync_on_append, false);
        let result = self.append(payload);
        self.sync_on_append = sync;
        result
    }

    /// A handle to fsync the file without holding the writer.
    pub(crate) fn handle(&self) -> Arc<File> {
        Arc::clone(&self.file)
    }

    pub(crate) fn sync(&mut self) -> io::Result<()> {
        self.file.sync_data()
    }
}

fn frame_crc(len_bytes: &[u8; 4], payload: &[u8]) -> u32 {
    let mut h = crc32fast::Hasher::new();
    h.update(len_bytes);
    h.update(payload);
    h.finalize()
}

pub(crate) fn encode_batch(entries: &[Entry]) -> Vec<u8> {
    let size = 5 + entries.iter().map(Entry::encoded_len).sum::<usize>();
    let mut out = Vec::with_capacity(size);
    put_u8(&mut out, RECORD_BATCH);
    put_u32(&mut out, entries.len() as u32);
    for e in entries {
        e.encode(&mut out);
    }
    out
}

fn decode_batch(payload: &[u8]) -> Result<Vec<Entry>, DecodeError> {
    let mut d = Decoder::new(payload);
    if d.u8()? != RECORD_BATCH {
        return Err(DecodeError("unknown WAL record type"));
    }
    let count = d.u32()? as usize;
    if count == 0 {
        return Err(DecodeError("empty batch"));
    }
    let mut entries = Vec::with_capacity(count.min(4096));
    for _ in 0..count {
        entries.push(Entry::decode(&mut d)?);
    }
    if !d.is_empty() {
        return Err(DecodeError("trailing bytes after batch"));
    }
    if entries.iter().any(|e| e.seq != entries[0].seq) {
        return Err(DecodeError("batch entries disagree on sequence number"));
    }
    Ok(entries)
}

/// Everything recoverable from one WAL file.
#[derive(Debug)]
pub(crate) struct WalContents {
    pub batches: Vec<Vec<Entry>>,
    /// Length of the valid prefix. Bytes past it are a torn tail.
    pub valid_len: u64,
    pub file_len: u64,
}

pub(crate) fn read_wal(path: &Path) -> Result<WalContents> {
    let data = fs::read(path).map_err(io_err(path))?;
    let file_len = data.len() as u64;
    if data.len() < WAL_HEADER_LEN {
        // Crash while the header was being written: nothing was ever acknowledged.
        return Ok(WalContents {
            batches: Vec::new(),
            valid_len: 0,
            file_len,
        });
    }
    if &data[..8] != WAL_MAGIC {
        return Err(corruption(path, "bad WAL magic number"));
    }
    let version = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
    if version != WAL_FORMAT_VERSION {
        return Err(StorageError::UnsupportedFormat {
            what: "WAL",
            found: version,
            supported: WAL_FORMAT_VERSION,
        });
    }

    let mut batches = Vec::new();
    let mut pos = WAL_HEADER_LEN;
    while pos < data.len() {
        let rest = &data[pos..];
        if rest.len() < FRAME_HEADER_LEN {
            break;
        }
        let len_bytes = [rest[0], rest[1], rest[2], rest[3]];
        let len = u32::from_le_bytes(len_bytes) as usize;
        let crc = u32::from_le_bytes([rest[4], rest[5], rest[6], rest[7]]);
        if len > MAX_RECORD_LEN || rest.len() - FRAME_HEADER_LEN < len {
            break;
        }
        let payload = &rest[FRAME_HEADER_LEN..FRAME_HEADER_LEN + len];
        if frame_crc(&len_bytes, payload) != crc {
            break;
        }
        // A checksummed frame that does not decode is not a torn write; it is
        // a bug or corruption that must not be skipped silently.
        let batch = decode_batch(payload).map_err(|e| {
            corruption(
                path,
                format!("record at offset {pos} has a valid checksum but cannot be decoded: {e}"),
            )
        })?;
        batches.push(batch);
        pos += FRAME_HEADER_LEN + len;
    }
    Ok(WalContents {
        batches,
        valid_len: pos as u64,
        file_len,
    })
}

/// Cuts a torn tail off a WAL so later recoveries see a clean file.
pub(crate) fn truncate(path: &Path, len: u64) -> Result<()> {
    let file = OpenOptions::new()
        .write(true)
        .open(path)
        .map_err(io_err(path))?;
    file.set_len(len).map_err(io_err(path))?;
    file.sync_all().map_err(io_err(path))
}

#[cfg(test)]
mod tests {
    use celeris_core::MutationId;

    use super::*;
    use crate::entry::EntryKind;

    fn batch(seq: u64, keys: &[&str]) -> Vec<Entry> {
        keys.iter()
            .map(|k| Entry {
                key: k.as_bytes().to_vec(),
                seq,
                kind: EntryKind::Put,
                timestamp_ms: 1,
                expires_at_ms: None,
                mutation_id: MutationId::from_u128(seq as u128),
                value: format!("v{seq}").into_bytes(),
            })
            .collect()
    }

    #[test]
    fn writes_and_reads_batches() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut w = WalWriter::create(dir.path(), 1, true).expect("create");
        w.append(&encode_batch(&batch(1, &["a", "b"])))
            .expect("append");
        w.append(&encode_batch(&batch(2, &["c"]))).expect("append");
        let c = read_wal(w.path()).expect("read");
        assert_eq!(c.batches, vec![batch(1, &["a", "b"]), batch(2, &["c"])]);
        assert_eq!(c.valid_len, c.file_len);
    }

    #[test]
    fn every_truncation_point_yields_a_batch_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut w = WalWriter::create(dir.path(), 1, false).expect("create");
        let all: Vec<_> = (1..=5).map(|s| batch(s, &["k1", "k2"])).collect();
        // ends[i] = file length after i complete frames.
        let mut ends = vec![WAL_HEADER_LEN as u64];
        for b in &all {
            let n = w.append(&encode_batch(b)).expect("append");
            let prev = ends[ends.len() - 1];
            ends.push(prev + n as u64);
        }
        let full = fs::read(w.path()).expect("read");
        for cut in 0..=full.len() {
            fs::write(w.path(), &full[..cut]).expect("write");
            let c = read_wal(w.path()).expect("torn tails are not errors");
            let complete = ends[1..].iter().filter(|&&e| e <= cut as u64).count();
            assert_eq!(c.batches, all[..complete].to_vec(), "cut at {cut}");
        }
    }

    #[test]
    fn checksum_mismatch_ends_the_valid_prefix() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut w = WalWriter::create(dir.path(), 1, false).expect("create");
        w.append(&encode_batch(&batch(1, &["a"]))).expect("append");
        let first_end = fs::metadata(w.path()).expect("meta").len();
        w.append(&encode_batch(&batch(2, &["b"]))).expect("append");
        let mut bytes = fs::read(w.path()).expect("read");
        let last = bytes.len() - 1;
        bytes[last] ^= 0xFF;
        fs::write(w.path(), &bytes).expect("write");
        let c = read_wal(w.path()).expect("read");
        assert_eq!(c.batches.len(), 1);
        assert_eq!(c.valid_len, first_end);
    }

    #[test]
    fn rejects_foreign_files_and_future_versions() {
        let dir = tempfile::tempdir().expect("tempdir");
        let path = dir.path().join("x.wal");
        fs::write(&path, b"NOTAWAL!\x01\0\0\0\0\0\0\0").expect("write");
        assert!(matches!(
            read_wal(&path),
            Err(StorageError::Corruption { .. })
        ));
        fs::write(&path, b"CELRSWAL\x09\0\0\0\0\0\0\0").expect("write");
        assert!(matches!(
            read_wal(&path),
            Err(StorageError::UnsupportedFormat { found: 9, .. })
        ));
    }
}
