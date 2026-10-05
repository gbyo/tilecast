//! Accepted player configuration in force. Core accepts and persists the
//! document; the host holds the projection (`player_config`) and applies
//! what does not flow through activation: the content-store policy.

use player_client::{AuthenticatedServer, ServerError};
use player_core::{ConfigurationCoordinator, ConfigurationOutcome as ConfigOutcome};
use player_state::repo::manifests::Binding;
use std::sync::Arc;

use crate::daemon::DaemonContext;
use crate::player_config::WindowsPlayerConfig;

fn coordinator(context: &DaemonContext) -> Option<ConfigurationCoordinator> {
    context.core.as_ref().map(player_core::PlayerCore::configuration)
}

struct Projection<'a>(&'a DaemonContext);

#[async_trait::async_trait]
impl player_core::ConfigurationHost for Projection<'_> {
    type Projection = WindowsPlayerConfig;
    fn prepare_configuration(
        &self,
        document: &serde_json::Value,
        native: &player_core::NativeConfiguration,
    ) -> Result<Self::Projection, &'static str> {
        WindowsPlayerConfig::project(document, native.clone()).map_err(|error| error.reason_code())
    }
    async fn install_configuration(&self, projection: Option<Self::Projection>) {
        install(self.0, projection).await;
    }
}

/// The configuration in force: the accepted document, or the defaults
/// before any was accepted.
pub fn effective(context: &DaemonContext) -> Arc<WindowsPlayerConfig> {
    context
        .player_config
        .read()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
        .unwrap_or_else(|| Arc::new(WindowsPlayerConfig::default()))
}

/// The accepted revision, if any, for the heartbeat.
pub fn accepted_revision(context: &DaemonContext) -> Option<i64> {
    context
        .player_config
        .read()
        .unwrap_or_else(|poison| poison.into_inner())
        .as_ref()
        .map(|config| config.native.revision)
}

/// Applies the accepted configuration for `binding` from local state.
/// Called at start, before the server is contacted, and whenever the
/// binding changes.
pub async fn load_cached(context: &DaemonContext, binding: &Binding) {
    if let Some(core) = coordinator(context) {
        core.load_cached(binding, &Projection(context)).await;
    }
}

/// Puts `config` in force and applies what does not flow through
/// activation.
pub async fn install(context: &DaemonContext, config: Option<WindowsPlayerConfig>) {
    let config = config.map(Arc::new);
    *context.player_config.write().unwrap_or_else(|poison| poison.into_inner()) = config.clone();
    let effective = config.unwrap_or_else(|| Arc::new(WindowsPlayerConfig::default()));
    if let Some(cas) = &context.cas {
        cas.set_policy(store_policy(context, &effective));
    }
    context.manifest_wake.notify_one();
}

/// The operator's store policy narrowed by the server's: the smaller byte
/// limit and the larger free-space floor. Operator configuration is local
/// policy that the server can tighten but never loosen.
pub fn store_policy(context: &DaemonContext, config: &WindowsPlayerConfig) -> player_cas::StorePolicy {
    let operator = &context.config.cas;
    player_cas::StorePolicy {
        limit_bytes: config
            .native
            .cache
            .maximum_bytes
            .map_or(operator.limit_bytes, |max| max.min(operator.limit_bytes)),
        reserved_free_bytes: config
            .native
            .cache
            .minimum_free_bytes
            .map_or(operator.reserved_free_bytes, |min| min.max(operator.reserved_free_bytes)),
    }
}

/// Core accepts configuration; the host supplies validated projections.
pub async fn reconcile(
    context: &DaemonContext,
    server: &AuthenticatedServer,
    binding: &Binding,
) -> Result<ConfigOutcome, ServerError> {
    let Some(core) = coordinator(context) else { return Ok(ConfigOutcome::Unchanged) };
    core.reconcile(server, binding, &Projection(context)).await
}
