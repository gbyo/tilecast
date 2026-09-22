//! Two real daemons with Edge identities form a fabric over loopback:
//! mesh presence, peer-to-peer object delivery through `peer_sources`,
//! change relay into the other node's feed, and revocation.
#![allow(clippy::unwrap_used)]

use std::sync::Arc;
use std::time::Duration;

use edge_cas::{BlobSource, FetchRequest, Fetcher, IngestMeta};
use edge_identity::NodeKey;
use edge_identity::certificate::parse_identity;
use edge_identity::testing::TestCa;
use edge_platform::systemd::Notifier;
use edge_protocol::signed::change::{AuthorityKey, AuthorityTrust};
use edge_protocol::signed::{Purpose, SigningKey};
use edge_protocol::{InstallationId, NodeId, Sha256Digest};
use edge_server::feed::{FeedApplier, Offer};
use edge_state::repo::cas::{Domain, SourceKind as RecordSource};
use edge_state::repo::daemon::NodeIdentitySource;
use edge_state::repo::identity::{CertificateRecord, TrustRecord};
use edge_state::repo::{changes, daemon as daemon_repo, identity};
use edge_state::{OpenOptions, StateDb};
use serde_json::json;
use tilecastd::config::EdgeConfig;
use tilecastd::daemon::{Daemon, DaemonContext};

const AUTHORITY_SEED: [u8; 32] = [11u8; 32];

fn loopback() -> String {
    if cfg!(target_os = "macos") { "lo0".into() } else { "lo".into() }
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn authority() -> AuthorityKey {
    AuthorityKey { epoch: 1, public_key: SigningKey::from_seed(&AUTHORITY_SEED).public_key().clone() }
}

/// Writes the state an enrolled node has: node ID, pinned CA and authority,
/// an active certificate, its key, and a feed baseline.
fn seed_identity(dir: &std::path::Path, ca: &TestCa) -> NodeId {
    let (state, identity_dir) = (dir.join("state"), dir.join("state/identity"));
    std::fs::create_dir_all(&identity_dir).unwrap();
    let node = NodeId::new_random();
    let key = NodeKey::generate().unwrap();
    key.save(&identity_dir).unwrap();
    let certificate = ca.issue(&key, node);
    let parsed = parse_identity(&certificate).unwrap();
    let db = StateDb::open(state.join("state.db"), OpenOptions::default()).unwrap();
    let now = parsed.not_before;
    db.run_blocking(|c| {
        daemon_repo::set_node_identity(c, node, NodeIdentitySource::Generated, now)?;
        identity::put_trust(
            c,
            &TrustRecord {
                installation_id: ca.installation_id,
                ca_certificate_der: ca.ca_der.clone(),
                ca_fingerprint: ca.anchor().fingerprint(),
                mesh_protocol_version: edge_protocol::MESH_PROTOCOL_VERSION,
                latest_sequence_at_enrollment: 0,
                authority_keys: vec![authority()],
            },
            now,
        )?;
        identity::activate_certificate(
            c,
            &CertificateRecord {
                fingerprint: parsed.fingerprint.clone(),
                serial_number: parsed.serial_hex.clone(),
                certificate_der: certificate.clone(),
                key_fingerprint: key.fingerprint(),
                installation_id: parsed.installation_id,
                node_id: parsed.node_id,
                screen_id: parsed.screen_id,
                not_before: parsed.not_before,
                not_after: parsed.not_after,
            },
            now,
        )?;
        changes::set_baseline(c, 0, now)
    })
    .unwrap();
    node
}

struct Node {
    _dir: tempfile::TempDir,
    id: NodeId,
    context: Arc<DaemonContext>,
    task: tokio::task::JoinHandle<anyhow::Result<()>>,
}

async fn start(ca: &TestCa, zenoh_port: u16, seeds: Vec<String>) -> Node {
    let dir = tempfile::tempdir().unwrap();
    let id = seed_identity(dir.path(), ca);
    let mut config = EdgeConfig::default();
    config.paths.state_dir = Some(dir.path().join("state"));
    config.paths.runtime_dir = Some(dir.path().join("run"));
    config.renderer.binary = dir.path().join("no-renderer");
    config.mesh.enabled = true;
    config.mesh.interfaces = vec![loopback()];
    config.mesh.multicast_scouting = false;
    config.mesh.zenoh_port = zenoh_port;
    config.mesh.blob_port = free_port();
    config.mesh.static_seeds = seeds;
    let daemon = Daemon::start(config, Notifier::disabled()).await.unwrap();
    let context = Arc::clone(daemon.context());
    let task = tokio::spawn(daemon.run());
    Node { _dir: dir, id, context, task }
}

async fn wait_for(what: &str, mut condition: impl AsyncFnMut() -> bool) {
    for _ in 0..200 {
        if condition().await {
            return;
        }
        tokio::time::sleep(Duration::from_millis(100)).await;
    }
    panic!("timed out waiting for {what}");
}

fn peers(context: &DaemonContext) -> usize {
    let state = context.mesh_state.lock().unwrap();
    if state.state == "available" { state.peers } else { 0 }
}

fn applier(context: &DaemonContext, installation: InstallationId) -> FeedApplier {
    let trust = AuthorityTrust { installation_id: installation, keys: vec![authority()] };
    FeedApplier::new(context.db().unwrap().clone(), trust, context.revocations.clone())
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_daemons_share_content_and_changes_over_the_fabric() {
    let ca = TestCa::new(InstallationId::new_random());
    let a_port = free_port();
    let a = start(&ca, a_port, Vec::new()).await;
    let b = start(&ca, free_port(), vec![format!("127.0.0.1:{a_port}")]).await;
    wait_for("mutual presence", async || peers(&a.context) == 1 && peers(&b.context) == 1).await;

    // A holds a peerable object; B finds it over the mesh and fetches it
    // over mTLS from A, verified by B's store.
    let bytes: Vec<u8> = (0..200_000u32).map(|i| (i % 251) as u8).collect();
    let digest = Sha256Digest::of(&bytes);
    let file = tempfile::NamedTempFile::new().unwrap();
    std::fs::write(file.path(), &bytes).unwrap();
    let meta = IngestMeta { domain: Domain::Media, content_type: None, peerable: true, source: RecordSource::Origin };
    a.context.cas.as_ref().unwrap().import_file(file.path(), digest, bytes.len() as u64, meta.clone()).await.unwrap();

    // A publishes its summary (with its blob endpoint) on its first tick.
    let mut sources: Vec<Arc<dyn BlobSource>> = Vec::new();
    wait_for("an availability answer", async || {
        sources = tilecastd::fabric::peer_sources(&b.context, &digest, bytes.len() as u64).await;
        !sources.is_empty()
    })
    .await;
    assert_eq!(sources.len(), 1);
    assert_eq!(sources[0].label(), a.id.to_string());
    let fetcher = Fetcher::new(b.context.cas.clone().unwrap(), 1);
    let request = FetchRequest { digest, size_bytes: bytes.len() as u64, meta };
    let observer = tilecastd::fabric::peer_observer(&b.context, digest);
    let record = fetcher.fetch(&request, &sources, Some(&observer)).await.unwrap();
    assert_eq!(record.size_bytes, bytes.len() as u64);
    let path = b.context.cas.as_ref().unwrap().verified_path(&digest).await.unwrap().unwrap();
    assert_eq!(std::fs::read(path).unwrap(), bytes);

    // A server-signed revocation applied on A reaches B over the mesh and
    // is applied by B's own feed verifier, in chain order.
    *a.context.feed.lock().await = Some(applier(&a.context, ca.installation_id));
    *b.context.feed.lock().await = Some(applier(&b.context, ca.installation_id));
    let victim = NodeId::new_random();
    let body = json!({
        "schema": 1, "installationId": ca.installation_id.to_string(), "authorityEpoch": 1,
        "sequence": 1, "previousSequence": 0, "type": "edge.node.revoked",
        "target": {"kind": "installation", "id": ca.installation_id.to_string()}, "object": null,
        "revocationGeneration": 1, "issuedAt": "2026-09-22T00:00:00Z", "expiresAt": null,
        "payload": {"nodeId": victim.to_string(), "screenId": null, "certificatesExpireAt": "2027-03-01T00:00:00Z"},
    });
    let change = SigningKey::from_seed(&AUTHORITY_SEED).sign(Purpose::ServerChange, &body, None).unwrap();
    let now = a.context.now();
    let applied = a.context.feed.lock().await.as_mut().unwrap().offer(&change, "server", now).await.unwrap();
    assert!(matches!(applied, Offer::Applied(_)));
    wait_for("B applies the relayed change", async || b.context.revocations.is_revoked(&victim)).await;
    let feed = b.context.db().unwrap().run(|c| changes::feed_state(c)).await.unwrap().unwrap();
    assert_eq!(feed.position.last_sequence, 1);

    // B learns that A is revoked: A's availability claims are refused.
    b.context.revocations.revoke(a.id, a.context.now().saturating_add(time::Duration::days(1)), 2);
    assert!(tilecastd::fabric::peer_sources(&b.context, &digest, bytes.len() as u64).await.is_empty());

    for node in [a, b] {
        node.context.shutdown.cancel();
        node.task.await.unwrap().unwrap();
    }
}
