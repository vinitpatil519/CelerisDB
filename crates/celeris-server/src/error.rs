//! API errors and their JSON representation.
//!
//! Every error body looks like:
//!
//! ```json
//! {"error": {"code": "condition_failed", "message": "...", "outcome": "not_applied",
//!            "mutation_id": "...", "current_version": 7}}
//! ```
//!
//! `outcome` is present on every write error and is either `not_applied`
//! (safe to treat as failed) or `unknown` (the write may have committed;
//! resolve with `GET /v1/mutations/{mutation_id}` or retry with the same ID).

use axum::Json;
use axum::extract::rejection::{JsonRejection, PathRejection, QueryRejection};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use celeris_core::MutationId;
use celeris_storage::StorageError;
use serde_json::{Map, Value, json};
use tracing::error;

/// What a client may conclude about a failed write.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// The mutation was definitely not applied.
    NotApplied,
    /// The mutation may or may not have been applied.
    Unknown,
}

impl Outcome {
    fn as_str(self) -> &'static str {
        match self {
            Outcome::NotApplied => "not_applied",
            Outcome::Unknown => "unknown",
        }
    }
}

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
    outcome: Option<Outcome>,
    mutation_id: Option<MutationId>,
    /// `Some(None)` means "the key is currently absent".
    current_version: Option<Option<u64>>,
    /// Extra fields merged into the error object (e.g. routing hints).
    /// Boxed: most errors have none, and it keeps `ApiError` small.
    details: Option<Box<Map<String, Value>>>,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        ApiError {
            status,
            code,
            message: message.into(),
            outcome: None,
            mutation_id: None,
            current_version: None,
            details: None,
        }
    }

    /// Adds a field to the error object.
    pub fn with_detail(mut self, key: &str, value: Value) -> Self {
        self.details
            .get_or_insert_with(Box::default)
            .insert(key.to_owned(), value);
        self
    }

    pub fn status(&self) -> StatusCode {
        self.status
    }

    pub fn code(&self) -> &'static str {
        self.code
    }

    pub fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, code, message)
    }

    pub fn not_found(key: &str) -> Self {
        Self::new(
            StatusCode::NOT_FOUND,
            "not_found",
            format!("key `{key}` not found"),
        )
    }

    pub fn forbidden(message: impl Into<String>) -> Self {
        Self::new(StatusCode::FORBIDDEN, "forbidden", message)
    }

    pub fn internal(message: impl Into<String>) -> Self {
        let err = Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message);
        error!(message = %err.message, "internal error");
        err
    }

    pub fn path(r: PathRejection) -> Self {
        Self::bad_request("invalid_path", r.body_text())
    }

    pub fn query(r: QueryRejection) -> Self {
        Self::bad_request("invalid_query", r.body_text())
    }

    pub fn json(r: JsonRejection) -> Self {
        Self::new(r.status(), "invalid_json", r.body_text())
    }

    /// Marks an error from a write endpoint. Errors raised before the
    /// storage call (validation, bad parameters) did not apply anything;
    /// an already-recorded `Unknown` outcome is kept.
    pub fn write_failure(mut self) -> Self {
        self.outcome.get_or_insert(Outcome::NotApplied);
        self
    }

    /// A write whose fate cannot be determined (e.g. the worker panicked).
    pub fn outcome_unknown(id: MutationId, message: impl Into<String>) -> Self {
        let mut err = Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "outcome_unknown",
            message,
        );
        err.outcome = Some(Outcome::Unknown);
        err.mutation_id = Some(id);
        error!(mutation_id = %id, message = %err.message, "write outcome unknown");
        err
    }

    /// Maps a storage error. `write` carries the mutation ID for write paths.
    ///
    /// The engine returns every error except `WalFailure` before appending to
    /// the WAL, so those writes are definitely not applied.
    pub fn storage(e: StorageError, write: Option<MutationId>) -> Self {
        let message = e.to_string();
        let mut err = match &e {
            StorageError::InvalidKey(_) => Self::bad_request("invalid_key", message),
            StorageError::InvalidArgument(_) => Self::bad_request("invalid_argument", message),
            StorageError::ConditionFailed { actual, .. } => {
                let mut err = Self::new(StatusCode::CONFLICT, "condition_failed", message);
                err.current_version = Some(*actual);
                err
            }
            StorageError::MutationIdReused(_) => Self::new(
                StatusCode::UNPROCESSABLE_ENTITY,
                "mutation_id_reused",
                message,
            ),
            StorageError::WalFailure(_) => {
                let mut err = Self::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "outcome_unknown",
                    message,
                );
                err.outcome = Some(Outcome::Unknown);
                err
            }
            StorageError::Poisoned(_) => {
                Self::new(StatusCode::SERVICE_UNAVAILABLE, "read_only", message)
            }
            StorageError::Corruption { .. } => {
                Self::new(StatusCode::INTERNAL_SERVER_ERROR, "corruption", message)
            }
            _ => Self::new(StatusCode::INTERNAL_SERVER_ERROR, "internal", message),
        };
        if let Some(id) = write {
            err.mutation_id = Some(id);
            err.outcome.get_or_insert(Outcome::NotApplied);
        }
        if err.status.is_server_error() {
            error!(code = err.code, error = %e, "storage error");
        }
        err
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        let mut body = Map::new();
        body.insert("code".into(), json!(self.code));
        body.insert("message".into(), json!(self.message));
        if let Some(outcome) = self.outcome {
            body.insert("outcome".into(), json!(outcome.as_str()));
        }
        if let Some(id) = self.mutation_id {
            body.insert("mutation_id".into(), json!(id.to_string()));
        }
        if let Some(current) = self.current_version {
            body.insert("current_version".into(), json!(current));
        }
        if let Some(details) = self.details {
            body.extend(*details);
        }
        (self.status, Json(json!({ "error": Value::Object(body) }))).into_response()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_errors_carry_outcome_and_mutation_id() {
        let id = MutationId::random();
        let e = ApiError::storage(
            StorageError::ConditionFailed {
                key: b"k".to_vec(),
                expected: celeris_storage::Condition::Absent,
                actual: Some(3),
            },
            Some(id),
        );
        assert_eq!(e.status, StatusCode::CONFLICT);
        assert_eq!(e.outcome, Some(Outcome::NotApplied));
        assert_eq!(e.current_version, Some(Some(3)));

        let e = ApiError::storage(StorageError::WalFailure("disk".into()), Some(id));
        assert_eq!(
            e.outcome,
            Some(Outcome::Unknown),
            "never downgrade unknown to not_applied"
        );
        assert_eq!(e.mutation_id, Some(id));
    }

    #[test]
    fn read_errors_have_no_outcome() {
        let e = ApiError::storage(StorageError::InvalidArgument("x".into()), None);
        assert_eq!(e.outcome, None);
        assert_eq!(e.status, StatusCode::BAD_REQUEST);
    }
}
