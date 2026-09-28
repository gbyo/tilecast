//! Presentation Networks on Tilecast Edge (M9): a typed client for the
//! existing root helper `tilecast-networkd` and the reconciliation around it.
//!
//! This is a port of the Electron player's client layer only
//! (`apps/player-linux/src/core/presentation-network.ts` and
//! `src/main/presentation-network.ts`). Every NetworkManager operation, the
//! `tilecast-presentation-<uuid>` profile namespace, the radio-state rule
//! and the Ethernet default-route check stay in the helper
//! (`apps/server/internal/httpapi/install/tilecast-networkd`), which Edge
//! reuses unchanged. Edge adds no privileged code.
//!
//! Protocol: one JSON object and a newline per connection to the helper's
//! socket (`/run/tilecast/networkd.sock`), one JSON line back, bounded to
//! [`MAX_RESPONSE_BYTES`], with a timeout per operation.
//!
//! The Wi-Fi credential is fetched from `GET /api/v1/player/presentation-
//! network` only when a profile must be installed, used for that one
//! `install` request and dropped. It is never stored, logged, sent over
//! local IPC or put in a process argument. SQLite keeps only which Tilecast
//! connection is up and whether the radio was on before Tilecast turned it
//! on (migration 0005).

use std::path::{Path, PathBuf};
use std::time::Duration;

use async_trait::async_trait;
use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortText, ShortToken, Token};
use edge_protocol::capability::{AttributeValue, Capability, CapabilityId, CapabilityState, ids};
use edge_server::player_api::{NetworkProvisioning, is_uuid, network_security};
use edge_state::StateDb;
use edge_state::repo::commands::CommandResult;
use edge_state::repo::presentation_network::{self as store, NetworkState};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt as _, AsyncWriteExt as _};

pub const DEFAULT_HELPER_SOCKET: &str = "/run/tilecast/networkd.sock";
pub const MAX_RESPONSE_BYTES: usize = 256 * 1024;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// One activation: enterprise authentication plus DHCP can take tens of
/// seconds.
pub const ACTIVATION_TIMEOUT: Duration = Duration::from_secs(75);
const MAX_PROFILES: usize = 64;
const MAX_TEXT: usize = 240;

// ------------------------------------------------------------ the assignment

/// The non-secret assignment from the configuration's `presentationNetwork`
/// section. `assigned: false` is an instruction to remove every Tilecast
/// profile, not an absence.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Assignment {
    pub network_id: String,
    pub name: String,
    pub ssid: String,
    pub hidden: bool,
    pub security: &'static str,
    pub config_revision: i64,
    pub credential_available: bool,
}

fn optional_text(section: &Map<String, Value>, key: &str, max_chars: usize) -> Result<String, &'static str> {
    match section.get(key) {
        Some(Value::String(text)) if text.chars().count() > max_chars => {
            Err("a Presentation Network field is too long")
        }
        Some(Value::String(text)) => Ok(text.clone()),
        _ => Ok(String::new()),
    }
}

/// The reference player's `parsePresentationNetworkAssignment`: `Ok(None)`
/// for "not assigned", an error for anything half-understood.
pub fn parse_assignment(section: &Value) -> Result<Option<Assignment>, &'static str> {
    let Some(section) = section.as_object() else { return Ok(None) };
    if section.get("assigned") != Some(&Value::Bool(true)) {
        return Ok(None);
    }
    let network_id = section
        .get("presentationNetworkId")
        .and_then(Value::as_str)
        .filter(|id| is_uuid(id))
        .ok_or("Presentation Network ID is invalid")?
        .to_ascii_lowercase();
    let ssid = section
        .get("ssid")
        .and_then(Value::as_str)
        .filter(|ssid| !ssid.is_empty() && ssid.chars().count() <= 32)
        .ok_or("Presentation Network SSID is invalid")?
        .to_owned();
    let security = section
        .get("security")
        .and_then(Value::as_str)
        .and_then(network_security)
        .ok_or("Presentation Network authentication type is unsupported")?;
    let config_revision = section
        .get("configRevision")
        .and_then(Value::as_i64)
        .filter(|revision| *revision >= 1)
        .ok_or("Presentation Network configuration revision is invalid")?;
    for (key, limit) in [("identity", 253), ("anonymousIdentity", 253), ("domainSuffixMatch", 253)] {
        optional_text(section, key, limit)?;
    }
    Ok(Some(Assignment {
        network_id,
        name: optional_text(section, "name", 120)?,
        ssid,
        hidden: section.get("hidden") == Some(&Value::Bool(true)),
        security,
        config_revision,
        credential_available: section.get("credentialAvailable") == Some(&Value::Bool(true)),
    }))
}

// ------------------------------------------------------------ the helper

/// What the helper reports, parsed as the reference player does.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct HelperStatus {
    /// NetworkManager is reachable and the helper is healthy.
    pub supported: bool,
    /// `ok`, `missing`, `unhealthy` or `unsupported`.
    pub helper_state: &'static str,
    pub network_manager_available: bool,
    pub wifi_adapter: bool,
    pub radio_enabled: bool,
    pub wired_interface_available: bool,
    pub wired_ipv4: String,
    pub default_route_interface: String,
    pub active_network_id: String,
    pub installed: Vec<(String, i64)>,
    pub limitation: Option<String>,
}

impl HelperStatus {
    fn unsupported(helper_state: &'static str, limitation: &str) -> Self {
        Self {
            supported: false,
            helper_state,
            network_manager_available: false,
            wifi_adapter: false,
            radio_enabled: false,
            wired_interface_available: false,
            wired_ipv4: String::new(),
            default_route_interface: String::new(),
            active_network_id: String::new(),
            installed: Vec::new(),
            limitation: Some(limitation.to_owned()),
        }
    }
}

/// The helper's activation answer.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Activation {
    pub ipv4: String,
    pub radio_was_enabled: bool,
    pub default_route_interface: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum HelperError {
    /// No socket, or nothing listening: the helper is not installed or not
    /// running.
    #[error("the Tilecast presentation-network helper is not installed or not running")]
    Missing,
    /// It answered badly, too much, or not in time.
    #[error("{0}")]
    Unavailable(&'static str),
    /// It refused the operation with one of its stable codes.
    #[error("{message}")]
    Refused { code: &'static str, message: String },
}

/// A usable group-RTP destination (the reference player's `validIpv4`).
pub fn valid_ipv4(value: &str) -> bool {
    let parts: Vec<&str> = value.trim().split('.').collect();
    if parts.len() != 4 {
        return false;
    }
    let mut octets = [0u16; 4];
    for (index, part) in parts.iter().enumerate() {
        let canonical = !part.is_empty()
            && part.len() <= 3
            && part.bytes().all(|b| b.is_ascii_digit())
            && !(part.len() > 1 && part.starts_with('0'));
        match part.parse::<u16>() {
            Ok(octet) if canonical && octet <= 255 => octets[index] = octet,
            _ => return false,
        }
    }
    !(octets[0] == 0 || octets[0] == 127 || octets[0] >= 224 || (octets[0] == 169 && octets[1] == 254))
}

/// Wireless interface names, to detect a sidecar that captured the default
/// route.
pub fn is_wireless_interface(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    ["wl", "wlan", "wlp", "ath", "ra"].iter().any(|prefix| lower.starts_with(prefix))
}

/// The helper's stable failure codes, and nothing else (the reference
/// player's `activationFailureCode`).
pub fn activation_failure_code(code: Option<&str>) -> &'static str {
    match code {
        Some("authentication_failed") => "authentication_failed",
        Some("ssid_not_found") => "ssid_not_found",
        Some("association_timeout") => "association_timeout",
        Some("dhcp_timeout") => "dhcp_timeout",
        Some("radio_unavailable") => "radio_unavailable",
        Some("wifi_adapter_unavailable") => "wifi_adapter_unavailable",
        Some("network_manager_unavailable") => "network_manager_unavailable",
        Some("profile_missing") => "profile_install_failed",
        _ => "activation_failed",
    }
}

fn bounded(text: &str, max_chars: usize) -> String {
    text.chars().filter(|c| !c.is_control()).take(max_chars).collect()
}

fn helper_message(response: &Map<String, Value>, fallback: &str) -> String {
    response
        .get("message")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|message| !message.is_empty())
        .map_or_else(|| fallback.to_owned(), |message| bounded(message, 200))
}

/// The typed helper client. There is no generic request: each operation
/// builds its own fixed JSON object.
#[derive(Debug, Clone)]
pub struct HelperClient {
    socket: PathBuf,
}

impl HelperClient {
    pub fn new(socket: impl Into<PathBuf>) -> Self {
        Self { socket: socket.into() }
    }

    async fn request(&self, payload: &Value, timeout: Duration) -> Result<Map<String, Value>, HelperError> {
        let exchange = async {
            let mut stream = match tokio::net::UnixStream::connect(&self.socket).await {
                Ok(stream) => stream,
                Err(error)
                    if matches!(error.kind(), std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused) =>
                {
                    return Err(HelperError::Missing);
                }
                Err(_) => {
                    return Err(HelperError::Unavailable("The presentation-network helper could not be reached."));
                }
            };
            let mut line = serde_json::to_vec(payload).map_err(|_| HelperError::Unavailable("invalid request"))?;
            line.push(b'\n');
            stream
                .write_all(&line)
                .await
                .map_err(|_| HelperError::Unavailable("The presentation-network helper closed the connection."))?;
            let mut buffer = Vec::with_capacity(4096);
            let mut chunk = [0u8; 8192];
            loop {
                let read = stream
                    .read(&mut chunk)
                    .await
                    .map_err(|_| HelperError::Unavailable("The presentation-network helper closed the connection."))?;
                if read == 0 {
                    return Err(HelperError::Unavailable("The presentation-network helper closed the connection."));
                }
                buffer.extend_from_slice(&chunk[..read]);
                if let Some(end) = buffer.iter().position(|byte| *byte == b'\n') {
                    buffer.truncate(end);
                    break;
                }
                if buffer.len() > MAX_RESPONSE_BYTES {
                    return Err(HelperError::Unavailable(
                        "The presentation-network helper returned an oversized response.",
                    ));
                }
            }
            match serde_json::from_slice::<Value>(&buffer) {
                Ok(Value::Object(object)) => Ok(object),
                _ => Err(HelperError::Unavailable("The presentation-network helper returned an unreadable response.")),
            }
        };
        tokio::time::timeout(timeout, exchange)
            .await
            .unwrap_or(Err(HelperError::Unavailable("The presentation-network helper did not respond in time.")))
    }

    /// Capability and current state. A missing helper and an unhealthy one
    /// are reported apart: they send an operator to different fixes.
    pub async fn status(&self) -> HelperStatus {
        let response = match self.request(&json!({"op": "status"}), REQUEST_TIMEOUT).await {
            Ok(response) => response,
            Err(HelperError::Missing) => {
                return HelperStatus::unsupported(
                    "missing",
                    "The Tilecast presentation-network helper is not installed or not running.",
                );
            }
            Err(_) => {
                return HelperStatus::unsupported(
                    "unhealthy",
                    "The Tilecast presentation-network helper is installed but did not respond.",
                );
            }
        };
        if response.get("ok") != Some(&Value::Bool(true)) {
            return HelperStatus::unsupported(
                "unhealthy",
                "The Tilecast presentation-network helper reported a failure.",
            );
        }
        let flag = |key: &str| response.get(key) == Some(&Value::Bool(true));
        let text = |key: &str, max: usize| response.get(key).and_then(Value::as_str).map(|v| bounded(v, max));
        let manager = flag("networkManagerAvailable");
        let installed = response
            .get("profiles")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|entry| {
                let id = entry.get("networkId")?.as_str().filter(|id| is_uuid(id))?.to_ascii_lowercase();
                Some((id, entry.get("revision").and_then(Value::as_i64).unwrap_or(0)))
            })
            .take(MAX_PROFILES)
            .collect();
        HelperStatus {
            supported: manager,
            helper_state: if manager { "ok" } else { "unsupported" },
            network_manager_available: manager,
            wifi_adapter: flag("wifiAdapter"),
            radio_enabled: flag("radioEnabled"),
            wired_interface_available: flag("wiredInterfaceAvailable"),
            wired_ipv4: text("wiredIpv4", 15).filter(|ip| valid_ipv4(ip)).unwrap_or_default(),
            default_route_interface: text("defaultRouteInterface", 32).unwrap_or_default(),
            active_network_id: text("activeNetworkId", 36)
                .filter(|id| is_uuid(id))
                .map(|id| id.to_ascii_lowercase())
                .unwrap_or_default(),
            installed,
            limitation: text("limitation", MAX_TEXT).filter(|limitation| !limitation.is_empty()),
        }
    }

    /// Installs or replaces one profile. The credential travels over the
    /// socket only, never in a process argument.
    pub async fn install(&self, material: &NetworkProvisioning) -> Result<(), HelperError> {
        let request = json!({
            "op": "install",
            "networkId": material.network_id,
            "revision": material.config_revision,
            "ssid": material.ssid,
            "hidden": material.hidden,
            "security": material.security,
            "secret": material.secret(),
            "identity": material.identity,
            "anonymousIdentity": material.anonymous_identity,
            "domainSuffixMatch": material.domain_suffix_match,
            "caCertificatePem": material.ca_certificate_pem,
        });
        let response = self.request(&request, REQUEST_TIMEOUT).await?;
        if response.get("ok") == Some(&Value::Bool(true)) {
            return Ok(());
        }
        Err(HelperError::Refused {
            code: "profile_install_failed",
            message: helper_message(&response, "The Presentation Network profile could not be installed."),
        })
    }

    pub async fn activate(&self, network_id: &str, timeout: Duration) -> Result<Activation, HelperError> {
        let seconds = timeout.as_secs().clamp(15, 180);
        let response = self
            .request(
                &json!({"op": "activate", "networkId": network_id, "timeoutSeconds": seconds}),
                Duration::from_secs(seconds + 10),
            )
            .await?;
        if response.get("ok") != Some(&Value::Bool(true)) {
            return Err(HelperError::Refused {
                code: activation_failure_code(response.get("code").and_then(Value::as_str)),
                message: helper_message(&response, "The Presentation Network could not be activated."),
            });
        }
        let text = |key: &str| response.get(key).and_then(Value::as_str).map(|v| bounded(v, 32)).unwrap_or_default();
        Ok(Activation {
            ipv4: Some(text("ipv4")).filter(|ip| valid_ipv4(ip)).unwrap_or_default(),
            radio_was_enabled: response.get("radioWasEnabled") == Some(&Value::Bool(true)),
            default_route_interface: text("defaultRouteInterface"),
        })
    }

    /// Idempotent; never fails loudly.
    pub async fn deactivate(&self, network_id: &str, restore_radio_disabled: bool) {
        let request =
            json!({"op": "deactivate", "networkId": network_id, "restoreRadioDisabled": restore_radio_disabled});
        let _ = self.request(&request, REQUEST_TIMEOUT).await;
    }

    /// Idempotent; never fails loudly.
    pub async fn delete(&self, network_id: &str) {
        let _ = self.request(&json!({"op": "delete", "networkId": network_id}), REQUEST_TIMEOUT).await;
    }
}

// ------------------------------------------------------------ reconciliation

/// Where the credential comes from: the authenticated server, or a test.
#[async_trait]
pub trait Provisioner: Send + Sync {
    async fn provisioning(&self) -> Result<NetworkProvisioning, String>;
}

/// What the player reports and Studio turns into a status.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Status {
    /// `unsupported`, `unassigned`, `pending`, `provisioned`, `joining`,
    /// `connected` or `failed`.
    pub state: &'static str,
    pub network_id: Option<String>,
    pub active_network_id: Option<String>,
    pub installed_network_id: Option<String>,
    pub installed_revision: Option<i64>,
    pub failure_code: Option<&'static str>,
    pub failure_message: Option<String>,
    pub last_connected_at: Option<Timestamp>,
    pub last_failure_at: Option<Timestamp>,
}

#[derive(Debug, Default)]
struct Inner {
    /// `None` until the configuration has said anything.
    assignment: Option<Option<Assignment>>,
    capability: Option<HelperStatus>,
    persisted: NetworkState,
    loaded: bool,
    status: Status,
}

#[derive(Debug)]
pub struct PresentationNetwork {
    helper: HelperClient,
    db: Option<StateDb>,
    /// Serializes every helper interaction: two activations never race.
    inner: tokio::sync::Mutex<Inner>,
    /// The last settled capability and status, readable without waiting for
    /// an operation in progress (an activation can take over a minute).
    published: std::sync::Mutex<(Option<HelperStatus>, Status)>,
}

fn failed(code: &'static str, message: &str) -> CommandResult {
    CommandResult::failed(code, message)
}

impl PresentationNetwork {
    pub fn new(helper: HelperClient, db: Option<StateDb>) -> Self {
        let status = Status { state: "unassigned", ..Status::default() };
        Self {
            helper,
            db,
            inner: tokio::sync::Mutex::new(Inner { status: status.clone(), ..Inner::default() }),
            published: std::sync::Mutex::new((None, status)),
        }
    }

    fn publish(&self, inner: &Inner) {
        *self.published.lock().unwrap_or_else(|poison| poison.into_inner()) =
            (inner.capability.clone(), inner.status.clone());
    }

    pub fn socket(&self) -> &Path {
        &self.helper.socket
    }

    async fn load(&self, inner: &mut Inner) {
        if inner.loaded {
            return;
        }
        inner.loaded = true;
        if let Some(db) = &self.db {
            // An unreadable record is discarded: the safe default says the
            // radio was already on, so Tilecast never turns it off.
            inner.persisted = db.run(|c| store::get(c)).await.unwrap_or_default();
        }
    }

    async fn persist(&self, inner: &mut Inner, state: NetworkState, now: Timestamp) {
        inner.persisted = state.clone();
        if let Some(db) = &self.db
            && let Err(error) = db.run(move |c| store::put(c, &state, now)).await
        {
            tracing::warn!(component = "network", event = "state_persist_failed", error = %error);
        }
    }

    fn set_status(inner: &mut Inner, state: &'static str, failure: Option<(&'static str, String)>, now: Timestamp) {
        let assignment = inner.assignment.clone().flatten();
        let installed = assignment.as_ref().and_then(|assignment| {
            inner.capability.as_ref()?.installed.iter().find(|(id, _)| *id == assignment.network_id).cloned()
        });
        let previous = std::mem::take(&mut inner.status);
        let failing = failure.is_some();
        inner.status =
            Status {
                state,
                network_id: assignment.map(|a| a.network_id),
                active_network_id: inner.persisted.active_network_id.clone().or_else(|| {
                    inner.capability.as_ref().map(|c| c.active_network_id.clone()).filter(|id| !id.is_empty())
                }),
                installed_network_id: installed.as_ref().map(|(id, _)| id.clone()),
                installed_revision: installed.map(|(_, revision)| revision),
                failure_code: failure.as_ref().map(|(code, _)| *code),
                failure_message: failure.map(|(_, message)| bounded(&message, MAX_TEXT)),
                last_connected_at: if state == "connected" { Some(now) } else { previous.last_connected_at },
                last_failure_at: if failing && state == "failed" { Some(now) } else { previous.last_failure_at },
            };
    }

    /// Applies the configuration's section. Absent (`None`) means a server
    /// that predates the feature: nothing is removed then. A malformed
    /// section is ignored and the previous state stays.
    pub async fn apply_configuration(&self, section: Option<&Value>, provisioner: &dyn Provisioner, now: Timestamp) {
        let Some(section) = section else { return };
        let assignment = match parse_assignment(section) {
            Ok(assignment) => assignment,
            Err(reason) => {
                tracing::warn!(component = "network", event = "assignment_rejected", reason);
                return;
            }
        };
        let mut inner = self.inner.lock().await;
        let changed = inner.assignment.as_ref() != Some(&assignment);
        inner.assignment = Some(assignment.clone());
        if changed {
            tracing::info!(
                component = "network",
                event = "assignment_applied",
                network = assignment.as_ref().map_or("", |a| a.network_id.as_str()),
                revision = assignment.as_ref().map_or(0, |a| a.config_revision)
            );
        }
        self.reconcile_locked(&mut inner, provisioner, now).await;
        self.publish(&inner);
    }

    pub async fn reconcile(&self, provisioner: &dyn Provisioner, now: Timestamp) -> Status {
        let mut inner = self.inner.lock().await;
        self.reconcile_locked(&mut inner, provisioner, now).await;
        self.publish(&inner);
        inner.status.clone()
    }

    /// Converges the installed Tilecast profiles on the assignment: deletes
    /// every profile that does not belong, installs a missing or stale one.
    async fn reconcile_locked(&self, inner: &mut Inner, provisioner: &dyn Provisioner, now: Timestamp) {
        self.load(inner).await;
        let capability = self.helper.status().await;
        inner.capability = Some(capability.clone());
        if !capability.network_manager_available {
            let code =
                if capability.helper_state == "missing" { "helper_unavailable" } else { "network_manager_unavailable" };
            Self::set_status(inner, "unsupported", Some((code, capability.limitation.unwrap_or_default())), now);
            return;
        }
        let assignment = inner.assignment.clone().flatten();
        for (network_id, _) in &capability.installed {
            if assignment.as_ref().is_some_and(|a| a.network_id == *network_id) {
                continue;
            }
            tracing::info!(component = "network", event = "obsolete_profile_removed", network = network_id.as_str());
            self.helper.delete(network_id).await;
            if inner.persisted.active_network_id.as_deref() == Some(network_id.as_str()) {
                let state = NetworkState { active_network_id: None, ..inner.persisted.clone() };
                self.persist(inner, state, now).await;
            }
        }
        let Some(assignment) = assignment else {
            Self::set_status(inner, "unassigned", None, now);
            return;
        };
        if !capability.wifi_adapter {
            Self::set_status(
                inner,
                "failed",
                Some((
                    "wifi_adapter_unavailable",
                    "This player has no usable Wi-Fi adapter, so it cannot join a Presentation Network.".into(),
                )),
                now,
            );
            return;
        }
        let fresh = self.helper.status().await;
        let current = fresh
            .installed
            .iter()
            .any(|(id, revision)| *id == assignment.network_id && *revision == assignment.config_revision);
        inner.capability = Some(fresh);
        if current {
            Self::set_status(inner, "provisioned", None, now);
            return;
        }
        if !assignment.credential_available {
            Self::set_status(
                inner,
                "failed",
                Some((
                    "credential_unavailable",
                    "The Presentation Network credential is unavailable on the Tilecast server.".into(),
                )),
                now,
            );
            return;
        }
        Self::set_status(inner, "pending", None, now);
        self.provision(inner, &assignment, provisioner, now).await;
    }

    /// The only place the credential exists in this process, for the length
    /// of one helper call.
    async fn provision(
        &self,
        inner: &mut Inner,
        assignment: &Assignment,
        provisioner: &dyn Provisioner,
        now: Timestamp,
    ) {
        let material = match provisioner.provisioning().await {
            Ok(material) => material,
            Err(message) => {
                Self::set_status(inner, "failed", Some(("credential_unavailable", message)), now);
                return;
            }
        };
        if material.network_id != assignment.network_id {
            // The assignment changed while the request was in flight.
            Self::set_status(inner, "pending", None, now);
            return;
        }
        let installed = self.helper.install(&material).await;
        drop(material);
        if let Err(error) = installed {
            let code = match &error {
                HelperError::Refused { code, .. } => *code,
                _ => "profile_install_failed",
            };
            Self::set_status(inner, "failed", Some((code, error.to_string())), now);
            return;
        }
        inner.capability = Some(self.helper.status().await);
        tracing::info!(
            component = "network",
            event = "profile_installed",
            network = assignment.network_id.as_str(),
            revision = assignment.config_revision
        );
        Self::set_status(inner, "provisioned", None, now);
    }

    /// Joins the assigned network and checks it is usable as a sidecar:
    /// an IPv4 address, and Ethernet still the default route.
    async fn connect_locked(
        &self,
        inner: &mut Inner,
        provisioner: &dyn Provisioner,
        now: impl Fn() -> Timestamp,
    ) -> Result<(), (&'static str, String)> {
        self.load(inner).await;
        let Some(assignment) = inner.assignment.clone().flatten() else {
            Self::set_status(inner, "unassigned", None, now());
            return Ok(());
        };
        self.reconcile_locked(inner, provisioner, now()).await;
        if matches!(inner.status.state, "failed" | "unsupported") {
            return Err((
                inner.status.failure_code.unwrap_or("activation_failed"),
                inner.status.failure_message.clone().unwrap_or_else(|| "The Presentation Network is not ready.".into()),
            ));
        }
        Self::set_status(inner, "joining", None, now());
        let activation = match self.helper.activate(&assignment.network_id, ACTIVATION_TIMEOUT).await {
            Ok(activation) => activation,
            Err(error) => {
                let code = match &error {
                    HelperError::Refused { code, .. } => *code,
                    _ => "activation_failed",
                };
                Self::set_status(inner, "failed", Some((code, error.to_string())), now());
                return Err((code, error.to_string()));
            }
        };
        // The prior radio state is recorded before anything else can fail, so
        // a teardown always knows whether Tilecast may turn the radio off.
        let state = NetworkState {
            active_network_id: Some(assignment.network_id.clone()),
            radio_was_enabled: activation.radio_was_enabled,
        };
        self.persist(inner, state, now()).await;
        let refuse = |code: &'static str, message: &str| (code, message.to_owned());
        let failure = if activation.ipv4.is_empty() {
            Some(refuse("dhcp_timeout", "The Presentation Network did not provide a usable IPv4 address."))
        } else {
            let capability = self.helper.status().await;
            let route = if activation.default_route_interface.is_empty() {
                capability.default_route_interface.clone()
            } else {
                activation.default_route_interface.clone()
            };
            let wired_usable = capability.wired_interface_available && valid_ipv4(&capability.wired_ipv4);
            inner.capability = Some(capability);
            if !wired_usable {
                Some(refuse(
                    "ethernet_default_route_lost",
                    "Ethernet is no longer usable on this player, so Tilecast disconnected the temporary Wi-Fi \
                     connection.",
                ))
            } else if !route.is_empty() && is_wireless_interface(&route) {
                Some(refuse(
                    "ethernet_default_route_lost",
                    "The temporary Wi-Fi connection became this player's default route, so Tilecast disconnected it.",
                ))
            } else {
                None
            }
        };
        if let Some((code, message)) = failure {
            self.disconnect_locked(inner, "sidecar_check_failed", now()).await;
            Self::set_status(inner, "failed", Some((code, message.clone())), now());
            return Err((code, message));
        }
        tracing::info!(component = "network", event = "joined", network = assignment.network_id.as_str());
        Self::set_status(inner, "connected", None, now());
        Ok(())
    }

    /// Leaves the network. Idempotent; the radio goes off only if Tilecast
    /// turned it on; the saved profile stays for the next session.
    async fn disconnect_locked(&self, inner: &mut Inner, reason: &str, now: Timestamp) {
        self.load(inner).await;
        let active = inner
            .persisted
            .active_network_id
            .clone()
            .or_else(|| inner.capability.as_ref().map(|c| c.active_network_id.clone()).filter(|id| !id.is_empty()));
        let settled = if inner.assignment.clone().flatten().is_some() { "provisioned" } else { "unassigned" };
        let Some(active) = active else {
            Self::set_status(inner, settled, None, now);
            return;
        };
        let restore = !inner.persisted.radio_was_enabled;
        tracing::info!(component = "network", event = "leaving", network = active.as_str(), reason, restore);
        self.helper.deactivate(&active, restore).await;
        self.persist(inner, NetworkState::default(), now).await;
        if let Some(capability) = inner.capability.as_mut() {
            capability.active_network_id.clear();
        }
        Self::set_status(inner, settled, None, now);
    }

    /// A Tilecast connection that is up at startup is left over from a
    /// crash: Edge has no AirPlay session that could be using it.
    pub async fn cleanup_orphaned(&self, now: Timestamp) {
        let mut inner = self.inner.lock().await;
        self.load(&mut inner).await;
        let capability = self.helper.status().await;
        let helper_active = Some(capability.active_network_id.clone()).filter(|id| !id.is_empty());
        let manager = capability.network_manager_available;
        inner.capability = Some(capability);
        if !manager {
            return;
        }
        if helper_active.is_some() || inner.persisted.active_network_id.is_some() {
            tracing::warn!(component = "network", event = "orphaned_connection_cleanup");
            self.disconnect_locked(&mut inner, "orphaned", now).await;
        }
        self.publish(&inner);
    }

    /// Refreshes the helper's capability for status and heartbeat.
    pub async fn probe(&self) -> HelperStatus {
        let capability = self.helper.status().await;
        let mut inner = self.inner.lock().await;
        inner.capability = Some(capability.clone());
        self.publish(&inner);
        capability
    }

    /// `provision_presentation_network`, with the reference result codes.
    pub async fn provision_command(&self, provisioner: &dyn Provisioner, now: Timestamp) -> CommandResult {
        let status = self.reconcile(provisioner, now).await;
        let capability = self.inner.lock().await.capability.clone();
        if capability.as_ref().is_some_and(|c| !c.network_manager_available) {
            let limitation = capability.and_then(|c| c.limitation);
            return failed(
                "presentation_network_unsupported",
                limitation.as_deref().unwrap_or("NetworkManager is not available on this player."),
            );
        }
        if status.state == "failed" {
            return failed(
                status.failure_code.unwrap_or("presentation_network_failed"),
                "The Presentation Network could not be provisioned.",
            );
        }
        CommandResult::ok("presentation_network_reconciled", "Presentation Network configuration is up to date.")
    }

    /// `test_presentation_network`: join, check the address and that Ethernet
    /// stays primary, then leave and restore the radio, whatever happened.
    pub async fn test_command(
        &self,
        payload: &Map<String, Value>,
        provisioner: &dyn Provisioner,
        now: impl Fn() -> Timestamp,
    ) -> CommandResult {
        let Some(network_id) = payload.get("presentationNetworkId").and_then(Value::as_str).filter(|id| id.len() <= 64)
        else {
            return failed("presentation_network_invalid", "The Presentation Network test payload is invalid.");
        };
        let mut inner = self.inner.lock().await;
        let Some(assignment) = inner.assignment.clone().flatten().filter(|a| a.network_id == network_id.to_lowercase())
        else {
            return failed(
                "presentation_network_not_assigned",
                "This player has not received that Presentation Network assignment yet.",
            );
        };
        let joined = self.connect_locked(&mut inner, provisioner, &now).await;
        let result = match joined {
            Ok(()) if inner.status.state == "connected" => {
                let ethernet =
                    inner.capability.as_ref().is_some_and(|c| c.wired_interface_available && valid_ipv4(&c.wired_ipv4));
                if ethernet {
                    CommandResult::ok(
                        "presentation_network_test_passed",
                        &format!(
                            "Joined {}: authentication succeeded, an IPv4 address was obtained, and Ethernet remains \
                             this player's primary connection.",
                            assignment.name
                        ),
                    )
                } else {
                    failed(
                        "ethernet_default_route_lost",
                        &format!(
                            "Joined {}, but Ethernet is no longer usable as this player's primary connection.",
                            assignment.name
                        ),
                    )
                }
            }
            Ok(()) => failed(
                inner.status.failure_code.unwrap_or("presentation_network_failed"),
                &format!("Tilecast could not join {}.", assignment.name),
            ),
            Err((code, message)) => failed(code, &message),
        };
        let outcome = inner.status.clone();
        self.disconnect_locked(&mut inner, "connection_test_complete", now()).await;
        // A failure stays visible after the teardown, as on the reference
        // player: Studio reports its code.
        if !result.success {
            inner.status.failure_code = Some(match result.code.as_str() {
                "ethernet_default_route_lost" => "ethernet_default_route_lost",
                _ => outcome.failure_code.unwrap_or("presentation_network_failed"),
            });
            inner.status.failure_message = Some(bounded(&result.message, MAX_TEXT));
            inner.status.last_failure_at = outcome.last_failure_at.or(Some(now()));
        }
        self.publish(&inner);
        result
    }

    /// The last settled state, without waiting for an operation.
    pub fn status(&self) -> (Option<HelperStatus>, Status) {
        self.published.lock().unwrap_or_else(|poison| poison.into_inner()).clone()
    }
}

/// The heartbeat's Presentation Network fields, as the reference player
/// sends them. `wired` is the sysfs fallback for a machine without the
/// helper.
pub fn heartbeat(heartbeat: &mut Value, capability: Option<&HelperStatus>, status: &Status, wired: Option<bool>) {
    if let Some(capability) = capability {
        heartbeat["presentationNetworkSupported"] = json!(capability.supported);
        heartbeat["presentationNetworkHelperState"] = json!(capability.helper_state);
        heartbeat["presentationNetworkManagerAvailable"] = json!(capability.network_manager_available);
        heartbeat["presentationNetworkWifiAdapter"] = json!(capability.wifi_adapter);
        heartbeat["presentationNetworkRadioEnabled"] = json!(capability.radio_enabled);
        if let Some(limitation) = &capability.limitation {
            heartbeat["presentationNetworkLimitation"] = json!(bounded(limitation, MAX_TEXT));
        }
        if capability.wired_interface_available {
            heartbeat["wiredInterfaceAvailable"] = json!(true);
            if !capability.wired_ipv4.is_empty() {
                heartbeat["wiredIpv4"] = json!(capability.wired_ipv4);
            }
        }
    }
    if heartbeat.get("wiredInterfaceAvailable").is_none()
        && let Some(available) = wired
    {
        heartbeat["wiredInterfaceAvailable"] = json!(available);
    }
    heartbeat["presentationNetworkState"] = json!(status.state);
    if let Some(id) = &status.installed_network_id {
        heartbeat["presentationNetworkInstalledId"] = json!(id);
    }
    if let Some(revision) = status.installed_revision {
        heartbeat["presentationNetworkInstalledRevision"] = json!(revision);
    }
    if let Some(id) = &status.active_network_id {
        heartbeat["presentationNetworkActiveId"] = json!(id);
    }
    if let Some(code) = status.failure_code {
        heartbeat["presentationNetworkLastFailureCode"] = json!(code);
    }
    if let Some(at) = status.last_connected_at {
        heartbeat["presentationNetworkLastConnectedAt"] = json!(at.to_string());
    }
    if let Some(at) = status.last_failure_at {
        heartbeat["presentationNetworkLastFailureAt"] = json!(at.to_string());
    }
}

/// Whether a physical Ethernet interface is up, from sysfs: the fallback
/// the reference player reads when the helper is absent.
pub fn wired_interface_up(sys_dir: &Path) -> bool {
    let Ok(entries) = std::fs::read_dir(sys_dir.join("class/net")) else { return false };
    entries.flatten().take(64).any(|entry| {
        let path = entry.path();
        let read = |name: &str| {
            edge_platform::fs::read_regular(&path.join(name), 64)
                .ok()
                .flatten()
                .map(|bytes| String::from_utf8_lossy(&bytes).trim().to_owned())
        };
        // ARPHRD_ETHER, backed by a device (not a bridge or veth), not Wi-Fi.
        read("type").as_deref() == Some("1")
            && path.join("device").exists()
            && !path.join("wireless").exists()
            && !path.join("phy80211").exists()
            && read("operstate").as_deref() == Some("up")
    })
}

/// `network.presentation_network`.
pub fn capability(capability: Option<&HelperStatus>, status: &Status, now: Timestamp) -> Option<Capability> {
    let (state, reason) = match capability {
        None => (CapabilityState::Supported, Some("not_probed")),
        Some(c) if c.helper_state == "missing" => (CapabilityState::Unsupported, Some("helper_unavailable")),
        Some(c) if c.helper_state == "unhealthy" => (CapabilityState::Degraded, Some("helper_unhealthy")),
        Some(c) if !c.network_manager_available => (CapabilityState::Unsupported, Some("network_manager_unavailable")),
        Some(c) if !c.wifi_adapter => (CapabilityState::Unsupported, Some("wifi_adapter_unavailable")),
        Some(_) if status.state == "failed" => (CapabilityState::Degraded, status.failure_code),
        Some(_) => (CapabilityState::Available, None),
    };
    let mut out = Capability::new(CapabilityId::new(ids::NETWORK_PRESENTATION_NETWORK).ok()?, state, now);
    out.provider = ShortToken::new("tilecast-networkd").ok();
    out.reason_code = reason.and_then(|reason| ShortToken::new(reason).ok());
    out.detail = capability.and_then(|c| c.limitation.as_deref()).map(DetailText::lossy);
    if let Ok(key) = Token::<48>::new("state") {
        out.attributes.insert(key, AttributeValue::Text(ShortText::lossy(status.state)));
    }
    Some(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn assignments_are_strict_and_unassigned_is_an_instruction() {
        let valid = json!({"assigned": true, "presentationNetworkId": "6F0C2B1E-9D2A-4B7E-8F3A-2C1D0E9F8A7B",
            "name": "Library AV", "ssid": "Library-AV", "security": "wpa_psk", "configRevision": 2,
            "credentialAvailable": true});
        let parsed = parse_assignment(&valid).unwrap().unwrap();
        assert_eq!(parsed.network_id, "6f0c2b1e-9d2a-4b7e-8f3a-2c1d0e9f8a7b");
        assert!(parsed.credential_available);
        assert_eq!(parse_assignment(&json!({"assigned": false})), Ok(None));
        for (key, bad) in [
            ("presentationNetworkId", json!("not-a-uuid")),
            ("ssid", json!("")),
            ("security", json!("wep")),
            ("configRevision", json!(0)),
            ("identity", json!("x".repeat(254))),
        ] {
            let mut section = valid.clone();
            section[key] = bad;
            assert!(parse_assignment(&section).is_err(), "{key}");
        }
    }

    #[test]
    fn addresses_and_codes_match_the_reference_player() {
        for good in ["10.10.2.15", "192.168.1.9"] {
            assert!(valid_ipv4(good), "{good}");
        }
        for bad in ["0.1.2.3", "127.0.0.1", "224.0.0.1", "169.254.1.1", "10.0.0", "10.00.0.1", "1.2.3.256", ""] {
            assert!(!valid_ipv4(bad), "{bad}");
        }
        assert!(is_wireless_interface("wlp2s0") && is_wireless_interface("wlan0") && !is_wireless_interface("eth0"));
        assert_eq!(activation_failure_code(Some("profile_missing")), "profile_install_failed");
        assert_eq!(activation_failure_code(Some("something_new")), "activation_failed");
    }

    #[tokio::test]
    async fn a_missing_helper_is_reported_as_missing_not_guessed() {
        let dir = tempfile::tempdir().unwrap();
        let client = HelperClient::new(dir.path().join("networkd.sock"));
        let status = client.status().await;
        assert_eq!((status.supported, status.helper_state), (false, "missing"));
        let now = Timestamp::parse("2026-09-25T12:00:00Z").unwrap();
        let capability = capability(Some(&status), &Status::default(), now).unwrap();
        assert_eq!(capability.state, CapabilityState::Unsupported);
        assert_eq!(capability.reason_code.unwrap().as_str(), "helper_unavailable");
    }

    #[tokio::test]
    async fn an_oversized_or_unreadable_answer_is_unhealthy() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("networkd.sock");
        let listener = tokio::net::UnixListener::bind(&path).unwrap();
        tokio::spawn(async move {
            for answer in [vec![b'x'; MAX_RESPONSE_BYTES + 10], b"[1,2]\n".to_vec()] {
                let (mut stream, _) = listener.accept().await.unwrap();
                let mut request = vec![0u8; 1024];
                let _ = stream.read(&mut request).await;
                let _ = stream.write_all(&answer).await;
            }
        });
        let client = HelperClient::new(&path);
        assert_eq!(client.status().await.helper_state, "unhealthy");
        assert_eq!(client.status().await.helper_state, "unhealthy");
    }
}
