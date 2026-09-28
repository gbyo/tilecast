//! The request vocabulary of `tilecast-edge-update`, the root update helper.
//!
//! One request per connection: a single line of JSON of at most
//! [`MAX_FRAME_BYTES`], answered by a single line of JSON. The vocabulary is
//! fixed. No request carries a path, a unit name, a command or a URL: the
//! helper derives every path from a validated digest or version name and
//! its own fixed roots (docs/tilecast-edge-update-threat-review.md).
//!
//! Fixtures: `packages/edge-protocol/fixtures/update-helper/`.

use serde::{Deserialize, Serialize};

/// The helper's socket (`tilecast-edge-update.socket`).
pub const DEFAULT_SOCKET: &str = "/run/tilecast-edge-update/update.sock";
pub const MAX_FRAME_BYTES: usize = 64 * 1024;
/// At most this many installed versions are listed in a status answer.
pub const MAX_LISTED_VERSIONS: usize = 16;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", rename_all_fields = "camelCase", deny_unknown_fields)]
pub enum HelperRequest {
    /// Verify the envelope, then the content-store object named by its
    /// artifact digest, and install the release under
    /// `/opt/tilecast-edge/<version>/` without activating it.
    Stage {
        artifact_sha256: String,
        /// The exact envelope bytes, base64.
        envelope: String,
        /// The envelope's base64 signature text, base64 again.
        signature: String,
    },
    /// Make a staged release current, provisionally.
    Activate {
        version_name: String,
    },
    /// End the provisional window of the running candidate.
    Confirm {
        version_name: String,
    },
    /// Return to the previous release during the provisional window.
    Rollback {
        reason: String,
    },
    Status {},
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperResponse {
    pub ok: bool,
    /// A stable reason code (`staged`, `activation_started`,
    /// `release_digest_mismatch`, ...).
    pub code: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub version_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<HelperStatus>,
}

impl HelperResponse {
    pub fn ok(code: &str) -> Self {
        Self { ok: true, code: code.to_owned(), version_name: None, status: None }
    }

    pub fn refused(code: &str) -> Self {
        Self { ok: false, code: code.to_owned(), version_name: None, status: None }
    }

    pub fn with_version(mut self, version: &str) -> Self {
        self.version_name = Some(version.to_owned());
        self
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReleaseRef {
    pub version_name: String,
    pub version_code: u64,
    pub manifest_sha256: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    /// Written before anything outside the helper's own files changes.
    ActivateIntent,
    /// The candidate is current and running; it has not confirmed.
    Provisional,
    /// Confirmation passed; written before its side effects.
    ConfirmIntent,
    Confirmed,
    /// Written before the rollback's side effects.
    RollbackIntent,
    RolledBack,
}

impl Phase {
    pub fn is_terminal(self) -> bool {
        matches!(self, Self::Confirmed | Self::RolledBack)
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TransactionView {
    pub transaction_id: String,
    pub candidate: ReleaseRef,
    pub previous: ReleaseRef,
    pub phase: Phase,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// After a rollback: the previous release refused the state database
    /// because the candidate migrated it to a newer schema.
    #[serde(default)]
    pub schema_incompatible: bool,
    /// Milliseconds left in the provisional window.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provisional_remaining_ms: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HelperStatus {
    pub current: Option<ReleaseRef>,
    /// Installed version names, newest first, at most
    /// [`MAX_LISTED_VERSIONS`].
    pub installed: Vec<String>,
    /// The open transaction, or the last finished one.
    pub transaction: Option<TransactionView>,
}

/// A reason code: lowercase ASCII, digits and `_`, 1 to 64 bytes.
pub fn is_reason(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
}

#[cfg(test)]
mod tests {
    use super::*;

    const FIXTURES: &str =
        concat!(env!("CARGO_MANIFEST_DIR"), "/../../../../packages/edge-protocol/fixtures/update-helper");

    fn fixture(name: &str) -> String {
        std::fs::read_to_string(format!("{FIXTURES}/{name}")).unwrap_or_else(|e| panic!("{name}: {e}"))
    }

    #[test]
    fn requests_round_trip_with_the_fixtures() {
        let cases = [
            (
                "stage.json",
                HelperRequest::Stage {
                    artifact_sha256: "a".repeat(64),
                    envelope: "eyJ9".into(),
                    signature: "c2ln".into(),
                },
            ),
            ("activate.json", HelperRequest::Activate { version_name: "0.2.0".into() }),
            ("confirm.json", HelperRequest::Confirm { version_name: "0.2.0".into() }),
            ("rollback.json", HelperRequest::Rollback { reason: "candidate_safe_mode".into() }),
            ("status.json", HelperRequest::Status {}),
        ];
        for (name, request) in cases {
            let parsed: HelperRequest = serde_json::from_str(&fixture(name)).unwrap();
            assert_eq!(parsed, request, "{name}");
            let again: HelperRequest = serde_json::from_str(&serde_json::to_string(&request).unwrap()).unwrap();
            assert_eq!(again, request);
        }
    }

    #[test]
    fn the_status_fixture_parses() {
        let response: HelperResponse = serde_json::from_str(&fixture("status-response.json")).unwrap();
        let status = response.status.unwrap();
        let transaction = status.transaction.unwrap();
        assert_eq!(transaction.phase, Phase::Provisional);
        assert_eq!(transaction.candidate.version_name, "0.2.0");
        assert_eq!(status.installed, vec!["0.2.0".to_owned(), "0.1.0".to_owned()]);
    }

    #[test]
    fn unknown_operations_and_fields_are_refused() {
        for text in [
            r#"{"op":"exec","command":"/bin/sh"}"#,
            r#"{"op":"activate","versionName":"0.2.0","path":"/tmp/x"}"#,
            r#"{"op":"stage","artifactSha256":"x","envelope":"","signature":"","unit":"ssh.service"}"#,
            r#"{"op":"status","extra":1}"#,
        ] {
            assert!(serde_json::from_str::<HelperRequest>(text).is_err(), "{text}");
        }
        assert!(is_reason("confirmation_timeout"));
        for bad in ["", "Timeout", "a b", "x;rm", &"a".repeat(65)] {
            assert!(!is_reason(bad), "{bad}");
        }
    }
}
