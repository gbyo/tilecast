//! Certificate signing requests.
//!
//! The CSR names exactly the installation and node (CN = node ID, URI SANs
//! `urn:tilecast:edge:installation:<id>` and `urn:tilecast:edge:node:<id>`).
//! The server checks both against what it already knows for the
//! authenticated device credential and builds the certificate from its own
//! template; nothing else in the CSR is honored.

use edge_protocol::{InstallationId, NodeId};
use rcgen::{CertificateParams, DistinguishedName, DnType, KeyPair, PKCS_ED25519, SanType, string::Ia5String};
use rustls_pki_types::PrivatePkcs8KeyDer;

use crate::key::NodeKey;
use crate::urn;

#[derive(Debug, thiserror::Error)]
#[error("could not build the certificate request: {0}")]
pub struct CsrError(String);

pub fn build_csr(key: &NodeKey, installation: InstallationId, node: NodeId) -> Result<String, CsrError> {
    let der = PrivatePkcs8KeyDer::from(key.pkcs8_der().to_vec());
    let key_pair = KeyPair::from_pkcs8_der_and_sign_algo(&der, &PKCS_ED25519).map_err(|e| CsrError(e.to_string()))?;
    let mut params = CertificateParams::default();
    let mut name = DistinguishedName::new();
    name.push(DnType::CommonName, node.to_string());
    params.distinguished_name = name;
    params.subject_alt_names = vec![
        SanType::URI(
            Ia5String::try_from(urn("installation", &installation.to_string())).map_err(|e| CsrError(e.to_string()))?,
        ),
        SanType::URI(Ia5String::try_from(urn("node", &node.to_string())).map_err(|e| CsrError(e.to_string()))?),
    ];
    let request = params.serialize_request(&key_pair).map_err(|e| CsrError(e.to_string()))?;
    request.pem().map_err(|e| CsrError(e.to_string()))
}
