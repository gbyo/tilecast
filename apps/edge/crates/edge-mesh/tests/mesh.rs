//! Two- and three-node Zenoh meshes over loopback TLS.
#![allow(clippy::unwrap_used)]

use std::net::SocketAddr;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use edge_identity::testing::TestCa;
use edge_identity::{RevocationSet, TrustAnchor};
use edge_mesh::{Mesh, MeshEvent, MeshIdentity, MeshLocal, NodeSummary, Transport};
use edge_protocol::signed::{Purpose, SignedDocument, SigningKey};
use edge_protocol::time::system_clock;
use edge_protocol::{InstallationId, NodeId, Sha256Digest, Timestamp};
use serde_json::json;
use tokio::sync::mpsc;

#[derive(Default)]
struct Local {
    objects: Mutex<Vec<(Sha256Digest, u64)>>,
    changes: Mutex<Vec<(u64, SignedDocument)>>,
}

#[async_trait]
impl MeshLocal for Local {
    async fn peerable_object(&self, digest: &Sha256Digest) -> Option<u64> {
        self.objects.lock().unwrap().iter().find(|(d, _)| d == digest).map(|(_, size)| *size)
    }
    async fn changes_after(&self, after: u64, limit: usize) -> Vec<SignedDocument> {
        let changes = self.changes.lock().unwrap();
        changes.iter().filter(|(s, _)| *s > after).take(limit).map(|(_, d)| d.clone()).collect()
    }
    fn load(&self) -> u32 {
        1
    }
    fn now(&self) -> Timestamp {
        system_clock().now()
    }
}

struct Node {
    id: NodeId,
    identity: MeshIdentity,
    local: Arc<Local>,
    port: u16,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn node(ca: &TestCa, anchor: TrustAnchor, revocations: RevocationSet) -> Node {
    let (id, _key, credentials) = ca.node();
    let identity = MeshIdentity { installation_id: ca.installation_id, node_id: id, credentials, anchor, revocations };
    Node { id, identity, local: Arc::new(Local::default()), port: free_port() }
}

async fn start(node: &Node, seeds: &[u16]) -> (Mesh, mpsc::Receiver<MeshEvent>) {
    let transport = Transport {
        listen: vec![SocketAddr::from(([127, 0, 0, 1], node.port))],
        seeds: seeds.iter().map(|port| format!("127.0.0.1:{port}")).collect(),
        multicast: None,
    };
    let (sender, receiver) = mpsc::channel(256);
    let local: Arc<dyn MeshLocal> = node.local.clone();
    let mesh = Mesh::start(node.identity.clone(), &transport, local, sender).await.unwrap();
    (mesh, receiver)
}

async fn expect(events: &mut mpsc::Receiver<MeshEvent>, what: &str, mut predicate: impl FnMut(&MeshEvent) -> bool) {
    let found = tokio::time::timeout(Duration::from_secs(20), async {
        while let Some(event) = events.recv().await {
            if predicate(&event) {
                return true;
            }
        }
        false
    })
    .await;
    assert!(matches!(found, Ok(true)), "timed out waiting for {what}");
}

async fn never(
    events: &mut mpsc::Receiver<MeshEvent>,
    window: Duration,
    mut predicate: impl FnMut(&MeshEvent) -> bool,
) {
    let deadline = tokio::time::Instant::now() + window;
    while let Ok(Some(event)) = tokio::time::timeout_at(deadline, events.recv()).await {
        assert!(!predicate(&event), "unexpected event {event:?}");
    }
}

fn change(installation: InstallationId, sequence: u64) -> SignedDocument {
    let body = json!({
        "schema": 1, "installationId": installation.to_string(), "authorityEpoch": 1,
        "sequence": sequence, "previousSequence": sequence - 1, "type": "screen.presentation.changed",
        "target": {"kind": "installation", "id": installation.to_string()}, "object": null,
        "revocationGeneration": 0, "issuedAt": "2026-09-22T00:00:00Z", "expiresAt": null, "payload": {},
    });
    SigningKey::from_seed(&[5u8; 32]).sign(Purpose::ServerChange, &body, None).unwrap()
}

fn summary(endpoint: SocketAddr) -> NodeSummary {
    NodeSummary {
        edge_version: "0.1.0".into(),
        blob_endpoint: Some(endpoint),
        capability_revision: 3,
        feed_sequence: 12,
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn two_nodes_discover_exchange_hints_and_reconnect() {
    let ca = TestCa::new(InstallationId::new_random());
    let (a, b) = (node(&ca, ca.anchor(), RevocationSet::new()), node(&ca, ca.anchor(), RevocationSet::new()));
    let held = Sha256Digest::of(b"held by a");
    a.local.objects.lock().unwrap().push((held, 9));
    let stored = change(ca.installation_id, 7);
    a.local.changes.lock().unwrap().push((7, stored.clone()));

    let (mesh_a, mut events_a) = start(&a, &[]).await;
    let a_endpoint: SocketAddr = "127.0.0.1:7448".parse().unwrap();
    mesh_a.publish_summary(&summary(a_endpoint)).await.unwrap();
    mesh_a.publish_capabilities(&json!({"schema": 1, "revision": 3})).await.unwrap();
    let (mesh_b, mut events_b) = start(&b, &[a.port]).await;

    expect(&mut events_b, "B sees A", |e| *e == MeshEvent::PeerPresent(a.id)).await;
    expect(&mut events_a, "A sees B", |e| *e == MeshEvent::PeerPresent(b.id)).await;
    // Discovery fetches the statements A published before B existed.
    expect(&mut events_b, "A's summary", |e| {
        matches!(e, MeshEvent::Summary { node, summary: s } if *node == a.id && s.blob_endpoint == Some(a_endpoint))
    })
    .await;
    assert_eq!(mesh_b.present_peers(), vec![a.id]);

    // Object availability: only verified claims for the exact hash and size.
    let holders = mesh_b.who_has(&held, 9, Duration::from_secs(3)).await;
    assert_eq!(holders.len(), 1);
    assert_eq!((holders[0].node_id, holders[0].blob_endpoint, holders[0].load), (a.id, a_endpoint, 1));
    assert!(mesh_b.who_has(&held, 10, Duration::from_secs(2)).await.is_empty(), "size must match");
    assert!(mesh_b.who_has(&Sha256Digest::of(b"nobody"), 1, Duration::from_secs(2)).await.is_empty());

    // Change hints and catch-up are relayed as-is (verification is the
    // feed's job).
    let hint = change(ca.installation_id, 8);
    mesh_a.relay_change(&hint).await.unwrap();
    expect(&mut events_b, "change hint", |e| *e == MeshEvent::ChangeHint { document: hint.clone() }).await;
    assert_eq!(mesh_b.query_changes(6, Duration::from_secs(3)).await, vec![stored]);
    assert!(mesh_b.query_changes(7, Duration::from_secs(2)).await.is_empty());

    // Losing A retracts its presence; A coming back is found again by B's
    // seed retry without any action.
    mesh_a.close().await;
    expect(&mut events_b, "A gone", |e| *e == MeshEvent::PeerGone(a.id)).await;
    let (mesh_a, _events_a) = start(&a, &[]).await;
    expect(&mut events_b, "A back", |e| *e == MeshEvent::PeerPresent(a.id)).await;
    mesh_a.close().await;
    mesh_b.close().await;
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn untrusted_and_revoked_nodes_are_not_members() {
    let installation = InstallationId::new_random();
    let ca = TestCa::new(installation);
    let revocations = RevocationSet::new();
    let a = node(&ca, ca.anchor(), revocations.clone());
    let (mesh_a, mut events_a) = start(&a, &[]).await;

    // Same installation ID, different CA: the TLS link never forms.
    let foreign_ca = TestCa::new(installation);
    let foreign = node(&foreign_ca, foreign_ca.anchor(), RevocationSet::new());
    let (mesh_foreign, mut events_foreign) = start(&foreign, &[a.port]).await;

    // A revoked member: its link may form (chain-valid certificate), but its
    // presence and statements are ignored and it is never offered as a holder.
    let revoked = node(&ca, ca.anchor(), RevocationSet::new());
    revocations.revoke(revoked.id, system_clock().now().saturating_add(time::Duration::days(1)), 1);
    let held = Sha256Digest::of(b"held by the revoked node");
    revoked.local.objects.lock().unwrap().push((held, 24));
    let (mesh_revoked, _events_revoked) = start(&revoked, &[a.port]).await;
    mesh_revoked.publish_summary(&summary("127.0.0.1:7448".parse().unwrap())).await.unwrap();

    never(&mut events_a, Duration::from_secs(6), |e| match e {
        MeshEvent::PeerPresent(node) | MeshEvent::Summary { node, .. } => *node == foreign.id || *node == revoked.id,
        _ => false,
    })
    .await;
    never(&mut events_foreign, Duration::from_secs(1), |e| matches!(e, MeshEvent::PeerPresent(_))).await;
    assert!(mesh_a.who_has(&held, 24, Duration::from_secs(2)).await.is_empty());
    mesh_foreign.close().await;
    mesh_revoked.close().await;
    mesh_a.close().await;
}
