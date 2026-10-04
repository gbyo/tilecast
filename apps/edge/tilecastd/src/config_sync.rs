//! Player configuration reconciliation (M4).
//!
//! The ordinary configuration endpoint is read on connection, at once on a
//! `config.changed` push, and at the manifest reconciliation interval as the
//! fallback, always conditional on the accepted document's validator. A
//! document is accepted only after [`PlayerConfig::parse`] and only at a
//! strictly greater `configRevision` than the one in force: the server's
//! validator is `"config-<screen>-<revision>"`, so a different answer at the
//! same revision can only follow a lost validator, and it never replaces
//! what was accepted. Anything refused leaves the last accepted document in
//! force and records a bounded reason for the heartbeat's
//! `configurationError`.
//!
//! The accepted document is applied at start from SQLite before any network
//! access, and every acceptance applies it at once: presentation surfaces
//! and playback defaults (through activation), the content store policy,
//! the recovery ladder and the renderer kiosk policy.

use std::sync::Arc;

use edge_cas::StorePolicy;
use edge_server::AuthenticatedServer;
use edge_server::client::ServerError;
use edge_state::repo::manifests::Binding;

use crate::daemon::DaemonContext;
use crate::player_config::PlayerConfig;

pub use player_core::ConfigurationOutcome as ConfigOutcome;

fn coordinator(context: &DaemonContext) -> Option<player_core::ConfigurationCoordinator> {
    let db = context.db()?;
    Some(
        player_core::PlayerCore::new(player_core::Dependencies { state: db.clone(), clock: context.clock.clone() })
            .configuration(),
    )
}

struct Projection<'a>(&'a DaemonContext);

#[async_trait::async_trait]
impl player_core::ConfigurationHost for Projection<'_> {
    type Projection = PlayerConfig;

    fn prepare_configuration(
        &self,
        document: &serde_json::Value,
    ) -> Result<player_core::PreparedConfiguration<PlayerConfig>, &'static str> {
        let parsed = PlayerConfig::parse(document).map_err(|error| error.reason_code())?;
        Ok(player_core::PreparedConfiguration {
            schema_version: parsed.schema_version,
            revision: parsed.revision,
            projection: parsed,
        })
    }

    async fn install_configuration(&self, config: Option<PlayerConfig>) {
        install(self.0, config).await;
    }
}

/// The configuration in force: the accepted document, or the defaults
/// before any was accepted.
pub fn effective(context: &DaemonContext) -> Arc<PlayerConfig> {
    context
        .player_config
        .read()
        .unwrap_or_else(|poison| poison.into_inner())
        .clone()
        .unwrap_or_else(|| Arc::new(PlayerConfig::default()))
}

/// The accepted revision, if any, for the heartbeat.
pub fn accepted_revision(context: &DaemonContext) -> Option<i64> {
    context.player_config.read().unwrap_or_else(|poison| poison.into_inner()).as_ref().map(|config| config.revision)
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
pub async fn install(context: &DaemonContext, config: Option<PlayerConfig>) {
    let config = config.map(Arc::new);
    *context.player_config.write().unwrap_or_else(|poison| poison.into_inner()) = config.clone();
    let effective = config.unwrap_or_else(|| Arc::new(PlayerConfig::default()));
    if let Some(cas) = &context.cas {
        cas.set_policy(store_policy(context, &effective));
    }
    context.presentation.lock().await.apply_player_config(&context.config, &effective);
    context.manifest_wake.notify_one();
    context.network_wake.notify_one();
    context.idle_wake.notify_one();
}

/// The operator's store policy narrowed by the server's: the smaller byte
/// limit and the larger free-space floor. Operator configuration is local
/// policy that the server can tighten but never loosen.
pub fn store_policy(context: &DaemonContext, config: &PlayerConfig) -> StorePolicy {
    let operator = &context.config.cas;
    StorePolicy {
        limit_bytes: config.cache.maximum_bytes.map_or(operator.limit_bytes, |max| max.min(operator.limit_bytes)),
        reserved_free_bytes: config
            .cache
            .minimum_free_bytes
            .map_or(operator.reserved_free_bytes, |min| min.max(operator.reserved_free_bytes)),
    }
}

/// Core accepts configuration; Edge supplies validated ownership projections.
pub async fn reconcile(
    context: &DaemonContext,
    server: &AuthenticatedServer,
    binding: &Binding,
) -> Result<ConfigOutcome, ServerError> {
    let Some(core) = coordinator(context) else { return Ok(ConfigOutcome::Unchanged) };
    core.reconcile(server, binding, &Projection(context)).await
}
