//! The mesh runtime: one Zenoh peer session per node.
//!
//! What travels here is small and never authoritative (RFC §13, §15):
//!
//! * **presence**: a liveliness token per node. Tokens are not signed, so
//!   presence is a hint for diagnostics and for *when to ask*; nothing
//!   actionable (an endpoint, a holder) is taken from it;
//! * **node statements** (summary, capabilities, object availability),
//!   signed by the node key and carrying the node certificate. A statement
//!   is accepted only if its certificate verifies against the installation
//!   CA and revocation set, it names this installation, and it arrived on
//!   its own node's key;
//! * **change hints**: server-signed change envelopes relayed as-is. They
//!   are handed to the daemon, which verifies them and applies them only in
//!   chain order (`edge_server::feed`); a hint can wake reconciliation but
//!   never advance it past what the signed chain proves.
//!
//! Bytes never travel here (the peer CDN carries them), every payload is
//! capped at [`MAX_MESSAGE_BYTES`], and losing the mesh only loses hints:
//! playback and server reconciliation do not depend on it.

use std::collections::{BTreeMap, BTreeSet};
use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use edge_identity::certificate::{PeerRole, verify_peer};
use edge_identity::tls::NodeCredentials;
use edge_identity::{RevocationSet, TrustAnchor};
use edge_protocol::signed::statement::{
    StatementDraft, StatementSigner, VerifiedStatement, sign_statement, types, verify_statement,
};
use edge_protocol::signed::{SignedDocument, SigningKey};
use edge_protocol::{InstallationId, NodeId, Sha256Digest, Timestamp};
use serde::{Deserialize, Serialize};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;
use zenoh::qos::{CongestionControl, Priority};
use zenoh::query::{ConsolidationMode, QueryTarget};
use zenoh::sample::SampleKind;

use crate::config::{ConfigError, Transport, zenoh_config};
use crate::keys::{Keyspace, NodeKey};

/// Upper bound on any mesh payload. Media never travels over Zenoh.
pub const MAX_MESSAGE_BYTES: usize = 64 * 1024;
pub const STATEMENT_LIFETIME_SECONDS: i64 = 300;
const MAX_TRACKED_PEERS: usize = 1_024;

#[derive(Debug, thiserror::Error)]
pub enum MeshError {
    #[error(transparent)]
    Config(#[from] ConfigError),
    #[error("zenoh session error: {0}")]
    Zenoh(String),
    #[error("the node key cannot sign statements")]
    Key,
}

fn zenoh_error(error: impl std::fmt::Display) -> MeshError {
    MeshError::Zenoh(error.to_string())
}

/// Who this node is on the mesh.
#[derive(Debug, Clone)]
pub struct MeshIdentity {
    pub installation_id: InstallationId,
    pub node_id: NodeId,
    pub credentials: NodeCredentials,
    pub anchor: TrustAnchor,
    pub revocations: RevocationSet,
}

/// What the mesh asks the daemon about local state.
#[async_trait]
pub trait MeshLocal: Send + Sync + 'static {
    /// Size of a verified, peerable object this node can serve.
    async fn peerable_object(&self, digest: &Sha256Digest) -> Option<u64>;
    /// Stored server-signed change envelopes after `after`, in order.
    async fn changes_after(&self, after: u64, limit: usize) -> Vec<SignedDocument>;
    /// Current transfers served by this node's blob service.
    fn load(&self) -> u32;
    fn now(&self) -> Timestamp;
}

/// Payload of a `node.summary` statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct NodeSummary {
    pub edge_version: String,
    pub blob_endpoint: Option<SocketAddr>,
    pub capability_revision: u64,
    pub feed_sequence: u64,
}

/// Payload of an `object.availability` statement.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Availability {
    sha256: Sha256Digest,
    size_bytes: u64,
    blob_endpoint: SocketAddr,
    load: u32,
}

/// A verified claim that a peer holds an object.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ObjectHolder {
    pub node_id: NodeId,
    pub blob_endpoint: SocketAddr,
    pub size_bytes: u64,
    pub load: u32,
}

#[derive(Debug, Clone, PartialEq)]
pub enum MeshEvent {
    PeerPresent(NodeId),
    PeerGone(NodeId),
    /// A verified summary statement.
    Summary {
        node: NodeId,
        summary: NodeSummary,
    },
    /// A verified capability statement (the capability snapshot payload).
    Capabilities {
        node: NodeId,
        snapshot: serde_json::Map<String, serde_json::Value>,
    },
    /// A relayed server change envelope. **Unverified**: the receiver must
    /// run it through the change-feed verifier.
    ChangeHint {
        document: SignedDocument,
    },
}

#[derive(Debug, Default)]
struct Published {
    summary: Option<Vec<u8>>,
    capabilities: Option<Vec<u8>>,
    blob_endpoint: Option<SocketAddr>,
}

struct Shared {
    identity: MeshIdentity,
    keys: Keyspace,
    signing: SigningKey,
    local: Arc<dyn MeshLocal>,
    published: Mutex<Published>,
    present: Mutex<BTreeSet<NodeId>>,
    events: mpsc::Sender<MeshEvent>,
}

impl Shared {
    fn sign(&self, statement_type: &str, payload: serde_json::Value) -> Option<Vec<u8>> {
        let serde_json::Value::Object(payload) = payload else { return None };
        let document = sign_statement(
            &self.signing,
            &self.identity.credentials.certificate_der,
            StatementDraft {
                installation_id: self.identity.installation_id,
                node_id: self.identity.node_id,
                statement_type,
                now: self.local.now(),
                lifetime_seconds: STATEMENT_LIFETIME_SECONDS,
                payload,
            },
        )
        .ok()?;
        let bytes = document.to_json_bytes();
        (bytes.len() <= MAX_MESSAGE_BYTES).then_some(bytes)
    }

    /// Verifies a statement of `statement_type`: signature, certificate
    /// (installation CA, node purpose, revocation), installation and
    /// lifetime. Callers also check that it arrived on the signer's own key.
    fn verify(&self, bytes: &[u8], statement_type: &str) -> Option<VerifiedStatement> {
        if bytes.len() > MAX_MESSAGE_BYTES {
            return None;
        }
        let document = SignedDocument::from_json_bytes(bytes).ok()?;
        let now = self.local.now();
        let (anchor, revocations) = (&self.identity.anchor, &self.identity.revocations);
        let verified = verify_statement(&document, self.identity.installation_id, now, |der| {
            let identity = verify_peer(der, anchor, revocations, now, PeerRole::Client, None).ok()?;
            Some(StatementSigner { node_id: identity.node_id, public_key: identity.public_key })
        })
        .ok()?;
        (verified.body.statement_type.as_str() == statement_type).then_some(verified)
    }

    fn emit(&self, event: MeshEvent) {
        // Events are hints; when the daemon is slow, drop rather than block
        // the Zenoh callbacks' consumers.
        if self.events.try_send(event).is_err() {
            tracing::debug!(component = "mesh", event = "event_dropped");
        }
    }
}

/// A running mesh. Dropping it without [`Mesh::close`] also ends the
/// session, but `close` retracts the liveliness token promptly.
pub struct Mesh {
    session: zenoh::Session,
    shared: Arc<Shared>,
    cancel: CancellationToken,
    tasks: tokio::task::JoinSet<()>,
}

impl std::fmt::Debug for Mesh {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Mesh").field("node", &self.shared.identity.node_id).finish_non_exhaustive()
    }
}

impl Mesh {
    pub async fn start(
        identity: MeshIdentity,
        transport: &Transport,
        local: Arc<dyn MeshLocal>,
        events: mpsc::Sender<MeshEvent>,
    ) -> Result<Self, MeshError> {
        let config = zenoh_config(transport, &identity.credentials, &identity.anchor)?;
        let signing = SigningKey::from_pkcs8(&identity.credentials.key_pkcs8).map_err(|_| MeshError::Key)?;
        let session = zenoh::open(config).await.map_err(zenoh_error)?;
        let keys = Keyspace::new(identity.installation_id);
        let shared = Arc::new(Shared {
            identity,
            keys,
            signing,
            local,
            published: Mutex::new(Published::default()),
            present: Mutex::new(BTreeSet::new()),
            events,
        });
        let cancel = CancellationToken::new();
        let mut mesh = Self { session, shared, cancel, tasks: tokio::task::JoinSet::new() };
        mesh.declare().await?;
        tracing::info!(component = "mesh", event = "started", node = %mesh.shared.identity.node_id);
        Ok(mesh)
    }

    async fn declare(&mut self) -> Result<(), MeshError> {
        let (session, shared, keys) = (&self.session, Arc::clone(&self.shared), self.shared.keys.clone());
        let me = shared.identity.node_id;

        // Presence.
        let token =
            session.liveliness().declare_token(keys.node(me, NodeKey::Liveliness)).await.map_err(zenoh_error)?;
        let presence = session
            .liveliness()
            .declare_subscriber(keys.every_node(NodeKey::Liveliness))
            .history(true)
            .await
            .map_err(zenoh_error)?;
        let (task_shared, cancel, session_for_task) = (Arc::clone(&shared), self.cancel.clone(), session.clone());
        self.tasks.spawn(async move {
            let _token = token;
            loop {
                let sample = tokio::select! {
                    () = cancel.cancelled() => return,
                    sample = presence.recv_async() => match sample { Ok(sample) => sample, Err(_) => return },
                };
                let Some(node) = task_shared.keys.parse_node(sample.key_expr().as_str(), NodeKey::Liveliness) else {
                    continue;
                };
                if node == me || task_shared.identity.revocations.is_revoked(&node) {
                    continue;
                }
                match sample.kind() {
                    SampleKind::Put => {
                        let fresh = {
                            let mut present = task_shared.present.lock().unwrap_or_else(|e| e.into_inner());
                            present.len() < MAX_TRACKED_PEERS && present.insert(node)
                        };
                        if fresh {
                            tracing::info!(component = "mesh", event = "peer_present", peer = %node);
                            task_shared.emit(MeshEvent::PeerPresent(node));
                            // After discovery, ask the peer for its current
                            // statements (RFC §13.8).
                            let (shared, session) = (Arc::clone(&task_shared), session_for_task.clone());
                            tokio::spawn(async move {
                                fetch_statements(&session, &shared, node).await;
                            });
                        }
                    }
                    SampleKind::Delete => {
                        let removed = task_shared.present.lock().unwrap_or_else(|e| e.into_inner()).remove(&node);
                        if removed {
                            tracing::info!(component = "mesh", event = "peer_gone", peer = %node);
                            task_shared.emit(MeshEvent::PeerGone(node));
                        }
                    }
                }
            }
        });

        // Statements pushed by peers.
        for (key, statement_type) in
            [(NodeKey::Summary, types::NODE_SUMMARY), (NodeKey::Capabilities, types::NODE_CAPABILITIES)]
        {
            let subscriber = session.declare_subscriber(keys.every_node(key)).await.map_err(zenoh_error)?;
            let (shared, cancel) = (Arc::clone(&shared), self.cancel.clone());
            self.tasks.spawn(async move {
                loop {
                    let sample = tokio::select! {
                        () = cancel.cancelled() => return,
                        sample = subscriber.recv_async() => match sample { Ok(sample) => sample, Err(_) => return },
                    };
                    let origin = shared.keys.parse_node(sample.key_expr().as_str(), key);
                    accept_statement(&shared, origin, &sample.payload().to_bytes(), key, statement_type);
                }
            });
        }

        // Our own statements for peers that just discovered us.
        for key in [NodeKey::Summary, NodeKey::Capabilities] {
            let queryable = session.declare_queryable(keys.node(me, key)).await.map_err(zenoh_error)?;
            let (shared, cancel) = (Arc::clone(&shared), self.cancel.clone());
            self.tasks.spawn(async move {
                loop {
                    let query = tokio::select! {
                        () = cancel.cancelled() => return,
                        query = queryable.recv_async() => match query { Ok(query) => query, Err(_) => return },
                    };
                    let bytes = {
                        let published = shared.published.lock().unwrap_or_else(|e| e.into_inner());
                        match key {
                            NodeKey::Summary => published.summary.clone(),
                            _ => published.capabilities.clone(),
                        }
                    };
                    if let Some(bytes) = bytes {
                        let _ = query.reply(shared.keys.node(me, key), bytes).await;
                    }
                }
            });
        }

        // Object availability: answer only for verified, peerable objects,
        // and only when this node runs a blob service.
        let objects = session.declare_queryable(keys.every_object()).await.map_err(zenoh_error)?;
        let (object_shared, cancel) = (Arc::clone(&shared), self.cancel.clone());
        self.tasks.spawn(async move {
            loop {
                let query = tokio::select! {
                    () = cancel.cancelled() => return,
                    query = objects.recv_async() => match query { Ok(query) => query, Err(_) => return },
                };
                let Some(digest) = object_shared.keys.parse_object(query.key_expr().as_str()) else { continue };
                let endpoint = object_shared.published.lock().unwrap_or_else(|e| e.into_inner()).blob_endpoint;
                let Some(endpoint) = endpoint else { continue };
                let Some(size) = object_shared.local.peerable_object(&digest).await else { continue };
                let payload = serde_json::json!({
                    "sha256": digest, "sizeBytes": size, "blobEndpoint": endpoint, "load": object_shared.local.load(),
                });
                if let Some(bytes) = object_shared.sign(types::OBJECT_AVAILABILITY, payload) {
                    let _ = query.reply(object_shared.keys.object(&digest), bytes).await;
                }
            }
        });

        // Relayed server changes: hints only.
        let changes = session.declare_subscriber(keys.changes_latest()).await.map_err(zenoh_error)?;
        let (change_shared, cancel) = (Arc::clone(&shared), self.cancel.clone());
        self.tasks.spawn(async move {
            loop {
                let sample = tokio::select! {
                    () = cancel.cancelled() => return,
                    sample = changes.recv_async() => match sample { Ok(sample) => sample, Err(_) => return },
                };
                let bytes = sample.payload().to_bytes();
                if bytes.len() <= MAX_MESSAGE_BYTES
                    && let Ok(document) = SignedDocument::from_json_bytes(&bytes)
                {
                    change_shared.emit(MeshEvent::ChangeHint { document });
                }
            }
        });

        // Stored changes for peers catching up (`?after=<sequence>`).
        let history = session.declare_queryable(keys.changes_query()).await.map_err(zenoh_error)?;
        let (history_shared, cancel) = (Arc::clone(&shared), self.cancel.clone());
        self.tasks.spawn(async move {
            loop {
                let query = tokio::select! {
                    () = cancel.cancelled() => return,
                    query = history.recv_async() => match query { Ok(query) => query, Err(_) => return },
                };
                let Some(after) = query.parameters().get("after").and_then(|v| v.parse::<u64>().ok()) else {
                    continue;
                };
                for document in history_shared.local.changes_after(after, 100).await {
                    let bytes = document.to_json_bytes();
                    if bytes.len() <= MAX_MESSAGE_BYTES {
                        let _ = query.reply(history_shared.keys.changes_query(), bytes).await;
                    }
                }
            }
        });
        Ok(())
    }

    pub fn node_id(&self) -> NodeId {
        self.shared.identity.node_id
    }

    /// Peers whose liveliness token is currently visible (a hint).
    pub fn present_peers(&self) -> Vec<NodeId> {
        self.shared.present.lock().unwrap_or_else(|e| e.into_inner()).iter().copied().collect()
    }

    /// Signs and publishes this node's summary; also answers later queries.
    pub async fn publish_summary(&self, summary: &NodeSummary) -> Result<(), MeshError> {
        let payload = serde_json::to_value(summary).map_err(zenoh_error)?;
        let bytes = self.shared.sign(types::NODE_SUMMARY, payload).ok_or(MeshError::Key)?;
        {
            let mut published = self.shared.published.lock().unwrap_or_else(|e| e.into_inner());
            published.summary = Some(bytes.clone());
            published.blob_endpoint = summary.blob_endpoint;
        }
        self.session
            .put(self.shared.keys.node(self.node_id(), NodeKey::Summary), bytes)
            .priority(Priority::Data)
            .congestion_control(CongestionControl::Drop)
            .await
            .map_err(zenoh_error)
    }

    /// Signs and publishes this node's capability snapshot.
    pub async fn publish_capabilities(&self, snapshot: &serde_json::Value) -> Result<(), MeshError> {
        let bytes = self.shared.sign(types::NODE_CAPABILITIES, snapshot.clone()).ok_or(MeshError::Key)?;
        self.shared.published.lock().unwrap_or_else(|e| e.into_inner()).capabilities = Some(bytes.clone());
        self.session
            .put(self.shared.keys.node(self.node_id(), NodeKey::Capabilities), bytes)
            .priority(Priority::Data)
            .congestion_control(CongestionControl::Drop)
            .await
            .map_err(zenoh_error)
    }

    /// Relays a server-signed change the daemon already verified and applied.
    pub async fn relay_change(&self, document: &SignedDocument) -> Result<(), MeshError> {
        let bytes = document.to_json_bytes();
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Ok(());
        }
        self.session
            .put(self.shared.keys.changes_latest(), bytes)
            .priority(Priority::InteractiveHigh)
            .congestion_control(CongestionControl::Block)
            .await
            .map_err(zenoh_error)
    }

    /// Asks every peer whether it holds `digest`. Only verified statements
    /// with the expected hash and size are returned.
    pub async fn who_has(&self, digest: &Sha256Digest, size: u64, timeout: Duration) -> Vec<ObjectHolder> {
        let Ok(replies) = self
            .session
            .get(self.shared.keys.object(digest))
            .target(QueryTarget::All)
            .consolidation(ConsolidationMode::None)
            .timeout(timeout)
            .await
        else {
            return Vec::new();
        };
        let mut holders = BTreeMap::new();
        while let Ok(reply) = replies.recv_async().await {
            let Ok(sample) = reply.result() else { continue };
            let Some(statement) = self.shared.verify(&sample.payload().to_bytes(), types::OBJECT_AVAILABILITY) else {
                continue;
            };
            let node = statement.signer.node_id;
            let Ok(claim) = serde_json::from_value::<Availability>(serde_json::Value::Object(statement.body.payload))
            else {
                continue;
            };
            if node != self.node_id() && claim.sha256 == *digest && claim.size_bytes == size {
                holders.insert(
                    node,
                    ObjectHolder {
                        node_id: node,
                        blob_endpoint: claim.blob_endpoint,
                        size_bytes: size,
                        load: claim.load,
                    },
                );
            }
        }
        holders.into_values().collect()
    }

    /// Stored change envelopes peers hold after `after`. **Unverified**: pass
    /// them to the change-feed verifier.
    pub async fn query_changes(&self, after: u64, timeout: Duration) -> Vec<SignedDocument> {
        let selector = format!("{}?after={after}", self.shared.keys.changes_query());
        let Ok(replies) = self
            .session
            .get(selector)
            .target(QueryTarget::All)
            .consolidation(ConsolidationMode::None)
            .timeout(timeout)
            .await
        else {
            return Vec::new();
        };
        let mut out = Vec::new();
        while let Ok(reply) = replies.recv_async().await {
            let Ok(sample) = reply.result() else { continue };
            let bytes = sample.payload().to_bytes();
            if bytes.len() <= MAX_MESSAGE_BYTES
                && let Ok(document) = SignedDocument::from_json_bytes(&bytes)
                && out.len() < 1_000
            {
                out.push(document);
            }
        }
        out
    }

    /// Retracts the liveliness token and ends the session.
    pub async fn close(mut self) {
        self.cancel.cancel();
        while self.tasks.join_next().await.is_some() {}
        let _ = self.session.close().await;
        tracing::info!(component = "mesh", event = "stopped");
    }
}

fn accept_statement(shared: &Shared, origin: Option<NodeId>, bytes: &[u8], key: NodeKey, statement_type: &str) {
    let Some(origin) = origin else { return };
    if origin == shared.identity.node_id {
        return;
    }
    let Some(statement) = shared.verify(bytes, statement_type) else {
        tracing::debug!(component = "mesh", event = "statement_rejected", peer = %origin);
        return;
    };
    // A node may only speak on its own keys.
    if statement.signer.node_id != origin {
        tracing::warn!(component = "mesh", event = "statement_on_foreign_key", key_node = %origin, signer = %statement.signer.node_id);
        return;
    }
    let payload = statement.body.payload;
    match key {
        NodeKey::Summary => {
            if let Ok(summary) = serde_json::from_value::<NodeSummary>(serde_json::Value::Object(payload)) {
                shared.emit(MeshEvent::Summary { node: origin, summary });
            }
        }
        NodeKey::Capabilities => shared.emit(MeshEvent::Capabilities { node: origin, snapshot: payload }),
        NodeKey::Liveliness => {}
    }
}

async fn fetch_statements(session: &zenoh::Session, shared: &Arc<Shared>, node: NodeId) {
    for (key, statement_type) in
        [(NodeKey::Summary, types::NODE_SUMMARY), (NodeKey::Capabilities, types::NODE_CAPABILITIES)]
    {
        let Ok(replies) = session.get(shared.keys.node(node, key)).timeout(Duration::from_secs(3)).await else {
            continue;
        };
        while let Ok(reply) = replies.recv_async().await {
            if let Ok(sample) = reply.result() {
                let origin = shared.keys.parse_node(sample.key_expr().as_str(), key);
                accept_statement(shared, origin, &sample.payload().to_bytes(), key, statement_type);
            }
        }
    }
}
