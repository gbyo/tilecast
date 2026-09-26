//! `tilecastd import-legacy`: the one-time migration from the Electron
//! Linux Player (docs/tilecast-edge.md §14.2).
//!
//! The migrator runs this as the `tilecast` account in
//! `tilecast-edge-import.service`, after it stops the legacy player and
//! before it enables `tilecast-edge.service`. The unit reads the copy of the
//! legacy state that the migrator made (`/var/lib/tilecast-edge/legacy-copy`),
//! so the daemon account never needs access to the kiosk account's home. It
//! refuses to run while the daemon is running, because the content store's
//! single-writer rules are per process. Re-running is safe; a completed
//! import is not repeated unless `--refresh` is given. Nothing in the legacy
//! directory is modified.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, bail};
use edge_cas::{ContentStore, LruByDomain, StorePolicy};
use edge_platform::disk::StatvfsProbe;
use edge_platform::paths::EdgePaths;
use edge_protocol::time::system_clock;
use edge_server::legacy::{ImportMode, ImportOutcome, default_legacy_dir, import_legacy};
use edge_state::{OpenOptions, StateDb};

use crate::config::EdgeConfig;

/// Why the import stopped before it reached the legacy state.
#[derive(Debug, thiserror::Error)]
#[error("tilecastd is running; stop tilecast-edge.service before importing")]
pub struct DaemonRunning;

pub async fn run(config: &EdgeConfig, from: Option<PathBuf>, mode: ImportMode) -> anyhow::Result<ImportOutcome> {
    let paths = EdgePaths::from_environment(config.paths.state_dir.as_deref(), config.paths.runtime_dir.as_deref());
    if tokio::net::UnixStream::connect(paths.socket()).await.is_ok() {
        return Err(DaemonRunning.into());
    }
    let legacy_dir = from
        .or_else(|| config.legacy.data_dir.clone())
        .or_else(default_legacy_dir)
        .context("no legacy data directory: pass --from")?;
    if !legacy_dir.is_absolute() {
        bail!("the legacy data directory must be an absolute path");
    }
    paths.ensure_private_dirs().with_context(|| format!("creating {}", paths.state_dir.display()))?;
    let clock = system_clock();
    let db = StateDb::open(paths.state_db(), OpenOptions::default()).context("opening state")?;
    let cas = ContentStore::open(
        paths.cas_root(),
        paths.partial_dir(),
        db.clone(),
        clock.clone(),
        Arc::new(StatvfsProbe),
        StorePolicy { limit_bytes: config.cas.limit_bytes, reserved_free_bytes: config.cas.reserved_free_bytes },
        Arc::new(LruByDomain),
    )
    .await
    .context("opening the content store")?;
    let outcome = import_legacy(&legacy_dir, &paths.identity_dir(), &db, &cas, clock.now(), mode).await;
    cas.flush_touches().await.ok();
    db.checkpoint().ok();
    Ok(outcome?)
}

/// The stable reason code for a failed import, for the migrator.
pub fn failure_reason(error: &anyhow::Error) -> &'static str {
    if error.is::<DaemonRunning>() {
        return "daemon_running";
    }
    match error.downcast_ref::<edge_server::legacy::ImportError>() {
        Some(error) => error.reason_code(),
        None => "import_failed",
    }
}
