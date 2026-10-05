//! Pairing a fresh installation with the ordinary pairing protocol.
//!
//! A server address arrives from the operator (`tilecast-windows pair` in
//! stage 2; the setup surface in stage 6). It passes the player URL policy,
//! then public installation identity must answer with pairing enabled, and
//! only then is a session created. The private poll secret and the one-time
//! enrollment token stay DPAPI-sealed in `identity/pairing-session` and in
//! this process, never in SQLite or logs.
//!
//! A session survives a restart and resumes. It is polled at the server's
//! cadence; an expired or rejected session is replaced by a fresh one for
//! the same server, as the reference player does, and `pairing.reset`
//! abandons it. Enrollment stores the credential, then the binding, then
//! removes the session file: a crash between those steps never loses the
//! credential, and a crash after the approving poll re-uses the saved token.
//!
//! A screen whose credential the server rejected starts pairing again with
//! its bound server; the existing protocol reuses its screen record.

use player_client::ServerError;
use player_core::{PairingCoordinator, PairingError, PairingStatus};
use player_types::PlayerId;
use std::sync::Arc;

use crate::daemon::{DaemonContext, PairingView};

fn coordinator(context: &DaemonContext) -> Result<&PairingCoordinator, &'static str> {
    context.pairing_coordinator.as_ref().ok_or("This screen's local state is unavailable.")
}

fn set_view(
    context: &DaemonContext,
    state: &'static str,
    code: Option<String>,
    reason: Option<String>,
    approval_url: String,
    organization_name: Option<String>,
) {
    let view = PairingView { state, code, reason, approval_url, organization_name };
    let mut current = context.pairing.lock().unwrap_or_else(|e| e.into_inner());
    if *current != view {
        *current = view;
        // The presentation task refreshes the setup/pairing surface. Only
        // changes wake: this runs inside the pairing loop, which also
        // sleeps on the same signal.
        context.pairing_wake.notify_one();
    }
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

/// Creates a session for `url` and records its code. Returns a message for
/// the caller on failure.
pub async fn begin(context: &DaemonContext, url: &str) -> Result<(), &'static str> {
    coordinator(context)?
        .begin(url, &crate::user_agent(), &Metadata(context))
        .await
        .map_err(|error| pairing_message(&error))?;
    context.pairing_wake.notify_one();
    Ok(())
}

struct Metadata<'a>(&'a DaemonContext);

#[async_trait::async_trait]
impl player_core::PairingMetadataProvider for Metadata<'_> {
    fn new_player_id(&self) -> PlayerId {
        PlayerId::from_uuid(uuid::Uuid::new_v4())
    }
    async fn metadata(&self, player: PlayerId) -> player_client::pairing::DeviceMetadata {
        crate::device::metadata(player, None)
    }
}

#[async_trait::async_trait]
impl player_core::PairingHost for Metadata<'_> {
    async fn show_pairing(&self, status: PairingStatus) {
        let context = self.0;
        match status {
            PairingStatus::Paired => set_view(context, "paired", None, None, String::new(), None),
            PairingStatus::Enrolled => {
                set_view(context, "paired", None, None, String::new(), None);
                context.server_wake.notify_one();
                context.manifest_wake.notify_one();
            }
            PairingStatus::Setup | PairingStatus::AddressRejected => {
                set_view(context, "unpaired", None, None, String::new(), None);
            }
            PairingStatus::Reset => {
                set_view(context, "unpaired", None, Some("reset".to_owned()), String::new(), None);
            }
            PairingStatus::Waiting { code, approval_url, organization_name } => {
                set_view(context, "waiting", Some(code), None, approval_url, organization_name);
            }
            PairingStatus::Renewing { reason } => {
                set_view(context, "renewing", None, Some(reason), String::new(), None)
            }
        }
    }
}

/// Abandons a session in progress and returns to the unpaired state.
pub async fn reset(context: &DaemonContext) {
    if let Ok(core) = coordinator(context) {
        core.reset(&Metadata(context)).await;
    } else {
        let _ = crate::pairing_store::SealedPairingStore::remove_at(&context.paths.identity_dir());
        player_core::PairingHost::show_pairing(&Metadata(context), PairingStatus::Reset).await;
    }
    context.pairing_wake.notify_one();
}

/// The host supplies lifecycle cancellation; Core owns the pairing loop.
pub async fn run(context: Arc<DaemonContext>) {
    let Ok(core) = coordinator(&context) else { return };
    core.run(&crate::user_agent(), &Metadata(&context), &context.pairing_wake, &context.shutdown).await;
}

/// The pairing state for `tilecast-windows status`.
pub fn view(context: &DaemonContext) -> PairingView {
    context.pairing.lock().unwrap_or_else(|e| e.into_inner()).clone()
}
