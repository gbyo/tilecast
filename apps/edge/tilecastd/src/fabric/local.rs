//! What the mesh may learn about this node: verified peerable objects and
//! stored server-signed changes. Nothing else is reachable from it.

use async_trait::async_trait;
use edge_cas::ContentStore;
use edge_cdn::TransferGauge;
use edge_mesh::MeshLocal;
use edge_protocol::signed::SignedDocument;
use edge_protocol::time::SharedClock;
use edge_protocol::{Sha256Digest, Timestamp};
use edge_state::StateDb;
use edge_state::repo::cas::VerifyState;

#[derive(Debug)]
pub struct DaemonMeshLocal {
    pub cas: ContentStore,
    pub db: StateDb,
    pub clock: SharedClock,
    pub gauge: TransferGauge,
}

#[async_trait]
impl MeshLocal for DaemonMeshLocal {
    async fn peerable_object(&self, digest: &Sha256Digest) -> Option<u64> {
        let record = self.cas.stat(digest).await.ok().flatten()?;
        // Suspect objects are re-verified when served, but are not
        // advertised: a claim should be one this node can keep.
        (record.peerable && record.verify_state == VerifyState::Verified).then_some(record.size_bytes)
    }

    async fn changes_after(&self, after: u64, limit: usize) -> Vec<SignedDocument> {
        let limit = limit.min(100);
        let documents =
            self.db.run(move |c| edge_state::repo::changes::documents_after(c, after, limit)).await.unwrap_or_default();
        documents.iter().filter_map(|bytes| SignedDocument::from_json_bytes(bytes).ok()).collect()
    }

    fn load(&self) -> u32 {
        self.gauge.active()
    }

    fn now(&self) -> Timestamp {
        self.clock.now()
    }
}
