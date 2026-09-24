//! The prepared presentation a renderer is asked to show.
//!
//! This is the renderer contract of the shared trusted web runtime (today the
//! DOM runtime in `apps/player-linux/src/renderer`, loaded unmodified by the
//! WPE host). Field names and meanings match that runtime's
//! `RendererPresentation`/`RendererItem`, so behavior established by the
//! reference implementation carries over exactly.
//!
//! # Media references
//!
//! Every media reference anywhere in a presentation (item `src`, layout zone
//! images, render-tree image nodes, plugin assets) is a **content URI**:
//!
//! ```text
//! tcmedia://sha256/<64 lowercase hex>
//! ```
//!
//! and every digest used must be listed in the activation's `content`.
//! [`validate_content_references`] enforces both. Renderer hosts implement the
//! `tcmedia` scheme by resolving the digest in the daemon's content store;
//! they never accept a path. The legacy `tcmedia://variant/<asset>/<variant>`
//! form is not valid on this protocol.
//!
//! The daemon only activates a presentation whose content objects are all
//! verified and pinned in the CAS, so a renderer never sees partial bytes.
//!
//! Nested render payloads (`widget`, `layout`, `viewport`, `website`) are
//! carried as bounded JSON whose schema is owned by the web runtime's render
//! tree (`apps/player-linux/src/core/render-tree.ts`). The daemon validates
//! their media references and size, not their inner structure.

use serde::{Deserialize, Serialize};

use crate::bounded::{SafeText, ShortToken};
use crate::digest::Sha256Digest;

pub const CONTENT_URI_PREFIX: &str = "tcmedia://sha256/";
pub const MAX_ITEMS: usize = 500;
pub const MAX_CONTENT_REFS: usize = 1024;

/// Builds the content URI for a digest.
pub fn content_uri(digest: &Sha256Digest) -> String {
    format!("{CONTENT_URI_PREFIX}{}", digest.to_hex())
}

/// Parses a content URI. Returns `None` for anything that is not exactly
/// `tcmedia://sha256/<digest>`.
pub fn parse_content_uri(value: &str) -> Option<Sha256Digest> {
    value.strip_prefix(CONTENT_URI_PREFIX).and_then(|hex| Sha256Digest::parse(hex).ok())
}

/// One immutable object a presentation uses.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ContentRef {
    pub sha256: Sha256Digest,
    pub size_bytes: u64,
    pub mime_type: SafeText<127>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ItemKind {
    Image,
    Video,
    Website,
    Widget,
    Layout,
    Youtube,
}

/// A playlist item, mirroring the web runtime's `RendererItem`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PresentationItem {
    pub id: SafeText<160>,
    pub kind: ItemKind,
    pub src: SafeText<2048>,
    pub duration_ms: Option<u64>,
    pub fit_mode: ShortToken,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<ShortToken>,
    pub audio_enabled: bool,
    pub volume: f64,
    pub video_start_offset_ms: Option<u64>,
    pub video_end_offset_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget: Option<serde_json::Value>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<serde_json::Value>,
}

/// Fields shared by the idle, disabled and unavailable status surfaces.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StatusSurface {
    pub title: SafeText<120>,
    pub message: SafeText<480>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub background_color: Option<SafeText<32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub text_color: Option<SafeText<32>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub logo_src: Option<SafeText<128>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub footer_text: Option<SafeText<240>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub status: Option<SafeText<120>>,
}

/// The presentation union, tagged by `state` exactly like the web runtime.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "state", rename_all = "kebab-case", deny_unknown_fields)]
pub enum PresentationDocument {
    /// No server configured yet; the runtime shows its setup surface.
    Setup {},
    Pairing {
        code: SafeText<16>,
        #[serde(rename = "approvalUrl")]
        approval_url: SafeText<512>,
        #[serde(rename = "organizationName", default, skip_serializing_if = "Option::is_none")]
        organization_name: Option<SafeText<120>>,
    },
    Idle(StatusSurface),
    Disabled(StatusSurface),
    Unavailable(StatusSurface),
    SafeMode {
        reason: SafeText<240>,
    },
    Sleep {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        display: Option<ShortToken>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        text: Option<SafeText<240>>,
        #[serde(rename = "textColor", default, skip_serializing_if = "Option::is_none")]
        text_color: Option<SafeText<32>>,
    },
    Playing {
        items: Vec<PresentationItem>,
        takeover: bool,
        generation: u64,
        /// True when the daemon's synchronized timeline owns occurrence
        /// changes; the renderer then never advances the playlist itself and
        /// follows `sync.position`.
        #[serde(default)]
        synchronized: bool,
    },
}

impl PresentationDocument {
    pub fn state_name(&self) -> &'static str {
        match self {
            Self::Setup {} => "setup",
            Self::Pairing { .. } => "pairing",
            Self::Idle(_) => "idle",
            Self::Disabled(_) => "disabled",
            Self::Unavailable(_) => "unavailable",
            Self::SafeMode { .. } => "safe-mode",
            Self::Sleep { .. } => "sleep",
            Self::Playing { .. } => "playing",
        }
    }

    /// Renderer features this presentation needs, in the vocabulary a
    /// renderer advertises in `renderer.ready`. The daemon activates only
    /// presentations whose requirements the connected renderer advertises;
    /// otherwise the screen reports the presentation as incompatible instead
    /// of silently dropping content (docs/tilecast-edge.md §10.4).
    pub fn required_features(&self) -> Vec<&'static str> {
        let mut features = vec!["status-surfaces-v1"];
        if let Self::Playing { items, synchronized, .. } = self {
            for item in items {
                let feature = match item.kind {
                    ItemKind::Image => "image",
                    ItemKind::Video => "video",
                    ItemKind::Website => "website",
                    ItemKind::Widget => "render-tree-v1",
                    ItemKind::Layout => "layout-v1",
                    ItemKind::Youtube => "youtube",
                };
                if !features.contains(&feature) {
                    features.push(feature);
                }
            }
            if *synchronized && !features.contains(&"synchronized-playback-v1") {
                features.push("synchronized-playback-v1");
            }
            if items.iter().any(|item| item.viewport.is_some()) {
                features.push("span-viewport-v1");
            }
        }
        features
    }
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PresentationError {
    #[error("presentation has too many items")]
    TooManyItems,
    #[error("presentation lists too many content objects")]
    TooManyContentRefs,
    #[error("malformed content URI: {0}")]
    MalformedContentUri(String),
    #[error("content {0} is referenced but not listed")]
    UnlistedContent(String),
    #[error("non-finite or out-of-range volume")]
    InvalidVolume,
}

/// Checks that every `tcmedia:` reference in `value` is a valid content URI
/// listed in `content`, and that item fields are within range.
pub fn validate_content_references(
    document: &PresentationDocument,
    content: &[ContentRef],
) -> Result<(), PresentationError> {
    if content.len() > MAX_CONTENT_REFS {
        return Err(PresentationError::TooManyContentRefs);
    }
    if let PresentationDocument::Playing { items, .. } = document {
        if items.len() > MAX_ITEMS {
            return Err(PresentationError::TooManyItems);
        }
        for item in items {
            if !item.volume.is_finite() || !(0.0..=1.0).contains(&item.volume) {
                return Err(PresentationError::InvalidVolume);
            }
        }
    }
    let value = serde_json::to_value(document).unwrap_or_default();
    validate_value(&value, content)
}

/// The same check for any bounded JSON payload (for example plugin state).
pub fn validate_value(value: &serde_json::Value, content: &[ContentRef]) -> Result<(), PresentationError> {
    match value {
        serde_json::Value::String(text) => {
            if text.to_ascii_lowercase().starts_with("tcmedia:") {
                let digest =
                    parse_content_uri(text).ok_or_else(|| PresentationError::MalformedContentUri(truncate(text)))?;
                if !content.iter().any(|item| item.sha256 == digest) {
                    return Err(PresentationError::UnlistedContent(digest.short()));
                }
            }
            Ok(())
        }
        serde_json::Value::Array(items) => items.iter().try_for_each(|item| validate_value(item, content)),
        serde_json::Value::Object(members) => members.values().try_for_each(|item| validate_value(item, content)),
        _ => Ok(()),
    }
}

fn truncate(value: &str) -> String {
    value.chars().take(48).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const HEX: &str = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

    fn item(src: &str) -> serde_json::Value {
        json!({
            "id": "item-1", "kind": "image", "src": src, "durationMs": 10000,
            "fitMode": "contain", "audioEnabled": false, "volume": 1.0,
            "videoStartOffsetMs": null, "videoEndOffsetMs": null
        })
    }

    fn content() -> Vec<ContentRef> {
        vec![ContentRef {
            sha256: Sha256Digest::parse(HEX).expect("digest"),
            size_bytes: 0,
            mime_type: SafeText::new("image/png").expect("mime"),
        }]
    }

    #[test]
    fn decodes_web_runtime_shapes() {
        let idle: PresentationDocument = serde_json::from_value(json!({
            "state": "idle", "title": "Tilecast", "message": "No content assigned."
        }))
        .expect("idle");
        assert_eq!(idle.state_name(), "idle");
        let playing: PresentationDocument = serde_json::from_value(json!({
            "state": "playing", "items": [item(&format!("tcmedia://sha256/{HEX}"))],
            "takeover": false, "generation": 3
        }))
        .expect("playing");
        assert_eq!(playing.required_features(), vec!["status-surfaces-v1", "image"]);
        validate_content_references(&playing, &content()).expect("references valid");
        assert!(serde_json::from_value::<PresentationDocument>(json!({"state": "hologram"})).is_err());
        assert!(
            serde_json::from_value::<PresentationDocument>(json!({"state": "safe-mode", "reason": "x", "more": 1}))
                .is_err()
        );
    }

    #[test]
    fn rejects_unlisted_legacy_and_nested_references() {
        let doc = |src: &str| -> PresentationDocument {
            serde_json::from_value(json!({
                "state": "playing", "items": [item(src)], "takeover": false, "generation": 1
            }))
            .expect("doc")
        };
        assert!(matches!(
            validate_content_references(&doc("tcmedia://variant/a/b"), &content()),
            Err(PresentationError::MalformedContentUri(_))
        ));
        let other = "a".repeat(64);
        assert!(matches!(
            validate_content_references(&doc(&format!("tcmedia://sha256/{other}")), &content()),
            Err(PresentationError::UnlistedContent(_))
        ));
        let mut nested = item("https://example.org");
        nested["kind"] = json!("layout");
        nested["layout"] = json!({"zones": [{"image": {"src": "TCMEDIA://sha256/../../etc"}}]});
        let doc: PresentationDocument = serde_json::from_value(json!({
            "state": "playing", "items": [nested], "takeover": false, "generation": 1
        }))
        .expect("doc");
        assert!(validate_content_references(&doc, &content()).is_err());
    }
}
