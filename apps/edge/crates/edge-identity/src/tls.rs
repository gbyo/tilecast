//! rustls configurations for node-to-node mTLS (peer blob service).
//!
//! * TLS 1.3 only, ring provider, Ed25519 node certificates.
//! * Both directions run [`verify_peer`]: chain to the pinned installation
//!   CA, installation SAN, node purpose, revocation. Hostnames and IP
//!   addresses are ignored: a dialer instead names the node it expects, which
//!   is a stronger check than a DNS name could be.
//! * The revocation set is shared, so a revocation applies to the next
//!   handshake without rebuilding configurations.
//!
//! Zenoh's TLS links are configured separately (`edge-mesh`) from the same
//! credentials; Zenoh verifies the chain, and revocation is enforced on every
//! node statement received over it.

use std::sync::Arc;

use edge_protocol::{NodeId, Timestamp};
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::CryptoProvider;
use rustls::pki_types::{CertificateDer, PrivateKeyDer, PrivatePkcs8KeyDer, ServerName, UnixTime};
use rustls::server::danger::{ClientCertVerified, ClientCertVerifier};
use rustls::{ClientConfig, DigitallySignedStruct, DistinguishedName, ServerConfig, SignatureScheme};

use crate::certificate::{PeerRole, verify_peer};
use crate::trust::{RevocationSet, TrustAnchor};

/// This node's certificate and key.
#[derive(Clone)]
pub struct NodeCredentials {
    pub certificate_der: Vec<u8>,
    pub key_pkcs8: Vec<u8>,
}

impl std::fmt::Debug for NodeCredentials {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("NodeCredentials")
            .field("certificate_bytes", &self.certificate_der.len())
            .finish_non_exhaustive()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum TlsError {
    #[error("TLS configuration failed: {0}")]
    Rustls(#[from] rustls::Error),
    #[error("the pinned CA certificate is invalid")]
    InvalidCa,
}

pub fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn now(time: UnixTime) -> Timestamp {
    Timestamp::from_unix_seconds(time.as_secs() as i64)
        .unwrap_or_else(|| Timestamp::from_unix_seconds(0).expect("epoch"))
}

fn tls_error(rejection: crate::certificate::PeerRejection) -> rustls::Error {
    tracing::warn!(component = "identity", event = "peer_rejected", reason = rejection.reason_code());
    rustls::Error::InvalidCertificate(rustls::CertificateError::ApplicationVerificationFailure)
}

#[derive(Debug)]
struct Verifier {
    anchor: TrustAnchor,
    revocations: RevocationSet,
    provider: Arc<CryptoProvider>,
    hints: Vec<DistinguishedName>,
    expected_node: Option<NodeId>,
}

impl Verifier {
    fn new(anchor: TrustAnchor, revocations: RevocationSet, expected_node: Option<NodeId>) -> Result<Self, TlsError> {
        let (_, ca) = x509_parser::parse_x509_certificate(&anchor.ca_der).map_err(|_| TlsError::InvalidCa)?;
        let hints = vec![DistinguishedName::from(ca.subject().as_raw().to_vec())];
        Ok(Self { anchor, revocations, provider: provider(), hints, expected_node })
    }

    fn signature13(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.provider.signature_verification_algorithms)
    }
}

impl ClientCertVerifier for Verifier {
    fn root_hint_subjects(&self) -> &[DistinguishedName] {
        &self.hints
    }

    fn verify_client_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        time: UnixTime,
    ) -> Result<ClientCertVerified, rustls::Error> {
        verify_peer(end_entity, &self.anchor, &self.revocations, now(time), PeerRole::Client, None)
            .map_err(tls_error)?;
        Ok(ClientCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::PeerIncompatible(rustls::PeerIncompatible::Tls12NotOffered))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.signature13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

impl ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        time: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        verify_peer(end_entity, &self.anchor, &self.revocations, now(time), PeerRole::Server, self.expected_node)
            .map_err(tls_error)?;
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &CertificateDer<'_>,
        _dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        Err(rustls::Error::PeerIncompatible(rustls::PeerIncompatible::Tls12NotOffered))
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.signature13(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        vec![SignatureScheme::ED25519]
    }
}

fn key(credentials: &NodeCredentials) -> PrivateKeyDer<'static> {
    PrivateKeyDer::Pkcs8(PrivatePkcs8KeyDer::from(credentials.key_pkcs8.clone()))
}

/// Server side: requires and verifies a client node certificate.
pub fn server_config(
    credentials: &NodeCredentials,
    anchor: TrustAnchor,
    revocations: RevocationSet,
) -> Result<ServerConfig, TlsError> {
    let verifier = Arc::new(Verifier::new(anchor, revocations, None)?);
    let config = ServerConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .with_client_cert_verifier(verifier)
        .with_single_cert(vec![CertificateDer::from(credentials.certificate_der.clone())], key(credentials))?;
    Ok(config)
}

/// Client side: presents this node's certificate and accepts only `expected`
/// (or any fabric member when `expected` is `None`).
pub fn client_config(
    credentials: &NodeCredentials,
    anchor: TrustAnchor,
    revocations: RevocationSet,
    expected: Option<NodeId>,
) -> Result<ClientConfig, TlsError> {
    let verifier = Arc::new(Verifier::new(anchor, revocations, expected)?);
    let config = ClientConfig::builder_with_provider(provider())
        .with_protocol_versions(&[&rustls::version::TLS13])?
        .dangerous()
        .with_custom_certificate_verifier(verifier)
        .with_client_auth_cert(vec![CertificateDer::from(credentials.certificate_der.clone())], key(credentials))?;
    Ok(config)
}
