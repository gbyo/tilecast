//! Single-screen AirPlay Present (docs/tilecast-edge-airplay.md §6–§8).
//!
//! `tilecastd` owns the session: it stores it in SQLite, reaches UxPlay only
//! through one [`ReceiverConnection`] to the `tilecast-airplay` supervisor for
//! each session, binds the Presentation Network, grants the renderer the
//! `tcpresent` stream, and asks the activation loop to show the session. The
//! loop shows it over everything but a takeover (`player_core`
//! `OfflineActivationHost::external_presentation`).
//!
//! Every durable transition is written before its effect, so a restart at
//! any point resumes an unexpired session, finishes a stop that began, or
//! deletes an expired session:
//!
//! - prepare: the row (`prepared`) before the network join and `start`;
//! - start: `started` after the supervisor reports `advertising`;
//! - stop and expire: `stopping` before UxPlay stops and the network is left,
//!   then the row is deleted with the PIN and the device ID;
//! - recover: at start, from the row alone.

use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use edge_protocol::airplay::{
    self as wire, AirplayDeviceId, AirplayPin, AudioMode, AudioRtpPort, ControlEvent, ControlRequest, ReceiverName,
    SessionId, VideoProfile, VideoRtpPort,
};
use edge_protocol::ipc::presentation::{PresentSourceId, PresentationDocument, PresentationNetworkState};
use edge_state::repo::commands::CommandResult;
use edge_state::repo::external_presentation::{self as store, ExternalPresentation, SessionState};
use serde_json::{Map, Value, json};
use tokio::sync::{mpsc, oneshot};

use crate::airplay_receiver::{ReceiverConnection, ReceiverError};
use crate::daemon::DaemonContext;
use crate::media::{MediaCapability, PresentGrant};

/// UxPlay must report `advertising` within this long after `start`.
const START_TIMEOUT: Duration = Duration::from_secs(20);
/// How long a `stop` waits for `stopped` before the connection is dropped.
const STOP_TIMEOUT: Duration = Duration::from_secs(3);
const PROBE_TIMEOUT: Duration = Duration::from_secs(5);
/// The wall clock is checked against the expiry this often.
const TICK: Duration = Duration::from_secs(1);
/// Ethernet must stay the default route while a session holds a network.
const ROUTE_CHECK: Duration = Duration::from_secs(15);
/// An idle screen refreshes its probe this often, for the heartbeat.
const IDLE_PROBE: Duration = Duration::from_secs(10 * 60);
const REQUESTS: usize = 8;

/// The stable stop reasons that are not supervisor failure codes.
pub mod reason {
    pub const REMOTE_STOP: &str = "remote_stop";
    pub const EXPIRED: &str = "expired";
    pub const TAKEOVER: &str = "takeover";
    pub const REPLACED: &str = "replaced";
    pub const RECONFIGURED: &str = "reconfigured";
    pub const RECEIVER_LOST: &str = "receiver_lost";
    pub const RECEIVER_STOPPED: &str = "receiver_stopped";
    pub const ROUTE_LOST: &str = "ethernet_default_route_lost";
    pub const RELAY_FAILED: &str = "relay_failed";
}

// ------------------------------------------------------------ payload

/// A validated `prepare_airplay_session` for this screen.
#[derive(Clone, PartialEq, Eq)]
pub struct Session {
    pub id: SessionId,
    pub receiver_name: ReceiverName,
    pub pin: AirplayPin,
    pub device_id: AirplayDeviceId,
    pub profile: VideoProfile,
    pub audio_mode: AudioMode,
    /// Lowercase UUID of the Presentation Network to join, when present.
    pub network_id: Option<String>,
    pub expires_at_ms: i64,
}

impl std::fmt::Debug for Session {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Session")
            .field("id", &self.id)
            .field("receiver_name", &self.receiver_name)
            .field("profile", &self.profile)
            .field("audio_mode", &self.audio_mode)
            .field("network_id", &self.network_id)
            .field("expires_at_ms", &self.expires_at_ms)
            .finish_non_exhaustive()
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PayloadError {
    /// `gateway` or `receiver`: Edge reports `airplayGroupSupported: false`.
    GroupUnsupported,
    Invalid(&'static str),
}

/// Makes a Server receiver name valid for UxPlay's `-n` argument
/// ([`ReceiverName`]): control characters are dropped, white space is trimmed,
/// a leading `-` is stripped, and the name is cut to the maximum length.
/// `None` when nothing is left.
pub fn normalize_receiver_name(raw: &str) -> Option<ReceiverName> {
    let kept: String = raw.chars().filter(|c| !c.is_control() && !matches!(c, '\u{2028}' | '\u{2029}')).collect();
    let trimmed = kept.trim().trim_start_matches('-').trim();
    let mut name: String = trimmed.chars().take(wire::MAX_RECEIVER_NAME_CHARS).collect();
    name = name.trim_end().to_owned();
    ReceiverName::new(name).ok()
}

fn text<'a>(payload: &'a Map<String, Value>, key: &'static str) -> Result<&'a str, PayloadError> {
    payload.get(key).and_then(Value::as_str).filter(|value| !value.trim().is_empty()).ok_or(PayloadError::Invalid(key))
}

/// Strictly decodes the Server payload. Fields for group sessions are
/// ignored; a group role fails before anything else is read.
pub fn parse_payload(payload: &Map<String, Value>, now_ms: i64) -> Result<Session, PayloadError> {
    if text(payload, "provider")? != "airplay" {
        return Err(PayloadError::Invalid("provider"));
    }
    match text(payload, "role")? {
        "single" => {}
        "gateway" | "receiver" => return Err(PayloadError::GroupUnsupported),
        _ => return Err(PayloadError::Invalid("role")),
    }
    if payload.get("phase").is_some_and(|phase| phase.as_str() != Some("start")) {
        return Err(PayloadError::Invalid("phase"));
    }
    let id =
        SessionId::new(text(payload, "sessionId")?.to_lowercase()).map_err(|_| PayloadError::Invalid("sessionId"))?;
    let receiver_name =
        normalize_receiver_name(text(payload, "receiverName")?).ok_or(PayloadError::Invalid("receiverName"))?;
    let pin = AirplayPin::new(text(payload, "pin")?).map_err(|_| PayloadError::Invalid("pin"))?;
    let device_id = AirplayDeviceId::new(text(payload, "deviceId")?.to_lowercase())
        .map_err(|_| PayloadError::Invalid("deviceId"))?;
    let profile = serde_json::from_value(Value::String(text(payload, "profile")?.to_owned()))
        .map_err(|_| PayloadError::Invalid("profile"))?;
    let audio_mode = serde_json::from_value(Value::String(text(payload, "audioMode")?.to_owned()))
        .map_err(|_| PayloadError::Invalid("audioMode"))?;
    let expires_at_ms = player_types::Timestamp::parse(text(payload, "expiresAt")?)
        .map_err(|_| PayloadError::Invalid("expiresAt"))?
        .unix_millis();
    if expires_at_ms <= now_ms {
        return Err(PayloadError::Invalid("expiresAt"));
    }
    if payload.get("videoPort").is_some_and(|port| port.as_u64() != Some(u64::from(wire::VIDEO_RTP_PORT))) {
        return Err(PayloadError::Invalid("videoPort"));
    }
    let network_id = match payload.get("presentationNetworkId") {
        None | Some(Value::Null) => None,
        Some(Value::String(id)) => {
            Some(uuid::Uuid::try_parse(id).map_err(|_| PayloadError::Invalid("presentationNetworkId"))?.to_string())
        }
        Some(_) => return Err(PayloadError::Invalid("presentationNetworkId")),
    };
    Ok(Session { id, receiver_name, pin, device_id, profile, audio_mode, network_id, expires_at_ms })
}

fn profile_text(profile: VideoProfile) -> &'static str {
    match profile {
        VideoProfile::P1080p30 => "1080p30",
        VideoProfile::P720p30 => "720p30",
    }
}

fn audio_text(mode: AudioMode) -> &'static str {
    match mode {
        AudioMode::GatewayOnly => "gateway_only",
        AudioMode::None => "none",
    }
}

impl Session {
    fn row(&self, state: SessionState) -> ExternalPresentation {
        ExternalPresentation {
            session_id: self.id.as_str().to_owned(),
            receiver_name: self.receiver_name.as_str().to_owned(),
            pin: self.pin.expose().to_owned(),
            device_id: self.device_id.expose().to_owned(),
            profile: profile_text(self.profile).to_owned(),
            audio_mode: audio_text(self.audio_mode).to_owned(),
            presentation_network_id: self.network_id.clone(),
            expires_at_ms: self.expires_at_ms,
            state,
            stop_reason: None,
        }
    }

    fn from_row(row: &ExternalPresentation) -> Option<Self> {
        Some(Self {
            id: SessionId::new(row.session_id.clone()).ok()?,
            receiver_name: ReceiverName::new(row.receiver_name.clone()).ok()?,
            pin: AirplayPin::new(row.pin.clone()).ok()?,
            device_id: AirplayDeviceId::new(row.device_id.clone()).ok()?,
            profile: serde_json::from_value(Value::String(row.profile.clone())).ok()?,
            audio_mode: serde_json::from_value(Value::String(row.audio_mode.clone())).ok()?,
            network_id: row.presentation_network_id.clone(),
            expires_at_ms: row.expires_at_ms,
        })
    }

    fn start_request(&self) -> ControlRequest {
        ControlRequest::Start {
            session_id: self.id.clone(),
            receiver_name: self.receiver_name.clone(),
            pin: self.pin.clone(),
            device_id: self.device_id.clone(),
            profile: self.profile,
            audio_mode: self.audio_mode,
            video_port: VideoRtpPort,
            audio_port: AudioRtpPort,
        }
    }

    /// A redelivered or extended command for the running session: only the
    /// expiry may change without restarting UxPlay.
    fn same_receiver(&self, other: &Self) -> bool {
        Self { expires_at_ms: 0, ..self.clone() } == Self { expires_at_ms: 0, ..other.clone() }
    }
}

// ------------------------------------------------------------ readiness

/// What the supervisor answered to `probe`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Probe {
    pub uxplay_version: Option<String>,
    pub avahi_available: bool,
    pub limitation: Option<String>,
}

/// What the renderer reported in `renderer.ready`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct RendererSupport {
    pub connected: bool,
    pub video: bool,
    pub decoder: Option<String>,
    pub hardware_decode: bool,
}

/// The inputs of `airplaySupported` and `airplayLimitation`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Readiness {
    /// `None`: the control socket is missing or nothing answers, so the
    /// unit is not installed yet (it arrives one update late).
    pub probe: Option<Probe>,
    pub renderer: RendererSupport,
}

const REMEDY: &str = "Install a Tilecast Edge release that includes it.";

impl Readiness {
    /// `airplaySupported`: the unit answers `probe` with no limitation,
    /// avahi-daemon is seen, and the renderer shows the stream.
    pub fn supported(&self) -> bool {
        self.probe.as_ref().is_some_and(|probe| probe.limitation.is_none() && probe.avahi_available)
            && self.renderer.connected
            && self.renderer.video
            && self.renderer.decoder.is_some()
    }

    /// One sentence for Studio, for the first failed dependency in the
    /// Electron Player's order (`describeLimitation`): UxPlay, then the
    /// decode path, then Avahi, then decode quality. The remedy names the
    /// Edge release, because Edge carries UxPlay and never runs the Electron
    /// installer.
    pub fn limitation(&self) -> Option<String> {
        let baseline = wire::UXPLAY_BASELINE;
        let Some(probe) = &self.probe else {
            return Some(
                "The AirPlay receiver service is not installed yet. It arrives with the next Tilecast Edge update."
                    .into(),
            );
        };
        use wire::limitation as code;
        let uxplay = match probe.limitation.as_deref() {
            Some(code::UXPLAY_MISSING) => {
                Some(format!("UxPlay was not found. AirPlay needs UxPlay {baseline} or newer. {REMEDY}"))
            }
            Some(code::UXPLAY_NOT_EXECUTABLE) => Some(format!(
                "UxPlay was found but is not executable. AirPlay needs UxPlay {baseline} or newer. {REMEDY}"
            )),
            Some(code::UXPLAY_VERSION_FAILED) => Some(format!(
                "UxPlay was found but its -v version check failed. AirPlay needs UxPlay {baseline} or newer. {REMEDY}"
            )),
            Some(code::UXPLAY_VERSION_UNRECOGNIZED) => Some(format!(
                "UxPlay was found but did not report a recognizable version with -v. AirPlay needs UxPlay \
                 {baseline} or newer. {REMEDY}"
            )),
            Some(code::UXPLAY_VERSION_UNSUPPORTED) => Some(format!(
                "UxPlay {} is older than the supported baseline {baseline}. {REMEDY}",
                probe.uxplay_version.as_deref().unwrap_or("of an unknown version")
            )),
            _ => None,
        };
        if uxplay.is_some() {
            return uxplay;
        }
        if !self.renderer.connected {
            return Some("The display renderer is not connected, so AirPlay video cannot be shown.".into());
        }
        if !self.renderer.video || self.renderer.decoder.is_none() {
            return Some(
                "No supported H.264 decoder was found; the display renderer cannot show AirPlay video.".into(),
            );
        }
        if probe.limitation.as_deref() == Some(code::AVAHI_UNAVAILABLE) || !probe.avahi_available {
            return Some("Avahi/Bonjour support is unavailable; AirPlay cannot be advertised.".into());
        }
        if let Some(other) = probe.limitation.as_deref() {
            return Some(format!("AirPlay is not ready on this player ({other})."));
        }
        if !self.renderer.hardware_decode {
            return Some("Hardware H.264 decoding is unavailable; use 720p30 to limit CPU load.".into());
        }
        None
    }

    fn max_profile(&self) -> &'static str {
        if !self.renderer.video || self.renderer.decoder.is_none() {
            "unsupported"
        } else if self.renderer.hardware_decode {
            "1080p30"
        } else {
            "720p30"
        }
    }
}

// ------------------------------------------------------------ shared view

/// What the screen shows for the session; read by the activation loop.
#[derive(Clone)]
struct View {
    session: SessionId,
    receiver_name: ReceiverName,
    pin: AirplayPin,
    expires_at_ms: i64,
    audio: bool,
    connected: bool,
    receiver_state: &'static str,
    network: Option<PresentationNetworkState>,
    /// The renderer session the stream grant is bound to, and the grant.
    source: Option<(edge_protocol::ids::SessionId, MediaCapability)>,
}

#[derive(Debug)]
enum Request {
    Prepare { session: Box<Session>, reply: oneshot::Sender<CommandResult> },
    Stop { session_id: Option<String>, reason: &'static str, reply: Option<oneshot::Sender<CommandResult>> },
    Test { reply: oneshot::Sender<CommandResult> },
}

/// The AirPlay state shared by the session task, the command handlers, the
/// activation loop, and the heartbeat.
pub struct Airplay {
    socket: PathBuf,
    requests: mpsc::Sender<Request>,
    inbox: std::sync::Mutex<Option<mpsc::Receiver<Request>>>,
    view: std::sync::Mutex<Option<View>>,
    probe: std::sync::Mutex<Option<Option<Probe>>>,
    last_session: std::sync::Mutex<Option<String>>,
}

impl std::fmt::Debug for Airplay {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Airplay").field("socket", &self.socket).field("active", &self.active()).finish()
    }
}

fn lock<T>(mutex: &std::sync::Mutex<T>) -> std::sync::MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poison| poison.into_inner())
}

impl Airplay {
    pub fn new(socket: PathBuf) -> Self {
        let (requests, inbox) = mpsc::channel(REQUESTS);
        Self {
            socket,
            requests,
            inbox: std::sync::Mutex::new(Some(inbox)),
            view: std::sync::Mutex::new(None),
            probe: std::sync::Mutex::new(None),
            last_session: std::sync::Mutex::new(None),
        }
    }

    /// A session is on screen (or is being prepared for it).
    pub fn active(&self) -> bool {
        lock(&self.view).is_some()
    }

    /// A takeover outranks the session: hide it at once and stop it.
    pub fn yield_to_takeover(&self) {
        if lock(&self.view).take().is_some() {
            tracing::info!(component = "airplay", event = "takeover");
            let _ = self.requests.try_send(Request::Stop { session_id: None, reason: reason::TAKEOVER, reply: None });
        }
    }

    /// The renderer reports (`renderer.health`, state `degraded`) that its
    /// relay for the session's stream did not start or stopped for a fault.
    /// Mirrored video cannot reach the screen, so the session ends with a
    /// stable reason and the Server sees it stop. The renderer repeats the
    /// report until its next activation, so a full request queue loses
    /// nothing. A report that arrives before the session's stream was granted
    /// is about an earlier session and is ignored.
    pub fn relay_failed(&self) {
        let granted = lock(&self.view).as_ref().is_some_and(|view| view.source.is_some());
        if granted {
            tracing::warn!(component = "airplay", event = "relay_failed");
            let _ =
                self.requests.try_send(Request::Stop { session_id: None, reason: reason::RELAY_FAILED, reply: None });
        }
    }

    async fn ask(&self, request: impl FnOnce(oneshot::Sender<CommandResult>) -> Request) -> CommandResult {
        let (reply, answer) = oneshot::channel();
        if self.requests.send(request(reply)).await.is_err() {
            return CommandResult::failed("airplay_unavailable", "The AirPlay session task is not running.");
        }
        answer
            .await
            .unwrap_or_else(|_| CommandResult::failed("airplay_unavailable", "The AirPlay session task stopped."))
    }

    /// `prepare_airplay_session`.
    pub async fn prepare(&self, payload: &Map<String, Value>, now_ms: i64) -> CommandResult {
        match parse_payload(payload, now_ms) {
            Ok(session) => self.ask(|reply| Request::Prepare { session: Box::new(session), reply }).await,
            Err(PayloadError::GroupUnsupported) => CommandResult::failed(
                "airplay_group_unsupported",
                "Tilecast Edge supports single-screen AirPlay only; group sessions stay on the Electron Player.",
            ),
            Err(PayloadError::Invalid(field)) => {
                CommandResult::failed("airplay_prepare_failed", &format!("AirPlay payload field {field} is invalid."))
            }
        }
    }

    /// `stop_airplay_session`.
    pub async fn stop(&self, payload: &Map<String, Value>) -> CommandResult {
        let session_id = payload.get("sessionId").and_then(Value::as_str).map(str::to_lowercase);
        self.ask(|reply| Request::Stop { session_id, reason: reason::REMOTE_STOP, reply: Some(reply) }).await
    }

    /// `test_airplay_support`.
    pub async fn test(&self) -> CommandResult {
        self.ask(|reply| Request::Test { reply }).await
    }

    fn set_view(&self, view: Option<View>) {
        *lock(&self.view) = view;
    }

    fn update_view(&self, change: impl FnOnce(&mut View)) {
        if let Some(view) = lock(&self.view).as_mut() {
            change(view);
        }
    }
}

/// The renderer's support, from its last `renderer.ready`.
pub async fn renderer_support(context: &DaemonContext) -> RendererSupport {
    let engine = context.presentation.lock().await;
    let Some(ready) = engine.ready_info().filter(|_| engine.renderer_is_ready()) else {
        return RendererSupport::default();
    };
    let video = ready
        .features
        .iter()
        .any(|feature| feature.as_str() == edge_protocol::ipc::RENDERER_FEATURE_EXTERNAL_PRESENTATION_VIDEO);
    RendererSupport {
        connected: true,
        video,
        decoder: ready.external_presentation.as_ref().map(|d| d.decoder.as_str().to_owned()),
        hardware_decode: ready.external_presentation.as_ref().is_some_and(|d| d.hardware_decode),
    }
}

/// The external-presentation document for the session, with a live stream
/// grant for the connected renderer when it shows the stream. A new
/// renderer instance gets a new grant.
pub async fn document(context: &DaemonContext) -> Option<PresentationDocument> {
    let support = renderer_support(context).await;
    let mut view = lock(&context.airplay.view).clone()?;
    let mut source = None;
    if support.video {
        let mut registry = context.media_registry.lock().unwrap_or_else(|poison| poison.into_inner());
        let live = view.source.as_ref().is_some_and(|(renderer, token)| {
            registry.resolve_present(*renderer, token.as_str()).is_some_and(|grant| grant.audio == view.audio)
        });
        if !live {
            view.source = registry.renderer().and_then(|renderer| {
                registry
                    .grant_present(renderer.session, PresentGrant { audio: view.audio })
                    .ok()
                    .map(|token| (renderer.session, token))
            });
        }
        source = view.source.as_ref().and_then(|(_, token)| PresentSourceId::new(token.as_str()));
    }
    let expires = player_types::Timestamp::from_unix_millis(view.expires_at_ms)?.to_string();
    let document = PresentationDocument::ExternalPresentation {
        session_id: view.session.clone(),
        receiver_name: view.receiver_name.clone(),
        pin: Some(view.pin.clone()),
        expires_at: edge_protocol::bounded::SafeText::lossy(&expires),
        connected: view.connected,
        presentation_network: view.network,
        source_id: source,
    };
    // Keep the grant for the next call, unless the session changed meanwhile.
    context.airplay.update_view(|current| {
        if current.session == view.session {
            current.source = view.source.clone();
        }
    });
    Some(document)
}

// ------------------------------------------------------------ heartbeat

/// The `airplay*` and `externalPresentation*` heartbeat fields.
pub async fn heartbeat(context: &DaemonContext, heartbeat: &mut Value) {
    let Some(probe) = lock(&context.airplay.probe).clone() else { return };
    let readiness = Readiness { probe, renderer: renderer_support(context).await };
    let Some(object) = heartbeat.as_object_mut() else { return };
    let probe = readiness.probe.as_ref();
    let installed = probe.is_some_and(|p| p.limitation.as_deref() != Some(wire::limitation::UXPLAY_MISSING));
    object.insert("airplaySupported".into(), json!(readiness.supported()));
    object.insert("airplayUxPlayInstalled".into(), json!(installed));
    if let Some(version) = probe.and_then(|p| p.uxplay_version.as_deref()) {
        object.insert("airplayUxPlayVersion".into(), json!(version));
    }
    object.insert("airplayGstreamerInstalled".into(), json!(readiness.renderer.video));
    object.insert("airplayH264DecoderAvailable".into(), json!(readiness.renderer.decoder.is_some()));
    object.insert("airplayHardwareDecode".into(), json!(readiness.renderer.hardware_decode));
    if let Some(decoder) = &readiness.renderer.decoder {
        object.insert("airplayDecoder".into(), json!(decoder));
    }
    object.insert("airplayMaxProfile".into(), json!(readiness.max_profile()));
    object.insert("airplayGroupSupported".into(), json!(false));
    object.insert("airplayAudioAvailable".into(), json!(readiness.renderer.video));
    let avahi = probe.is_some_and(|p| p.avahi_available);
    object.insert("airplayAvahiAvailable".into(), json!(avahi));
    object.insert("airplayMdnsAdvertisementAvailable".into(), json!(avahi));
    object.insert("airplayMulticastTestStatus".into(), json!("unsupported"));
    if let Some(limitation) = readiness.limitation() {
        object.insert("airplayLimitation".into(), json!(limitation.chars().take(240).collect::<String>()));
    }
    let view = lock(&context.airplay.view).clone();
    match view {
        Some(view) => {
            object.insert("externalPresentationState".into(), json!(view.receiver_state));
            object.insert("externalPresentationSessionId".into(), json!(view.session.as_str()));
            object.insert("externalPresentationRole".into(), json!("single"));
            object.insert("airplayReceiverState".into(), json!(view.receiver_state));
            object.insert("airplayTransport".into(), json!("unicast"));
            object.insert("airplayConnected".into(), json!(view.connected));
            if let Some(expires) = player_types::Timestamp::from_unix_millis(view.expires_at_ms) {
                object.insert("externalPresentationExpiresAt".into(), json!(expires.to_string()));
            }
        }
        None => {
            // Clears the Server's last snapshot after a local stop or expiry.
            object.insert("externalPresentationState".into(), json!("none"));
            if let Some(last) = lock(&context.airplay.last_session).clone() {
                object.insert("externalPresentationSessionId".into(), json!(last));
            }
        }
    }
}

/// `external_presentation.airplay`.
pub async fn capability(context: &DaemonContext) -> Option<player_types::capability::Capability> {
    use edge_protocol::bounded::{DetailText, ShortText, ShortToken, Token};
    use edge_protocol::capability::{AttributeValue, Capability, CapabilityId, CapabilityState, ids};
    let probe = lock(&context.airplay.probe).clone();
    let readiness = Readiness { probe: probe.clone().flatten(), renderer: renderer_support(context).await };
    let (state, reason) = match &probe {
        None => (CapabilityState::Supported, Some("not_probed".to_owned())),
        Some(None) => (CapabilityState::Unsupported, Some("receiver_unavailable".to_owned())),
        Some(Some(probe)) if probe.limitation.is_some() => (CapabilityState::Unsupported, probe.limitation.clone()),
        Some(Some(probe)) if !probe.avahi_available => {
            (CapabilityState::Unsupported, Some(wire::limitation::AVAHI_UNAVAILABLE.to_owned()))
        }
        Some(Some(_)) if !readiness.renderer.connected => {
            (CapabilityState::Degraded, Some("renderer_not_connected".to_owned()))
        }
        Some(Some(_)) if !readiness.renderer.video || readiness.renderer.decoder.is_none() => {
            (CapabilityState::Unsupported, Some("renderer_video_unavailable".to_owned()))
        }
        Some(Some(_)) => (CapabilityState::Available, None),
    };
    let mut out = Capability::new(CapabilityId::new(ids::EXTERNAL_PRESENTATION_AIRPLAY).ok()?, state, context.now());
    out.provider = ShortToken::new("tilecast-airplay").ok();
    out.reason_code = reason.and_then(|reason| ShortToken::new(&reason).ok());
    out.detail = readiness.limitation().as_deref().map(DetailText::lossy);
    if let Some(decoder) = &readiness.renderer.decoder
        && let Ok(key) = Token::<48>::new("decoder")
    {
        out.attributes.insert(key, AttributeValue::Text(ShortText::lossy(decoder)));
    }
    if let Ok(key) = Token::<48>::new("session") {
        let state = lock(&context.airplay.view).as_ref().map_or("none", |view| view.receiver_state);
        out.attributes.insert(key, AttributeValue::Text(ShortText::lossy(state)));
    }
    Some(out)
}

/// Whether the stored session still uses its Presentation Network after a
/// restart, so the network task must not tear the connection down.
pub async fn keeps_network(context: &DaemonContext) -> bool {
    let Some(db) = context.db() else { return false };
    let now = context.now().unix_millis();
    db.run(|c| store::get(c)).await.ok().flatten().is_some_and(|row| {
        row.presentation_network_id.is_some() && row.state != SessionState::Stopping && row.expires_at_ms > now
    })
}

// ------------------------------------------------------------ session task

struct Running {
    session: Session,
    connection: Option<ReceiverConnection>,
    deadline: tokio::time::Instant,
}

struct Actor {
    context: Arc<DaemonContext>,
    running: Option<Running>,
}

fn monotonic_deadline(expires_at_ms: i64, now_ms: i64) -> tokio::time::Instant {
    let remaining = u64::try_from(expires_at_ms.saturating_sub(now_ms)).unwrap_or(0);
    tokio::time::Instant::now() + Duration::from_millis(remaining)
}

async fn probe_on(connection: &mut ReceiverConnection) -> Option<Probe> {
    connection.send(&ControlRequest::Probe {}).await.ok()?;
    loop {
        match connection.next_event_within(PROBE_TIMEOUT).await.ok()? {
            ControlEvent::ProbeResult { uxplay_version, avahi_available, limitation } => {
                return Some(Probe {
                    uxplay_version: uxplay_version.map(|v| v.as_str().to_owned()),
                    avahi_available,
                    limitation: limitation.map(|l| l.as_str().to_owned()),
                });
            }
            _ => continue,
        }
    }
}

impl Actor {
    fn airplay(&self) -> &Airplay {
        &self.context.airplay
    }

    fn now_ms(&self) -> i64 {
        self.context.now().unix_millis()
    }

    fn show_changed(&self) {
        self.context.manifest_wake.notify_one();
        self.context.report_status_soon();
    }

    async fn store<T: Send + 'static>(
        &self,
        work: impl FnOnce(&mut rusqlite::Connection) -> edge_state::Result<T> + Send + 'static,
    ) -> Option<T> {
        let db = self.context.db()?;
        match db.run(work).await {
            Ok(value) => Some(value),
            Err(error) => {
                tracing::warn!(component = "airplay", event = "state_failed", reason = error.reason_code());
                None
            }
        }
    }

    /// Connects and probes, and records the answer for the heartbeat.
    async fn probe(&self) -> (Option<ReceiverConnection>, Option<Probe>) {
        let mut connection = match ReceiverConnection::connect(&self.airplay().socket).await {
            Ok(connection) => connection,
            Err(error) => {
                tracing::debug!(component = "airplay", event = "receiver_unavailable", code = error.code());
                *lock(&self.airplay().probe) = Some(None);
                return (None, None);
            }
        };
        let probe = probe_on(&mut connection).await;
        *lock(&self.airplay().probe) = Some(probe.clone());
        (probe.is_some().then_some(connection), probe)
    }

    async fn takeover_active(&self) -> bool {
        let engine = self.context.presentation.lock().await;
        engine.current().and_then(|current| current.identity.as_ref()).is_some_and(|i| i.takeover_id.is_some())
    }

    async fn prepare(&mut self, session: Session) -> CommandResult {
        if self.takeover_active().await {
            return CommandResult::failed(
                "emergency_takeover_active",
                "AirPlay cannot start while an emergency takeover is active.",
            );
        }
        if let Some(running) = self.running.as_mut()
            && running.session.id == session.id
        {
            if running.session.same_receiver(&session) {
                // A redelivered command, or a new expiry for the session.
                if running.session.expires_at_ms != session.expires_at_ms {
                    running.session.expires_at_ms = session.expires_at_ms;
                    running.deadline = monotonic_deadline(session.expires_at_ms, self.context.now().unix_millis());
                    let row = session.row(SessionState::Started);
                    let now = self.now_ms();
                    self.store(move |c| store::put(c, &row, now)).await;
                    self.airplay().update_view(|view| view.expires_at_ms = session.expires_at_ms);
                    self.show_changed();
                }
                return CommandResult::ok("airplay_started", "AirPlay receiver is advertised.");
            }
            self.stop(reason::RECONFIGURED).await;
        } else if self.running.is_some() {
            self.stop(reason::REPLACED).await;
        }
        let (connection, probe) = self.probe().await;
        let readiness = Readiness { probe, renderer: renderer_support(&self.context).await };
        let Some(connection) = connection.filter(|_| readiness.supported()) else {
            self.context.report_status_soon();
            return CommandResult::failed(
                "airplay_not_ready",
                &readiness.limitation().unwrap_or_else(|| "This player is not ready for AirPlay Present.".into()),
            );
        };
        let row = session.row(SessionState::Prepared);
        let now = self.now_ms();
        if self.store(move |c| store::put(c, &row, now)).await.is_none() {
            return CommandResult::failed("state_unavailable", "The AirPlay session could not be stored.");
        }
        self.start(session, connection).await
    }

    /// Joins the network, starts UxPlay and waits for `advertising`. On
    /// failure the session is stopped and its row deleted.
    async fn start(&mut self, session: Session, connection: ReceiverConnection) -> CommandResult {
        let now = self.now_ms();
        self.airplay().set_view(Some(View {
            session: session.id.clone(),
            receiver_name: session.receiver_name.clone(),
            pin: session.pin.clone(),
            expires_at_ms: session.expires_at_ms,
            audio: session.audio_mode == AudioMode::GatewayOnly,
            connected: false,
            receiver_state: "preparing",
            network: session.network_id.as_ref().map(|_| PresentationNetworkState::Joining),
            source: None,
        }));
        self.running = Some(Running {
            deadline: monotonic_deadline(session.expires_at_ms, now),
            session: session.clone(),
            connection: Some(connection),
        });
        self.show_changed();
        if let Some(network_id) = session.network_id.clone() {
            let provisioner = crate::network_task::ServerProvisioner::new(&self.context);
            let context = Arc::clone(&self.context);
            let joined = self.context.network.join_for_session(&network_id, &provisioner, move || context.now()).await;
            if let Err((code, message)) = joined {
                self.airplay().update_view(|view| view.network = Some(PresentationNetworkState::Failed));
                self.stop(code).await;
                return CommandResult::failed(code, &message);
            }
            self.airplay().update_view(|view| view.network = Some(PresentationNetworkState::Connected));
        }
        let started = self.await_advertising(&session).await;
        if let Err(code) = started {
            self.stop(code).await;
            return CommandResult::failed(code, "The AirPlay receiver did not start.");
        }
        let id = session.id.as_str().to_owned();
        let now = self.now_ms();
        self.store(move |c| store::set_state(c, &id, SessionState::Started, None, now)).await;
        self.airplay().update_view(|view| view.receiver_state = "waiting");
        tracing::info!(component = "airplay", event = "advertising", session = session.id.as_str());
        self.show_changed();
        CommandResult::ok("airplay_started", "AirPlay receiver is advertised.")
    }

    async fn await_advertising(&mut self, session: &Session) -> Result<(), &'static str> {
        let Some(connection) = self.running.as_mut().and_then(|running| running.connection.as_mut()) else {
            return Err(reason::RECEIVER_LOST);
        };
        connection.send(&session.start_request()).await.map_err(|error| error.code())?;
        let deadline = tokio::time::Instant::now() + START_TIMEOUT;
        loop {
            let left = deadline.saturating_duration_since(tokio::time::Instant::now());
            match connection.next_event_within(left).await {
                Ok(ControlEvent::Advertising { session_id }) if session_id == session.id => return Ok(()),
                Ok(ControlEvent::Failed { session_id, code }) if session_id == session.id => {
                    return Err(failure_code(code.as_str()));
                }
                Ok(ControlEvent::Stopped { session_id }) if session_id == session.id => {
                    return Err(reason::RECEIVER_STOPPED);
                }
                Ok(_) => continue,
                Err(ReceiverError::Timeout) => return Err(wire::failure::UXPLAY_START_TIMEOUT),
                Err(error) => return Err(error.code()),
            }
        }
    }

    /// Stops the running session: durable `stopping` first, then the screen,
    /// UxPlay, the network, and finally the row.
    async fn stop(&mut self, why: &'static str) {
        let Some(mut running) = self.running.take() else { return };
        let id = running.session.id.as_str().to_owned();
        let now = self.now_ms();
        let marked = id.clone();
        self.store(move |c| store::set_state(c, &marked, SessionState::Stopping, Some(why), now)).await;
        // Signage is evaluated again at once; it never restores a snapshot.
        self.airplay().set_view(None);
        self.context.media_registry.lock().unwrap_or_else(|poison| poison.into_inner()).revoke_present();
        *lock(&self.airplay().last_session) = Some(id.clone());
        self.show_changed();
        if let Some(mut connection) = running.connection.take() {
            let request = ControlRequest::Stop { session_id: running.session.id.clone() };
            if connection.send(&request).await.is_ok() {
                let deadline = tokio::time::Instant::now() + STOP_TIMEOUT;
                loop {
                    let left = deadline.saturating_duration_since(tokio::time::Instant::now());
                    match connection.next_event_within(left).await {
                        Ok(ControlEvent::Stopped { .. }) | Err(_) => break,
                        Ok(_) => continue,
                    }
                }
            }
            // Dropping the connection stops UxPlay in any case.
        }
        if running.session.network_id.is_some() {
            self.context.network.leave_for_session(why, self.context.now()).await;
        }
        self.store(move |c| store::delete(c, &id)).await;
        tracing::info!(component = "airplay", event = "stopped", reason = why);
        self.context.report_status_soon();
    }

    /// Restart recovery from the stored row alone.
    async fn recover(&mut self) {
        let Some(Some(row)) = self.store(|c| store::get(c)).await else { return };
        let now = self.now_ms();
        let session = Session::from_row(&row);
        let finish = |actor: &Self, why: &'static str| {
            let id = row.session_id.clone();
            let network = row.presentation_network_id.is_some();
            let context = Arc::clone(&actor.context);
            async move {
                let marked = id.clone();
                if let Some(db) = context.db() {
                    let _ = db.run(move |c| store::set_state(c, &marked, SessionState::Stopping, Some(why), now)).await;
                }
                if network {
                    context.network.leave_for_session(why, context.now()).await;
                }
                if let Some(db) = context.db() {
                    let _ = db.run(move |c| store::delete(c, &id)).await;
                }
                *lock(&context.airplay.last_session) = Some(row.session_id.clone());
                tracing::info!(component = "airplay", event = "recovered_stop", reason = why);
                context.report_status_soon();
            }
        };
        match session {
            _ if row.state == SessionState::Stopping => {
                finish(self, row.stop_reason.as_deref().map_or(reason::RECEIVER_STOPPED, stop_reason)).await
            }
            None => finish(self, "invalid_state").await,
            Some(_) if row.expires_at_ms <= now => finish(self, reason::EXPIRED).await,
            Some(session) => {
                tracing::info!(component = "airplay", event = "resuming", session = session.id.as_str());
                let (connection, probe) = self.probe().await;
                let readiness = Readiness { probe, renderer: RendererSupport::default() };
                match connection.filter(|_| readiness.probe.as_ref().is_some_and(|p| p.limitation.is_none())) {
                    Some(connection) => {
                        let result = self.start(session, connection).await;
                        if !result.success {
                            tracing::warn!(component = "airplay", event = "resume_failed", code = result.code.as_str());
                        }
                    }
                    None => finish(self, "receiver_unavailable").await,
                }
            }
        }
    }

    async fn handle(&mut self, request: Request) {
        match request {
            Request::Prepare { session, reply } => {
                let result = self.prepare(*session).await;
                let _ = reply.send(result);
            }
            Request::Stop { session_id, reason: why, reply } => {
                let matches = self.running.as_ref().is_some_and(|running| {
                    session_id.as_deref().is_none_or(|requested| requested == running.session.id.as_str())
                });
                let result = if matches {
                    self.stop(why).await;
                    CommandResult::ok("airplay_stopped", "AirPlay stopped and current signage state was evaluated.")
                } else {
                    CommandResult::ok(
                        "airplay_already_stopped",
                        "The requested AirPlay session is not active on this player.",
                    )
                };
                if let Some(reply) = reply {
                    let _ = reply.send(result);
                }
            }
            Request::Test { reply } => {
                let readiness = if self.running.is_some() {
                    let probe = lock(&self.airplay().probe).clone().flatten();
                    Readiness { probe, renderer: renderer_support(&self.context).await }
                } else {
                    let (_, probe) = self.probe().await;
                    Readiness { probe, renderer: renderer_support(&self.context).await }
                };
                self.context.report_status_soon();
                let supported = readiness.supported();
                let message = readiness.limitation().unwrap_or_else(|| {
                    format!("AirPlay ready with {}.", readiness.renderer.decoder.as_deref().unwrap_or("H.264"))
                });
                let _ = reply.send(CommandResult::new(
                    supported,
                    if supported { "airplay_supported" } else { "airplay_not_ready" },
                    &message,
                ));
            }
        }
    }

    async fn event(&mut self, event: Result<ControlEvent, ReceiverError>) {
        let Some(running) = self.running.as_ref() else { return };
        let ours = |id: &SessionId| *id == running.session.id;
        match event {
            Ok(ControlEvent::ClientConnected { session_id }) if ours(&session_id) => {
                self.airplay().update_view(|view| {
                    view.connected = true;
                    view.receiver_state = "connected";
                });
                tracing::info!(component = "airplay", event = "client_connected");
                self.show_changed();
            }
            Ok(ControlEvent::ClientDisconnected { session_id }) if ours(&session_id) => {
                // Back to the ready page; the session continues.
                self.airplay().update_view(|view| {
                    view.connected = false;
                    view.receiver_state = "waiting";
                });
                tracing::info!(component = "airplay", event = "client_disconnected");
                self.show_changed();
            }
            Ok(ControlEvent::Failed { session_id, code }) if ours(&session_id) => {
                tracing::warn!(component = "airplay", event = "receiver_failed", code = code.as_str());
                self.stop(failure_code(code.as_str())).await;
            }
            Ok(ControlEvent::Stopped { session_id }) if ours(&session_id) => self.stop(reason::RECEIVER_STOPPED).await,
            Ok(ControlEvent::Rejected { code }) => {
                tracing::warn!(component = "airplay", event = "rejected", code = code.as_str());
                self.stop(reason::RECEIVER_LOST).await;
            }
            Ok(_) => {}
            Err(error) => {
                tracing::warn!(component = "airplay", event = "receiver_lost", code = error.code());
                self.stop(reason::RECEIVER_LOST).await;
            }
        }
    }
}

/// A supervisor failure code as a static stop reason.
fn failure_code(code: &str) -> &'static str {
    use wire::failure as f;
    [
        f::INVALID_REQUEST,
        f::SESSION_ACTIVE,
        f::SESSION_FILE_FAILED,
        f::UXPLAY_START_FAILED,
        f::UXPLAY_START_TIMEOUT,
        f::UXPLAY_EXITED,
        f::PIN_ATTEMPTS_EXCEEDED,
    ]
    .into_iter()
    .find(|known| *known == code)
    .unwrap_or("receiver_failed")
}

/// A stored stop reason as a static one, for a stop that a restart finishes.
fn stop_reason(stored: &str) -> &'static str {
    [
        reason::REMOTE_STOP,
        reason::EXPIRED,
        reason::TAKEOVER,
        reason::REPLACED,
        reason::RECONFIGURED,
        reason::RECEIVER_LOST,
        reason::RECEIVER_STOPPED,
        reason::ROUTE_LOST,
        reason::RELAY_FAILED,
    ]
    .into_iter()
    .find(|known| *known == stored)
    .unwrap_or_else(|| failure_code(stored))
}

async fn next_event(running: &mut Option<Running>) -> Result<ControlEvent, ReceiverError> {
    match running.as_mut().and_then(|running| running.connection.as_mut()) {
        Some(connection) => connection.next_event().await,
        None => std::future::pending().await,
    }
}

async fn until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// The session task. Recovers the stored session, then serves commands,
/// supervisor events, expiry, and the route check until shutdown. Shutdown
/// keeps the row, so the session resumes after a restart; dropping the
/// connection stops UxPlay meanwhile.
pub async fn run(context: Arc<DaemonContext>) {
    let Some(mut inbox) = lock(&context.airplay.inbox).take() else { return };
    let mut actor = Actor { context: Arc::clone(&context), running: None };
    actor.recover().await;
    if actor.running.is_none() {
        actor.probe().await;
    }
    let mut tick = tokio::time::interval(TICK);
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_route_check = tokio::time::Instant::now();
    let mut last_probe = tokio::time::Instant::now();
    loop {
        let deadline = actor.running.as_ref().map(|running| running.deadline);
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            request = inbox.recv() => match request {
                Some(request) => actor.handle(request).await,
                None => return,
            },
            event = next_event(&mut actor.running) => actor.event(event).await,
            () = until(deadline) => actor.stop(reason::EXPIRED).await,
            _ = tick.tick() => {
                let now = actor.now_ms();
                let Some(running) = actor.running.as_ref() else {
                    if last_probe.elapsed() >= IDLE_PROBE {
                        last_probe = tokio::time::Instant::now();
                        actor.probe().await;
                    }
                    continue;
                };
                if running.session.expires_at_ms <= now {
                    actor.stop(reason::EXPIRED).await;
                } else if running.session.network_id.is_some()
                    && last_route_check.elapsed() >= ROUTE_CHECK
                {
                    last_route_check = tokio::time::Instant::now();
                    if !context.network.ethernet_is_default_route().await {
                        actor.stop(reason::ROUTE_LOST).await;
                    }
                }
            }
        }
    }
}

/// The supervisor's control socket.
pub fn socket_path(configured: Option<&Path>) -> PathBuf {
    configured.map(Path::to_path_buf).unwrap_or_else(|| PathBuf::from(wire::DEFAULT_SOCKET))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn payload() -> Map<String, Value> {
        json!({
            "provider": "airplay", "sessionId": "3F2504E0-4F89-41D3-9A0C-0305E82C3301", "role": "single",
            "phase": "start", "targetType": "screen", "targetId": "6f0c2b1e-9d2a-4b7e-8f3a-2c1d0e9f8a7b",
            "gatewayScreenId": "6f0c2b1e-9d2a-4b7e-8f3a-2c1d0e9f8a7b", "audioScreenId": "",
            "receiverName": "  Lobby \"North\" 'A'  ", "pin": "7319", "deviceId": "02:5a:00:00:00:01",
            "expiresAt": "2026-11-13T18:00:00Z", "transport": "unicast", "videoPort": 42000, "audioPort": 42002,
            "destinations": [], "multicastAddress": "", "profile": "1080p30", "audioMode": "gateway_only"
        })
        .as_object()
        .unwrap()
        .clone()
    }

    const NOW: i64 = 1_763_000_000_000; // 2025-11-13, before the payload's expiry

    #[test]
    fn single_payloads_parse_and_group_roles_fail_first() {
        let session = parse_payload(&payload(), NOW).unwrap();
        assert_eq!(session.id.as_str(), "3f2504e0-4f89-41d3-9a0c-0305e82c3301");
        assert_eq!(session.receiver_name.as_str(), "Lobby \"North\" 'A'");
        assert_eq!((session.profile, session.audio_mode), (VideoProfile::P1080p30, AudioMode::GatewayOnly));
        assert!(session.network_id.is_none());
        let debug = format!("{session:?}");
        assert!(!debug.contains("7319") && !debug.contains("02:5a"), "{debug}");
        for role in ["gateway", "receiver"] {
            let mut group = payload();
            group.insert("role".into(), json!(role));
            group.insert("pin".into(), json!("bad"));
            assert_eq!(parse_payload(&group, NOW), Err(PayloadError::GroupUnsupported));
        }
        for (key, bad) in [
            ("provider", json!("miracast")),
            ("phase", json!("prepare")),
            ("pin", json!("12345")),
            ("deviceId", json!("01:00:00:00:00:01")),
            ("profile", json!("4k60")),
            ("audioMode", json!("all")),
            ("videoPort", json!(5353)),
            ("presentationNetworkId", json!("not-a-uuid")),
            ("expiresAt", json!("2020-01-01T00:00:00Z")),
            ("receiverName", json!("---")),
        ] {
            let mut invalid = payload();
            invalid.insert(key.into(), bad);
            assert_eq!(parse_payload(&invalid, NOW), Err(PayloadError::Invalid(key)), "{key}");
        }
        let mut network = payload();
        network.insert("presentationNetworkId".into(), json!("6F0C2B1E-9D2A-4B7E-8F3A-2C1D0E9F8A7B"));
        assert_eq!(
            parse_payload(&network, NOW).unwrap().network_id.as_deref(),
            Some("6f0c2b1e-9d2a-4b7e-8f3a-2c1d0e9f8a7b")
        );
    }

    #[test]
    fn receiver_names_are_normalized_for_the_name_argument() {
        for (raw, expected) in [
            ("  Lobby  ", Some("Lobby")),
            ("-Lobby", Some("Lobby")),
            ("--- Lobby", Some("Lobby")),
            ("Room \"A\" 'B'", Some("Room \"A\" 'B'")),
            ("Room \"A\"", Some("Room \"A\"")),
            ("Line\nbreak", Some("Linebreak")),
            (" \t ", None),
        ] {
            assert_eq!(normalize_receiver_name(raw).as_ref().map(ReceiverName::as_str), expected, "{raw:?}");
        }
        let long = "x".repeat(400);
        assert_eq!(normalize_receiver_name(&long).unwrap().as_str().chars().count(), wire::MAX_RECEIVER_NAME_CHARS);
    }

    #[test]
    fn a_row_round_trips_and_only_the_expiry_may_change_in_place() {
        let session = parse_payload(&payload(), NOW).unwrap();
        let row = session.row(SessionState::Prepared);
        assert_eq!(Session::from_row(&row).as_ref(), Some(&session));
        let later = Session { expires_at_ms: session.expires_at_ms + 60_000, ..session.clone() };
        assert!(session.same_receiver(&later));
        let renamed = Session { receiver_name: ReceiverName::new("Other").unwrap(), ..session.clone() };
        assert!(!session.same_receiver(&renamed));
    }

    #[test]
    fn readiness_follows_the_electron_order_with_edge_remedies() {
        let renderer =
            RendererSupport { connected: true, video: true, decoder: Some("vah264dec".into()), hardware_decode: true };
        let probe = Probe { uxplay_version: Some("1.73.7".into()), avahi_available: true, limitation: None };
        let ready = Readiness { probe: Some(probe.clone()), renderer: renderer.clone() };
        assert!(ready.supported());
        assert_eq!(ready.limitation(), None);
        assert_eq!(ready.max_profile(), "1080p30");

        let missing = Readiness { probe: None, renderer: renderer.clone() };
        assert!(!missing.supported());
        assert!(missing.limitation().unwrap().contains("next Tilecast Edge update"));

        // UxPlay comes first, before the renderer and Avahi.
        let old = Readiness {
            probe: Some(Probe {
                uxplay_version: Some("1.70".into()),
                avahi_available: false,
                limitation: Some(wire::limitation::UXPLAY_VERSION_UNSUPPORTED.into()),
            }),
            renderer: RendererSupport::default(),
        };
        let sentence = old.limitation().unwrap();
        assert!(sentence.starts_with("UxPlay 1.70 is older than the supported baseline 1.73.7."), "{sentence}");
        assert!(!sentence.contains("install-airplay"), "Edge never runs the Electron installer");

        let no_video = Readiness {
            probe: Some(Probe { avahi_available: false, ..probe.clone() }),
            renderer: RendererSupport { video: false, ..renderer.clone() },
        };
        assert!(no_video.limitation().unwrap().starts_with("No supported H.264 decoder was found"));
        assert_eq!(no_video.max_profile(), "unsupported");

        let no_avahi =
            Readiness { probe: Some(Probe { avahi_available: false, ..probe.clone() }), renderer: renderer.clone() };
        assert!(!no_avahi.supported());
        assert_eq!(
            no_avahi.limitation().as_deref(),
            Some("Avahi/Bonjour support is unavailable; AirPlay cannot be advertised.")
        );

        // A software decoder is a quality limitation, not a refusal.
        let software = Readiness {
            probe: Some(probe),
            renderer: RendererSupport { decoder: Some("avdec_h264".into()), hardware_decode: false, ..renderer },
        };
        assert!(software.supported());
        assert_eq!(software.max_profile(), "720p30");
        assert!(software.limitation().unwrap().contains("720p30"));
    }

    #[test]
    fn stored_reasons_map_back_to_static_codes() {
        assert_eq!(stop_reason("expired"), reason::EXPIRED);
        assert_eq!(stop_reason("pin_attempts_exceeded"), wire::failure::PIN_ATTEMPTS_EXCEEDED);
        assert_eq!(stop_reason("anything"), "receiver_failed");
    }
}
