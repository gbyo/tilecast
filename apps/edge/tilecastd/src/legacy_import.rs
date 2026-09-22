//! `tilecastd import-legacy`: the one-time migration from the Electron
//! Linux Player (RFC Amendment A1.3).
//!
//! The installer runs this as the `tilecast` account, outside the daemon
//! unit (whose `ProtectHome=yes` hides the legacy directory), after stopping
//! the legacy player and before enabling `tilecast-edge.service`. It refuses
//! to run while the daemon is running, because the content store's
//! single-writer rules are per process. Re-running is safe; a completed
//! import is not repeated. Nothing in the legacy directory is modified.

use std::path::PathBuf;
use std::sync::Arc;

use anyhow::{Context as _, bail};
use edge_cas::{ContentStore, LruByDomain, StorePolicy};
use edge_platform::disk::StatvfsProbe;
use edge_platform::paths::EdgePaths;
use edge_protocol::time::system_clock;
use edge_server::legacy::{ImportOutcome, default_legacy_dir, import_legacy};
use edge_state::{OpenOptions, StateDb};

use crate::config::EdgeConfig;

pub async fn run(config: &EdgeConfig, from: Option<PathBuf>) -> anyhow::Result<ImportOutcome> {
    let paths = EdgePaths::from_environment(config.paths.state_dir.as_deref(), config.paths.runtime_dir.as_deref());
    if tokio::net::UnixStream::connect(paths.socket()).await.is_ok() {
        bail!("tilecastd is running; stop tilecast-edge.service before importing");
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
    let outcome = import_legacy(&legacy_dir, &paths.identity_dir(), &db, &cas, clock.now()).await;
    cas.flush_touches().await.ok();
    db.checkpoint().ok();
    Ok(outcome?)
}
