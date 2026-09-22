//! Identity, certificate verification and mTLS tests.
#![allow(clippy::unwrap_used)]

use std::sync::Arc;

use edge_identity::certificate::{PeerRole, parse_identity};
use edge_identity::csr::build_csr;
use edge_identity::testing::TestCa;
use edge_identity::tls::{client_config, server_config};
use edge_identity::{NodeKey, PeerRejection, RevocationSet, verify_peer};
use edge_protocol::time::{SystemClock, WallClock};
use edge_protocol::{InstallationId, NodeId, Timestamp};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use x509_parser::prelude::FromDer;

fn now() -> Timestamp {
    SystemClock.now()
}

#[test]
fn csr_names_exactly_installation_and_node() {
    let key = NodeKey::generate().unwrap();
    let installation = InstallationId::new_random();
    let node = NodeId::new_random();
    let pem = build_csr(&key, installation, node).unwrap();
    assert!(pem.starts_with("-----BEGIN CERTIFICATE REQUEST-----"));
    assert!(!pem.contains("PRIVATE KEY"));
    let der = pem_to_der(&pem);
    let (_, csr) = x509_parser::certification_request::X509CertificationRequest::from_der(&der).unwrap();
    csr.verify_signature().unwrap();
    let cn = csr.certification_request_info.subject.iter_common_name().next().unwrap().as_str().unwrap().to_owned();
    assert_eq!(cn, node.to_string());
    let mut uris = Vec::new();
    for extension in csr.requested_extensions().into_iter().flatten() {
        if let x509_parser::extensions::ParsedExtension::SubjectAlternativeName(san) = extension {
            for name in &san.general_names {
                if let x509_parser::extensions::GeneralName::URI(uri) = name {
                    uris.push(uri.to_string());
                }
            }
        }
    }
    uris.sort();
    let mut want =
        vec![format!("urn:tilecast:edge:installation:{installation}"), format!("urn:tilecast:edge:node:{node}")];
    want.sort();
    assert_eq!(uris, want);
}

fn pem_to_der(pem: &str) -> Vec<u8> {
    use base64_decode::decode;
    let body: String = pem.lines().filter(|l| !l.starts_with("-----")).collect();
    decode(&body)
}

mod base64_decode {
    pub fn decode(input: &str) -> Vec<u8> {
        const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
        let mut out = Vec::new();
        let mut buffer = 0u32;
        let mut bits = 0;
        for byte in input.bytes().filter(|b| *b != b'=') {
            let value = TABLE.iter().position(|c| *c == byte).unwrap() as u32;
            buffer = (buffer << 6) | value;
            bits += 6;
            if bits >= 8 {
                bits -= 8;
                out.push((buffer >> bits) as u8);
            }
        }
        out
    }
}

#[test]
fn verify_peer_accepts_members_and_rejects_everything_else() {
    let ca = TestCa::new(InstallationId::new_random());
    let revocations = RevocationSet::new();
    let (node, key, credentials) = ca.node();
    let identity =
        verify_peer(&credentials.certificate_der, &ca.anchor(), &revocations, now(), PeerRole::Client, Some(node))
            .unwrap();
    assert_eq!(identity.node_id, node);
    assert_eq!(&identity.public_key, key.public_key());

    // Valid certificate from another installation's CA.
    let other = TestCa::new(InstallationId::new_random());
    let (_, _, foreign) = other.node();
    assert!(matches!(
        verify_peer(&foreign.certificate_der, &ca.anchor(), &revocations, now(), PeerRole::Client, None),
        Err(PeerRejection::Untrusted(_))
    ));

    // Our CA, but a certificate naming a different installation (CA misuse).
    let wrong = ca.issue_with(&key, node, InstallationId::new_random(), 180);
    assert_eq!(
        verify_peer(&wrong, &ca.anchor(), &revocations, now(), PeerRole::Client, None),
        Err(PeerRejection::WrongInstallation)
    );

    // Expired.
    let expired = ca.issue_with(&key, node, ca.installation_id, -1);
    assert!(matches!(
        verify_peer(&expired, &ca.anchor(), &revocations, now(), PeerRole::Client, None),
        Err(PeerRejection::Untrusted(_))
    ));

    // Dialed a different node than the certificate names.
    assert_eq!(
        verify_peer(
            &credentials.certificate_der,
            &ca.anchor(),
            &revocations,
            now(),
            PeerRole::Server,
            Some(NodeId::new_random())
        ),
        Err(PeerRejection::UnexpectedNode)
    );

    // The CA certificate itself is not a node.
    assert!(verify_peer(&ca.ca_der, &ca.anchor(), &revocations, now(), PeerRole::Client, None).is_err());

    // Revoked before natural expiry.
    revocations.revoke(node, identity.not_after, 1);
    assert_eq!(
        verify_peer(&credentials.certificate_der, &ca.anchor(), &revocations, now(), PeerRole::Client, None),
        Err(PeerRejection::Revoked)
    );
    assert!(parse_identity(b"not a certificate").is_err());
}

async fn handshake(
    ca: &TestCa,
    server_revocations: RevocationSet,
    client: &edge_identity::tls::NodeCredentials,
    expected: Option<NodeId>,
) -> Result<Vec<u8>, String> {
    let (_, _, server_credentials) = ca.node();
    let server = Arc::new(server_config(&server_credentials, ca.anchor(), server_revocations).unwrap());
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let acceptor = tokio_rustls::TlsAcceptor::from(server);
    let server_task = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        if let Ok(mut tls) = acceptor.accept(stream).await {
            let _ = tls.write_all(b"ok").await;
            let _ = tls.shutdown().await;
        }
    });
    let anchor = ca.anchor();
    let config = Arc::new(client_config(client, anchor, RevocationSet::new(), expected).unwrap());
    let connector = tokio_rustls::TlsConnector::from(config);
    let stream = tokio::net::TcpStream::connect(address).await.unwrap();
    let name = rustls::pki_types::ServerName::try_from("127.0.0.1").unwrap();
    let result = match connector.connect(name, stream).await {
        Ok(mut tls) => {
            let mut buffer = Vec::new();
            tls.read_to_end(&mut buffer).await.map(|_| buffer).map_err(|e| e.to_string())
        }
        Err(error) => Err(error.to_string()),
    };
    let _ = server_task.await;
    result
}

#[tokio::test]
async fn mutual_tls_admits_members_only() {
    let ca = TestCa::new(InstallationId::new_random());
    let (_, _, member) = ca.node();
    assert_eq!(handshake(&ca, RevocationSet::new(), &member, None).await.unwrap(), b"ok");

    let other = TestCa::new(InstallationId::new_random());
    let (_, _, outsider) = other.node();
    assert!(handshake(&ca, RevocationSet::new(), &outsider, None).await.is_err(), "foreign installation rejected");

    let (revoked_node, _, revoked) = ca.node();
    let revocations = RevocationSet::new();
    revocations.revoke(revoked_node, now().saturating_add(time::Duration::days(200)), 1);
    assert!(handshake(&ca, revocations, &revoked, None).await.is_err(), "revoked node rejected");

    // A client that dials a specific node refuses a different server.
    assert!(handshake(&ca, RevocationSet::new(), &member, Some(NodeId::new_random())).await.is_err());
}
