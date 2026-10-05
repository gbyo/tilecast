//! Core-owned background drivers for the Android host.
//!
//! Each driver is a Core reconciliation loop from `player-core`; this module
//! only supervises their lifetime. Drivers start exactly once per host and
//! stop before the host drops, so there is never a second socket or
//! reconciliation loop. PR2a runs the pairing driver; the server link,
//! configuration, manifest, command, Activity, telemetry, and recovery
//! drivers join behind the same supervisor.

use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};

use player_core::PairingCoordinator;
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

use crate::pairing_host::{AndroidPairingHost, MetadataSource};

#[derive(Debug)]
pub struct Drivers {
    pairing: PairingDriver,
}

#[derive(Debug)]
struct PairingDriver {
    coordinator: PairingCoordinator,
    host: AndroidPairingHost,
    user_agent: String,
    wake: Arc<Notify>,
    shutdown: CancellationToken,
    started: AtomicBool,
    handles: Mutex<Vec<tokio::task::JoinHandle<()>>>,
}

impl Drivers {
    pub fn new(coordinator: PairingCoordinator, meta: Arc<dyn MetadataSource>, user_agent: String) -> Self {
        let wake = Arc::new(Notify::new());
        let host = AndroidPairingHost::new(meta, wake.clone());
        Self {
            pairing: PairingDriver {
                coordinator,
                host,
                user_agent,
                wake,
                shutdown: CancellationToken::new(),
                started: AtomicBool::new(false),
                handles: Mutex::new(Vec::new()),
            },
        }
    }

    /// Spawns the pairing reconciliation loop. Idempotent: a second call is
    /// a no-op, so Kotlin can call start unconditionally.
    pub fn start(&self, runtime: &tokio::runtime::Runtime) {
        if self.pairing.started.swap(true, Ordering::AcqRel) {
            return;
        }
        let coordinator = self.pairing.coordinator.clone();
        let host = self.pairing.host.clone();
        let user_agent = self.pairing.user_agent.clone();
        let wake = self.pairing.wake.clone();
        let shutdown = self.pairing.shutdown.clone();
        let handle = runtime.spawn(async move {
            coordinator.run(&user_agent, &host, &wake, &shutdown).await;
        });
        self.pairing.handles.lock().unwrap_or_else(|error| error.into_inner()).push(handle);
    }

    /// Wakes the pairing loop for an immediate pass (for example after the
    /// server URL changes or a pairing reset).
    pub fn wake_pairing(&self) {
        self.pairing.wake.notify_one();
    }

    pub fn pairing(&self) -> &PairingCoordinator {
        &self.pairing.coordinator
    }

    pub fn pairing_host(&self) -> &AndroidPairingHost {
        &self.pairing.host
    }

    pub fn user_agent(&self) -> &str {
        &self.pairing.user_agent
    }

    /// Cancels every driver and waits for their tasks to finish. Runs
    /// before the host drops its runtime, state, and stores.
    pub async fn shutdown(&self) {
        self.pairing.shutdown.cancel();
        let handles: Vec<_> =
            self.pairing.handles.lock().unwrap_or_else(|error| error.into_inner()).drain(..).collect();
        for handle in handles {
            let _ = handle.await;
        }
    }
}
