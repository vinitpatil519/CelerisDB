//! Platform-aware filesystem helpers and data-directory file naming.

use std::fs::File;
use std::io;
use std::path::{Path, PathBuf};

pub(crate) fn wal_path(dir: &Path, id: u64) -> PathBuf {
    dir.join(format!("{id:020}.wal"))
}

pub(crate) fn table_path(dir: &Path, id: u64) -> PathBuf {
    dir.join(format!("{id:020}.sst"))
}

pub(crate) fn table_tmp_path(dir: &Path, id: u64) -> PathBuf {
    dir.join(format!("{id:020}.sst.tmp"))
}

/// What a file in the data directory is.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DataFile {
    Wal(u64),
    Table(u64),
    /// Leftover from an interrupted flush, compaction or manifest write.
    Temp,
    Other,
}

pub(crate) fn classify(name: &str) -> DataFile {
    if name.ends_with(".tmp") {
        return DataFile::Temp;
    }
    let parse = |stem: &str| stem.parse::<u64>().ok();
    if let Some(id) = name.strip_suffix(".wal").and_then(parse) {
        DataFile::Wal(id)
    } else if let Some(id) = name.strip_suffix(".sst").and_then(parse) {
        DataFile::Table(id)
    } else {
        DataFile::Other
    }
}

/// Makes directory entries (creates, renames, deletes) durable.
///
/// Windows offers no portable way to fsync a directory; NTFS journals
/// metadata, so this is a no-op there.
pub(crate) fn sync_dir(dir: &Path) -> io::Result<()> {
    #[cfg(unix)]
    {
        File::open(dir)?.sync_all()
    }
    #[cfg(not(unix))]
    {
        let _ = dir;
        Ok(())
    }
}

/// Positional read that does not depend on (or race with) a shared file cursor.
pub(crate) fn read_exact_at(file: &File, buf: &mut [u8], offset: u64) -> io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileExt;
        file.read_exact_at(buf, offset)
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::FileExt;
        let mut done = 0;
        while done < buf.len() {
            let n = file.seek_read(&mut buf[done..], offset + done as u64)?;
            if n == 0 {
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof));
            }
            done += n;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_names() {
        assert_eq!(classify("00000000000000000007.wal"), DataFile::Wal(7));
        assert_eq!(classify("00000000000000000012.sst"), DataFile::Table(12));
        assert_eq!(classify("00000000000000000012.sst.tmp"), DataFile::Temp);
        assert_eq!(classify("MANIFEST.tmp"), DataFile::Temp);
        assert_eq!(classify("MANIFEST"), DataFile::Other);
        assert_eq!(classify("LOCK"), DataFile::Other);
        assert_eq!(classify("notes.wal"), DataFile::Other);
    }

    #[test]
    fn names_sort_by_id() {
        let a = wal_path(Path::new("d"), 9);
        let b = wal_path(Path::new("d"), 10);
        assert!(a < b);
    }
}
