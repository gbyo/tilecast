//! Edge certificate enrollment and renewal (RFC §11.2, §11.4).
//!
//! Steps, in crash-safe order:
//!
//! 1. Generate a new node key and write it (fsync) to the identity
//!    directory before anything leaves the node. A crash here leaves an
//!    orphan key file that the next run deletes.
//! 2. Send a CSR over the authenticated server client (installation
//!    identity already verified by construction of `AuthenticatedServer`).
//! 3. Verify the response independently: installation and node IDs, the CA
//!    certificate's installation SAN, that the issued certificate chains to
//!    that CA with node purpose and certifies *our* key, that the authority
//!    key's ID matches its bytes, and that the revocation snapshot verifies
//!    under that authority key.
//! 4. Commit trust material, the new active certificate, revocations and the
//!    change-feed baseline in one transaction. The previous certificate is
//!    superseded only by that commit, so it stays usable until then.
//! 5. Delete key files no stored certificate references.
//!
//! The first enrollment pins the CA and authority key. A later response with
//! a *different* CA or authority is refused (RFC §45: "Edge CA mismatch:
//! refuse peers; do not auto-trust new CA") until authority rotation with
//! overlapping epochs is implemented.

use std::path::Path;

use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use edge_identity::certificate::{PeerRole, verify_peer};
use edge_identity::csr::build_csr;
use edge_identity::{NodeKey, RevocationSet, TrustAnchor};
use edge_protocol::signed::PublicKey;
use edge_protocol::signed::change::{AuthorityKey, AuthorityTrust};
use edge_protocol::signed::snapshot::verify_revocation_snapshot;
use edge_protocol::{NodeId, Timestamp};
use edge_state::StateDb;
use edge_state::repo::identity::{self, CertificateRecord, TrustRecord};

use crate::client::{AuthenticatedServer, ServerError};

#[derive(Debug, thiserror::Error)]
pub enum EnrollError {
    #[error(transparent)]
    Server(#[from] ServerError),
    #[error("could not create the node key: {0}")]
    Key(String),
    #[error("the enrollment response failed verification: {0}")]
    Verification(&'static str),
    #[error("the server presented a different Edge CA or authority than the one pinned")]
    TrustChanged,
    #[error("state error: {0}")]
    State(#[from] edge_state::StateError),
}

impl EnrollError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Server(error) => error.reason_code(),
            Self::Key(_) => "node_key_failed",
            Self::Verification(_) => "enrollment_response_invalid",
            Self::TrustChanged => "edge_trust_changed",
            Self::State(_) => "state_error",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Enrolled {
    pub certificate: CertificateRecord,
    pub latest_sequence: u64,
    pub revoked_nodes: usize,
}

fn pem_der(pem: &str, label: &str) -> Option<Vec<u8>> {
    let begin = format!("-----BEGIN {label}-----");
    let end = format!("-----END {label}-----");
    let start = pem.find(&begin)? + begin.len();
    let stop = pem[start..].find(&end)? + start;
    let body: String = pem[start..stop].chars().filter(|c| !c.is_whitespace()).collect();
    STANDARD.decode(body).ok()
}

fn ca_installation_matches(ca_der: &[u8], installation: &str) -> bool {
    let Ok((_, ca)) = x509_parser::parse_x509_certificate(ca_der) else { return false };
    let want = edge_identity::urn("installation", installation);
    ca.is_ca()
        && ca.extensions().iter().any(|extension| match extension.parsed_extension() {
            x509_parser::extensions::ParsedExtension::SubjectAlternativeName(san) => san
                .general_names
                .iter()
                .any(|name| matches!(name, x509_parser::extensions::GeneralName::URI(uri) if *uri == want.as_str())),
            _ => false,
        })
}

/// Enrolls (first time) or renews (later) this node's Edge certificate.
pub async fn enroll(
    server: &AuthenticatedServer,
    db: &StateDb,
    identity_dir: &Path,
    node_id: NodeId,
    revocations: &RevocationSet,
    now: Timestamp,
) -> Result<Enrolled, EnrollError> {
    let key = NodeKey::generate().map_err(|e| EnrollError::Key(e.to_string()))?;
    key.save(identity_dir).map_err(|e| EnrollError::Key(e.to_string()))?;
    let csr = build_csr(&key, server.installation_id(), node_id).map_err(|e| EnrollError::Key(e.to_string()))?;
    let response = server.edge_enroll(&csr).await?;

    if response.installation_id != server.installation_id() || response.node_id != node_id {
        return Err(EnrollError::Verification("installation or node does not match"));
    }
    if response.mesh_protocol_version != edge_protocol::MESH_PROTOCOL_VERSION {
        return Err(EnrollError::Verification("mesh protocol version"));
    }
    let ca_der =
        pem_der(&response.ca_certificate_pem, "CERTIFICATE").ok_or(EnrollError::Verification("CA certificate"))?;
    if !ca_installation_matches(&ca_der, &server.installation_id().to_string()) {
        return Err(EnrollError::Verification("CA installation"));
    }
    let certificate_der =
        pem_der(&response.certificate_pem, "CERTIFICATE").ok_or(EnrollError::Verification("node certificate"))?;
    let anchor = TrustAnchor { installation_id: server.installation_id(), ca_der: ca_der.clone() };
    let issued = verify_peer(&certificate_der, &anchor, &RevocationSet::new(), now, PeerRole::Client, Some(node_id))
        .map_err(|_| EnrollError::Verification("node certificate does not verify"))?;
    if &issued.public_key != key.public_key() {
        return Err(EnrollError::Verification("certificate is for another key"));
    }
    let authority_public = URL_SAFE_NO_PAD
        .decode(&response.authority.public_key)
        .ok()
        .and_then(|bytes| PublicKey::from_slice(&bytes))
        .ok_or(EnrollError::Verification("authority key"))?;
    if authority_public.key_id() != response.authority.key_id || response.authority.epoch == 0 {
        return Err(EnrollError::Verification("authority key id"));
    }
    let authority = AuthorityKey { epoch: response.authority.epoch, public_key: authority_public };
    let trust = AuthorityTrust { installation_id: server.installation_id(), keys: vec![authority.clone()] };
    let snapshot = verify_revocation_snapshot(&response.revocation_snapshot, &trust)
        .map_err(|_| EnrollError::Verification("revocation snapshot"))?;

    // Refuse a silently changed CA or authority (see module docs).
    if let Some(pinned) = db.run(|c| identity::get_trust(c)).await? {
        let same_ca = pinned.ca_certificate_der == ca_der;
        let same_authority = pinned.authority_keys.iter().any(|k| k == &authority);
        if pinned.installation_id != server.installation_id() || !same_ca || !same_authority {
            return Err(EnrollError::TrustChanged);
        }
    }

    let record = CertificateRecord {
        fingerprint: issued.fingerprint.clone(),
        serial_number: issued.serial_hex.clone(),
        certificate_der,
        key_fingerprint: key.fingerprint(),
        installation_id: issued.installation_id,
        node_id: issued.node_id,
        screen_id: issued.screen_id,
        not_before: issued.not_before,
        not_after: issued.not_after,
    };
    let trust_record = TrustRecord {
        installation_id: server.installation_id(),
        ca_fingerprint: anchor.fingerprint(),
        ca_certificate_der: ca_der,
        mesh_protocol_version: response.mesh_protocol_version,
        latest_sequence_at_enrollment: response.latest_sequence,
        authority_keys: vec![authority],
    };
    let stored = record.clone();
    let latest = response.latest_sequence;
    let revoked = snapshot.revoked.clone();
    let generation = snapshot.generation;
    db.run(move |c| {
        identity::put_trust(c, &trust_record, now)?;
        identity::activate_certificate(c, &stored, now)?;
        for entry in &revoked {
            identity::record_revocation(c, entry.node_id, generation, now, entry.certificates_expire_at)?;
        }
        edge_state::repo::changes::set_baseline(c, latest, now)
    })
    .await?;
    revocations.apply_snapshot(&snapshot);
    let referenced = db.run(|c| identity::referenced_key_fingerprints(c)).await?;
    let _ = edge_identity::key::remove_orphans(identity_dir, &referenced);
    tracing::info!(
        component = "identity",
        event = "certificate_issued",
        fingerprint = &record.fingerprint[record.fingerprint.len() - 12..],
        not_after = %record.not_after
    );
    Ok(Enrolled { certificate: record, latest_sequence: latest, revoked_nodes: snapshot.revoked.len() })
}
