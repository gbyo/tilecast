//! Binding-scoped configuration acceptance. Hosts validate ownership projections.
use crate::{Dependencies, NativeConfiguration};
use async_trait::async_trait;
use player_client::player_api::ConfigFetch;
use player_client::{AuthenticatedServer, ServerError};
use player_state::repo::config::{self, AcceptOutcome, ConfigStage};
use player_state::repo::manifests::Binding;
use serde_json::Value;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ConfigurationOutcome {
    Unchanged,
    Accepted { revision: i64 },
    Refused { reason: &'static str },
}

/// Metadata for acceptance plus a projection owned by the host/Runtime.
#[derive(Debug)]
struct PreparedConfiguration<T> {
    native: NativeConfiguration,
    projection: T,
}

#[async_trait]
pub trait ConfigurationHost: Send + Sync {
    type Projection: Send;
    fn prepare_configuration(
        &self,
        document: &Value,
        native: &NativeConfiguration,
    ) -> Result<Self::Projection, &'static str>;
    async fn install_configuration(&self, projection: Option<Self::Projection>);
}

#[derive(Debug, Clone)]
pub struct ConfigurationCoordinator {
    dependencies: Dependencies,
}

impl ConfigurationCoordinator {
    pub fn new(dependencies: Dependencies) -> Self {
        Self { dependencies }
    }

    pub async fn load_cached(&self, binding: &Binding, host: &impl ConfigurationHost) {
        let lookup = binding.clone();
        let stored = match self
            .dependencies
            .state
            .run(move |connection| config::get_for(connection, ConfigStage::Current, &lookup))
            .await
        {
            Ok(stored) => stored,
            Err(error) => {
                tracing::warn!(component = "config", event = "cached_config_unreadable", reason = error.reason_code());
                return;
            }
        };
        let Some(stored) = stored else {
            host.install_configuration(None).await;
            return;
        };
        match prepare(host, &stored.document) {
            Ok(parsed) => {
                tracing::info!(
                    component = "config",
                    event = "cached_config_applied",
                    revision = parsed.native.revision
                );
                host.install_configuration(Some(parsed.projection)).await;
            }
            Err(reason) => tracing::warn!(component = "config", event = "cached_config_invalid", reason),
        }
    }

    async fn record(&self, error: Option<&'static str>) {
        let now = self.dependencies.clock.now();
        let _ = self.dependencies.state.run(move |connection| config::record_outcome(connection, error, now)).await;
    }

    pub async fn reconcile(
        &self,
        server: &AuthenticatedServer,
        binding: &Binding,
        host: &impl ConfigurationHost,
    ) -> Result<ConfigurationOutcome, ServerError> {
        self.reconcile_with(server, binding, host).await
    }

    /// One reconciliation against the authenticated server.
    async fn reconcile_with(
        &self,
        server: &impl ConfigurationApi,
        binding: &Binding,
        host: &impl ConfigurationHost,
    ) -> Result<ConfigurationOutcome, ServerError> {
        let db = &self.dependencies.state;
        let lookup = binding.clone();
        let current = db.run(move |c| config::get_for(c, ConfigStage::Current, &lookup)).await.ok().flatten();
        let fetched = server.player_config(current.as_ref().and_then(|stored| stored.etag.as_deref())).await;
        let (document, etag) = match fetched {
            Ok(ConfigFetch::NotModified) => {
                self.record(None).await;
                return Ok(ConfigurationOutcome::Unchanged);
            }
            Ok(ConfigFetch::Modified { document, etag }) => (document, etag),
            Err(ServerError::CredentialRejected) => return Err(ServerError::CredentialRejected),
            Err(error) => {
                // Unreachable or a bounded protocol failure: keep what is in
                // force. A transient network failure is not a configuration
                // error.
                if !matches!(error, ServerError::Network) {
                    self.record(Some(error.reason_code())).await;
                }
                return Err(error);
            }
        };
        let parsed = match prepare(host, &document) {
            Ok(parsed) => parsed,
            Err(reason) => {
                tracing::warn!(component = "config", event = "config_refused", reason);
                self.record(Some(reason)).await;
                return Ok(ConfigurationOutcome::Refused { reason });
            }
        };
        if let Some(current) = current.as_ref()
            && parsed.native.revision <= current.revision
        {
            let same =
                parsed.native.revision == current.revision && comparable(&document) == comparable(&current.document);
            if parsed.native.revision == current.revision
                && let Some(etag) = etag.clone()
            {
                let (bind, revision) = (binding.clone(), current.revision);
                let _ = db.run(move |c| config::set_current_etag(c, &bind, revision, &etag)).await;
            }
            if same {
                self.record(None).await;
                return Ok(ConfigurationOutcome::Unchanged);
            }
            let reason = if parsed.native.revision < current.revision {
                "config_revision_stale"
            } else {
                "config_revision_not_newer"
            };
            tracing::warn!(
                component = "config",
                event = "config_refused",
                reason,
                revision = parsed.native.revision,
                current = current.revision
            );
            self.record(Some(reason)).await;
            return Ok(ConfigurationOutcome::Refused { reason });
        }
        let (bind, schema, revision, now) =
            (binding.clone(), parsed.native.schema_version, parsed.native.revision, self.dependencies.clock.now());
        let stored_document = document.clone();
        let accepted =
            db.run(move |c| config::accept(c, &bind, schema, revision, etag.as_deref(), &stored_document, now)).await;
        match accepted {
            Ok(AcceptOutcome::Accepted) => {
                tracing::info!(component = "config", event = "config_accepted", revision);
                host.install_configuration(Some(parsed.projection)).await;
                self.record(None).await;
                Ok(ConfigurationOutcome::Accepted { revision })
            }
            Ok(AcceptOutcome::NotNewer { .. }) => {
                self.record(Some("config_revision_not_newer")).await;
                Ok(ConfigurationOutcome::Refused { reason: "config_revision_not_newer" })
            }
            Err(error) => {
                tracing::warn!(component = "config", event = "config_store_failed", reason = error.reason_code());
                self.record(Some("config_store_failed")).await;
                Ok(ConfigurationOutcome::Refused { reason: "config_store_failed" })
            }
        }
    }
}

fn prepare<H: ConfigurationHost>(
    host: &H,
    document: &Value,
) -> Result<PreparedConfiguration<H::Projection>, &'static str> {
    let native = NativeConfiguration::parse(document).map_err(|error| error.reason_code())?;
    let projection = host.prepare_configuration(document, &native)?;
    Ok(PreparedConfiguration { native, projection })
}

fn comparable(document: &Value) -> Value {
    let mut copy = document.clone();
    if let Some(object) = copy.as_object_mut() {
        object.remove("generatedAt");
    }
    copy
}

#[async_trait]
trait ConfigurationApi: Send + Sync {
    async fn player_config(&self, etag: Option<&str>) -> Result<ConfigFetch, ServerError>;
}

#[async_trait]
impl ConfigurationApi for AuthenticatedServer {
    async fn player_config(&self, etag: Option<&str>) -> Result<ConfigFetch, ServerError> {
        AuthenticatedServer::player_config(self, etag).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_client::player_api::MAX_CONFIG_BYTES;
    use player_state::{OpenOptions, StateDb};
    use player_types::{InstallationId, ScreenId, Timestamp, time::ManualClock};
    use serde_json::json;
    use std::sync::Mutex;

    #[derive(Default)]
    struct Host(Mutex<Vec<Option<Value>>>);

    #[async_trait]
    impl ConfigurationHost for Host {
        type Projection = Value;
        fn prepare_configuration(&self, document: &Value, _: &NativeConfiguration) -> Result<Value, &'static str> {
            Ok(document.clone())
        }
        async fn install_configuration(&self, projection: Option<Value>) {
            self.0.lock().unwrap().push(projection);
        }
    }

    struct Api {
        response: Result<ConfigFetch, ServerError>,
        validators: Mutex<Vec<Option<String>>>,
    }

    impl Api {
        fn document(document: Value, etag: &str) -> Self {
            Self {
                response: Ok(ConfigFetch::Modified { document, etag: Some(etag.into()) }),
                validators: Mutex::new(vec![]),
            }
        }
    }

    #[async_trait]
    impl ConfigurationApi for Api {
        async fn player_config(&self, etag: Option<&str>) -> Result<ConfigFetch, ServerError> {
            self.validators.lock().unwrap().push(etag.map(str::to_owned));
            self.response.clone()
        }
    }

    fn fixture() -> (tempfile::TempDir, ConfigurationCoordinator, Binding, Host) {
        let dir = tempfile::tempdir().unwrap();
        let state = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
        let clock = ManualClock::new(Timestamp::parse("2026-10-04T12:00:00Z").unwrap());
        let core = ConfigurationCoordinator::new(Dependencies { state, clock });
        let binding = Binding {
            installation_id: InstallationId::from_uuid(uuid::Uuid::from_u128(1)),
            screen_id: ScreenId::from_uuid(uuid::Uuid::from_u128(2)),
            server_url: "https://signs.example.org".into(),
        };
        (dir, core, binding, Host::default())
    }

    async fn stored(
        core: &ConfigurationCoordinator,
        binding: &Binding,
        stage: ConfigStage,
    ) -> Option<config::StoredConfig> {
        let binding = binding.clone();
        core.dependencies.state.run(move |connection| config::get_for(connection, stage, &binding)).await.unwrap()
    }

    #[tokio::test]
    async fn opaque_projection_survives_acceptance_restart_and_monotonic_revisions() {
        let (dir, core, binding, host) = fixture();
        let first = json!({"schemaVersion":1,"configRevision":1,"generatedAt":"first",
            "playback":{"futureRuntimeOption":{"transition":"unknown","values":[1,2,3]}},
            "linuxKiosk":{"preventDisplaySleep":false}});
        assert_eq!(
            core.reconcile_with(&Api::document(first.clone(), "one"), &binding, &host).await.unwrap(),
            ConfigurationOutcome::Accepted { revision: 1 }
        );
        assert_eq!(*host.0.lock().unwrap(), vec![Some(first.clone())]);
        let mut duplicate = first.clone();
        duplicate["generatedAt"] = json!("second");
        let api = Api::document(duplicate, "resend");
        assert_eq!(core.reconcile_with(&api, &binding, &host).await.unwrap(), ConfigurationOutcome::Unchanged);
        assert_eq!(*api.validators.lock().unwrap(), vec![Some("one".into())]);
        let mut conflicting = first.clone();
        conflicting["playback"]["futureRuntimeOption"] = json!(false);
        assert_eq!(
            core.reconcile_with(&Api::document(conflicting, "conflict"), &binding, &host).await.unwrap(),
            ConfigurationOutcome::Refused { reason: "config_revision_not_newer" }
        );
        let current = stored(&core, &binding, ConfigStage::Current).await.unwrap();
        assert_eq!(current.document, first);
        assert_eq!(current.etag.as_deref(), Some("conflict"));
        assert_eq!(host.0.lock().unwrap().len(), 1);
        let mut newer = first.clone();
        newer["configRevision"] = json!(2);
        newer["playback"]["anotherRuntimeOption"] = json!("preserved");
        assert_eq!(
            core.reconcile_with(&Api::document(newer.clone(), "two"), &binding, &host).await.unwrap(),
            ConfigurationOutcome::Accepted { revision: 2 }
        );
        assert_eq!(stored(&core, &binding, ConfigStage::Previous).await.unwrap().document, first);
        assert_eq!(
            core.reconcile_with(&Api::document(first, "stale"), &binding, &host).await.unwrap(),
            ConfigurationOutcome::Refused { reason: "config_revision_stale" }
        );
        let reopened = ConfigurationCoordinator::new(Dependencies {
            state: StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap(),
            clock: core.dependencies.clock.clone(),
        });
        let host = Host::default();
        reopened.load_cached(&binding, &host).await;
        assert_eq!(*host.0.lock().unwrap(), vec![Some(newer)]);
    }

    #[tokio::test]
    async fn configurations_never_cross_installation_screen_or_server_bindings() {
        let (_dir, core, binding, host) = fixture();
        let document = json!({"schemaVersion":1,"configRevision":10});
        core.reconcile_with(&Api::document(document, "old"), &binding, &host).await.unwrap();
        let mut replacement = binding.clone();
        replacement.server_url = "https://new.example.org".into();
        core.load_cached(&replacement, &host).await;
        assert_eq!(host.0.lock().unwrap().last(), Some(&None));
        assert_eq!(
            core.reconcile_with(
                &Api::document(json!({"schemaVersion":1,"configRevision":1}), "new"),
                &replacement,
                &host
            )
            .await
            .unwrap(),
            ConfigurationOutcome::Accepted { revision: 1 }
        );
        assert!(stored(&core, &binding, ConfigStage::Current).await.is_none());
        assert!(stored(&core, &replacement, ConfigStage::Previous).await.is_none());
    }

    #[tokio::test]
    async fn malformed_or_unstored_documents_cannot_replace_configuration_in_force() {
        let (_dir, core, binding, host) = fixture();
        core.reconcile_with(&Api::document(json!({"schemaVersion":1,"configRevision":1}), "one"), &binding, &host)
            .await
            .unwrap();
        for (document, reason) in [
            (json!(null), "config_malformed"),
            (json!({"schemaVersion":2,"configRevision":2}), "config_schema_unsupported"),
            (json!({"schemaVersion":1,"configRevision":-1}), "config_revision_invalid"),
            (
                json!({"schemaVersion":1,"configRevision":2,"playback":{"unknown":"x".repeat(MAX_CONFIG_BYTES)}}),
                "config_too_large",
            ),
        ] {
            assert_eq!(
                core.reconcile_with(&Api::document(document, "bad"), &binding, &host).await.unwrap(),
                ConfigurationOutcome::Refused { reason }
            );
        }
        core.dependencies.state.run(|connection| {
            connection.execute_batch("CREATE TRIGGER reject_config BEFORE INSERT ON player_config BEGIN SELECT RAISE(ABORT, 'fixture'); END;")?;
            Ok(())
        }).await.unwrap();
        assert_eq!(
            core.reconcile_with(&Api::document(json!({"schemaVersion":1,"configRevision":2}), "two"), &binding, &host)
                .await
                .unwrap(),
            ConfigurationOutcome::Refused { reason: "config_store_failed" }
        );
        assert_eq!(stored(&core, &binding, ConfigStage::Current).await.unwrap().revision, 1);
        assert!(stored(&core, &binding, ConfigStage::Previous).await.is_none());
        assert_eq!(host.0.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn network_failure_preserves_the_previous_configuration_error() {
        let (_dir, core, binding, host) = fixture();
        core.record(Some("config_schema_unsupported")).await;
        let api = Api { response: Err(ServerError::Network), validators: Mutex::new(vec![]) };
        assert_eq!(core.reconcile_with(&api, &binding, &host).await, Err(ServerError::Network));
        let status = core.dependencies.state.run(|connection| config::status(connection)).await.unwrap();
        assert_eq!(status.last_error_code.as_deref(), Some("config_schema_unsupported"));
        let api = Api { response: Ok(ConfigFetch::NotModified), validators: Mutex::new(vec![]) };
        assert_eq!(core.reconcile_with(&api, &binding, &host).await.unwrap(), ConfigurationOutcome::Unchanged);
        let status = core.dependencies.state.run(|connection| config::status(connection)).await.unwrap();
        assert!(status.last_error_code.is_none());
        assert!(host.0.lock().unwrap().is_empty());
    }

    struct ConcurrentAcceptance {
        core: ConfigurationCoordinator,
        binding: Binding,
    }

    #[async_trait]
    impl ConfigurationApi for ConcurrentAcceptance {
        async fn player_config(&self, _: Option<&str>) -> Result<ConfigFetch, ServerError> {
            let binding = self.binding.clone();
            let now = self.core.dependencies.clock.now();
            self.core
                .dependencies
                .state
                .run(move |connection| {
                    config::accept(
                        connection,
                        &binding,
                        1,
                        3,
                        Some("winner"),
                        &json!({"schemaVersion":1,"configRevision":3,"playback":{"winner":true}}),
                        now,
                    )?;
                    Ok(())
                })
                .await
                .unwrap();
            Ok(ConfigFetch::Modified {
                document: json!({"schemaVersion":1,"configRevision":2}),
                etag: Some("loser".into()),
            })
        }
    }

    #[tokio::test]
    async fn a_concurrent_acceptance_cannot_be_overwritten_after_the_fetch() {
        let (_dir, core, binding, host) = fixture();
        core.reconcile_with(&Api::document(json!({"schemaVersion":1,"configRevision":1}), "one"), &binding, &host)
            .await
            .unwrap();
        let api = ConcurrentAcceptance { core: core.clone(), binding: binding.clone() };
        assert_eq!(
            core.reconcile_with(&api, &binding, &host).await.unwrap(),
            ConfigurationOutcome::Refused { reason: "config_revision_not_newer" }
        );
        let current = stored(&core, &binding, ConfigStage::Current).await.unwrap();
        assert_eq!(current.revision, 3);
        assert_eq!(current.etag.as_deref(), Some("winner"));
        assert_eq!(stored(&core, &binding, ConfigStage::Previous).await.unwrap().revision, 1);
        assert_eq!(host.0.lock().unwrap().len(), 1);
    }
}
