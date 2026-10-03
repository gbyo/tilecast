//! Prepared Runtime data with semantic verified-object references.
use crate::renderer_resources::{MAX_RUNTIME_PAYLOAD_BYTES, Resource, RuntimePayload};
use player_types::{
    Sha256Digest,
    bounded::{SafeText, ShortToken},
};
use serde::{Deserialize, Serialize};
pub const MAX_ITEMS: usize = 500;
pub const MAX_CONTENT_REFS: usize = 1024;

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
    pub src: Resource,
    pub duration_ms: Option<u64>,
    pub fit_mode: ShortToken,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub transition: Option<ShortToken>,
    pub audio_enabled: bool,
    pub volume: f64,
    pub video_start_offset_ms: Option<u64>,
    pub video_end_offset_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub viewport: Option<RuntimePayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub website: Option<RuntimePayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub widget: Option<RuntimePayload>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub layout: Option<RuntimePayload>,
}

/// Renderer features a presentation needs beyond what its item kinds say.
///
/// The daemon's projection knows what a presentation needs (a Widget item
/// whose server-compiled presentation is `kind: "web"`, a Layout with a web
/// Widget placement) and records it here, so the renderer never infers it
/// from provider names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PresentationFeature {
    RemoteWebV1,
    Website,
    Youtube,
    SpanViewportV1,
}

impl PresentationFeature {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RemoteWebV1 => "remote-web-v1",
            Self::Website => "website",
            Self::Youtube => "youtube",
            Self::SpanViewportV1 => "span-viewport-v1",
        }
    }
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
    pub logo_src: Option<Resource>,
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
        /// Explicit requirements from the projection; see
        /// [`PresentationFeature`]. At most one of each.
        #[serde(default, skip_serializing_if = "Vec::is_empty", deserialize_with = "features")]
        requires: Vec<PresentationFeature>,
    },
}

fn features<'de, D: serde::Deserializer<'de>>(d: D) -> Result<Vec<PresentationFeature>, D::Error> {
    let list = Vec::<PresentationFeature>::deserialize(d)?;
    if list.len() > 8 {
        return Err(serde::de::Error::custom("too many presentation features"));
    }
    Ok(list)
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum PreparedDocumentError {
    #[error("prepared presentation exceeds its bound")]
    TooLarge,
    #[error("prepared presentation has invalid volume")]
    InvalidVolume,
    #[error("prepared presentation references an unlisted object")]
    UnlistedObject,
}

impl PresentationDocument {
    /// Check bounds and object membership before a host authorizes a generation.
    pub fn validate(&self, content: &[ContentRef]) -> Result<(), PreparedDocumentError> {
        if content.len() > MAX_CONTENT_REFS
            || serde_json::to_vec(self).map_or(true, |bytes| bytes.len() > MAX_RUNTIME_PAYLOAD_BYTES)
        {
            return Err(PreparedDocumentError::TooLarge);
        }
        let listed = |object: Sha256Digest| {
            if content.iter().any(|reference| reference.sha256 == object) {
                Ok(())
            } else {
                Err(PreparedDocumentError::UnlistedObject)
            }
        };
        let resource = |reference: &Resource| match reference {
            Resource::Object { object } => listed(*object),
            Resource::External(_) => Ok(()),
        };
        match self {
            Self::Playing { items, requires, .. } => {
                if items.len() > MAX_ITEMS || requires.len() > 8 {
                    return Err(PreparedDocumentError::TooLarge);
                }
                for item in items {
                    if !item.volume.is_finite() || !(0.0..=1.0).contains(&item.volume) {
                        return Err(PreparedDocumentError::InvalidVolume);
                    }
                    resource(&item.src)?;
                    for payload in [&item.viewport, &item.website, &item.widget, &item.layout].into_iter().flatten() {
                        for binding in payload.bindings() {
                            listed(binding.object)?;
                        }
                    }
                }
            }
            Self::Idle(surface) | Self::Disabled(surface) | Self::Unavailable(surface) => {
                if let Some(logo) = &surface.logo_src {
                    resource(logo)?;
                }
            }
            _ => {}
        }
        Ok(())
    }

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

    /// Semantic Runtime features needed before activation.
    pub fn required_features(&self) -> Vec<&'static str> {
        let mut features = vec!["status-surfaces-v1"];
        if let Self::Playing { items, synchronized, requires, .. } = self {
            let mut add = |feature: &'static str| {
                if !features.contains(&feature) {
                    features.push(feature);
                }
            };
            for item in items {
                match item.kind {
                    ItemKind::Image => add("image"),
                    ItemKind::Video => add("video"),
                    ItemKind::Website => {
                        add("website");
                        add("remote-web-v1");
                    }
                    ItemKind::Widget => add("render-tree-v1"),
                    ItemKind::Layout => add("layout-v1"),
                    ItemKind::Youtube => {
                        add("youtube");
                        add("remote-web-v1");
                    }
                }
            }
            for feature in requires {
                add(feature.as_str());
            }
            if *synchronized {
                add("synchronized-playback-v1");
            }
            if items.iter().any(|item| item.viewport.is_some()) {
                add("span-viewport-v1");
            }
        }
        features
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::renderer_resources::ObjectBinding;
    use serde_json::json;

    fn item() -> PresentationItem {
        PresentationItem {
            id: SafeText::new("image").unwrap(),
            kind: ItemKind::Image,
            src: Resource::Object { object: Sha256Digest::of(b"verified") },
            duration_ms: Some(10_000),
            fit_mode: ShortToken::new("contain").unwrap(),
            transition: None,
            audio_enabled: false,
            volume: 1.0,
            video_start_offset_ms: None,
            video_end_offset_ms: None,
            viewport: None,
            website: None,
            widget: None,
            layout: None,
        }
    }

    fn document(item: PresentationItem) -> PresentationDocument {
        PresentationDocument::Playing {
            items: vec![item],
            takeover: false,
            generation: 1,
            synchronized: false,
            requires: vec![],
        }
    }

    fn content() -> Vec<ContentRef> {
        vec![ContentRef {
            sha256: Sha256Digest::of(b"verified"),
            size_bytes: 8,
            mime_type: SafeText::new("image/png").unwrap(),
        }]
    }

    #[test]
    fn every_direct_and_nested_object_must_be_listed() {
        assert_eq!(document(item()).validate(&[]), Err(PreparedDocumentError::UnlistedObject));
        assert_eq!(document(item()).validate(&content()), Ok(()));
        let mut nested = item();
        nested.widget = Some(
            RuntimePayload::new(
                json!({"image": ""}),
                vec![ObjectBinding { pointer: SafeText::new("/image").unwrap(), object: Sha256Digest::of(b"other") }],
            )
            .unwrap(),
        );
        assert_eq!(document(nested).validate(&content()), Err(PreparedDocumentError::UnlistedObject));
    }

    #[test]
    fn invalid_volume_and_oversized_lists_are_refused() {
        let mut invalid = item();
        invalid.volume = 1.1;
        assert_eq!(document(invalid).validate(&content()), Err(PreparedDocumentError::InvalidVolume));
        let oversized = PresentationDocument::Playing {
            items: vec![item(); MAX_ITEMS + 1],
            takeover: false,
            generation: 1,
            synchronized: false,
            requires: vec![],
        };
        assert_eq!(oversized.validate(&content()), Err(PreparedDocumentError::TooLarge));
    }
}
