//! Result types returned to `tilecastctl`. Bounded, and free of secrets by
//! construction: nothing here can hold a credential.

use serde::{Deserialize, Serialize};

use crate::bounded::{DetailText, ShortText, ShortToken};
use crate::digest::Sha256Digest;
use crate::ids::{InstallationId, PlayerId, ScreenId};
use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonMode {
    /// State is open; normal operation.
    Normal,
    /// The state database could not be opened or failed its integrity check.
    /// IPC and diagnostics work; the binding and content are never recreated.
    Recovery,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerBindingStatus {
    pub server_url: ShortText,
    pub installation_id: InstallationId,
    pub screen_id: Option<ScreenId>,
    pub screen_name: Option<ShortText>,
    /// Last time `/api/v1/system/identity` matched the saved installation.
    pub identity_verified_at: Option<Timestamp>,
    pub has_device_credential: bool,
}

/// The daemon's link to the Tilecast Server, from its last pass.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ServerLinkStatus {
    /// `unbound`, `connected`, `retrying` or `stopped`.
    pub state: ShortToken,
    /// Why the last pass stopped early, if it did.
    pub reason_code: Option<ShortToken>,
    pub last_contact_at: Option<Timestamp>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CasStatus {
    pub object_count: u64,
    pub used_bytes: u64,
    pub pinned_bytes: u64,
    pub partial_bytes: u64,
    pub limit_bytes: u64,
    pub reserved_free_bytes: u64,
    pub filesystem_available_bytes: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RendererStatus {
    pub connected: bool,
    pub state: ShortToken,
    pub kind: Option<ShortToken>,
    pub version: Option<ShortText>,
    pub platform: Option<ShortToken>,
    pub current_activation_generation: Option<u64>,
    pub last_progress_at: Option<Timestamp>,
    pub last_error_code: Option<ShortToken>,
    pub incompatible_reason: Option<DetailText>,
    /// The item the renderer last reported starting, and when the daemon
    /// accepted that evidence (local wall clock). Diagnostics only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_item_id: Option<ShortText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub current_item_started_at: Option<Timestamp>,
    /// WPE WebKit and GStreamer versions the connected renderer reported.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_version: Option<ShortText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gstreamer_version: Option<ShortText>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonStatus {
    pub daemon_version: ShortText,
    pub mode: DaemonMode,
    pub recovery_reason: Option<ShortToken>,
    pub started_at: Timestamp,
    pub player_id: Option<PlayerId>,
    pub server: Option<ServerBindingStatus>,
    pub link: ServerLinkStatus,
    pub cas: Option<CasStatus>,
    pub renderer: RendererStatus,
    pub capability_revision: u64,
    pub systemd_watchdog: bool,
    pub last_legacy_import: Option<ShortToken>,
    /// Pairing of a fresh installation: the state and the visible code. The
    /// private poll secret never appears here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pairing: Option<PairingStatus>,
    /// The current activation and whether the renderer proved it. The
    /// migrator's settlement reads this; systemd unit states never replace it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presentation: Option<PresentationStatus>,
    /// Activity and telemetry reports waiting for the server (M8).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outbox: Option<OutboxStatus>,
}

/// The bounded report outbox: what waits, and what was lost and why.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OutboxStatus {
    pub queued_activity: u64,
    pub queued_telemetry: u64,
    /// Dropped oldest-first because the outbox was full.
    pub dropped_activity: u64,
    pub dropped_telemetry: u64,
    /// Refused by the server as invalid; never retried.
    pub rejected: u64,
    /// Telemetry older than the server's reporting window.
    pub expired: u64,
}

/// What the screen shows now, and the evidence for it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationStatus {
    /// `status_surface`, `fixture`, `server_manifest`, `safe_mode` or `policy`.
    pub source: ShortToken,
    pub generation: u64,
    /// The prepared manifest that the activation shows, if any.
    pub manifest_sha256: Option<Sha256Digest>,
    /// The manifest the server last selected for this screen, if any.
    pub target_manifest_sha256: Option<Sha256Digest>,
    /// The renderer accepted exactly this activation.
    pub accepted: bool,
    /// The renderer reported meaningful content evidence for it.
    pub evidence: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PairingStatus {
    /// `unpaired`, `waiting`, `renewing` or `paired`.
    pub state: ShortToken,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<ShortText>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<ShortToken>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum VerifyOutcome {
    Verified,
    Missing,
    /// The file did not match its digest or size and has been removed.
    Corrupt,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CasVerifyResult {
    pub sha256: Sha256Digest,
    pub outcome: VerifyOutcome,
}
