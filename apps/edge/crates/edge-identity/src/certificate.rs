//! Edge certificate parsing and peer verification.

use std::time::Duration;

use edge_protocol::signed::PublicKey;
use edge_protocol::{InstallationId, NodeId, ScreenId, Sha256Digest, Timestamp};
use rustls_pki_types::{CertificateDer, UnixTime};
use x509_parser::extensions::{GeneralName, ParsedExtension};

use crate::trust::{RevocationSet, TrustAnchor};
use crate::{PURPOSE_NODE, URN_PREFIX};

/// Identity proven by a verified node certificate.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EdgeIdentity {
    pub installation_id: InstallationId,
    pub node_id: NodeId,
    pub screen_id: Option<ScreenId>,
    pub not_before: Timestamp,
    pub not_after: Timestamp,
    pub public_key: PublicKey,
    /// SHA-256 of the certificate DER.
    pub fingerprint: String,
    pub serial_hex: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PeerRejection {
    #[error("certificate could not be parsed")]
    Malformed,
    #[error("certificate does not chain to this installation's Edge CA: {0}")]
    Untrusted(String),
    #[error("certificate belongs to another installation")]
    WrongInstallation,
    #[error("certificate is not a Tilecast Edge node certificate")]
    NotANodeCertificate,
    #[error("certificate names a different node than expected")]
    UnexpectedNode,
    #[error("node is revoked")]
    Revoked,
}

impl PeerRejection {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Malformed => "peer_certificate_malformed",
            Self::Untrusted(_) => "peer_certificate_untrusted",
            Self::WrongInstallation => "peer_wrong_installation",
            Self::NotANodeCertificate => "peer_not_a_node",
            Self::UnexpectedNode => "peer_unexpected_node",
            Self::Revoked => "peer_revoked",
        }
    }
}

/// Parses identity claims from a certificate without verifying it.
pub fn parse_identity(der: &[u8]) -> Result<EdgeIdentity, PeerRejection> {
    let (rest, certificate) = x509_parser::parse_x509_certificate(der).map_err(|_| PeerRejection::Malformed)?;
    if !rest.is_empty() {
        return Err(PeerRejection::Malformed);
    }
    let mut installation = None;
    let mut node = None;
    let mut screen = None;
    let mut purpose = false;
    for extension in certificate.extensions() {
        if let ParsedExtension::SubjectAlternativeName(san) = extension.parsed_extension() {
            for name in &san.general_names {
                match name {
                    GeneralName::URI(uri) => {
                        if *uri == PURPOSE_NODE {
                            purpose = true;
                            continue;
                        }
                        let Some(rest) = uri.strip_prefix(URN_PREFIX) else {
                            return Err(PeerRejection::NotANodeCertificate);
                        };
                        match rest.split_once(':') {
                            Some(("installation", id)) if installation.is_none() => {
                                installation =
                                    Some(id.parse::<InstallationId>().map_err(|_| PeerRejection::Malformed)?);
                            }
                            Some(("node", id)) if node.is_none() => {
                                node = Some(id.parse::<NodeId>().map_err(|_| PeerRejection::Malformed)?);
                            }
                            Some(("screen", id)) if screen.is_none() => {
                                screen = Some(id.parse::<ScreenId>().map_err(|_| PeerRejection::Malformed)?);
                            }
                            _ => return Err(PeerRejection::NotANodeCertificate),
                        }
                    }
                    // Node certificates carry no DNS names, IPs or emails.
                    _ => return Err(PeerRejection::NotANodeCertificate),
                }
            }
        }
    }
    let (Some(installation_id), Some(node_id)) = (installation, node) else {
        return Err(PeerRejection::NotANodeCertificate);
    };
    if !purpose || certificate.is_ca() {
        return Err(PeerRejection::NotANodeCertificate);
    }
    let common_name = certificate.subject().iter_common_name().next().and_then(|cn| cn.as_str().ok());
    if common_name != Some(node_id.to_string().as_str()) {
        return Err(PeerRejection::NotANodeCertificate);
    }
    let key = PublicKey::from_slice(&certificate.public_key().subject_public_key.data)
        .ok_or(PeerRejection::NotANodeCertificate)?;
    let not_before =
        Timestamp::from_unix_seconds(certificate.validity().not_before.timestamp()).ok_or(PeerRejection::Malformed)?;
    let not_after =
        Timestamp::from_unix_seconds(certificate.validity().not_after.timestamp()).ok_or(PeerRejection::Malformed)?;
    Ok(EdgeIdentity {
        installation_id,
        node_id,
        screen_id: screen,
        not_before,
        not_after,
        public_key: key,
        fingerprint: Sha256Digest::of(der).to_hex(),
        serial_hex: certificate.raw_serial_as_string().replace(':', ""),
    })
}

/// Which side of a TLS connection the peer certificate is presented on.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PeerRole {
    /// The peer connected to us (client certificate).
    Client,
    /// We connected to the peer (server certificate).
    Server,
}

/// The one function that decides whether a peer is a member of this
/// installation's Edge fabric. Order: chain to the pinned CA (signature,
/// validity, key usage) → installation → node purpose → expected node (when
/// the caller knows whom it dialed) → revocation.
pub fn verify_peer(
    der: &[u8],
    anchor: &TrustAnchor,
    revocations: &RevocationSet,
    now: Timestamp,
    role: PeerRole,
    expected_node: Option<NodeId>,
) -> Result<EdgeIdentity, PeerRejection> {
    let ca = CertificateDer::from(anchor.ca_der.as_slice());
    let trust_anchor =
        webpki::anchor_from_trusted_cert(&ca).map_err(|e| PeerRejection::Untrusted(format!("pinned CA: {e}")))?;
    let certificate = CertificateDer::from(der);
    let end_entity = webpki::EndEntityCert::try_from(&certificate).map_err(|_| PeerRejection::Malformed)?;
    let usage = match role {
        PeerRole::Client => webpki::KeyUsage::client_auth(),
        PeerRole::Server => webpki::KeyUsage::server_auth(),
    };
    let time = UnixTime::since_unix_epoch(Duration::from_secs(now.unix_seconds().max(0) as u64));
    end_entity
        .verify_for_usage(&[webpki::ring::ED25519], &[trust_anchor], &[], time, usage, None, None)
        .map_err(|e| PeerRejection::Untrusted(e.to_string()))?;
    let identity = parse_identity(der)?;
    if identity.installation_id != anchor.installation_id {
        return Err(PeerRejection::WrongInstallation);
    }
    if expected_node.is_some_and(|expected| expected != identity.node_id) {
        return Err(PeerRejection::UnexpectedNode);
    }
    if revocations.is_revoked(&identity.node_id) {
        return Err(PeerRejection::Revoked);
    }
    Ok(identity)
}
