//! The signed change feed consumer (RFC §12, change-feed direction in the
//! user corrections).
//!
//! * The server is authoritative. [`FeedApplier::reconcile`] reads
//!   `GET /player/edge/changes?after=<last applied>` in order; the sequence
//!   is monotonic, not gapless, so a missing *integer* never means a lost
//!   change. Continuity is the signed `previousSequence` chain.
//! * Changes relayed by peers go through [`FeedApplier::offer`] with the
//!   same verification. A relayed change that does not link is held
//!   (bounded) and answered with [`Offer::NeedsReconcile`]; a peer can never
//!   advance the position past what the chain proves, and it can never set
//!   the baseline.
//! * If the server no longer has the link (retention), the node resyncs:
//!   it adopts the signed revocation snapshot and its `asOfSequence` as the
//!   new baseline, and reports [`Wake::Resynced`] so every subsystem refetches
//!   its authoritative state. Other change types are hints for state that is
//!   fetched from its own API, so skipping them is safe.
//! * Two different bodies for one sequence is an authority fault: reported,
//!   never resolved.

use edge_identity::RevocationSet;
use edge_protocol::Timestamp;
use edge_protocol::signed::SignedDocument;
use edge_protocol::signed::change::{
    AuthorityTrust, ChainDecision, ChainPosition, ChangeType, NodeRevokedPayload, PendingChanges, VerifiedChange,
    verify_change,
};
use edge_protocol::signed::snapshot::verify_revocation_snapshot;
use edge_state::StateDb;
use edge_state::repo::changes::{self, ApplyOutcome};
use edge_state::repo::identity;

use crate::client::{AuthenticatedServer, ServerError};

pub const PAGE_LIMIT: u32 = 200;
/// Bound on pages per reconcile call, so one call cannot run unbounded.
pub const MAX_PAGES: usize = 50;

#[derive(Debug, thiserror::Error)]
pub enum FeedError {
    #[error(transparent)]
    Server(#[from] ServerError),
    #[error("state error: {0}")]
    State(#[from] edge_state::StateError),
    #[error("the node has no change-feed baseline; enroll first")]
    NoBaseline,
    #[error("the server sent a change that failed verification: {0}")]
    Unverifiable(String),
    #[error("two different changes were signed for sequence {0}")]
    Conflict(u64),
}

impl FeedError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Server(error) => error.reason_code(),
            Self::State(_) => "state_error",
            Self::NoBaseline => "feed_no_baseline",
            Self::Unverifiable(_) => "feed_change_unverifiable",
            Self::Conflict(_) => "feed_authority_conflict",
        }
    }
}

/// What a subsystem should refetch because of applied changes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Wake {
    /// A known change type was applied (hint for its owner).
    Change(ChangeType),
    /// The node resynchronized from a snapshot; refetch everything.
    Resynced,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct FeedReport {
    pub applied: usize,
    pub last_sequence: u64,
    pub wakes: Vec<Wake>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Offer {
    Applied(Vec<Wake>),
    Duplicate,
    /// Held; the caller should run a server reconcile soon.
    NeedsReconcile,
    Rejected(&'static str),
}

/// Applies verified changes in chain order. One per daemon; not `Sync`
/// across concurrent callers (the daemon serializes access with a mutex).
#[derive(Debug)]
pub struct FeedApplier {
    db: StateDb,
    trust: AuthorityTrust,
    revocations: RevocationSet,
    pending: PendingChanges,
}

impl FeedApplier {
    pub fn new(db: StateDb, trust: AuthorityTrust, revocations: RevocationSet) -> Self {
        Self { db, trust, revocations, pending: PendingChanges::default() }
    }

    async fn position(&self) -> Result<ChainPosition, FeedError> {
        let state = self.db.run(|c| changes::feed_state(c)).await?;
        state.map(|s| s.position).ok_or(FeedError::NoBaseline)
    }

    /// Applies one change that classified as `Next`.
    async fn apply(&mut self, change: VerifiedChange, source: &str, now: Timestamp) -> Result<Vec<Wake>, FeedError> {
        let mut wakes = Vec::new();
        let outcome = if change.is_expired(now) {
            ApplyOutcome::Expired
        } else {
            match &change.change_type {
                ChangeType::EdgeNodeRevoked => {
                    let payload: NodeRevokedPayload =
                        serde_json::from_value(serde_json::Value::Object(change.body.payload.clone()))
                            .map_err(|_| FeedError::Unverifiable("edge.node.revoked payload".into()))?;
                    let generation = change.body.revocation_generation;
                    let (node, expires) = (payload.node_id, payload.certificates_expire_at);
                    self.db.run(move |c| identity::record_revocation(c, node, generation, now, expires)).await?;
                    // Applies to the next handshake and statement at once.
                    self.revocations.revoke(node, expires, generation);
                    wakes.push(Wake::Change(ChangeType::EdgeNodeRevoked));
                    ApplyOutcome::Applied
                }
                ChangeType::Unknown(_) => ApplyOutcome::UnknownType,
                known => {
                    wakes.push(Wake::Change(known.clone()));
                    ApplyOutcome::NotApplicable
                }
            }
        };
        let source = source.to_owned();
        let stored = change.clone();
        let advanced = self.db.run(move |c| changes::record_applied(c, &stored, &source, outcome, now)).await?;
        if !advanced {
            // Another path advanced the position concurrently; the next
            // classification sees it as already seen.
            return Ok(Vec::new());
        }
        Ok(wakes)
    }

    async fn check_duplicate(&self, change: &VerifiedChange) -> Result<Offer, FeedError> {
        let sequence = change.body.sequence;
        match self.db.run(move |c| changes::stored_digest(c, sequence)).await? {
            Some(digest) if digest != change.body_digest => Err(FeedError::Conflict(sequence)),
            // Unknown digest means the entry was pruned or predates the
            // baseline; either way it was already accounted for.
            _ => Ok(Offer::Duplicate),
        }
    }

    /// Applies a verified change and then any held changes that now link.
    async fn offer_verified(
        &mut self,
        change: VerifiedChange,
        source: &str,
        now: Timestamp,
    ) -> Result<Offer, FeedError> {
        let position = self.position().await?;
        match position.classify(&change.body) {
            ChainDecision::AlreadySeen => self.check_duplicate(&change).await,
            ChainDecision::Missing { .. } => {
                let sequence = change.body.sequence;
                self.db.run(move |c| changes::note_seen(c, sequence, now)).await?;
                self.pending.hold(change);
                Ok(Offer::NeedsReconcile)
            }
            ChainDecision::Next => {
                let mut wakes = self.apply(change, source, now).await?;
                loop {
                    let position = self.position().await?;
                    self.pending.prune(position);
                    let Some(next) = self.pending.take_next(position) else { break };
                    wakes.extend(self.apply(next, "held", now).await?);
                }
                Ok(Offer::Applied(wakes))
            }
        }
    }

    /// A change received from a peer or a mesh wake-up. Never trusted beyond
    /// its signature: same verification and chain rules as the server path.
    pub async fn offer(&mut self, document: &SignedDocument, source: &str, now: Timestamp) -> Result<Offer, FeedError> {
        let change = match verify_change(document, &self.trust) {
            Ok(change) => change,
            Err(_) => return Ok(Offer::Rejected("change_unverifiable")),
        };
        self.offer_verified(change, source, now).await
    }

    /// Reads the server feed after the current position until caught up.
    pub async fn reconcile(&mut self, server: &AuthenticatedServer, now: Timestamp) -> Result<FeedReport, FeedError> {
        let mut report = FeedReport::default();
        for _ in 0..MAX_PAGES {
            let position = self.position().await?;
            let page = server.edge_changes(position.last_sequence, PAGE_LIMIT).await?;
            let full = page.items.len() >= PAGE_LIMIT as usize;
            if page.items.is_empty() {
                report.last_sequence = position.last_sequence;
                return Ok(report);
            }
            let mut linked = false;
            for document in &page.items {
                let change =
                    verify_change(document, &self.trust).map_err(|e| FeedError::Unverifiable(e.to_string()))?;
                match self.offer_verified(change, "server", now).await? {
                    Offer::Applied(wakes) => {
                        linked = true;
                        report.applied += 1;
                        report.wakes.extend(wakes);
                    }
                    Offer::Duplicate => {}
                    Offer::NeedsReconcile => {
                        // The server itself cannot close the chain: the link
                        // was retired. Resync from the snapshot.
                        if !linked {
                            self.resync(server, now).await?;
                            report.wakes.push(Wake::Resynced);
                        }
                        break;
                    }
                    Offer::Rejected(reason) => return Err(FeedError::Unverifiable(reason.into())),
                }
            }
            if !full {
                report.last_sequence = self.position().await?.last_sequence;
                return Ok(report);
            }
        }
        report.last_sequence = self.position().await?.last_sequence;
        Ok(report)
    }

    /// Adopts the server's revocation snapshot and its sequence as baseline.
    async fn resync(&mut self, server: &AuthenticatedServer, now: Timestamp) -> Result<(), FeedError> {
        let document = server.edge_revocations().await?;
        let snapshot =
            verify_revocation_snapshot(&document, &self.trust).map_err(|e| FeedError::Unverifiable(e.to_string()))?;
        let revoked = snapshot.revoked.clone();
        let (generation, as_of) = (snapshot.generation, snapshot.as_of_sequence);
        self.db
            .run(move |c| {
                for entry in &revoked {
                    identity::record_revocation(c, entry.node_id, generation, now, entry.certificates_expire_at)?;
                }
                changes::set_baseline(c, as_of, now)
            })
            .await?;
        self.revocations.apply_snapshot(&snapshot);
        self.pending.prune(ChainPosition { last_sequence: as_of });
        tracing::warn!(component = "feed", event = "resynchronized", as_of_sequence = as_of);
        Ok(())
    }

    pub fn held(&self) -> usize {
        self.pending.len()
    }
}
