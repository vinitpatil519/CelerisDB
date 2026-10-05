//! Mutation identity.
//!
//! Every mutation carries a [`MutationId`] chosen by the client (or generated
//! on its behalf). The ID makes retries safe: if a response is lost, the
//! client retries with the same ID and the server returns the original
//! outcome instead of applying the mutation twice. The ID also lets a client
//! ask whether a mutation with an unknown outcome actually committed.

use std::fmt;
use std::str::FromStr;

use uuid::Uuid;

/// 128-bit unique mutation identifier, rendered as a UUID.
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord)]
pub struct MutationId(u128);

impl MutationId {
    /// Generates a random (UUIDv4) mutation ID.
    pub fn random() -> Self {
        MutationId(Uuid::new_v4().as_u128())
    }

    pub const fn from_u128(raw: u128) -> Self {
        MutationId(raw)
    }

    pub const fn as_u128(self) -> u128 {
        self.0
    }

    pub const fn from_bytes(bytes: [u8; 16]) -> Self {
        MutationId(u128::from_be_bytes(bytes))
    }

    pub const fn to_bytes(self) -> [u8; 16] {
        self.0.to_be_bytes()
    }
}

impl fmt::Display for MutationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        fmt::Display::fmt(&Uuid::from_u128(self.0).hyphenated(), f)
    }
}

impl fmt::Debug for MutationId {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "MutationId({self})")
    }
}

/// Returned when a string is not a valid UUID.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("invalid mutation id `{0}`: expected a UUID")]
pub struct ParseMutationIdError(pub String);

impl FromStr for MutationId {
    type Err = ParseMutationIdError;

    fn from_str(s: &str) -> Result<Self, Self::Err> {
        Uuid::parse_str(s)
            .map(|u| MutationId(u.as_u128()))
            .map_err(|_| ParseMutationIdError(s.to_owned()))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn random_ids_differ() {
        assert_ne!(MutationId::random(), MutationId::random());
    }

    #[test]
    fn string_and_byte_round_trip() {
        let id = MutationId::random();
        assert_eq!(id.to_string().parse::<MutationId>(), Ok(id));
        assert_eq!(MutationId::from_bytes(id.to_bytes()), id);
    }

    #[test]
    fn rejects_garbage() {
        assert!("not-a-uuid".parse::<MutationId>().is_err());
    }
}
