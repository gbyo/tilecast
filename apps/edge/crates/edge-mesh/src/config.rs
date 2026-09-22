//! Zenoh session configuration (RFC §13.1–13.5).
//!
//! * peer mode, TLS links only (`transport.link.protocols = ["tls"]`), so a
//!   node found by multicast or gossip is not connected until mutual TLS
//!   against the installation CA succeeds;
//! * the node's own certificate for both directions, `enable_mtls`, and no
//!   hostname check (identity is the certificate's node URN, checked on every
//!   statement; addresses are hints);
//! * links close when the peer certificate expires;
//! * multicast scouting and gossip are configurable; static seeds are tried
//!   in addition, with bounded exponential retry;
//! * no admin space, no plugins, no shared memory, no timestamps (HLC is not
//!   used for any decision, RFC §13.11).

use std::net::SocketAddr;

use base64::Engine as _;
use base64::engine::general_purpose::STANDARD;
use edge_identity::TrustAnchor;
use edge_identity::tls::NodeCredentials;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Multicast {
    pub address: SocketAddr,
    /// Interface name; `None` lets Zenoh choose. The daemon passes the Edge
    /// interface and never a Presentation Network interface.
    pub interface: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Transport {
    /// Addresses to accept peer sessions on (the Edge interface).
    pub listen: Vec<SocketAddr>,
    /// `host:port` peers to dial (static or server-provided seeds).
    pub seeds: Vec<String>,
    pub multicast: Option<Multicast>,
}

#[derive(Debug, thiserror::Error)]
pub enum ConfigError {
    #[error("invalid mesh endpoint {0:?}")]
    Endpoint(String),
    #[error("zenoh rejected the configuration: {0}")]
    Zenoh(String),
}

fn pem(label: &str, der: &[u8]) -> String {
    let body = STANDARD.encode(der);
    let mut out = format!("-----BEGIN {label}-----\n");
    for chunk in body.as_bytes().chunks(64) {
        out.push_str(std::str::from_utf8(chunk).unwrap_or_default());
        out.push('\n');
    }
    out.push_str(&format!("-----END {label}-----\n"));
    out
}

/// Zenoh takes base64 of PEM for inline TLS material.
fn inline(label: &str, der: &[u8]) -> String {
    serde_json::Value::String(STANDARD.encode(pem(label, der))).to_string()
}

fn seed(value: &str) -> Result<String, ConfigError> {
    let valid = !value.is_empty()
        && value.len() <= 255
        && value.rsplit_once(':').is_some_and(|(host, port)| {
            !host.is_empty()
                && port.parse::<u16>().is_ok_and(|p| p > 0)
                && host.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '[' | ']' | ':'))
        });
    if !valid {
        return Err(ConfigError::Endpoint(value.to_owned()));
    }
    Ok(format!("tls/{value}"))
}

pub fn zenoh_config(
    transport: &Transport,
    credentials: &NodeCredentials,
    anchor: &TrustAnchor,
) -> Result<zenoh::Config, ConfigError> {
    let mut config = zenoh::Config::default();
    let listen: Vec<String> = transport.listen.iter().map(|address| format!("tls/{address}")).collect();
    let seeds = transport.seeds.iter().map(|value| seed(value)).collect::<Result<Vec<_>, _>>()?;
    let certificate = inline("CERTIFICATE", &credentials.certificate_der);
    let key = inline("PRIVATE KEY", &credentials.key_pkcs8);
    let entries: Vec<(&str, String)> = vec![
        ("mode", "\"peer\"".into()),
        ("listen/endpoints", serde_json::to_string(&listen).unwrap_or_default()),
        ("listen/exit_on_failure", "false".into()),
        ("connect/endpoints", serde_json::to_string(&seeds).unwrap_or_default()),
        ("connect/exit_on_failure", "false".into()),
        ("connect/timeout_ms", "0".into()),
        ("connect/retry", "{period_init_ms: 1000, period_max_ms: 30000, period_increase_factor: 2}".into()),
        ("transport/link/protocols", "[\"tls\"]".into()),
        ("transport/link/tls/root_ca_certificate_base64", inline("CERTIFICATE", &anchor.ca_der)),
        ("transport/link/tls/listen_certificate_base64", certificate.clone()),
        ("transport/link/tls/listen_private_key_base64", key.clone()),
        ("transport/link/tls/connect_certificate_base64", certificate),
        ("transport/link/tls/connect_private_key_base64", key),
        ("transport/link/tls/enable_mtls", "true".into()),
        ("transport/link/tls/verify_name_on_connect", "false".into()),
        ("transport/link/tls/close_link_on_expiration", "true".into()),
        ("transport/shared_memory/enabled", "false".into()),
        ("adminspace/enabled", "false".into()),
        ("timestamping/enabled", "false".into()),
        ("scouting/gossip/enabled", "true".into()),
        ("scouting/multicast/enabled", transport.multicast.is_some().to_string()),
    ];
    for (key, value) in entries {
        config.insert_json5(key, &value).map_err(|e| ConfigError::Zenoh(format!("{key}: {e}")))?;
    }
    if let Some(multicast) = &transport.multicast {
        config
            .insert_json5("scouting/multicast/address", &format!("\"{}\"", multicast.address))
            .map_err(|e| ConfigError::Zenoh(e.to_string()))?;
        if let Some(interface) = &multicast.interface {
            if !interface.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
                return Err(ConfigError::Endpoint(interface.clone()));
            }
            config
                .insert_json5("scouting/multicast/interface", &format!("\"{interface}\""))
                .map_err(|e| ConfigError::Zenoh(e.to_string()))?;
        }
    }
    Ok(config)
}
