//! One target-bound preparation worker, independent of renderer projection.
use crate::{Dependencies, ManifestPrepared};
use async_trait::async_trait;
use player_state::repo::manifests::{self, Stage, Target};
use player_types::Sha256Digest;
use std::sync::{Arc, Mutex};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ManifestPreparationStatus {
    pub target: Option<Sha256Digest>,
    pub state: &'static str,
    pub reason: Option<String>,
}

pub type SharedManifestPreparationStatus = Arc<Mutex<ManifestPreparationStatus>>;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ManifestFailureKind {
    Incompatible,
    Invalid,
    Retryable,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ManifestWorkerFailure {
    pub kind: ManifestFailureKind,
    pub reason: &'static str,
}

/// Hosts supply renderer compatibility and the authenticated content source.
/// Verified preparation and pending storage use the native manifest coordinator.
#[async_trait]
pub trait ManifestWorkerHost: Send + Sync + 'static {
    async fn content_intact(&self, target: &Target) -> bool;
    async fn prepare(&self, target: &Target) -> Result<ManifestPrepared, ManifestWorkerFailure>;
}

#[derive(Debug)]
pub struct ManifestPreparationCoordinator {
    dependencies: Dependencies,
    status: SharedManifestPreparationStatus,
    worker: Option<(Sha256Digest, JoinHandle<()>)>,
}

impl ManifestPreparationCoordinator {
    pub fn new(dependencies: Dependencies, status: SharedManifestPreparationStatus) -> Self {
        Self { dependencies, status, worker: None }
    }

    pub fn abort(&mut self) {
        if let Some((_, task)) = self.worker.take() {
            task.abort();
        }
    }

    pub async fn reap(&mut self) {
        if self.worker.as_ref().is_some_and(|(_, task)| task.is_finished())
            && let Some((_, task)) = self.worker.take()
        {
            let _ = task.await;
        }
    }

    /// Replacement cancels the obsolete worker; CAS partials remain resumable.
    /// The native coordinator checks the target again before pending storage.
    pub async fn ensure<H: ManifestWorkerHost>(
        &mut self,
        target: Option<Target>,
        host: Arc<H>,
        shutdown: &CancellationToken,
    ) {
        let Some(target) = target else {
            self.abort();
            return;
        };
        let digest = target.digest;
        if self.worker.as_ref().is_some_and(|(running, _)| *running == digest) {
            return;
        }
        self.abort();
        for stage in [Stage::Active, Stage::Pending] {
            let binding = target.binding.clone();
            if self
                .dependencies
                .state
                .run(move |connection| manifests::get_for(connection, stage, &binding))
                .await
                .ok()
                .flatten()
                .is_some_and(|stored| stored.digest == digest)
                && host.content_intact(&target).await
            {
                return;
            }
        }
        // A deterministic rejection is final for this exact target.
        let known_final = {
            let status = self.status.lock().unwrap_or_else(|error| error.into_inner());
            status.target == Some(digest) && matches!(status.state, "incompatible" | "invalid")
        };
        if known_final {
            return;
        }
        *self.status.lock().unwrap_or_else(|error| error.into_inner()) =
            ManifestPreparationStatus { target: Some(digest), state: "preparing", reason: None };
        let status = self.status.clone();
        let shutdown = shutdown.clone();
        let task = tokio::spawn(async move {
            let result = tokio::select! {
                () = shutdown.cancelled() => return,
                result = host.prepare(&target) => result,
            };
            let (state, reason) = match result {
                Ok(ManifestPrepared::Current) => ("current", None),
                Ok(ManifestPrepared::Repaired) => ("repaired", None),
                Ok(ManifestPrepared::Pending) => ("pending", None),
                Ok(ManifestPrepared::Superseded) => ("superseded", None),
                Err(error) => {
                    let state = match error.kind {
                        ManifestFailureKind::Incompatible => "incompatible",
                        ManifestFailureKind::Invalid => "invalid",
                        ManifestFailureKind::Retryable => "failed",
                    };
                    (state, Some(error.reason.to_owned()))
                }
            };
            let mut status = status.lock().unwrap_or_else(|error| error.into_inner());
            if status.target == Some(digest) {
                *status = ManifestPreparationStatus { target: Some(digest), state, reason };
            }
        });
        self.worker = Some((digest, task));
    }
}

impl Drop for ManifestPreparationCoordinator {
    fn drop(&mut self) {
        self.abort();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_state::repo::manifests::{Binding, StoredManifest};
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, ScreenId, Timestamp, time::ManualClock};
    use serde_json::json;
    use std::collections::HashMap;
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::time::Duration;
    use tokio::sync::{mpsc, oneshot};

    type Answer = Result<ManifestPrepared, ManifestWorkerFailure>;
    struct Host {
        calls: mpsc::UnboundedSender<Sha256Digest>,
        replies: Mutex<HashMap<Sha256Digest, oneshot::Receiver<Answer>>>,
        intact: AtomicBool,
    }

    #[async_trait]
    impl ManifestWorkerHost for Host {
        async fn content_intact(&self, _: &Target) -> bool {
            self.intact.load(Ordering::Relaxed)
        }
        async fn prepare(&self, target: &Target) -> Answer {
            let reply = self.replies.lock().unwrap().remove(&target.digest).unwrap();
            self.calls.send(target.digest).unwrap();
            reply.await.unwrap()
        }
    }

    impl Host {
        fn reply(&self, target: &Target) -> oneshot::Sender<Answer> {
            let (sender, receiver) = oneshot::channel();
            self.replies.lock().unwrap().insert(target.digest, receiver);
            sender
        }
    }

    fn fixture() -> (tempfile::TempDir, ManifestPreparationCoordinator, Arc<Host>, mpsc::UnboundedReceiver<Sha256Digest>)
    {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let clock = ManualClock::new(Timestamp::parse("2026-10-04T12:00:00Z").unwrap());
        let core = ManifestPreparationCoordinator::new(Dependencies { state, clock }, Arc::default());
        let (calls, receiver) = mpsc::unbounded_channel();
        let host = Arc::new(Host { calls, replies: Mutex::default(), intact: AtomicBool::new(true) });
        (dir, core, host, receiver)
    }

    fn target(version: i64) -> Target {
        let binding = Binding {
            installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
            screen_id: ScreenId::from_uuid(uuid::Uuid::from_u128(2)),
            server_url: "https://signs.example.org".into(),
        };
        let document = json!({"schemaVersion":16,"manifestVersion":version,"screenId":binding.screen_id.to_string(),
            "futureRuntimeOption":{"transition":"unknown"}});
        Target {
            binding,
            digest: crate::manifest_digest(&document),
            version,
            document,
            etag: version.to_string(),
            fetched_at: Timestamp::parse("2026-10-04T12:00:00Z").unwrap(),
        }
    }

    async fn completed(core: &mut ManifestPreparationCoordinator) {
        tokio::time::timeout(Duration::from_secs(2), async {
            while core.worker.as_ref().is_some_and(|(_, task)| !task.is_finished()) {
                tokio::task::yield_now().await;
            }
        })
        .await
        .unwrap();
        core.reap().await;
    }

    #[tokio::test]
    async fn replacement_and_shutdown_cancel_obsolete_workers() {
        let (_dir, mut core, host, mut calls) = fixture();
        let shutdown = CancellationToken::new();
        let first = target(1);
        let mut first_reply = host.reply(&first);
        core.ensure(Some(first.clone()), host.clone(), &shutdown).await;
        assert_eq!(calls.recv().await, Some(first.digest));
        core.ensure(Some(first.clone()), host.clone(), &shutdown).await;
        assert!(calls.try_recv().is_err(), "one worker for the same target");

        let second = target(2);
        let mut second_reply = host.reply(&second);
        core.ensure(Some(second.clone()), host.clone(), &shutdown).await;
        assert_eq!(calls.recv().await, Some(second.digest));
        tokio::time::timeout(Duration::from_secs(2), first_reply.closed()).await.unwrap();
        assert_eq!(core.status.lock().unwrap().target, Some(second.digest));
        assert_eq!(core.status.lock().unwrap().state, "preparing");

        shutdown.cancel();
        tokio::time::timeout(Duration::from_secs(2), second_reply.closed()).await.unwrap();
        completed(&mut core).await;
        assert!(core.worker.is_none());
        assert_eq!(core.status.lock().unwrap().state, "preparing", "cancelled work reports no success");
    }

    #[tokio::test]
    async fn deterministic_failures_wait_for_a_new_target_but_transient_failures_retry() {
        let (_dir, mut core, host, mut calls) = fixture();
        let shutdown = CancellationToken::new();
        let first = target(1);
        for kind in [ManifestFailureKind::Retryable, ManifestFailureKind::Incompatible] {
            let reply = host.reply(&first);
            core.ensure(Some(first.clone()), host.clone(), &shutdown).await;
            assert_eq!(calls.recv().await, Some(first.digest));
            reply.send(Err(ManifestWorkerFailure { kind, reason: "fixture_refusal" })).unwrap();
            completed(&mut core).await;
        }
        assert_eq!(core.status.lock().unwrap().state, "incompatible");
        assert_eq!(core.status.lock().unwrap().reason.as_deref(), Some("fixture_refusal"));
        core.ensure(Some(first), host.clone(), &shutdown).await;
        assert!(calls.try_recv().is_err());
        assert!(core.worker.is_none());
        let second = target(2);
        let reply = host.reply(&second);
        core.ensure(Some(second.clone()), host.clone(), &shutdown).await;
        assert_eq!(calls.recv().await, Some(second.digest));
        reply.send(Ok(ManifestPrepared::Pending)).unwrap();
        completed(&mut core).await;
        assert_eq!(core.status.lock().unwrap().state, "pending");
        assert!(core.status.lock().unwrap().reason.is_none());
    }

    #[tokio::test]
    async fn cached_content_is_rechecked_and_missing_content_is_repaired() {
        let (_dir, mut core, host, mut calls) = fixture();
        let shutdown = CancellationToken::new();
        let target = target(1);
        let stored_target = target.clone();
        core.dependencies
            .state
            .run(move |connection| {
                manifests::put_target(connection, &stored_target)?;
                let manifest = StoredManifest {
                    binding: stored_target.binding,
                    digest: stored_target.digest,
                    version: stored_target.version,
                    document: stored_target.document,
                    stored_at: stored_target.fetched_at,
                };
                assert!(manifests::put_pending_for_target(connection, &manifest)?);
                Ok(())
            })
            .await
            .unwrap();
        core.ensure(Some(target.clone()), host.clone(), &shutdown).await;
        assert!(calls.try_recv().is_err());
        assert!(core.worker.is_none());
        host.intact.store(false, Ordering::Relaxed);
        let reply = host.reply(&target);
        core.ensure(Some(target.clone()), host.clone(), &shutdown).await;
        assert_eq!(calls.recv().await, Some(target.digest));
        reply.send(Ok(ManifestPrepared::Repaired)).unwrap();
        completed(&mut core).await;
        assert_eq!(core.status.lock().unwrap().state, "repaired");
    }
}
