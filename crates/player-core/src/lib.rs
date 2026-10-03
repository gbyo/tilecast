//! Shared native Player behavior. Hosts supply services and platform handlers.
mod activity;
mod commands;
mod origin;
mod renderer_document;
mod renderer_port;
mod renderer_profile;
mod renderer_resources;
mod renderer_tracking;
mod schedule;
mod supervisor;

pub use activity::{
    Clocks as ActivityClocks, Event as ActivityEvent, ItemInfo as ActivityItem, Persisted as PersistedActivity,
    PresentationContext as ActivityPresentationContext, Presented as ActivityPresented,
    RendererSignal as ActivityRendererSignal, Signal as ActivitySignal, Tracker as ActivityTracker,
    reason as activity_reason,
};
pub use commands::{
    CommandApi, Coordinator, Handlers, POLL_INTERVAL, PassOutcome, Plan, REPORT_BEFORE_DISRUPTION_TIMEOUT,
    drive_commands,
};
pub use origin::{InvalidDownloadPath, OriginBlobSource};
pub use renderer_document::{
    ContentRef as VerifiedContentRef, ItemKind as RendererItemKind, PreparedDocumentError,
    PresentationDocument as PreparedDocument, PresentationFeature as RequiredRendererFeature,
    PresentationItem as PreparedItem, StatusSurface as PreparedSurface,
};
pub use renderer_port::{
    CapturedFrame, RendererActivation, RendererActivationRef, RendererCaptureRequest, RendererConfiguration,
    RendererPort, RendererPortError, SemanticRendererCommand,
};
pub use renderer_profile::{
    ConnectedRendererProfile, PackagedRendererProfile, RendererProfileError, RendererProfileMismatch,
    RendererRequirement, RendererSupport,
};
pub use renderer_resources::{ObjectBinding, Resource, ResourceError, RuntimePayload};
pub use renderer_tracking::{RendererProgressDecision, RendererTracker, SemanticRendererProgress};
pub use schedule::{DisplayPolicy, ScheduleError, Selection, Source, resolve, resolve_display_policy};
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

    /// Construct the durable coordinator with the host's fixed command handlers.
    pub fn commands<H: Handlers>(&self, handlers: H) -> Coordinator<H> {
        Coordinator::new(self.dependencies.state.clone(), self.dependencies.clock.clone(), handlers)
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
