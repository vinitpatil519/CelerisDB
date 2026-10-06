//! API authentication: bearer tokens with scopes.
//!
//! Tokens are random strings handed to clients. The node stores only their
//! SHA-256 hashes (`[[auth.tokens]]` in `celeris.toml`), so a leaked config
//! file does not leak usable credentials. A request is checked by hashing
//! the presented token and looking the hash up; the comparison happens on
//! hashes, so it reveals nothing about the secret through timing.
//!
//! With no tokens configured, authentication is off and every request is
//! allowed (admin endpoints then stay loopback-only).

use std::collections::HashMap;
use std::fmt;

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// What a token may do. Each scope includes nothing else: give a client
/// that writes both `read` and `write`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, PartialOrd, Ord)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Reads, scans, change streams, status, partitions, conflicts.
    Read,
    /// Puts, deletes, batches, clearing conflicts.
    Write,
    /// `/v1/admin/*`: rebalance and shutdown.
    Admin,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Read => "read",
            Scope::Write => "write",
            Scope::Admin => "admin",
        }
    }

    pub fn parse(s: &str) -> Option<Scope> {
        match s.trim().to_ascii_lowercase().as_str() {
            "read" => Some(Scope::Read),
            "write" => Some(Scope::Write),
            "admin" => Some(Scope::Admin),
            _ => None,
        }
    }
}

impl fmt::Display for Scope {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// One `[[auth.tokens]]` entry.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct TokenConfig {
    /// A label for logs and metrics, e.g. `web-app`.
    pub name: String,
    /// Lowercase hex SHA-256 of the token (`celeris token create` prints it).
    pub sha256: String,
    pub scopes: Vec<Scope>,
}

impl TokenConfig {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.is_empty() || self.name.len() > 64 {
            return Err("auth token name must be 1-64 characters".into());
        }
        if decode_hash(&self.sha256).is_none() {
            return Err(format!(
                "auth token `{}`: sha256 must be 64 lowercase hex characters",
                self.name
            ));
        }
        if self.scopes.is_empty() {
            return Err(format!("auth token `{}` has no scopes", self.name));
        }
        Ok(())
    }

    /// Parses the `CELERIS_AUTH_TOKENS` form: `name:scope+scope:sha256`.
    pub fn parse_env(item: &str) -> Result<TokenConfig, String> {
        let mut parts = item.trim().splitn(3, ':');
        let (Some(name), Some(scopes), Some(sha256)) = (parts.next(), parts.next(), parts.next())
        else {
            return Err(format!(
                "CELERIS_AUTH_TOKENS entries are `name:scope+scope:sha256`, got `{item}`"
            ));
        };
        let scopes = scopes
            .split('+')
            .map(|s| Scope::parse(s).ok_or_else(|| format!("unknown scope `{s}` in `{item}`")))
            .collect::<Result<Vec<_>, _>>()?;
        let token = TokenConfig {
            name: name.to_owned(),
            sha256: sha256.trim().to_ascii_lowercase(),
            scopes,
        };
        token.validate()?;
        Ok(token)
    }
}

/// Who made a request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Principal {
    pub name: String,
    pub scopes: Vec<Scope>,
}

impl Principal {
    pub fn allows(&self, scope: Scope) -> bool {
        self.scopes.contains(&scope)
    }
}

/// The node's token table.
#[derive(Debug, Default)]
pub struct Authenticator {
    by_hash: HashMap<[u8; 32], Principal>,
}

/// Why a request was refused.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Denied {
    /// No token, or an unknown one: 401.
    Unauthenticated,
    /// A valid token without the scope: 403.
    Forbidden { name: String, needs: Scope },
}

impl Authenticator {
    pub fn new(tokens: &[TokenConfig]) -> Result<Authenticator, String> {
        let mut by_hash = HashMap::new();
        for t in tokens {
            t.validate()?;
            let hash = decode_hash(&t.sha256).ok_or("invalid token hash")?;
            let principal = Principal {
                name: t.name.clone(),
                scopes: t.scopes.clone(),
            };
            if by_hash.insert(hash, principal).is_some() {
                return Err(format!("auth token `{}` is configured twice", t.name));
            }
        }
        Ok(Authenticator { by_hash })
    }

    /// Whether any token is configured (authentication is on).
    pub fn enabled(&self) -> bool {
        !self.by_hash.is_empty()
    }

    /// Checks a presented token against the scope a request needs.
    pub fn authorize(
        &self,
        token: Option<&str>,
        needs: Scope,
    ) -> Result<Option<Principal>, Denied> {
        if !self.enabled() {
            return Ok(None);
        }
        let token = token
            .filter(|t| !t.is_empty())
            .ok_or(Denied::Unauthenticated)?;
        let principal = self
            .by_hash
            .get(&hash_bytes(token))
            .ok_or(Denied::Unauthenticated)?;
        if principal.allows(needs) {
            Ok(Some(principal.clone()))
        } else {
            Err(Denied::Forbidden {
                name: principal.name.clone(),
                needs,
            })
        }
    }
}

fn hash_bytes(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

/// Lowercase hex SHA-256 of a token, as stored in the config.
pub fn hash_token(token: &str) -> String {
    hash_bytes(token)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

fn decode_hash(hex: &str) -> Option<[u8; 32]> {
    if hex.len() != 64 {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, chunk) in hex.as_bytes().chunks(2).enumerate() {
        let s = std::str::from_utf8(chunk).ok()?;
        if s.chars().any(|c| c.is_ascii_uppercase()) {
            return None;
        }
        out[i] = u8::from_str_radix(s, 16).ok()?;
    }
    Some(out)
}

/// A new random token: `cel_` and 64 hex characters.
pub fn generate_token() -> String {
    let a = uuid::Uuid::new_v4().as_u128().to_le_bytes();
    let b = uuid::Uuid::new_v4().as_u128().to_le_bytes();
    // A v4 UUID carries 122 random bits from the OS generator; hashing two
    // spreads their 244 bits evenly over the output.
    let mut hasher = Sha256::new();
    hasher.update(a);
    hasher.update(b);
    let bytes: [u8; 32] = hasher.finalize().into();
    let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
    format!("cel_{hex}")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn auth(scopes: &[Scope]) -> (Authenticator, String) {
        let token = generate_token();
        let a = Authenticator::new(&[TokenConfig {
            name: "app".into(),
            sha256: hash_token(&token),
            scopes: scopes.to_vec(),
        }])
        .expect("valid");
        (a, token)
    }

    #[test]
    fn disabled_without_tokens() {
        let a = Authenticator::default();
        assert!(!a.enabled());
        assert_eq!(a.authorize(None, Scope::Admin), Ok(None));
    }

    #[test]
    fn checks_token_and_scope() {
        let (a, token) = auth(&[Scope::Read]);
        assert!(a.enabled());
        assert_eq!(
            a.authorize(Some(&token), Scope::Read)
                .map(|p| p.map(|p| p.name)),
            Ok(Some("app".into()))
        );
        assert_eq!(
            a.authorize(Some(&token), Scope::Write),
            Err(Denied::Forbidden {
                name: "app".into(),
                needs: Scope::Write
            })
        );
        assert_eq!(a.authorize(None, Scope::Read), Err(Denied::Unauthenticated));
        assert_eq!(
            a.authorize(Some("cel_wrong"), Scope::Read),
            Err(Denied::Unauthenticated)
        );
    }

    #[test]
    fn tokens_are_random_and_hashes_valid() {
        let (a, b) = (generate_token(), generate_token());
        assert_ne!(a, b);
        assert!(a.starts_with("cel_") && a.len() == 68);
        assert!(decode_hash(&hash_token(&a)).is_some());
        assert!(decode_hash(&hash_token(&a).to_uppercase()).is_none());
    }

    #[test]
    fn parses_env_form() {
        let hash = hash_token("t");
        let t = TokenConfig::parse_env(&format!("ci:read+write:{hash}")).expect("parse");
        assert_eq!(t.scopes, vec![Scope::Read, Scope::Write]);
        assert!(TokenConfig::parse_env("ci:read").is_err());
        assert!(TokenConfig::parse_env(&format!("ci:fly:{hash}")).is_err());
    }

    #[test]
    fn duplicate_tokens_are_rejected() {
        let hash = hash_token("t");
        let t = TokenConfig {
            name: "a".into(),
            sha256: hash,
            scopes: vec![Scope::Read],
        };
        assert!(Authenticator::new(&[t.clone(), t]).is_err());
    }
}
