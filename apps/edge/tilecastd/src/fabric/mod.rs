//! The Edge fabric in the daemon: peer blob service plus Zenoh mesh.
//!
//! Off unless `mesh.enabled` (RFC §47.1). When on, it starts only after
//! Edge enrollment (it needs the node certificate and pinned CA) and only
//! on a permitted interface ([`interfaces`]). It restarts on certificate
//! renewal and retries when anything fails; playback and the server link
//! never wait for it.
//!
//! Integration points:
//!
//! * [`peer_sources`]: ranked, identity-pinned peer sources for one object,
//!   to put before the origin in an `edge_cas::Fetcher` source list, with
//!   [`peer_observer`] recording outcomes for ranking;
//! * change hints from the mesh go through the same feed applier as the
//!   server link (`DaemonContext::feed`). A chain gap is closed from peers'
//!   stored changes if possible, otherwise by waking the server link;
//! * changes the node applied, from either path, are relayed once.

pub mod interfaces;
pub mod local;

use std::net::{SocketAddr, SocketAddrV4};
use std::sync::Arc;
use std::time::Duration;

use edge_cas::BlobSource;
use edge_cdn::selector::SelectorObserver;
use edge_cdn::{BlobServerLimits, PeerBlobServer, PeerBlobSource, PeerCandidate, PeerEndpoint};
use edge_identity::tls::{NodeCredentials, client_config, server_config};
use edge_identity::{NodeKey, TrustAnchor};
use edge_mesh::{Mesh, MeshEvent, MeshIdentity, Multicast, NodeSummary, Transport};
use edge_protocol::signed::SignedDocument;
use edge_protocol::{Sha256Digest, Timestamp};
use edge_server::feed::Offer;
use edge_state::repo::{changes, identity, peers};

use crate::daemon::{DaemonContext, VERSION};

pub const MULTICAST_ADDRESS: &str = "224.0.0.224:7446";
const RETRY: Duration = Duration::from_secs(60);
const SUMMARY_INTERVAL: Duration = Duration::from_secs(60);
const RELAY_INTERVAL: Duration = Duration::from_secs(5);
const WHO_HAS_TIMEOUT: Duration = Duration::from_millis(1_500);
const CATCH_UP_TIMEOUT: Duration = Duration::from_secs(3);

/// The mesh state reported by status and capabilities.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MeshState {
    pub state: &'static str,
    pub reason: Option<&'static str>,
    pub peers: usize,
    pub last_peer_change_at: Option<Timestamp>,
}

impl Default for MeshState {
    fn default() -> Self {
        Self { state: "disabled", reason: Some("mesh_disabled"), peers: 0, last_peer_change_at: None }
    }
}

/// What other subsystems use while the fabric runs.
#[derive(Debug, Clone)]
pub struct FabricHandle {
    mesh: Arc<Mesh>,
    credentials: NodeCredentials,
    anchor: TrustAnchor,
    address: std::net::Ipv4Addr,
}

enum Outcome {
    Stop,
    Restart,
    Unavailable(&'static str),
}

fn set_state(context: &DaemonContext, state: &'static str, reason: Option<&'static str>) {
    let mut current = context.mesh_state.lock().unwrap_or_else(|e| e.into_inner());
    current.state = state;
    current.reason = reason;
    if state != "available" {
        current.peers = 0;
    }
}

pub async fn run(context: Arc<DaemonContext>) {
    if !context.config.mesh.enabled {
        set_state(&context, "disabled", Some("mesh_disabled"));
        return;
    }
    set_state(&context, "starting", None);
    loop {
        match session(&context).await {
            Outcome::Stop => return,
            Outcome::Restart => continue,
            Outcome::Unavailable(reason) => {
                set_state(&context, "unavailable", Some(reason));
                tracing::info!(component = "mesh", event = "unavailable", reason);
                tokio::select! {
                    () = context.shutdown.cancelled() => return,
                    () = tokio::time::sleep(RETRY) => {}
                }
            }
        }
    }
}

/// Loads the node's Edge credentials and pinned CA, if enrolled.
async fn load_credentials(context: &DaemonContext) -> Result<(NodeCredentials, TrustAnchor, String), &'static str> {
    let db = context.db().ok_or("state_unavailable")?;
    let certificate = db.run(|c| identity::active_certificate(c)).await.map_err(|_| "state_error")?;
    let trust = db.run(|c| identity::get_trust(c)).await.map_err(|_| "state_error")?;
    let (Some(certificate), Some(trust)) = (certificate, trust) else { return Err("edge_not_enrolled") };
    if certificate.not_after <= context.now() {
        return Err("edge_certificate_expired");
    }
    let key = NodeKey::load(&context.paths.identity_dir(), &certificate.key_fingerprint)
        .map_err(|_| "edge_node_key_missing")?;
    Ok((
        NodeCredentials { certificate_der: certificate.certificate_der, key_pkcs8: key.pkcs8_der().to_vec() },
        TrustAnchor { installation_id: trust.installation_id, ca_der: trust.ca_certificate_der },
        certificate.fingerprint,
    ))
}

async fn session(context: &Arc<DaemonContext>) -> Outcome {
    let (Some(db), Some(cas), Some(node_id)) = (context.db().cloned(), context.cas.clone(), context.node_id) else {
        return Outcome::Unavailable("state_unavailable");
    };
    let (credentials, anchor, fingerprint) = match load_credentials(context).await {
        Ok(loaded) => loaded,
        Err(reason) => return Outcome::Unavailable(reason),
    };
    let selected = match interfaces::select(&context.config.mesh.interfaces) {
        Ok(selected) => selected,
        Err(refusal) => return Outcome::Unavailable(refusal.reason_code()),
    };
    let mesh_config = &context.config.mesh;

    let Ok(tls) = server_config(&credentials, anchor.clone(), context.revocations.clone()) else {
        return Outcome::Unavailable("mesh_tls_config_failed");
    };
    let blob_address = SocketAddr::V4(SocketAddrV4::new(selected.address, mesh_config.blob_port));
    let server = match PeerBlobServer::bind(
        blob_address,
        tls,
        cas.clone(),
        context.revocations.clone(),
        BlobServerLimits::default(),
    )
    .await
    {
        Ok(server) => server,
        Err(error) => {
            tracing::warn!(component = "cdn", event = "bind_failed", error = %error);
            return Outcome::Unavailable("mesh_blob_bind_failed");
        }
    };
    let gauge = server.gauge();
    let blob_endpoint = server.local_addr().unwrap_or(blob_address);
    let fabric_shutdown = context.shutdown.child_token();
    tokio::spawn(server.run(fabric_shutdown.clone()));

    let transport = Transport {
        listen: vec![SocketAddr::V4(SocketAddrV4::new(selected.address, mesh_config.zenoh_port))],
        seeds: mesh_config.static_seeds.clone(),
        multicast: mesh_config.multicast_scouting.then(|| Multicast {
            address: MULTICAST_ADDRESS.parse().unwrap_or_else(|_| SocketAddr::from(([224, 0, 0, 224], 7446))),
            interface: Some(selected.name.clone()),
        }),
    };
    let identity = MeshIdentity {
        installation_id: anchor.installation_id,
        node_id,
        credentials: credentials.clone(),
        anchor: anchor.clone(),
        revocations: context.revocations.clone(),
    };
    let local = Arc::new(local::DaemonMeshLocal { cas, db: db.clone(), clock: context.clock.clone(), gauge });
    let (sender, mut events) = tokio::sync::mpsc::channel(256);
    let mesh = match Mesh::start(identity, &transport, local, sender).await {
        Ok(mesh) => Arc::new(mesh),
        Err(error) => {
            fabric_shutdown.cancel();
            tracing::warn!(component = "mesh", event = "start_failed", error = %error);
            return Outcome::Unavailable("mesh_start_failed");
        }
    };
    *context.fabric.write().await =
        Some(FabricHandle { mesh: Arc::clone(&mesh), credentials, anchor, address: selected.address });
    set_state(context, "available", None);
    tracing::info!(component = "mesh", event = "fabric_started", interface = %selected.name, blob = %blob_endpoint);

    let mut last_relayed =
        db.run(|c| changes::feed_state(c)).await.ok().flatten().map_or(0, |s| s.position.last_sequence);
    let mut summary_tick = tokio::time::interval(SUMMARY_INTERVAL);
    let mut relay_tick = tokio::time::interval(RELAY_INTERVAL);
    let outcome = loop {
        tokio::select! {
            () = context.shutdown.cancelled() => break Outcome::Stop,
            _ = summary_tick.tick() => {
                // A renewed certificate means new credentials for both
                // services: restart the fabric with them.
                match load_credentials(context).await {
                    Ok((_, _, current)) if current == fingerprint => {}
                    _ => break Outcome::Restart,
                }
                publish(context, &mesh, blob_endpoint).await;
            }
            _ = relay_tick.tick() => {
                last_relayed = relay(&db, &mesh, last_relayed).await;
            }
            event = events.recv() => match event {
                Some(event) => handle(context, &mesh, event).await,
                None => break Outcome::Restart,
            },
        }
    };
    *context.fabric.write().await = None;
    mesh.close().await;
    fabric_shutdown.cancel();
    set_state(context, if matches!(outcome, Outcome::Stop) { "stopped" } else { "starting" }, None);
    outcome
}

async fn publish(context: &DaemonContext, mesh: &Mesh, blob_endpoint: SocketAddr) {
    let Some(db) = context.db() else { return };
    let feed_sequence = db.run(|c| changes::feed_state(c)).await.ok().flatten().map_or(0, |s| s.position.last_sequence);
    let stored = db.run(|c| edge_state::repo::capabilities::load(c)).await.ok().flatten();
    let summary = NodeSummary {
        edge_version: VERSION.to_owned(),
        blob_endpoint: Some(blob_endpoint),
        capability_revision: stored.as_ref().map_or(0, |s| s.snapshot.revision),
        feed_sequence,
    };
    if let Err(error) = mesh.publish_summary(&summary).await {
        tracing::debug!(component = "mesh", event = "summary_publish_failed", error = %error);
    }
    if let Some(stored) = stored
        && let Ok(snapshot) = serde_json::to_value(&stored.snapshot)
        && let Err(error) = mesh.publish_capabilities(&snapshot).await
    {
        tracing::debug!(component = "mesh", event = "capabilities_publish_failed", error = %error);
    }
}

/// Relays each applied change once, in order.
async fn relay(db: &edge_state::StateDb, mesh: &Mesh, after: u64) -> u64 {
    let documents = db.run(move |c| changes::documents_after(c, after, 50)).await.unwrap_or_default();
    let mut last = after;
    for bytes in documents {
        let Ok(document) = SignedDocument::from_json_bytes(&bytes) else { continue };
        let Some(sequence) = sequence_of(&document) else { continue };
        if mesh.relay_change(&document).await.is_err() {
            break;
        }
        last = last.max(sequence);
    }
    last
}

/// The sequence of a stored (already verified) change envelope.
fn sequence_of(document: &SignedDocument) -> Option<u64> {
    use base64::Engine as _;
    let body = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(&document.body).ok()?;
    serde_json::from_slice::<serde_json::Value>(&body).ok()?.get("sequence")?.as_u64()
}

async fn handle(context: &DaemonContext, mesh: &Mesh, event: MeshEvent) {
    let now = context.now();
    match event {
        MeshEvent::PeerPresent(_) | MeshEvent::PeerGone(_) => {
            let mut state = context.mesh_state.lock().unwrap_or_else(|e| e.into_inner());
            state.peers = mesh.present_peers().len();
            state.last_peer_change_at = Some(now);
        }
        MeshEvent::Summary { node, summary } => {
            let Some(db) = context.db() else { return };
            let record = peers::PeerRecord {
                node_id: node,
                screen_id: None,
                edge_version: Some(summary.edge_version.chars().take(64).collect()),
                blob_endpoint: summary.blob_endpoint.map(|e| e.to_string()),
                certificate_fingerprint: None,
                last_seen_at: now,
            };
            let _ = db.run(move |c| peers::observe(c, &record)).await;
        }
        MeshEvent::Capabilities { .. } => {}
        MeshEvent::ChangeHint { document } => {
            let mut feed = context.feed.lock().await;
            let Some(applier) = feed.as_mut() else {
                context.server_wake.notify_one();
                return;
            };
            let mut outcome = applier.offer(&document, "mesh", now).await;
            if matches!(outcome, Ok(Offer::NeedsReconcile)) {
                // Try to close the chain from peers before bothering the
                // server; peers can only supply server-signed changes.
                let after = context
                    .db()
                    .and_then(|db| db.run_blocking(|c| changes::feed_state(c)).ok().flatten())
                    .map_or(0, |s| s.position.last_sequence);
                let documents = mesh.query_changes(after, CATCH_UP_TIMEOUT).await;
                outcome = applier.offer_batch(&documents, "mesh", now).await;
            }
            match outcome {
                Ok(Offer::Applied(_)) => tracing::info!(component = "feed", event = "applied_from_mesh"),
                Ok(Offer::NeedsReconcile) => context.server_wake.notify_one(),
                Ok(Offer::Duplicate | Offer::Rejected(_)) => {}
                Err(error) => {
                    tracing::warn!(component = "feed", event = "mesh_change_failed", reason = error.reason_code());
                }
            }
        }
    }
}

/// Peer sources for one object, best first, each pinned to the node that
/// claimed it. Empty when the fabric is not running. Append the origin.
pub async fn peer_sources(context: &DaemonContext, digest: &Sha256Digest, size: u64) -> Vec<Arc<dyn BlobSource>> {
    let Some(handle) = context.fabric.read().await.clone() else { return Vec::new() };
    let holders = handle.mesh.who_has(digest, size, WHO_HAS_TIMEOUT).await;
    let our_subnet = handle.address.octets();
    let candidates: Vec<PeerCandidate> = holders
        .iter()
        .map(|holder| PeerCandidate {
            endpoint: PeerEndpoint { node_id: holder.node_id, address: holder.blob_endpoint },
            same_subnet: matches!(holder.blob_endpoint, SocketAddr::V4(v4) if v4.ip().octets()[..3] == our_subnet[..3]),
            load: holder.load,
        })
        .collect();
    context
        .peer_selector
        .rank(digest, &candidates, std::time::Instant::now())
        .into_iter()
        .filter_map(|candidate| {
            let tls = client_config(
                &handle.credentials,
                handle.anchor.clone(),
                context.revocations.clone(),
                Some(candidate.endpoint.node_id),
            )
            .ok()?;
            Some(Arc::new(PeerBlobSource::new(candidate.endpoint, tls)) as Arc<dyn BlobSource>)
        })
        .collect()
}

/// Records peer attempts for ranking during one fetch of `digest`.
pub fn peer_observer(context: &DaemonContext, digest: Sha256Digest) -> SelectorObserver<'_> {
    context.peer_selector.observer(digest)
}
