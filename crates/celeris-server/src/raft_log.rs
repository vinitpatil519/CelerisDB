//! Durable storage for a replication group's Raft state.
//!
//! * `hardstate.json`: `{format_version, term, voted_for}`, replaced
//!   atomically (tmp + fsync + rename).
//! * `raft.log`: header `"CLRSRLOG"` + `u32` version (LE) + `u64` snapshot
//!   index + `u64` snapshot term, then one frame per entry after the
//!   snapshot: `len u32 LE | crc32(payload) u32 LE | JSON entry`.
//!   Version 1 files (no snapshot fields; snapshot = 0) are still read and
//!   are upgraded the first time the log is compacted.
//!
//! Appends are incremental: [`Raft::take_log_changes`] reports the lowest
//! changed index, the file is cut back to that entry's offset, and the
//! changed suffix is rewritten. A torn frame at the end of the file (a crash
//! mid-append) was never acknowledged, because Raft persists before sending,
//! and is discarded on open.
//!
//! Compaction ([`Raft::take_compaction`]) rewrites the whole file into a
//! temporary file that atomically replaces the old one, so a crash leaves
//! either the old log or the new one, never a mix. The caller must make the
//! state machine durable up to the snapshot index *before* persisting a
//! compaction, since the entries are gone afterwards.

use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Seek, Write};
use std::marker::PhantomData;
use std::path::{Path, PathBuf};

use anyhow::{Context, ensure};
use celeris_cluster::raft::{LogEntry, LogIndex, PersistentState, Raft, Term};
use celeris_core::partition::NodeId;
use serde::Serialize;
use serde::de::DeserializeOwned;

const LOG_FILE: &str = "raft.log";
const HARD_STATE_FILE: &str = "hardstate.json";
const MAGIC: &[u8; 8] = b"CLRSRLOG";
/// Version of the group Raft log format.
pub const RAFT_LOG_FORMAT_VERSION: u32 = 2;
const V1_HEADER_LEN: u64 = 12;
const HEADER_LEN: u64 = 28;
const MAX_FRAME: usize = 64 * 1024 * 1024;

#[derive(serde::Serialize, serde::Deserialize)]
struct HardState {
    format_version: u32,
    term: Term,
    voted_for: Option<NodeId>,
}

/// Hard state files were introduced at log version 1 and have not changed.
const HARD_STATE_FORMAT_VERSION: u32 = 1;

#[derive(Debug)]
pub(crate) struct RaftLogStore<C> {
    dir: PathBuf,
    file: File,
    /// `offsets[i]` is the file offset of the entry with index
    /// `snapshot_index + i + 1`.
    offsets: Vec<u64>,
    end: u64,
    snapshot_index: LogIndex,
    hard: (Term, Option<NodeId>),
    _command: PhantomData<C>,
}

fn header(snapshot_index: LogIndex, snapshot_term: Term) -> Vec<u8> {
    let mut h = MAGIC.to_vec();
    h.extend_from_slice(&RAFT_LOG_FORMAT_VERSION.to_le_bytes());
    h.extend_from_slice(&snapshot_index.to_le_bytes());
    h.extend_from_slice(&snapshot_term.to_le_bytes());
    h
}

fn frame<C: Serialize>(entry: &LogEntry<C>, out: &mut Vec<u8>) -> anyhow::Result<()> {
    let payload = serde_json::to_vec(entry)?;
    out.extend_from_slice(&(payload.len() as u32).to_le_bytes());
    out.extend_from_slice(&crc32fast::hash(&payload).to_le_bytes());
    out.extend_from_slice(&payload);
    Ok(())
}

fn u64_at(data: &[u8], pos: usize) -> u64 {
    let mut b = [0u8; 8];
    b.copy_from_slice(&data[pos..pos + 8]);
    u64::from_le_bytes(b)
}

impl<C: Serialize + DeserializeOwned + Clone> RaftLogStore<C> {
    /// Opens (creating if needed) the store in `dir` and returns the state
    /// to restore the Raft node from.
    pub(crate) fn open(dir: &Path) -> anyhow::Result<(Self, PersistentState<C>)> {
        fs::create_dir_all(dir).with_context(|| format!("creating {}", dir.display()))?;
        let hard = match fs::read(dir.join(HARD_STATE_FILE)) {
            Ok(bytes) => {
                let h: HardState =
                    serde_json::from_slice(&bytes).context("parsing raft hard state")?;
                ensure!(
                    h.format_version == HARD_STATE_FORMAT_VERSION,
                    "unsupported raft hard state version {}",
                    h.format_version
                );
                (h.term, h.voted_for)
            }
            Err(e) if e.kind() == io::ErrorKind::NotFound => (0, None),
            Err(e) => return Err(e).context("reading raft hard state"),
        };
        // A leftover temporary file is an interrupted compaction; the real
        // log is still intact.
        let _ = fs::remove_file(dir.join(format!("{LOG_FILE}.tmp")));

        let path = dir.join(LOG_FILE);
        let mut file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(&path)
            .with_context(|| format!("opening {}", path.display()))?;
        let mut data = Vec::new();
        file.read_to_end(&mut data)?;
        let mut log: Vec<LogEntry<C>> = Vec::new();
        let mut offsets = Vec::new();
        let (snapshot_index, snapshot_term, end) = if data.is_empty() {
            file.write_all(&header(0, 0))?;
            file.sync_all()?;
            (0, 0, HEADER_LEN)
        } else {
            ensure!(
                data.len() >= V1_HEADER_LEN as usize && &data[..8] == MAGIC,
                "{} is not a raft log",
                path.display()
            );
            let version = u32::from_le_bytes([data[8], data[9], data[10], data[11]]);
            let (snapshot_index, snapshot_term, mut pos) = match version {
                1 => (0, 0, V1_HEADER_LEN as usize),
                2 => {
                    ensure!(
                        data.len() >= HEADER_LEN as usize,
                        "{} has a truncated header",
                        path.display()
                    );
                    (u64_at(&data, 12), u64_at(&data, 20), HEADER_LEN as usize)
                }
                v => anyhow::bail!("unsupported raft log version {v}"),
            };
            while data.len() - pos >= 8 {
                let len =
                    u32::from_le_bytes([data[pos], data[pos + 1], data[pos + 2], data[pos + 3]])
                        as usize;
                let crc = u32::from_le_bytes([
                    data[pos + 4],
                    data[pos + 5],
                    data[pos + 6],
                    data[pos + 7],
                ]);
                if len > MAX_FRAME || data.len() - pos - 8 < len {
                    break;
                }
                let payload = &data[pos + 8..pos + 8 + len];
                if crc32fast::hash(payload) != crc {
                    break;
                }
                let entry: LogEntry<C> = serde_json::from_slice(payload).with_context(|| {
                    format!(
                        "raft log entry at offset {pos} has a valid checksum but does not parse"
                    )
                })?;
                ensure!(
                    entry.index == snapshot_index + log.len() as u64 + 1,
                    "raft log entries out of order at offset {pos}"
                );
                offsets.push(pos as u64);
                log.push(entry);
                pos += 8 + len;
            }
            if pos < data.len() {
                file.set_len(pos as u64)?;
                file.sync_all()?;
            }
            (snapshot_index, snapshot_term, pos as u64)
        };
        let state = PersistentState {
            term: hard.0,
            voted_for: hard.1.clone(),
            log,
            snapshot_index,
            snapshot_term,
        };
        Ok((
            RaftLogStore {
                dir: dir.to_path_buf(),
                file,
                offsets,
                end,
                snapshot_index,
                hard,
                _command: PhantomData,
            },
            state,
        ))
    }

    /// Makes everything the Raft node changed durable. Must succeed before
    /// any message produced by the same call is sent.
    pub(crate) fn persist(&mut self, raft: &mut Raft<C>) -> anyhow::Result<()> {
        if raft.take_compaction() {
            raft.take_log_changes();
            self.rewrite(raft)?;
        } else if let Some(from) = raft.take_log_changes() {
            let keep =
                (from.saturating_sub(self.snapshot_index + 1) as usize).min(self.offsets.len());
            let cut = self.offsets.get(keep).copied().unwrap_or(self.end);
            self.offsets.truncate(keep);
            self.end = cut;
            self.file.set_len(cut)?;
            let mut buf = Vec::new();
            for entry in &raft.log()[keep..] {
                self.offsets.push(self.end + buf.len() as u64);
                frame(entry, &mut buf)?;
            }
            self.file.seek(io::SeekFrom::Start(self.end))?;
            self.file.write_all(&buf)?;
            self.file.sync_data()?;
            self.end += buf.len() as u64;
        }
        let (term, voted_for) = raft.hard_state();
        if term != self.hard.0 || voted_for != self.hard.1.as_ref() {
            let hard = HardState {
                format_version: HARD_STATE_FORMAT_VERSION,
                term,
                voted_for: voted_for.cloned(),
            };
            let tmp = self.dir.join(format!("{HARD_STATE_FILE}.tmp"));
            let mut f = File::create(&tmp)?;
            f.write_all(&serde_json::to_vec(&hard)?)?;
            f.sync_all()?;
            drop(f);
            fs::rename(&tmp, self.dir.join(HARD_STATE_FILE))?;
            #[cfg(unix)]
            File::open(&self.dir)?.sync_all()?;
            self.hard = (term, voted_for.cloned());
        }
        Ok(())
    }

    /// Replaces the log file with the snapshot boundary plus the retained
    /// entries.
    fn rewrite(&mut self, raft: &Raft<C>) -> anyhow::Result<()> {
        let (snapshot_index, snapshot_term) = raft.snapshot_meta();
        let mut buf = header(snapshot_index, snapshot_term);
        let mut offsets = Vec::with_capacity(raft.log().len());
        for entry in raft.log() {
            offsets.push(buf.len() as u64);
            frame(entry, &mut buf)?;
        }
        let tmp = self.dir.join(format!("{LOG_FILE}.tmp"));
        let mut f = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(true)
            .open(&tmp)?;
        f.write_all(&buf)?;
        f.sync_all()?;
        fs::rename(&tmp, self.dir.join(LOG_FILE))?;
        #[cfg(unix)]
        File::open(&self.dir)?.sync_all()?;
        // The open handle follows the renamed file.
        self.file = f;
        self.offsets = offsets;
        self.end = buf.len() as u64;
        self.snapshot_index = snapshot_index;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use celeris_cluster::raft::RaftConfig;

    use super::*;

    fn solo(state: PersistentState<u64>) -> Raft<u64> {
        let id = NodeId::new("solo").expect("id");
        let mut raft = Raft::restore(id, vec![], RaftConfig::default(), 1, 0, state);
        raft.tick(10_000);
        raft
    }

    #[test]
    fn appends_survive_reopen_and_rewrites_after_truncation() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut store, state) = RaftLogStore::<u64>::open(dir.path()).expect("open");
        let mut raft = solo(state);
        for v in 1..=3 {
            raft.propose(v).expect("leader");
        }
        store.persist(&mut raft).expect("persist");
        let expected = raft.persistent_state();
        drop(store);

        let (mut store, reopened) = RaftLogStore::<u64>::open(dir.path()).expect("reopen");
        assert_eq!(reopened, expected);
        let mut raft = solo(reopened);
        raft.propose(4).expect("leader");
        store.persist(&mut raft).expect("persist");
        let (_, again) = RaftLogStore::<u64>::open(dir.path()).expect("reopen");
        assert_eq!(again, raft.persistent_state(), "incremental append");
    }

    #[test]
    fn compaction_rewrites_the_log_and_appends_continue_after_it() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut store, state) = RaftLogStore::<u64>::open(dir.path()).expect("open");
        let mut raft = solo(state);
        for v in 1..=5 {
            raft.propose(v).expect("leader");
        }
        let applied: Vec<u64> = raft
            .take_committed()
            .iter()
            .filter_map(|e| e.command)
            .collect();
        assert_eq!(applied, vec![1, 2, 3, 4, 5]);
        store.persist(&mut raft).expect("persist");
        let before = fs::metadata(dir.path().join(LOG_FILE)).expect("meta").len();

        assert!(raft.compact(4), "entries 1..=4 (no-op + 1..=3) are applied");
        store.persist(&mut raft).expect("persist compaction");
        assert!(fs::metadata(dir.path().join(LOG_FILE)).expect("meta").len() < before);
        raft.propose(6).expect("leader");
        store.persist(&mut raft).expect("persist append");
        drop(store);

        let (_, reopened) = RaftLogStore::<u64>::open(dir.path()).expect("reopen");
        assert_eq!(reopened, raft.persistent_state());
        assert_eq!(reopened.snapshot_index, 4);
        let tail: Vec<u64> = reopened.log.iter().filter_map(|e| e.command).collect();
        assert_eq!(tail, vec![4, 5, 6]);
        let restored = solo(reopened);
        assert_eq!(
            restored.last_applied(),
            4,
            "restores from the snapshot point"
        );
    }

    #[test]
    fn reads_version_1_logs() {
        let dir = tempfile::tempdir().expect("tempdir");
        let entry = LogEntry {
            term: 1,
            index: 1,
            command: Some(9u64),
        };
        let mut bytes = MAGIC.to_vec();
        bytes.extend_from_slice(&1u32.to_le_bytes());
        frame(&entry, &mut bytes).expect("frame");
        fs::write(dir.path().join(LOG_FILE), &bytes).expect("write");
        let (_, state) = RaftLogStore::<u64>::open(dir.path()).expect("open v1");
        assert_eq!(state.log, vec![entry]);
        assert_eq!(state.snapshot_index, 0);
    }

    #[test]
    fn torn_tail_is_discarded() {
        let dir = tempfile::tempdir().expect("tempdir");
        let (mut store, state) = RaftLogStore::<u64>::open(dir.path()).expect("open");
        let mut raft = solo(state);
        raft.propose(7).expect("leader");
        store.persist(&mut raft).expect("persist");
        let good = raft.persistent_state();
        drop(store);
        let path = dir.path().join(LOG_FILE);
        let mut bytes = fs::read(&path).expect("read");
        bytes.extend_from_slice(&[9, 0, 0, 0, 1, 2]); // half a frame
        fs::write(&path, &bytes).expect("write");
        let (_, recovered) = RaftLogStore::<u64>::open(dir.path()).expect("open");
        assert_eq!(recovered, good);
        assert_eq!(
            fs::metadata(&path).expect("meta").len() as usize,
            bytes.len() - 6
        );
    }

    #[test]
    fn rejects_foreign_files() {
        let dir = tempfile::tempdir().expect("tempdir");
        fs::write(dir.path().join(LOG_FILE), b"definitely not a log").expect("write");
        assert!(RaftLogStore::<u64>::open(dir.path()).is_err());
    }
}
