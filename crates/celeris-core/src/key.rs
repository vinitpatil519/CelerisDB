//! Key and value limits shared by the storage engine and the API layer.

/// Maximum key length in bytes.
pub const MAX_KEY_LEN: usize = 1024;

/// Maximum value length in bytes (4 MiB).
pub const MAX_VALUE_LEN: usize = 4 * 1024 * 1024;

/// Keys starting with this byte are reserved for internal records
/// (for example mutation-ID deduplication entries). User keys may not use it.
pub const RESERVED_KEY_PREFIX: u8 = 0x00;

/// Why a key was rejected.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum KeyError {
    #[error("key must not be empty")]
    Empty,
    #[error("key is {len} bytes; maximum is {max}")]
    TooLong { len: usize, max: usize },
    #[error("keys starting with byte 0x00 are reserved for internal use")]
    Reserved,
}

/// Checks that `key` is acceptable as a user key.
pub fn validate_key(key: &[u8]) -> Result<(), KeyError> {
    match key.first() {
        None => Err(KeyError::Empty),
        Some(&RESERVED_KEY_PREFIX) => Err(KeyError::Reserved),
        Some(_) if key.len() > MAX_KEY_LEN => Err(KeyError::TooLong {
            len: key.len(),
            max: MAX_KEY_LEN,
        }),
        Some(_) => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_normal_keys() {
        assert_eq!(validate_key(b"users/42"), Ok(()));
        assert_eq!(validate_key(&[b'a'; MAX_KEY_LEN]), Ok(()));
    }

    #[test]
    fn rejects_bad_keys() {
        assert_eq!(validate_key(b""), Err(KeyError::Empty));
        assert_eq!(validate_key(b"\0internal"), Err(KeyError::Reserved));
        assert_eq!(
            validate_key(&[b'a'; MAX_KEY_LEN + 1]),
            Err(KeyError::TooLong {
                len: MAX_KEY_LEN + 1,
                max: MAX_KEY_LEN
            })
        );
    }
}
