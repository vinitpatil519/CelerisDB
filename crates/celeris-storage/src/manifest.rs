//! The manifest: the authoritative list of live SSTables.
//!
//! Layout:
//!
//! ```text
//! magic "CELRSMAN" (8) | format version u32 | body length u32 | crc32(body) u32 | JSON body
//! ```
//!
//! Updates are atomic: write `MANIFEST.tmp`, fsync, rename over `MANIFEST`,
//! fsync the directory. A crash leaves either the old or the new manifest.
//! SSTables on disk but absent from the manifest are leftovers of an
//! interrupted flush or compaction and are deleted at startup.

use std::collections::HashSet;
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::codec::put_u32;
use crate::error::{Result, StorageError, corruption, io_err};
use crate::fsutil;

const MANIFEST_FILE: &str = "MANIFEST";
const MANIFEST_TMP: &str = "MANIFEST.tmp";
const MAGIC: &[u8; 8] = b"CELRSMAN";
/// Current manifest format version.
pub const MANIFEST_FORMAT_VERSION: u32 = 1;
const HEADER_LEN: usize = 20;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct Manifest {
    /// Next unused id for WAL and table files.
    pub next_file_id: u64,
    /// Every batch with a sequence number at or below this is in an SSTable.
    pub flushed_seq: u64,
    pub tables: Vec<TableMeta>,
}

impl Default for Manifest {
    fn default() -> Self {
        Manifest {
            next_file_id: 1,
            flushed_seq: 0,
            tables: Vec::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub(crate) struct TableMeta {
    pub id: u64,
    /// 0 = flushed memtable (tables may overlap); 1 = compacted sorted run.
    pub level: u8,
    #[serde(with = "hex_bytes")]
    pub min_key: Vec<u8>,
    #[serde(with = "hex_bytes")]
    pub max_key: Vec<u8>,
    /// File size in bytes.
    pub size: u64,
    pub entries: u64,
    pub max_seq: u64,
}

impl Manifest {
    fn validate(&self, path: &Path) -> Result<()> {
        let mut ids = HashSet::new();
        for t in &self.tables {
            if !ids.insert(t.id) {
                return Err(corruption(path, format!("table {} listed twice", t.id)));
            }
            if t.level > 1 {
                return Err(corruption(
                    path,
                    format!("table {} has unknown level {}", t.id, t.level),
                ));
            }
            if t.min_key > t.max_key || t.id >= self.next_file_id {
                return Err(corruption(
                    path,
                    format!("table {} metadata is inconsistent", t.id),
                ));
            }
        }
        Ok(())
    }
}

pub(crate) fn path(dir: &Path) -> PathBuf {
    dir.join(MANIFEST_FILE)
}

/// Returns `None` for a data directory that has never been initialised.
pub(crate) fn load(dir: &Path) -> Result<Option<Manifest>> {
    let path = path(dir);
    let data = match fs::read(&path) {
        Ok(d) => d,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(io_err(&path)(e)),
    };
    if data.len() < HEADER_LEN || &data[..8] != MAGIC {
        return Err(corruption(&path, "bad manifest header"));
    }
    let word = |i: usize| u32::from_le_bytes([data[i], data[i + 1], data[i + 2], data[i + 3]]);
    let version = word(8);
    if version != MANIFEST_FORMAT_VERSION {
        return Err(StorageError::UnsupportedFormat {
            what: "MANIFEST",
            found: version,
            supported: MANIFEST_FORMAT_VERSION,
        });
    }
    let body = &data[HEADER_LEN..];
    if body.len() != word(12) as usize {
        return Err(corruption(&path, "manifest length mismatch"));
    }
    if crc32fast::hash(body) != word(16) {
        return Err(corruption(&path, "manifest checksum mismatch"));
    }
    let manifest: Manifest = serde_json::from_slice(body)
        .map_err(|e| corruption(&path, format!("manifest body: {e}")))?;
    manifest.validate(&path)?;
    Ok(Some(manifest))
}

pub(crate) fn store(dir: &Path, manifest: &Manifest) -> Result<()> {
    let body = serde_json::to_vec(manifest)
        .map_err(|e| StorageError::Internal(format!("serialize manifest: {e}")))?;
    let mut buf = Vec::with_capacity(HEADER_LEN + body.len());
    buf.extend_from_slice(MAGIC);
    put_u32(&mut buf, MANIFEST_FORMAT_VERSION);
    put_u32(&mut buf, body.len() as u32);
    put_u32(&mut buf, crc32fast::hash(&body));
    buf.extend_from_slice(&body);

    let tmp = dir.join(MANIFEST_TMP);
    let mut file = OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .open(&tmp)
        .map_err(io_err(&tmp))?;
    file.write_all(&buf).map_err(io_err(&tmp))?;
    file.sync_all().map_err(io_err(&tmp))?;
    drop(file);
    let path = path(dir);
    fs::rename(&tmp, &path).map_err(io_err(&path))?;
    fsutil::sync_dir(dir).map_err(io_err(dir))
}

mod hex_bytes {
    use std::fmt::Write;

    use serde::de::Error;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(bytes: &[u8], s: S) -> Result<S::Ok, S::Error> {
        let mut out = String::with_capacity(bytes.len() * 2);
        for b in bytes {
            let _ = write!(out, "{b:02x}");
        }
        s.serialize_str(&out)
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(d: D) -> Result<Vec<u8>, D::Error> {
        let s = String::deserialize(d)?;
        if !s.is_ascii() || s.len() % 2 != 0 {
            return Err(D::Error::custom("invalid hex string"));
        }
        (0..s.len())
            .step_by(2)
            .map(|i| u8::from_str_radix(&s[i..i + 2], 16).map_err(D::Error::custom))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> Manifest {
        Manifest {
            next_file_id: 9,
            flushed_seq: 120,
            tables: vec![TableMeta {
                id: 4,
                level: 1,
                min_key: b"a\x00\xff".to_vec(),
                max_key: b"zz".to_vec(),
                size: 4096,
                entries: 10,
                max_seq: 120,
            }],
        }
    }

    #[test]
    fn missing_manifest_is_none() {
        let dir = tempfile::tempdir().expect("tempdir");
        assert_eq!(load(dir.path()).expect("load"), None);
    }

    #[test]
    fn store_then_load_round_trips_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().expect("tempdir");
        store(dir.path(), &sample()).expect("store");
        assert_eq!(load(dir.path()).expect("load"), Some(sample()));
        assert!(!dir.path().join(MANIFEST_TMP).exists());
    }

    #[test]
    fn detects_corruption_and_future_versions() {
        let dir = tempfile::tempdir().expect("tempdir");
        store(dir.path(), &sample()).expect("store");
        let p = path(dir.path());
        let good = fs::read(&p).expect("read");

        let mut flipped = good.clone();
        let last = flipped.len() - 2;
        flipped[last] ^= 0x01;
        fs::write(&p, &flipped).expect("write");
        assert!(matches!(
            load(dir.path()),
            Err(StorageError::Corruption { .. })
        ));

        let mut future = good.clone();
        future[8] = 2;
        fs::write(&p, &future).expect("write");
        assert!(matches!(
            load(dir.path()),
            Err(StorageError::UnsupportedFormat { found: 2, .. })
        ));
    }

    #[test]
    fn rejects_inconsistent_contents() {
        let dir = tempfile::tempdir().expect("tempdir");
        let mut m = sample();
        m.tables.push(m.tables[0].clone());
        store(dir.path(), &m).expect("store");
        assert!(matches!(
            load(dir.path()),
            Err(StorageError::Corruption { .. })
        ));
    }
}
