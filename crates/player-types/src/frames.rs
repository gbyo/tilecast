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

/// The full response policy for frames whose media arrives as `tcmedia:`
/// capabilities (Android, Windows). The frame's own `<meta>` policy is not
/// a barrier because the Widget's bytes are untrusted; this header is.
/// Passive loads (image, media, font) reach only host-granted `tcmedia:`
/// URIs and inline `data:`, so a Widget cannot encode granted data into an
/// attacker-owned URL. Every other fetch directive stays denied.
pub const FRAME_RESPONSE_POLICY: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: tcmedia:; media-src data: tcmedia:; font-src data: tcmedia:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// The same policy for hosts that cannot load custom schemes inside
/// opaque-origin frames (Edge/WPE): passive loads reach only the daemon's
/// loopback media route, `http://127.0.0.1:<port>/media/`.
pub const FRAME_LOOPBACK_RESPONSE_POLICY: &str = "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: http://127.0.0.1:*/media/; media-src data: http://127.0.0.1:*/media/; font-src data: http://127.0.0.1:*/media/; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

/// The rendered `Content-Security-Policy` response header for frame bytes.
pub const FRAME_CSP_HEADER: &str = "Content-Security-Policy: sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: tcmedia:; media-src data: tcmedia:; font-src data: tcmedia:; connect-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'";

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
        assert_eq!(FRAME_RESPONSE_POLICY, constants["responsePolicy"].as_str().expect("response policy"));
        assert_eq!(
            FRAME_LOOPBACK_RESPONSE_POLICY,
            constants["loopbackResponsePolicy"].as_str().expect("loopback policy")
        );
        assert_eq!(EXTERNAL_RUNTIME_CAPABILITY, constants["capability"].as_str().expect("capability"));
        assert_eq!(EXTERNAL_RUNTIME_FRAME_VERSION, constants["capabilityVersion"].as_u64().expect("version") as u32);
        assert_eq!(fixture["serveHeaders"]["contentSecurityPolicy"].as_str(), Some(FRAME_RESPONSE_POLICY));
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
        assert_eq!(FRAME_CSP_HEADER, format!("Content-Security-Policy: {FRAME_RESPONSE_POLICY}"));
        assert!(FRAME_RESPONSE_POLICY.starts_with(FRAME_SANDBOX_POLICY));
        assert!(FRAME_LOOPBACK_RESPONSE_POLICY.starts_with(FRAME_SANDBOX_POLICY));
    }

    #[test]
    fn passive_loads_never_reach_the_open_web() {
        for policy in [FRAME_RESPONSE_POLICY, FRAME_LOOPBACK_RESPONSE_POLICY] {
            for directive in ["img-src", "media-src", "font-src"] {
                let sources = policy
                    .split("; ")
                    .find_map(|part| part.strip_prefix(directive))
                    .unwrap_or_else(|| panic!("{directive} missing from {policy}"));
                for source in sources.split_whitespace() {
                    assert!(
                        matches!(source, "data:" | "tcmedia:") || source.starts_with("http://127.0.0.1:*/media/"),
                        "{directive} grants {source}"
                    );
                }
            }
            for denied in ["connect-src", "worker-src", "object-src", "base-uri", "form-action"] {
                assert!(policy.contains(&format!("{denied} 'none'")), "{denied} must stay denied");
            }
            assert!(policy.contains("default-src 'none'"));
        }
    }
}
