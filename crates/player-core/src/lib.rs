//! Shared native Player behavior. Hosts supply services and platform handlers.
mod activity;
mod capture;
mod commands;
mod configuration;
mod live_stream;
mod manifest_content;
mod manifest_resources;
mod manifests;
mod native_configuration;
mod origin;
mod pairing;
mod preview;
mod renderer_commands;
mod renderer_coordinator;
mod renderer_document;
mod renderer_port;
mod renderer_profile;
mod renderer_resources;
mod renderer_tracking;
mod schedule;
mod server_link;
mod supervisor;

pub use activity::{
    Clocks as ActivityClocks, Event as ActivityEvent, ItemInfo as ActivityItem, Persisted as PersistedActivity,
    PresentationContext as ActivityPresentationContext, Presented as ActivityPresented,
    RendererSignal as ActivityRendererSignal, Signal as ActivitySignal, Tracker as ActivityTracker,
    reason as activity_reason,
};
pub use capture::{CaptureBroker, CaptureError, CaptureState, RENDERER_CAPTURE_TIMEOUT};
pub use commands::{
    CommandApi, Coordinator, Handlers, POLL_INTERVAL, PassOutcome, Plan, REPORT_BEFORE_DISRUPTION_TIMEOUT,
    drive_commands,
};
pub use configuration::{ConfigurationCoordinator, ConfigurationHost, ConfigurationOutcome};
pub use live_stream::{LiveFrame, LiveStreamApi, LiveStreamHost, clear_live_frame, drive_live_stream};
pub use manifest_content::{
    MANIFEST_PIN_PREFIX, ManifestOriginSources, ManifestPreparationError, ManifestSourcePlan, manifest_pin_holder,
};
pub use manifest_resources::{ManifestAsset, NATIVE_MANIFEST_SCHEMAS, NativeManifest, NativeManifestError};
pub use manifests::{ManifestCoordinator, ManifestPrepared, ManifestSyncError, manifest_digest};
pub use native_configuration::{
    ActiveHours, ActiveHoursResult, Cache, ConfigError as ConfigurationError, NativeConfiguration, Reliability, Sync,
    evaluate_active_hours,
};
pub use origin::{InvalidDownloadPath, OriginBlobSource};
pub use pairing::{
    PAIRING_RETRY, PairingCoordinator, PairingError, PairingHost, PairingMetadataProvider, PairingOutcome,
    PairingStatus,
};
pub use preview::{
    PREVIEW_FIRST_SUSPENSION, PREVIEW_MAX_HEIGHT, PREVIEW_MAX_SUSPENSION, PREVIEW_MAX_WIDTH, PreviewApi, PreviewHealth,
    PreviewHost, drive_preview,
};
pub use renderer_commands::{
    RendererCommandBroker, RendererCommandError, SemanticRendererCommandResult, StartupWebsiteClear,
    WEBSITE_DATA_CLEAR_TIMEOUT,
};
pub use renderer_coordinator::{RendererCoordinator, RendererDispatch};
pub use renderer_document::{
    ContentRef as VerifiedContentRef, MAX_RENDERER_REQUIREMENTS, PreparedActivationError, RendererMetadata,
};
pub use renderer_port::{
    CapturedFrame, RendererActivation, RendererActivationRef, RendererCaptureRequest, RendererPort, RendererPortError,
    SemanticRendererCommand,
};
pub use renderer_profile::{
    ConnectedRendererProfile, PackagedRendererProfile, RendererProfileError, RendererProfileMismatch,
    RendererRequirement, RendererSupport,
};
pub use renderer_resources::{ObjectBinding, ResourceError, RuntimePayload};
pub use renderer_tracking::{RendererProgressDecision, RendererTracker, SemanticRendererProgress};
pub use schedule::{DisplayPolicy, ScheduleError, Selection, Source, resolve, resolve_display_policy};
pub use server_link::{
    SERVER_HEALTHY_RESET, SERVER_MAX_RETRY, SERVER_RETRY_BASE, ServerBackoff, ServerLinkState, ServerRelationship,
    ServerRelationshipError, refined_server_offset, server_retry_delay,
};
pub use supervisor::{
    Expectation, HealAction, ProgressEvidence, SupervisorConfig, SupervisorState, is_content_evidence, is_meaningful,
};

use player_state::StateDb;
use player_types::time::SharedClock;

/// Durable services shared by native Player behavior. The host chooses storage.
#[derive(Debug, Clone)]
pub struct Dependencies {
    pub state: StateDb,
    pub clock: SharedClock,
}

/// Composition entry point for shared native Player behavior.
#[derive(Debug, Clone)]
pub struct PlayerCore {
    dependencies: Dependencies,
}

impl PlayerCore {
    pub fn new(dependencies: Dependencies) -> Self {
        Self { dependencies }
    }

    pub fn configuration(&self) -> ConfigurationCoordinator {
        ConfigurationCoordinator::new(self.dependencies.clone())
    }

    pub fn manifests(&self) -> ManifestCoordinator {
        ManifestCoordinator::new(self.dependencies.clone())
    }

    /// Construct the durable coordinator with the host's fixed command handlers.
    pub fn commands<H: Handlers>(&self, handlers: H) -> Coordinator<H> {
        Coordinator::new(self.dependencies.state.clone(), self.dependencies.clock.clone(), handlers)
    }

    /// Construct pairing policy with the host's private credential/session stores.
    pub fn pairing(
        &self,
        credentials: std::sync::Arc<dyn player_client::CredentialStore>,
        sessions: std::sync::Arc<dyn player_client::PairingStore>,
    ) -> PairingCoordinator {
        PairingCoordinator::new(self.dependencies.clone(), credentials, sessions)
    }

    pub fn server_relationship(
        &self,
        credentials: std::sync::Arc<dyn player_client::CredentialStore>,
    ) -> ServerRelationship {
        ServerRelationship::new(self.dependencies.clone(), credentials)
    }

    /// Resolve native selection at the host's current wall-clock instant.
    pub fn select(&self, document: &serde_json::Value) -> Result<Selection, ScheduleError> {
        resolve(document, self.dependencies.clock.now().unix_millis())
    }

    /// Drive command delivery for the current verified server relationship.
    pub async fn run<H, A>(
        &self,
        coordinator: &Coordinator<H>,
        server: tokio::sync::watch::Receiver<Option<A>>,
        wake: &tokio::sync::Notify,
        shutdown: &tokio_util::sync::CancellationToken,
        on_outcome: impl FnMut(PassOutcome),
    ) where
        H: Handlers,
        A: CommandApi + Clone,
    {
        drive_commands(coordinator, server, wake, shutdown, on_outcome).await;
    }
}
