//! Little-endian encoding helpers shared by the WAL and SSTable formats.

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub(crate) struct DecodeError(pub &'static str);

pub(crate) fn put_u8(out: &mut Vec<u8>, v: u8) {
    out.push(v);
}

pub(crate) fn put_u32(out: &mut Vec<u8>, v: u32) {
    out.extend_from_slice(&v.to_le_bytes());
}

pub(crate) fn put_u64(out: &mut Vec<u8>, v: u64) {
    out.extend_from_slice(&v.to_le_bytes());
}

/// Writes a `u32` length prefix followed by the bytes. Callers guarantee
/// `bytes.len()` fits in a `u32` (keys and values are bounded far below that).
pub(crate) fn put_bytes(out: &mut Vec<u8>, bytes: &[u8]) {
    put_u32(out, bytes.len() as u32);
    out.extend_from_slice(bytes);
}

/// Cursor over an encoded buffer. Every read is bounds-checked.
#[derive(Debug)]
pub(crate) struct Decoder<'a> {
    buf: &'a [u8],
    pos: usize,
}

impl<'a> Decoder<'a> {
    pub(crate) fn new(buf: &'a [u8]) -> Self {
        Decoder { buf, pos: 0 }
    }

    pub(crate) fn is_empty(&self) -> bool {
        self.pos >= self.buf.len()
    }

    fn take(&mut self, n: usize) -> Result<&'a [u8], DecodeError> {
        if self.buf.len() - self.pos < n {
            return Err(DecodeError("unexpected end of data"));
        }
        let slice = &self.buf[self.pos..self.pos + n];
        self.pos += n;
        Ok(slice)
    }

    fn array<const N: usize>(&mut self) -> Result<[u8; N], DecodeError> {
        self.take(N)?
            .try_into()
            .map_err(|_| DecodeError("unexpected end of data"))
    }

    pub(crate) fn u8(&mut self) -> Result<u8, DecodeError> {
        Ok(self.take(1)?[0])
    }

    pub(crate) fn u32(&mut self) -> Result<u32, DecodeError> {
        self.array().map(u32::from_le_bytes)
    }

    pub(crate) fn u64(&mut self) -> Result<u64, DecodeError> {
        self.array().map(u64::from_le_bytes)
    }

    pub(crate) fn bytes16(&mut self) -> Result<[u8; 16], DecodeError> {
        self.array()
    }

    pub(crate) fn bytes(&mut self) -> Result<&'a [u8], DecodeError> {
        let len = self.u32()? as usize;
        self.take(len)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip() {
        let mut buf = Vec::new();
        put_u8(&mut buf, 7);
        put_u32(&mut buf, 0xDEAD_BEEF);
        put_u64(&mut buf, u64::MAX - 1);
        put_bytes(&mut buf, b"hello");
        let mut d = Decoder::new(&buf);
        assert_eq!(d.u8(), Ok(7));
        assert_eq!(d.u32(), Ok(0xDEAD_BEEF));
        assert_eq!(d.u64(), Ok(u64::MAX - 1));
        assert_eq!(d.bytes(), Ok(&b"hello"[..]));
        assert!(d.is_empty());
    }

    #[test]
    fn truncated_input_is_an_error_not_a_panic() {
        let mut buf = Vec::new();
        put_bytes(&mut buf, b"hello");
        buf.truncate(6);
        assert!(Decoder::new(&buf).bytes().is_err());
        assert!(Decoder::new(&[1, 2]).u32().is_err());
    }
}
