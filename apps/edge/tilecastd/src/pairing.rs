//! Pairing a fresh installation (M5) with the ordinary pairing protocol.
//!
//! A server address arrives from the runtime's setup surface
//! (`setup.submit_server_url`), from a discovered server the viewer chose,
//! or from the operator (`tilecastctl pair`). It passes the player URL
//! policy, then public installation identity must answer with pairing
//! enabled, and only then is a session created. The screen shows the visible
//! code; the private poll secret and the one-time enrollment token stay in
//! `identity/pairing-session` (0600) and in this process, never in SQLite,
//! IPC or logs.
//!
//! A session survives a daemon restart and resumes. It is polled at the
//! server's cadence; an expired or rejected session is replaced by a fresh
//! one for the same server, as the reference player does, and `pairing.reset`
//! abandons it. Enrollment stores the credential, then the binding, then
//! removes the session file: a crash between those steps never loses the
//! credential, and a crash after the approving poll re-uses the saved token.
//!
//! A screen whose credential the server rejected starts pairing again with
//! its bound server; the existing protocol reuses its screen record.

use std::sync::Arc;
use std::time::Duration;

use edge_protocol::PlayerId;
use edge_protocol::bounded::SafeText;
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_server::client::{ServerClient, ServerError};
use edge_server::pairing::{DeviceMetadata, PairingSession, PollStatus};
use edge_server::url_policy::normalize_server_url;
use edge_state::repo::binding::{self, CredentialState, ServerBinding};
use edge_state::repo::daemon as daemon_repo;

use crate::daemon::{DaemonContext, VERSION};
use crate::presentation::ActivationSource;

const RETRY: Duration = Duration::from_secs(5);
const ENROLL_ATTEMPTS: u32 = 10;

/// What pairing is doing, for status and tests.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct PairingView {
    pub state: &'static str,
    pub code: Option<String>,
    pub reason: Option<String>,
}

fn set_view(context: &DaemonContext, state: &'static str, code: Option<String>, reason: Option<String>) {
    *context.pairing.lock().unwrap_or_else(|e| e.into_inner()) = PairingView { state, code, reason };
}

/// Whether this installation may start pairing: it has no usable credential.
async fn may_pair(context: &DaemonContext) -> Result<Option<ServerBinding>, &'static str> {
    let db = context.db().ok_or("This screen's local state is unavailable.")?;
    let bound = db.run(|c| binding::get(c)).await.map_err(|_| "This screen's local state is unavailable.")?;
    let credential_present =
        edge_server::DeviceCredential::load(&context.paths.identity_dir()).ok().flatten().is_some();
    match &bound {
        Some(record) if record.credential_state == CredentialState::Stored && credential_present => {
            Err("This screen is already paired.")
        }
        _ => Ok(bound),
    }
}

fn read_small(path: &str) -> String {
    use std::io::Read as _;
    let mut text = String::new();
    if let Ok(file) = std::fs::File::open(path) {
        let _ = file.take(256).read_to_string(&mut text);
    }
    text.trim().to_owned()
}

fn metadata(player: PlayerId, display: Option<(u32, u32)>) -> DeviceMetadata {
    let locale = std::env::var("LANG").ok().and_then(|lang| lang.split('.').next().map(|l| l.replace('_', "-")));
    let timezone = jiff::tz::TimeZone::system().iana_name().map(str::to_owned);
    DeviceMetadata::new(
        *player.as_uuid(),
        &read_small("/proc/sys/kernel/hostname"),
        &format!("Linux {}", std::env::consts::ARCH),
        &read_small("/proc/sys/kernel/osrelease"),
        VERSION,
        display.unwrap_or((1920, 1080)),
        locale.as_deref().unwrap_or("en-US"),
        timezone.as_deref().unwrap_or("UTC"),
    )
}

async fn ensure_player_id(context: &DaemonContext) -> Result<PlayerId, &'static str> {
    let db = context.db().ok_or("This screen's local state is unavailable.")?;
    let now = context.now();
    db.run(move |c| {
        if let Some(identity) = daemon_repo::player_identity(c)? {
            return Ok(identity.player_id);
        }
        let id = PlayerId::new_random();
        daemon_repo::set_player_identity(c, id, daemon_repo::PlayerIdentitySource::Generated, now)?;
        Ok(id)
    })
    .await
    .map_err(|_| "This screen's local state is unavailable.")
}

fn user_message(error: &ServerError) -> &'static str {
    match error {
        ServerError::Url(_) => "That address is not allowed. Public servers need https://.",
        ServerError::Network => "The server could not be reached. Check the address and the network.",
        ServerError::Decode | ServerError::ResponseTooLarge => "That address did not answer as a Tilecast server.",
        ServerError::Api { status: 403, .. } => "Pairing is turned off on this Tilecast server.",
        ServerError::Api { status: 429, .. } => "Too many pairing attempts. Wait a minute and try again.",
        _ => "The server refused the pairing request.",
    }
}

/// Creates a session for `url` and shows its code. Returns a message for the
/// setup surface on failure.
pub async fn begin(context: &DaemonContext, url: &str) -> Result<(), &'static str> {
    may_pair(context).await?;
    context.pairing_suppressed.store(false, std::sync::atomic::Ordering::Release);
    let normalized =
        normalize_server_url(url).map_err(|_| "That address is not allowed. Public servers need https://.")?;
    let client = ServerClient::new(&normalized).map_err(|e| user_message(&e))?;
    let session = create_session(context, &client).await?;
    tracing::info!(component = "pairing", event = "session_created", server = %client.base_url());
    show(context, &session).await;
    context.pairing_wake.notify_one();
    Ok(())
}

async fn create_session(context: &DaemonContext, client: &ServerClient) -> Result<PairingSession, &'static str> {
    let identity = client.identity().await.map_err(|e| user_message(&e))?;
    if !identity.pairing_enabled {
        return Err("Pairing is turned off on this Tilecast server.");
    }
    let player = ensure_player_id(context).await?;
    let display = context
        .presentation
        .lock()
        .await
        .renderer_display()
        .filter(|display| display.connected)
        .map(|display| (display.width, display.height));
    let session = client
        .create_pairing_session(identity.installation_id, &metadata(player, display))
        .await
        .map_err(|e| user_message(&e))?;
    session.save(&context.paths.identity_dir()).map_err(|_| "The pairing session could not be stored.")?;
    Ok(session)
}

/// Abandons a session in progress and returns to the setup surface.
pub async fn reset(context: &DaemonContext) {
    // A screen with a rejected credential would otherwise pair again at once.
    context.pairing_suppressed.store(true, std::sync::atomic::Ordering::Release);
    take_renewal(context);
    let _ = PairingSession::remove(&context.paths.identity_dir());
    set_view(context, "unpaired", None, Some("reset".to_owned()));
    show_setup(context).await;
    context.pairing_wake.notify_one();
}

async fn show(context: &DaemonContext, session: &PairingSession) {
    set_view(context, "waiting", Some(session.code.clone()), None);
    let document = PresentationDocument::Pairing {
        code: SafeText::lossy(&session.code),
        approval_url: SafeText::lossy(&session.approval_url),
        organization_name: session.organization_name.as_deref().map(SafeText::lossy),
    };
    activate(context, document).await;
}

async fn show_setup(context: &DaemonContext) {
    activate(context, PresentationDocument::Setup {}).await;
}

async fn activate(context: &DaemonContext, document: PresentationDocument) {
    let now = context.now().unix_millis();
    let mut engine = context.presentation.lock().await;
    if engine.current().is_some_and(|current| current.document == document) {
        return;
    }
    let _ = engine.activate(document, Vec::new(), None, ActivationSource::StatusSurface, now);
}

enum Outcome {
    Enrolled,
    /// The session is gone; start a fresh one for this server.
    Replace(String),
    /// Try again after a delay.
    Retry,
}

async fn step(context: &DaemonContext, session: PairingSession) -> Outcome {
    let identity_dir = context.paths.identity_dir();
    let Ok(client) = ServerClient::new(&session.server_url) else {
        return Outcome::Replace("server_url_rejected".to_owned());
    };
    let session = if session.has_enrollment_token() {
        session
    } else {
        if session.is_expired(context.now()) {
            return Outcome::Replace("expired".to_owned());
        }
        match client.poll_pairing(&session).await {
            Ok(PollStatus::Waiting) => return Outcome::Retry,
            Ok(PollStatus::Claimed(token)) => {
                let claimed = session.with_enrollment_token(token);
                // The token is single-use: keep it before trying to use it.
                if claimed.save(&identity_dir).is_err() {
                    tracing::error!(component = "pairing", event = "token_not_stored");
                }
                claimed
            }
            Ok(PollStatus::TokenLost) => return Outcome::Replace("enrollment_token_lost".to_owned()),
            Ok(PollStatus::Ended(reason)) => return Outcome::Replace(reason),
            Err(error) => {
                tracing::warn!(component = "pairing", event = "poll_failed", reason = error.reason_code());
                return Outcome::Retry;
            }
        }
    };
    for attempt in 0..ENROLL_ATTEMPTS {
        match client.enroll(&session).await {
            Ok(enrolled) => {
                if enrolled.credential.save(&identity_dir).is_err() {
                    tracing::error!(component = "pairing", event = "credential_not_stored");
                    return Outcome::Retry;
                }
                let Some(db) = context.db() else { return Outcome::Retry };
                let now = context.now();
                let record = ServerBinding {
                    server_url: session.server_url.clone(),
                    installation_id: session.installation_id,
                    organization_name: session.organization_name.clone(),
                    screen_id: Some(enrolled.screen_id),
                    screen_name: Some(enrolled.screen_name.clone()),
                    credential_state: CredentialState::Stored,
                    identity_verified_at: Some(now),
                    bound_at: now,
                };
                if db.run(move |c| binding::put(c, &record, now)).await.is_err() {
                    return Outcome::Retry;
                }
                let _ = PairingSession::remove(&identity_dir);
                tracing::info!(component = "pairing", event = "enrolled", screen = %enrolled.screen_id);
                return Outcome::Enrolled;
            }
            // Only a network failure is retried; a server verdict on a
            // one-time token is final.
            Err(ServerError::Network) if attempt + 1 < ENROLL_ATTEMPTS => tokio::time::sleep(RETRY).await,
            Err(error) => {
                tracing::warn!(component = "pairing", event = "enrollment_refused", reason = error.reason_code());
                return Outcome::Replace("enrollment_failed".to_owned());
            }
        }
    }
    Outcome::Replace("enrollment_failed".to_owned())
}

/// The pairing task. Idle while the installation holds a credential.
pub async fn run(context: Arc<DaemonContext>) {
    if context.config.dev.fixture.is_some() || context.db().is_none() {
        return;
    }
    let identity_dir = context.paths.identity_dir();
    loop {
        let mut delay = None;
        match may_pair(&context).await {
            Err(_) => set_view(&context, "paired", None, None),
            Ok(bound) => match PairingSession::load(&identity_dir) {
                Ok(Some(session)) => {
                    show(&context, &session).await;
                    let interval = Duration::from_secs(u64::from(session.polling_interval_seconds));
                    let server_url = session.server_url.clone();
                    match step(&context, session).await {
                        Outcome::Enrolled => {
                            set_view(&context, "paired", None, None);
                            let surface = crate::daemon::status_surface(&context, true);
                            activate(&context, surface).await;
                            context.server_wake.notify_one();
                            context.manifest_wake.notify_one();
                        }
                        Outcome::Retry => delay = Some(interval),
                        Outcome::Replace(reason) => {
                            tracing::info!(component = "pairing", event = "session_ended", reason = reason.as_str());
                            let _ = PairingSession::remove(&identity_dir);
                            set_view(&context, "renewing", None, Some(reason));
                            match ServerClient::new(&server_url) {
                                Ok(client) => {
                                    // Show and poll the new session at once.
                                    delay = Some(Duration::ZERO);
                                    if let Err(message) = create_session(&context, &client).await {
                                        tracing::warn!(component = "pairing", event = "renewal_failed", message);
                                        // Keep the address so the next pass tries again.
                                        delay = Some(RETRY);
                                        renew_later(&context, &server_url);
                                    }
                                }
                                Err(_) => show_setup(&context).await,
                            }
                        }
                    }
                }
                Ok(None) => match bound.filter(|record| record.credential_state != CredentialState::Stored) {
                    // A rejected credential pairs again with its own server.
                    Some(record) if !context.pairing_suppressed.load(std::sync::atomic::Ordering::Acquire) => {
                        if begin(&context, &record.server_url).await.is_err() {
                            delay = Some(RETRY * 6);
                        }
                    }
                    _ => {
                        if let Some(url) = take_renewal(&context) {
                            if begin(&context, &url).await.is_err() {
                                renew_later(&context, &url);
                                delay = Some(RETRY);
                            }
                        } else {
                            set_view(&context, "unpaired", None, None);
                            show_setup(&context).await;
                        }
                    }
                },
                Err(error) => {
                    tracing::error!(component = "pairing", event = "session_unreadable", error = %error);
                    let _ = PairingSession::remove(&identity_dir);
                    delay = Some(RETRY);
                }
            },
        }
        let wait = delay.unwrap_or(Duration::from_secs(3600));
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = context.pairing_wake.notified() => {}
            () = tokio::time::sleep(wait) => {}
        }
    }
}

fn renew_later(context: &DaemonContext, url: &str) {
    *context.pairing_renewal.lock().unwrap_or_else(|e| e.into_inner()) = Some(url.to_owned());
}

fn take_renewal(context: &DaemonContext) -> Option<String> {
    context.pairing_renewal.lock().unwrap_or_else(|e| e.into_inner()).take()
}

/// The pairing state for `tilecastctl status`.
pub fn view(context: &DaemonContext) -> PairingView {
    context.pairing.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
