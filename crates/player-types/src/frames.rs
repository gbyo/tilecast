//! Shared native Widget-frame values.
//!
//! External Widgets execute as documents served from verified frame grants.
//! Every native host names them the same way and confines them with the
//! same sandbox policy, so the values here are cross-player constants,
//! pinned by the conformance fixtures.

/// The custom scheme naming Widget frame loads: `tcwidget://cap/<opaque>`.
pub const FRAME_SCHEME: &str = "tcwidget";

/// The one authority the frame scheme serves.
pub const FRAME_CAPABILITY_HOST: &str = "cap";

/// The MIME type every frame grant serves as.
pub const FRAME_MIME_TYPE: &str = "text/html";

/// The sandbox policy every host applies to served frame bytes: scripts
/// run, but the document stays opaque, formless, and pointer-lock-free.
/// Hosts that can send response headers use it as a `Content-Security-Policy`
/// value; hosts that cannot must apply the equivalent sandbox attribute.
pub const FRAME_SANDBOX_POLICY: &str = "sandbox allow-scripts";

/// The rendered `Content-Security-Policy` response header for frame bytes.
pub const FRAME_CSP_HEADER: &str = "Content-Security-Policy: sandbox allow-scripts";

/// The one Widget-component capability naming the frame execution ABI.
/// External Widgets never join the discovered component list; every
/// manifest frame claim gates on this name at
/// [`EXTERNAL_RUNTIME_FRAME_VERSION`].
pub const EXTERNAL_RUNTIME_CAPABILITY: &str = "widget.external-runtime";

/// The frame execution ABI version every frame-capable host advertises.
/// Matches the Runtime's `EXTERNAL_RUNTIME_FRAME_VERSION`; the
/// cross-player conformance fixtures pin the pair.
pub const EXTERNAL_RUNTIME_FRAME_VERSION: u32 = 2;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn constants_match_the_shared_frame_contract() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../packages/player-contracts/fixtures/widget-frames.json"))
                .expect("fixture parses");
        let constants = &fixture["constants"];
        assert_eq!(fixture["schemaVersion"], 1);
        assert_eq!(FRAME_SCHEME, constants["scheme"].as_str().expect("scheme"));
        assert_eq!(FRAME_CAPABILITY_HOST, constants["host"].as_str().expect("host"));
        assert_eq!(FRAME_MIME_TYPE, constants["mimeType"].as_str().expect("mime"));
        assert_eq!(FRAME_SANDBOX_POLICY, constants["sandboxPolicy"].as_str().expect("policy"));
        assert_eq!(FRAME_CSP_HEADER, constants["cspHeader"].as_str().expect("csp"));
        assert_eq!(EXTERNAL_RUNTIME_CAPABILITY, constants["capability"].as_str().expect("capability"));
        assert_eq!(EXTERNAL_RUNTIME_FRAME_VERSION, constants["capabilityVersion"].as_u64().expect("version") as u32);
        assert_eq!(fixture["serveHeaders"]["contentSecurityPolicy"].as_str(), Some(FRAME_SANDBOX_POLICY));
        assert_eq!(fixture["rangesRefused"], true);
    }

    #[test]
    fn frame_url_shape_is_fixed() {
        assert_eq!(format!("{FRAME_SCHEME}://{FRAME_CAPABILITY_HOST}/<token>"), "tcwidget://cap/<token>");
        assert_eq!(FRAME_MIME_TYPE, "text/html");
    }

    #[test]
    fn sandbox_policy_confines_without_plugins_or_forms() {
        assert!(FRAME_SANDBOX_POLICY.starts_with("sandbox "));
        assert!(FRAME_SANDBOX_POLICY.contains("allow-scripts"));
        for granted in ["allow-same-origin", "allow-forms", "allow-popups", "allow-top-navigation"] {
            assert!(!FRAME_SANDBOX_POLICY.contains(granted), "frame policy grants {granted}");
        }
        assert_eq!(FRAME_CSP_HEADER, format!("Content-Security-Policy: {FRAME_SANDBOX_POLICY}"));
    }
}
