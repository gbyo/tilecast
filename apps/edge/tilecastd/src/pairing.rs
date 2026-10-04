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

use edge_server::{FileCredentialStore, FilePairingStore};
use std::sync::Arc;
use std::time::Duration;

use edge_protocol::PlayerId;
use edge_protocol::bounded::SafeText;
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_server::client::{ServerClient, ServerError};
use edge_server::pairing::{DeviceMetadata, PairingSession};
use edge_server::url_policy::normalize_server_url;
use edge_state::repo::binding::{CredentialState, ServerBinding};
use player_core::{PAIRING_RETRY as RETRY, PairingCoordinator, PairingError, PairingOutcome as Outcome};

use crate::daemon::{DaemonContext, VERSION};
use crate::presentation::ActivationSource;

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

fn coordinator(context: &DaemonContext) -> Result<PairingCoordinator, &'static str> {
    let db = context.db().ok_or("This screen's local state is unavailable.")?;
    let core =
        player_core::PlayerCore::new(player_core::Dependencies { state: db.clone(), clock: context.clock.clone() });
    Ok(core.pairing(
        Arc::new(FileCredentialStore::new(context.paths.identity_dir())),
        Arc::new(FilePairingStore::new(context.paths.identity_dir())),
    ))
}

async fn may_pair(context: &DaemonContext) -> Result<Option<ServerBinding>, &'static str> {
    coordinator(context)?.may_pair().await.map_err(|error| pairing_message(&error))
}

fn pairing_message(error: &PairingError) -> &'static str {
    match error {
        PairingError::LocalStateUnavailable => "This screen's local state is unavailable.",
        PairingError::AlreadyPaired => "This screen is already paired.",
        PairingError::PairingDisabled => "Pairing is turned off on this Tilecast server.",
        PairingError::SessionNotStored => "The pairing session could not be stored.",
        PairingError::Server(error) => user_message(error),
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
        "linux",
        &read_small("/proc/sys/kernel/hostname"),
        &format!("Linux {}", std::env::consts::ARCH),
        &read_small("/proc/sys/kernel/osrelease"),
        VERSION,
        display.unwrap_or((1920, 1080)),
        locale.as_deref().unwrap_or("en-US"),
        timezone.as_deref().unwrap_or("UTC"),
    )
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
    let client = ServerClient::new(&normalized, &format!("tilecastd/{}", edge_platform::RELEASE_VERSION))
        .map_err(|e| user_message(&e))?;
    let session = create_session(context, &client).await?;
    tracing::info!(component = "pairing", event = "session_created", server = %client.base_url());
    show(context, &session).await;
    context.pairing_wake.notify_one();
    Ok(())
}

struct Metadata<'a>(&'a DaemonContext);

#[async_trait::async_trait]
impl player_core::PairingMetadataProvider for Metadata<'_> {
    async fn metadata(&self, player: PlayerId) -> DeviceMetadata {
        let display = self
            .0
            .presentation
            .lock()
            .await
            .renderer_display()
            .filter(|display| display.connected)
            .map(|display| (display.width, display.height));
        metadata(player, display)
    }
}

async fn create_session(context: &DaemonContext, client: &ServerClient) -> Result<PairingSession, &'static str> {
    coordinator(context)?.create_session(client, &Metadata(context)).await.map_err(|error| pairing_message(&error))
}

/// Abandons a session in progress and returns to the setup surface.
pub async fn reset(context: &DaemonContext) {
    // A screen with a rejected credential would otherwise pair again at once.
    context.pairing_suppressed.store(true, std::sync::atomic::Ordering::Release);
    take_renewal(context);
    let _ = FilePairingStore::remove_at(&context.paths.identity_dir());
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

async fn step(context: &DaemonContext, session: PairingSession) -> Outcome {
    let Ok(client) = ServerClient::new(&session.server_url, &format!("tilecastd/{}", edge_platform::RELEASE_VERSION))
    else {
        return Outcome::Replace("server_url_rejected".to_owned());
    };
    let Ok(core) = coordinator(context) else { return Outcome::Retry };
    core.step(&client, session).await
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
            Ok(bound) => match FilePairingStore::read_at(&identity_dir) {
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
                            let _ = FilePairingStore::remove_at(&identity_dir);
                            set_view(&context, "renewing", None, Some(reason));
                            match ServerClient::new(
                                &server_url,
                                &format!("tilecastd/{}", edge_platform::RELEASE_VERSION),
                            ) {
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
                    let _ = FilePairingStore::remove_at(&identity_dir);
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
