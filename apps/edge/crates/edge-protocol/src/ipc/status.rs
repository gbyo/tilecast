//! Result types returned to `tilecastctl`. Bounded, and free of secrets by
//! construction: nothing here can hold a credential or key.

use serde::{Deserialize, Serialize};

use crate::bounded::{DetailText, ShortText, ShortToken};
use crate::digest::Sha256Digest;
use crate::ids::{InstallationId, NodeId, ScreenId};
use crate::time::Timestamp;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DaemonMode {
    /// State is open; normal operation.
    Normal,
    /// The state database could not be opened or failed its integrity check.
    /// IPC and diagnostics work; identity and content are never recreated.
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CertificateStatus {
    /// Last 12 hex characters of the certificate fingerprint.
    pub fingerprint_suffix: ShortText,
    pub not_before: Timestamp,
    pub not_after: Timestamp,
    pub renew_after: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EdgeIdentityStatus {
    pub state: ShortToken,
    pub certificate: Option<CertificateStatus>,
    pub last_error: Option<ShortToken>,
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
pub struct MeshStatus {
    pub state: ShortToken,
    pub peer_count: u32,
    pub last_peer_change_at: Option<Timestamp>,
    pub reason_code: Option<ShortToken>,
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
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DaemonStatus {
    pub daemon_version: ShortText,
    pub mode: DaemonMode,
    pub recovery_reason: Option<ShortToken>,
    pub started_at: Timestamp,
    pub node_id: Option<NodeId>,
    pub server: Option<ServerBindingStatus>,
    pub identity: EdgeIdentityStatus,
    pub cas: Option<CasStatus>,
    pub mesh: MeshStatus,
    pub renderer: RendererStatus,
    pub capability_revision: u64,
    pub systemd_watchdog: bool,
    pub last_legacy_import: Option<ShortToken>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PeerSummary {
    pub node_id: NodeId,
    pub screen_id: Option<ScreenId>,
    pub edge_version: Option<ShortText>,
    pub blob_endpoint: Option<ShortText>,
    pub last_seen_at: Timestamp,
    pub present: bool,
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
