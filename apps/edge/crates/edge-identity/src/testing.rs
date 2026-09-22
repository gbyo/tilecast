//! Test certificate authority matching the server's issuance template
//! (`apps/server/internal/edge/certificates.go`). Test builds only.

use edge_protocol::{InstallationId, NodeId, ScreenId};
use rcgen::{
    BasicConstraints, CertificateParams, DistinguishedName, DnType, ExtendedKeyUsagePurpose, IsCa, Issuer, KeyPair,
    KeyUsagePurpose, PKCS_ED25519, SanType, string::Ia5String,
};
use rustls_pki_types::PrivatePkcs8KeyDer;

use crate::key::NodeKey;
use crate::tls::NodeCredentials;
use crate::trust::TrustAnchor;
use crate::{PURPOSE_NODE, urn};

#[allow(missing_debug_implementations)]
pub struct TestCa {
    pub installation_id: InstallationId,
    pub ca_der: Vec<u8>,
    issuer: Issuer<'static, KeyPair>,
}

fn uri(value: String) -> SanType {
    #[allow(clippy::unwrap_used)]
    SanType::URI(Ia5String::try_from(value).unwrap())
}

impl TestCa {
    #[allow(clippy::unwrap_used)]
    pub fn new(installation_id: InstallationId) -> Self {
        let key = KeyPair::generate_for(&PKCS_ED25519).unwrap();
        let mut params = CertificateParams::default();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, format!("Tilecast Edge CA {installation_id}"));
        params.distinguished_name = name;
        params.is_ca = IsCa::Ca(BasicConstraints::Constrained(0));
        params.key_usages = vec![KeyUsagePurpose::KeyCertSign, KeyUsagePurpose::CrlSign];
        params.subject_alt_names =
            vec![uri(urn("installation", &installation_id.to_string())), uri("urn:tilecast:edge:purpose:ca".into())];
        let certificate = params.self_signed(&key).unwrap();
        let ca_der = certificate.der().to_vec();
        Self { installation_id, ca_der, issuer: Issuer::new(params, key) }
    }

    pub fn anchor(&self) -> TrustAnchor {
        TrustAnchor { installation_id: self.installation_id, ca_der: self.ca_der.clone() }
    }

    fn node_params(node: NodeId, installation: InstallationId, validity_days: i64) -> CertificateParams {
        let mut params = CertificateParams::default();
        let mut name = DistinguishedName::new();
        name.push(DnType::CommonName, node.to_string());
        params.distinguished_name = name;
        let now = time::OffsetDateTime::now_utc();
        params.not_before = now - time::Duration::minutes(5);
        params.not_after = now + time::Duration::days(validity_days);
        params.key_usages = vec![KeyUsagePurpose::DigitalSignature];
        params.extended_key_usages = vec![ExtendedKeyUsagePurpose::ServerAuth, ExtendedKeyUsagePurpose::ClientAuth];
        params.subject_alt_names = vec![
            uri(urn("installation", &installation.to_string())),
            uri(urn("node", &node.to_string())),
            uri(urn("screen", &ScreenId::new_random().to_string())),
            uri(PURPOSE_NODE.into()),
        ];
        params
    }

    /// Issues a node certificate with the server's template, optionally
    /// overriding the installation (to build foreign certificates).
    #[allow(clippy::unwrap_used)]
    pub fn issue_with(&self, key: &NodeKey, node: NodeId, installation: InstallationId, validity_days: i64) -> Vec<u8> {
        let der = PrivatePkcs8KeyDer::from(key.pkcs8_der().to_vec());
        let subject_key = KeyPair::from_pkcs8_der_and_sign_algo(&der, &PKCS_ED25519).unwrap();
        let params = Self::node_params(node, installation, validity_days);
        params.signed_by(&subject_key, &self.issuer).unwrap().der().to_vec()
    }

    /// Issues for the public key in a PEM CSR, as the server does. The CSR's
    /// requested names are ignored; the template decides them.
    pub fn issue_from_csr(&self, csr_pem: &str, node: NodeId) -> Result<Vec<u8>, rcgen::Error> {
        let csr = rcgen::CertificateSigningRequestParams::from_pem(csr_pem)?;
        let params = Self::node_params(node, self.installation_id, 180);
        Ok(params.signed_by(&csr.public_key, &self.issuer)?.der().to_vec())
    }

    pub fn issue(&self, key: &NodeKey, node: NodeId) -> Vec<u8> {
        self.issue_with(key, node, self.installation_id, 180)
    }

    /// A fresh node: key plus certificate.
    #[allow(clippy::unwrap_used)]
    pub fn node(&self) -> (NodeId, NodeKey, NodeCredentials) {
        let node = NodeId::new_random();
        let key = NodeKey::generate().unwrap();
        let certificate_der = self.issue(&key, node);
        let credentials = NodeCredentials { certificate_der, key_pkcs8: key.pkcs8_der().to_vec() };
        (node, key, credentials)
    }
}
