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
use edge_server::player_api::ConfigFetch;
use edge_state::repo::config::{self, AcceptOutcome, ConfigStage};
use edge_state::repo::manifests::Binding;

use crate::daemon::DaemonContext;
use crate::player_config::PlayerConfig;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigOutcome {
    Unchanged,
    Accepted { revision: i64 },
    Refused { reason: &'static str },
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
    let Some(db) = context.db() else { return };
    let lookup = binding.clone();
    let stored = match db.run(move |c| config::get_for(c, ConfigStage::Current, &lookup)).await {
        Ok(stored) => stored,
        Err(error) => {
            tracing::warn!(component = "config", event = "cached_config_unreadable", reason = error.reason_code());
            return;
        }
    };
    let Some(stored) = stored else {
        install(context, None).await;
        return;
    };
    match PlayerConfig::parse(&stored.document) {
        Ok(parsed) => {
            tracing::info!(component = "config", event = "cached_config_applied", revision = parsed.revision);
            install(context, Some(parsed)).await;
        }
        Err(error) => {
            // A stored document was validated when it was accepted; one that
            // no longer parses (for example after a downgrade) is not used.
            tracing::warn!(component = "config", event = "cached_config_invalid", reason = error.reason_code());
        }
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

async fn record(context: &DaemonContext, error: Option<&'static str>) {
    if let Some(db) = context.db() {
        let now = context.now();
        let _ = db.run(move |c| config::record_outcome(c, error, now)).await;
    }
}

/// One reconciliation against the authenticated server.
pub async fn reconcile(
    context: &DaemonContext,
    server: &AuthenticatedServer,
    binding: &Binding,
) -> Result<ConfigOutcome, ServerError> {
    let Some(db) = context.db() else { return Ok(ConfigOutcome::Unchanged) };
    let lookup = binding.clone();
    let current = db.run(move |c| config::get_for(c, ConfigStage::Current, &lookup)).await.ok().flatten();
    let fetched = server.player_config(current.as_ref().and_then(|stored| stored.etag.as_deref())).await;
    let (document, etag) = match fetched {
        Ok(ConfigFetch::NotModified) => {
            record(context, None).await;
            return Ok(ConfigOutcome::Unchanged);
        }
        Ok(ConfigFetch::Modified { document, etag }) => (document, etag),
        Err(ServerError::CredentialRejected) => return Err(ServerError::CredentialRejected),
        Err(error) => {
            // Unreachable or a bounded protocol failure: keep what is in
            // force. A transient network failure is not a configuration
            // error.
            if !matches!(error, ServerError::Network) {
                record(context, Some(error.reason_code())).await;
            }
            return Err(error);
        }
    };
    let parsed = match PlayerConfig::parse(&document) {
        Ok(parsed) => parsed,
        Err(error) => {
            tracing::warn!(component = "config", event = "config_refused", reason = error.reason_code());
            record(context, Some(error.reason_code())).await;
            return Ok(ConfigOutcome::Refused { reason: error.reason_code() });
        }
    };
    if let Some(current) = current.as_ref()
        && parsed.revision <= current.revision
    {
        let same = parsed.revision == current.revision
            && PlayerConfig::comparable(&document) == PlayerConfig::comparable(&current.document);
        if parsed.revision == current.revision
            && let Some(etag) = etag.clone()
        {
            let (bind, revision) = (binding.clone(), current.revision);
            let _ = db.run(move |c| config::set_current_etag(c, &bind, revision, &etag)).await;
        }
        if same {
            record(context, None).await;
            return Ok(ConfigOutcome::Unchanged);
        }
        let reason =
            if parsed.revision < current.revision { "config_revision_stale" } else { "config_revision_not_newer" };
        tracing::warn!(
            component = "config",
            event = "config_refused",
            reason,
            revision = parsed.revision,
            current = current.revision
        );
        record(context, Some(reason)).await;
        return Ok(ConfigOutcome::Refused { reason });
    }
    let (bind, schema, revision, now) = (binding.clone(), parsed.schema_version, parsed.revision, context.now());
    let stored_document = document.clone();
    let accepted =
        db.run(move |c| config::accept(c, &bind, schema, revision, etag.as_deref(), &stored_document, now)).await;
    match accepted {
        Ok(AcceptOutcome::Accepted) => {
            tracing::info!(component = "config", event = "config_accepted", revision);
            install(context, Some(parsed)).await;
            record(context, None).await;
            Ok(ConfigOutcome::Accepted { revision })
        }
        Ok(AcceptOutcome::NotNewer { .. }) => {
            record(context, Some("config_revision_not_newer")).await;
            Ok(ConfigOutcome::Refused { reason: "config_revision_not_newer" })
        }
        Err(error) => {
            tracing::warn!(component = "config", event = "config_store_failed", reason = error.reason_code());
            record(context, Some("config_store_failed")).await;
            Ok(ConfigOutcome::Refused { reason: "config_store_failed" })
        }
    }
}
