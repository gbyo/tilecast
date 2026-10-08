//! Custom-scheme request validation, shared by the WebView2 resource
//! handler. The grammar mirrors the Electron host's
//! (`runtime-protocol.ts`): nothing outside the runtime directory is
//! reachable — no traversal, no query-controlled path, no directory
//! listing — and `tcmedia` carries only opaque capabilities, never digests
//! or paths.

pub const RUNTIME_SCHEME: &str = "tilecast";
pub const RUNTIME_HOST: &str = "runtime";
pub const RUNTIME_ENTRY_URL: &str = "tilecast://runtime/index.html";
pub const MEDIA_SCHEME: &str = "tcmedia";
pub const WIDGET_SCHEME: &str = "tcwidget";
pub const MEDIA_HOST: &str = "cap";

/// A validated request for a packaged runtime file.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RuntimeRequest {
    /// `assets/app.js`: one or two segments, fixed grammar.
    pub path: String,
}

/// A validated request for granted media.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaRequest {
    /// The opaque capability token (validated for shape, not authorized:
    /// the registry decides that).
    pub capability: String,
}

/// A validated plugin media load: manifest asset/variant identity, resolved
/// through the live generations' alias maps (never served directly).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MediaVariantRequest {
    pub asset_id: uuid::Uuid,
    pub variant_id: uuid::Uuid,
}

/// A validated request for a granted Widget frame.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WidgetRequest {
    /// The opaque capability token (validated for shape, not authorized:
    /// the registry decides that).
    pub capability: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SchemeRequest {
    Runtime(RuntimeRequest),
    Media(MediaRequest),
    MediaVariant(MediaVariantRequest),
    Widget(WidgetRequest),
}

fn segment_ok(segment: &str) -> bool {
    let mut chars = segment.chars();
    match chars.next() {
        Some(first) if first.is_ascii_alphanumeric() => {}
        _ => return false,
    }
    segment.len() <= 64
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
        && !segment.contains("..")
}

fn split_authority<'a>(url: &'a str, scheme: &str) -> Option<(&'a str, &'a str)> {
    let prefix = format!("{scheme}://");
    let rest = url.strip_prefix(&prefix)?;
    let (authority, path) = rest.split_once('/')?;
    Some((authority, path))
}

/// Validates a `tilecast://runtime/<file>` request URL. The URL parser is
/// not trusted with security decisions: anything it would rewrite (encoded
/// dots, backslashes, userinfo, ports, queries, fragments) is refused.
pub fn parse_runtime_url(url: &str) -> Option<RuntimeRequest> {
    let (authority, path) = split_authority(url, RUNTIME_SCHEME)?;
    if authority != RUNTIME_HOST {
        return None;
    }
    if url.contains(['?', '#', '\\', '@']) {
        return None;
    }
    // The path must be exactly what was requested: no empty segments, no
    // dot segments, one or two segments of the fixed grammar.
    let segments: Vec<&str> = path.split('/').collect();
    if segments.is_empty() || segments.len() > 2 || segments.iter().any(|s| !segment_ok(s)) {
        return None;
    }
    // Re-encode check: the URL must be the canonical form of its segments,
    // so no `%2e`, `%2f`, or case trickery survives.
    if url != format!("{RUNTIME_SCHEME}://{RUNTIME_HOST}/{}", segments.join("/")) {
        return None;
    }
    Some(RuntimeRequest { path: segments.join("/") })
}

/// Validates a `tcmedia://cap/<opaque>` request URL. Shape only; the media
/// registry authorizes the capability.
pub fn parse_media_url(url: &str) -> Option<MediaRequest> {
    let (authority, path) = split_authority(url, MEDIA_SCHEME)?;
    if authority != MEDIA_HOST {
        return None;
    }
    if url.contains(['?', '#', '\\', '@']) || path.is_empty() || path.contains('/') {
        return None;
    }
    let capability = crate::media::MediaCapability::parse(path)?;
    if url != format!("{MEDIA_SCHEME}://{MEDIA_HOST}/{path}") {
        return None;
    }
    Some(MediaRequest { capability: capability.as_str().to_owned() })
}

/// Validates a `tcwidget://cap/<opaque>` request URL. Shape only; the media
/// registry authorizes the capability as a frame grant. Unlike every other
/// scheme here, a fragment is stripped, not refused: the executor binds
/// each attach with a `#token` fragment, and WebView2 may or may not pass
/// it through to the resource handler. The token authenticates the frame
/// handshake, never the HTTP layer, so the resolver ignores it.
pub fn parse_widget_url(url: &str) -> Option<WidgetRequest> {
    let bare = url.split_once('#').map_or(url, |(head, _)| head);
    let (authority, path) = split_authority(bare, WIDGET_SCHEME)?;
    if authority != MEDIA_HOST {
        return None;
    }
    if bare.contains(['?', '\\', '@']) || path.is_empty() || path.contains('/') {
        return None;
    }
    let capability = crate::media::MediaCapability::parse(path)?;
    if bare != format!("{WIDGET_SCHEME}://{MEDIA_HOST}/{path}") {
        return None;
    }
    Some(WidgetRequest { capability: capability.as_str().to_owned() })
}

/// Validates a `tcmedia://variant/<assetId>/<variantId>` plugin media URL:
/// exactly that shape, canonical UUIDs, nothing else.
pub fn parse_media_variant_url(url: &str) -> Option<MediaVariantRequest> {
    let (authority, path) = split_authority(url, MEDIA_SCHEME)?;
    if authority != "variant" {
        return None;
    }
    if url.contains(['?', '#', '\\', '@']) {
        return None;
    }
    let (asset_id, variant_id) = path.split_once('/')?;
    if variant_id.contains('/') {
        return None;
    }
    let asset_id = asset_id.parse::<uuid::Uuid>().ok()?;
    let variant_id = variant_id.parse::<uuid::Uuid>().ok()?;
    if url != format!("{MEDIA_SCHEME}://variant/{asset_id}/{variant_id}") {
        return None;
    }
    Some(MediaVariantRequest { asset_id, variant_id })
}

/// Classifies a resource request URL, or refuses it.
pub fn parse_request_url(url: &str) -> Option<SchemeRequest> {
    if let Some(runtime) = parse_runtime_url(url) {
        return Some(SchemeRequest::Runtime(runtime));
    }
    if let Some(variant) = parse_media_variant_url(url) {
        return Some(SchemeRequest::MediaVariant(variant));
    }
    if let Some(widget) = parse_widget_url(url) {
        return Some(SchemeRequest::Widget(widget));
    }
    parse_media_url(url).map(SchemeRequest::Media)
}

/// The response headers for one served frame document: the shared MIME
/// type and sandbox policy, no sniffing, no ranges, no store.
pub fn frame_response_headers(size_bytes: u64) -> String {
    format!(
        "Content-Type: {}\r\nContent-Length: {size_bytes}\r\n{}\r\nX-Content-Type-Options: nosniff\r\nAccept-Ranges: none\r\nCache-Control: no-store\r\n",
        player_types::frames::FRAME_MIME_TYPE,
        player_types::frames::FRAME_CSP_HEADER,
    )
}

/// Whether a resource-request initiator is the trusted Runtime origin.
/// `tcmedia` is served only to the Runtime document itself.
pub fn is_trusted_runtime_source(source: &str) -> bool {
    source == "tilecast://runtime" || source.starts_with("tilecast://runtime/")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn runtime_urls_accept_the_packaged_grammar() {
        assert_eq!(
            parse_runtime_url("tilecast://runtime/index.html"),
            Some(RuntimeRequest { path: "index.html".into() })
        );
        assert_eq!(
            parse_runtime_url("tilecast://runtime/assets/app-abc123.js"),
            Some(RuntimeRequest { path: "assets/app-abc123.js".into() })
        );
    }

    #[test]
    fn runtime_urls_refuse_everything_else() {
        for url in [
            "tilecast://runtime/",
            "tilecast://runtime",
            "tilecast://runtime/../state.db",
            "tilecast://runtime/%2e%2e/state.db",
            "tilecast://runtime/..%2fstate.db",
            "tilecast://runtime/assets/../../state.db",
            "tilecast://runtime/a/b/c.js",
            "tilecast://runtime/index.html?x=1",
            "tilecast://runtime/index.html#frag",
            "tilecast://runtime\\index.html",
            "tilecast://runtime/index.html ",
            "tilecast://other/index.html",
            "tilecast://runtime:1/index.html",
            "tilecast://user@runtime/index.html",
            "https://runtime/index.html",
            "tcmedia://cap/index.html",
            "",
        ] {
            assert_eq!(parse_runtime_url(url), None, "{url}");
        }
    }

    #[test]
    fn media_urls_carry_only_opaque_capabilities() {
        let token = "a".repeat(64);
        assert_eq!(parse_media_url(&format!("tcmedia://cap/{token}")), Some(MediaRequest { capability: token }));
        for url in [
            "tcmedia://cap/",
            "tcmedia://cap",
            "tcmedia://cap/short",
            &format!("tcmedia://cap/{}", "A".repeat(64)),
            &format!("tcmedia://cap/{}/extra", "a".repeat(64)),
            &format!("tcmedia://cap/{}?x=1", "a".repeat(64)),
            "tcmedia://other/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "tilecast://runtime/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        ] {
            assert_eq!(parse_media_url(url), None, "{url}");
        }
    }

    #[test]
    fn widget_urls_carry_opaque_capabilities_and_ignore_fragments() {
        let token = "b".repeat(64);
        let url = format!("tcwidget://cap/{token}");
        assert_eq!(parse_widget_url(&url), Some(WidgetRequest { capability: token.clone() }));
        // The executor binds each attach with a `#token` fragment; the
        // resolver strips it because the fragment authenticates the frame
        // handshake, never the HTTP layer.
        assert_eq!(parse_widget_url(&format!("{url}#handshake-token")), Some(WidgetRequest { capability: token }));
        assert!(matches!(parse_request_url(&url), Some(SchemeRequest::Widget(_))));
        for bad in [
            "tcwidget://cap/".to_string(),
            "tcwidget://cap".to_string(),
            "tcwidget://cap/short".to_string(),
            format!("tcwidget://cap/{}", "B".repeat(64)),
            format!("tcwidget://cap/{}/extra", "b".repeat(64)),
            format!("tcwidget://cap/{}?x=1", "b".repeat(64)),
            "tcwidget://other/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
            "tcmedia://cap/bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string(),
        ] {
            assert_eq!(parse_widget_url(&bad), None, "{bad}");
        }
    }

    #[test]
    fn widget_requests_match_the_shared_contract() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../packages/player-contracts/fixtures/widget-frames.json"))
                .expect("fixture parses");
        for case in fixture["requestUris"].as_array().expect("corpus") {
            let uri = case["uri"].as_str().expect("uri");
            let name = case["name"].as_str().unwrap_or(uri);
            match parse_widget_url(uri) {
                Some(request) if case["accepted"].as_bool().expect("accepted") => {
                    assert_eq!(request.capability, case["token"].as_str().expect("token"), "{name}");
                }
                None if !case["accepted"].as_bool().expect("accepted") => {}
                other => panic!("{name}: unexpected {other:?}"),
            }
        }
    }

    #[test]
    fn widget_scheme_matches_the_shared_frame_shape() {
        assert_eq!(WIDGET_SCHEME, player_types::frames::FRAME_SCHEME);
        assert_eq!(MEDIA_HOST, player_types::frames::FRAME_CAPABILITY_HOST);
    }

    #[test]
    fn variant_urls_name_exact_asset_variants() {
        let asset = uuid::Uuid::new_v4();
        let variant = uuid::Uuid::new_v4();
        let url = format!("tcmedia://variant/{asset}/{variant}");
        assert_eq!(parse_media_variant_url(&url), Some(MediaVariantRequest { asset_id: asset, variant_id: variant }));
        assert_eq!(
            parse_request_url(&url),
            Some(SchemeRequest::MediaVariant(MediaVariantRequest { asset_id: asset, variant_id: variant }))
        );
        for bad in [
            "tcmedia://variant".to_string(),
            "tcmedia://variant/".to_string(),
            format!("tcmedia://variant/{asset}"),
            format!("tcmedia://variant/{asset}/{variant}/extra"),
            format!("tcmedia://variant/{asset}/{variant}?x=1"),
            format!("tcmedia://variant/{asset}/not-a-uuid"),
            format!("tcmedia://variant/{}/{}", asset.to_string().to_uppercase(), variant),
            "tcmedia://cap/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".to_string(),
        ] {
            assert_eq!(parse_media_variant_url(&bad), None, "{bad}");
        }
    }

    #[test]
    fn only_the_runtime_origin_reads_granted_media() {
        assert!(is_trusted_runtime_source("tilecast://runtime"));
        assert!(is_trusted_runtime_source("tilecast://runtime/index.html"));
        assert!(!is_trusted_runtime_source("tilecast://runtime2/index.html"));
        assert!(!is_trusted_runtime_source("tilecast://other/index.html"));
        assert!(!is_trusted_runtime_source("https://signs.example.org/"));
        assert!(!is_trusted_runtime_source(""));
    }

    #[test]
    fn frame_headers_confine_every_served_document() {
        let headers = frame_response_headers(512);
        assert!(headers.contains("Content-Type: text/html\r\n"), "{headers}");
        assert!(headers.contains("Content-Length: 512\r\n"), "{headers}");
        assert!(headers.contains("Content-Security-Policy: sandbox allow-scripts\r\n"), "{headers}");
        assert!(headers.contains("X-Content-Type-Options: nosniff\r\n"), "{headers}");
        assert!(headers.contains("Accept-Ranges: none\r\n"), "{headers}");
        assert!(headers.contains("Cache-Control: no-store\r\n"), "{headers}");
        // The confinement is the shared cross-player policy, not a local copy.
        assert!(headers.contains(player_types::frames::FRAME_CSP_HEADER));
    }

    #[test]
    fn frame_headers_match_the_shared_contract() {
        let fixture: serde_json::Value =
            serde_json::from_str(include_str!("../../../packages/player-contracts/fixtures/widget-frames.json"))
                .expect("fixture parses");
        let serve = &fixture["serveHeaders"];
        let headers = frame_response_headers(512);
        for (name, value) in [
            ("Content-Type", serve["contentType"].as_str().expect("type")),
            ("Content-Security-Policy", serve["contentSecurityPolicy"].as_str().expect("csp")),
            ("X-Content-Type-Options", serve["xContentTypeOptions"].as_str().expect("nosniff")),
            ("Accept-Ranges", serve["acceptRanges"].as_str().expect("ranges")),
            ("Cache-Control", serve["cacheControl"].as_str().expect("cache")),
        ] {
            assert!(headers.contains(&format!("{name}: {value}\r\n")), "{name} in {headers}");
        }
        assert_eq!(fixture["rangesRefused"], true);
    }

    #[test]
    fn frame_headers_are_byte_exact() {
        // `serve_frame` sends this block verbatim on every 200; pin it
        // exactly so a header reorder or rename fails loudly.
        assert_eq!(
            frame_response_headers(0),
            "Content-Type: text/html\r\nContent-Length: 0\r\nContent-Security-Policy: sandbox allow-scripts\r\nX-Content-Type-Options: nosniff\r\nAccept-Ranges: none\r\nCache-Control: no-store\r\n"
        );
    }
}
