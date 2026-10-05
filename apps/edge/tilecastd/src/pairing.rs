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

use edge_protocol::PlayerId;
use edge_protocol::bounded::SafeText;
use edge_protocol::ipc::presentation::PresentationDocument;
use edge_server::client::ServerError;
use edge_server::pairing::DeviceMetadata;
use player_core::{PairingCoordinator, PairingError, PairingStatus};

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

fn coordinator(context: &DaemonContext) -> Result<&PairingCoordinator, &'static str> {
    context.pairing_coordinator.as_ref().ok_or("This screen's local state is unavailable.")
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
    coordinator(context)?
        .begin(url, &user_agent(), &Metadata(context))
        .await
        .map_err(|error| pairing_message(&error))?;
    context.pairing_wake.notify_one();
    Ok(())
}

fn user_agent() -> String {
    format!("tilecastd/{}", edge_platform::RELEASE_VERSION)
}

struct Metadata<'a>(&'a DaemonContext);

#[async_trait::async_trait]
impl player_core::PairingMetadataProvider for Metadata<'_> {
    fn new_player_id(&self) -> edge_protocol::PlayerId {
        edge_protocol::PlayerId::from_uuid(uuid::Uuid::new_v4())
    }
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

#[async_trait::async_trait]
impl player_core::PairingHost for Metadata<'_> {
    async fn show_pairing(&self, status: PairingStatus) {
        let context = self.0;
        match status {
            PairingStatus::Paired => set_view(context, "paired", None, None),
            PairingStatus::Enrolled => {
                set_view(context, "paired", None, None);
                activate(context, crate::daemon::status_surface(context, true)).await;
                context.server_wake.notify_one();
                context.manifest_wake.notify_one();
            }
            PairingStatus::Setup => {
                set_view(context, "unpaired", None, None);
                activate(context, PresentationDocument::Setup {}).await;
            }
            PairingStatus::Reset => {
                set_view(context, "unpaired", None, Some("reset".to_owned()));
                activate(context, PresentationDocument::Setup {}).await;
            }
            PairingStatus::AddressRejected => activate(context, PresentationDocument::Setup {}).await,
            PairingStatus::Waiting { code, approval_url, organization_name } => {
                set_view(context, "waiting", Some(code.clone()), None);
                activate(
                    context,
                    PresentationDocument::Pairing {
                        code: SafeText::lossy(&code),
                        approval_url: SafeText::lossy(&approval_url),
                        organization_name: organization_name.as_deref().map(SafeText::lossy),
                    },
                )
                .await;
            }
            PairingStatus::Renewing { reason } => set_view(context, "renewing", None, Some(reason)),
        }
    }
}

/// Abandons a session in progress and returns to the setup surface.
pub async fn reset(context: &DaemonContext) {
    if let Ok(core) = coordinator(context) {
        core.reset(&Metadata(context)).await;
    } else {
        let _ = edge_server::FilePairingStore::remove_at(&context.paths.identity_dir());
        player_core::PairingHost::show_pairing(&Metadata(context), PairingStatus::Reset).await;
    }
    context.pairing_wake.notify_one();
}

async fn activate(context: &DaemonContext, document: PresentationDocument) {
    let now = context.now().unix_millis();
    let mut engine = context.presentation.lock().await;
    if engine.current().is_some_and(|current| current.document == document) {
        return;
    }
    let _ = engine.activate(document, Vec::new(), None, ActivationSource::StatusSurface, now);
}

/// Edge supplies lifecycle cancellation and its private platform adapters.
pub async fn run(context: Arc<DaemonContext>) {
    if context.config.dev.fixture.is_some() {
        return;
    }
    let Ok(core) = coordinator(&context) else { return };
    core.run(&user_agent(), &Metadata(&context), &context.pairing_wake, &context.shutdown).await;
}

/// The pairing state for `tilecastctl status`.
pub fn view(context: &DaemonContext) -> PairingView {
    context.pairing.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
