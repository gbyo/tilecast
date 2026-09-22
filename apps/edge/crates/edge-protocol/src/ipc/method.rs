//! Requests: client → daemon calls with exactly one response each.
//!
//! Methods are a closed set. Each names the roles that may call it and
//! whether it is *administrative*. Administrative methods additionally
//! require the peer UID to be the daemon's own account or root, regardless of
//! which roles the socket admits (RFC §37.2). No method takes a path,
//! executable, shell fragment or credential.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::Role;
use crate::bounded::SafeText;
use crate::digest::Sha256Digest;
use crate::time::Timestamp;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Empty {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CasVerifyParams {
    pub sha256: Sha256Digest,
}

/// Server address typed on the setup surface of an unconfigured screen.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitServerUrlParams {
    pub url: SafeText<512>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitServerUrlResult {
    pub ok: bool,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub error: Option<SafeText<240>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PingResult {
    pub daemon_time: Timestamp,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShowDiagnosticResult {
    pub generation: u64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Method {
    Ping(Empty),
    StatusGet(Empty),
    CapabilitiesGet(Empty),
    PeersList(Empty),
    CasStatus(Empty),
    CasVerify(CasVerifyParams),
    /// Ask the renderer to show the daemon's status surface (self-test).
    DiagnosticsShowStatus(Empty),
    SetupSubmitServerUrl(SubmitServerUrlParams),
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MethodError {
    #[error("unknown method {0}")]
    Unknown(String),
    #[error("invalid {name} params: {detail}")]
    InvalidParams { name: &'static str, detail: String },
}

macro_rules! methods {
    ($( $variant:ident => $name:literal, [$($role:ident),*], admin = $admin:literal ;)*) => {
        impl Method {
            pub fn name(&self) -> &'static str {
                match self { $( Method::$variant(_) => $name, )* }
            }

            pub fn allowed_roles(&self) -> &'static [Role] {
                match self { $( Method::$variant(_) => &[$(Role::$role),*], )* }
            }

            pub fn is_administrative(&self) -> bool {
                match self { $( Method::$variant(_) => $admin, )* }
            }

            pub fn decode(name: &str, params: Value) -> Result<Method, MethodError> {
                match name {
                    $( $name => serde_json::from_value(params)
                        .map(Method::$variant)
                        .map_err(|e| MethodError::InvalidParams { name: $name, detail: e.to_string() }), )*
                    other => Err(MethodError::Unknown(other.chars().take(64).collect())),
                }
            }

            pub fn params(&self) -> Value {
                let value = match self { $( Method::$variant(inner) => serde_json::to_value(inner), )* };
                value.unwrap_or(Value::Null)
            }
        }
    };
}

methods! {
    Ping => "ping", [Renderer, Tilecastctl], admin = false;
    StatusGet => "status.get", [Tilecastctl], admin = false;
    CapabilitiesGet => "capabilities.get", [Tilecastctl], admin = false;
    PeersList => "peers.list", [Tilecastctl], admin = false;
    CasStatus => "cas.status", [Tilecastctl], admin = false;
    CasVerify => "cas.verify", [Tilecastctl], admin = true;
    DiagnosticsShowStatus => "diagnostics.show_status", [Tilecastctl], admin = true;
    SetupSubmitServerUrl => "setup.submit_server_url", [Renderer], admin = false;
}

/// Stable error codes carried in `error` responses.
pub mod error_codes {
    pub const UNKNOWN_METHOD: &str = "unknown_method";
    pub const INVALID_PARAMS: &str = "invalid_params";
    pub const ROLE_NOT_PERMITTED: &str = "role_not_permitted";
    pub const NOT_AUTHORIZED: &str = "not_authorized";
    pub const UNAVAILABLE: &str = "unavailable";
    pub const INTERNAL: &str = "internal_error";
    pub const DUPLICATE_REQUEST_ID: &str = "duplicate_request_id";
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn method_table() {
        let verify = Method::decode(
            "cas.verify",
            json!({"sha256": "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"}),
        )
        .expect("valid");
        assert!(verify.is_administrative());
        assert_eq!(verify.allowed_roles(), &[Role::Tilecastctl]);
        assert!(Method::decode("cas.verify", json!({"sha256": "../../x"})).is_err());
        assert!(Method::decode("cas.verify", json!({"path": "/etc"})).is_err());
        assert!(matches!(
            Method::decode("shell.exec", json!({})),
            Err(MethodError::Unknown(_))
        ));
        assert!(Method::decode("ping", json!({"extra": 1})).is_err());
        let round = Method::decode("ping", Method::Ping(Empty {}).params()).expect("round trip");
        assert_eq!(round, Method::Ping(Empty {}));
    }
}
