//! Development/CI presentation source: activates a local fixture instead of
//! the status surface when `[dev] fixture` is configured.
//!
//! The fixture is operator configuration, never reachable over IPC. Its
//! media files are imported into the CAS through the verified commit path,
//! pinned, and referenced by content URI, so a fixture exercises exactly the
//! path server-prepared content uses. Fixture format:
//!
//! ```json
//! {
//!   "media": [{"id": "still", "file": "media/still.png", "mimeType": "image/png"}],
//!   "presentation": {"state": "playing", "items": [{"src": "media:still", ...}], ...}
//! }
//! ```
//!
//! Every string `media:<id>` anywhere in `presentation` is replaced with the
//! object's `tcmedia://sha256/<hex>` URI. Media files must live under the
//! fixture's directory.

use std::collections::BTreeMap;
use std::path::{Component, Path, PathBuf};
use std::sync::Arc;

use anyhow::{Context as _, bail};
use edge_cas::IngestMeta;
use edge_protocol::Sha256Digest;
use edge_protocol::bounded::SafeText;
use edge_protocol::ipc::presentation::{ContentRef, PresentationDocument, content_uri};
use edge_state::repo::cas::{Domain, PinReason, SourceKind};
use serde::Deserialize;
use serde_json::Value;

use crate::daemon::DaemonContext;
use crate::presentation::ActivationSource;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FixtureFile {
    media: Vec<FixtureMedia>,
    presentation: Value,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct FixtureMedia {
    id: String,
    file: String,
    mime_type: String,
}

pub const PIN_HOLDER: &str = "dev-fixture";

pub async fn run(context: Arc<DaemonContext>) {
    let Some(path) = context.config.dev.fixture.clone() else {
        return;
    };
    match activate(&context, &path).await {
        Ok(generation) => tracing::info!(component = "fixture", event = "fixture_activated", generation),
        Err(error) => tracing::error!(component = "fixture", event = "fixture_failed", error = error.detail()),
    }
}

/// Why a fixture did not activate. The release self-test reports the stable
/// [`FixtureError::reason`] and a bounded [`FixtureError::detail`], so an
/// operator sees which layer failed instead of a later timeout.
#[derive(Debug)]
pub struct FixtureError {
    reason: &'static str,
    source: anyhow::Error,
}

impl FixtureError {
    /// `content_store_unavailable`, `fixture_invalid`, `fixture_import_failed`
    /// or `fixture_activation_failed`.
    pub fn reason(&self) -> &'static str {
        self.reason
    }

    /// The error chain, one line, at most [`DETAIL_LIMIT`] characters.
    pub fn detail(&self) -> String {
        bounded_detail(&format!("{:#}", self.source))
    }
}

impl std::fmt::Display for FixtureError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}: {:#}", self.reason, self.source)
    }
}

pub const DETAIL_LIMIT: usize = 200;

/// One printable line of at most [`DETAIL_LIMIT`] characters: control
/// characters become spaces, so a diagnostic cannot carry a terminal escape
/// or a second record into persisted state.
pub fn bounded_detail(text: &str) -> String {
    let line: String = text.chars().map(|c| if c.is_control() { ' ' } else { c }).collect();
    line.trim().chars().take(DETAIL_LIMIT).collect()
}

fn invalid(source: impl Into<anyhow::Error>) -> FixtureError {
    FixtureError { reason: "fixture_invalid", source: source.into() }
}

fn import_failed(source: impl Into<anyhow::Error>) -> FixtureError {
    FixtureError { reason: "fixture_import_failed", source: source.into() }
}

fn inside(base: &Path, relative: &str) -> anyhow::Result<PathBuf> {
    let candidate = Path::new(relative);
    if candidate.is_absolute() || candidate.components().any(|c| !matches!(c, Component::Normal(_))) {
        bail!("fixture media path {relative:?} must be a plain relative path");
    }
    Ok(base.join(candidate))
}

fn substitute(value: &mut Value, uris: &BTreeMap<String, String>) -> anyhow::Result<()> {
    match value {
        Value::String(text) => {
            if let Some(id) = text.strip_prefix("media:") {
                let uri = uris.get(id).with_context(|| format!("unknown fixture media {id:?}"))?;
                *text = uri.clone();
            }
        }
        Value::Array(items) => items.iter_mut().try_for_each(|item| substitute(item, uris))?,
        Value::Object(members) => members.values_mut().try_for_each(|item| substitute(item, uris))?,
        _ => {}
    }
    Ok(())
}

/// Imports the fixture's media and activates its presentation.
pub async fn activate(context: &DaemonContext, path: &Path) -> Result<u64, FixtureError> {
    let cas = context.cas.clone().ok_or_else(|| FixtureError {
        reason: "content_store_unavailable",
        source: anyhow::anyhow!("the content store is unavailable"),
    })?;
    let text = tokio::fs::read_to_string(path)
        .await
        .with_context(|| format!("reading {}", path.display()))
        .map_err(invalid)?;
    let mut fixture: FixtureFile = serde_json::from_str(&text).context("parsing fixture").map_err(invalid)?;
    let base = path.parent().context("fixture has no directory").map_err(invalid)?.to_path_buf();

    let mut uris = BTreeMap::new();
    let mut content = Vec::new();
    for media in &fixture.media {
        let file = inside(&base, &media.file).map_err(invalid)?;
        let hashed = file.clone();
        let (digest, size) = tokio::task::spawn_blocking(move || edge_cas::store::hash_file(&hashed))
            .await
            .context("hashing task")
            .map_err(import_failed)?
            .with_context(|| format!("hashing {}", file.display()))
            .map_err(import_failed)?;
        let meta = IngestMeta {
            domain: Domain::Media,
            content_type: Some(media.mime_type.clone()),
            source: SourceKind::Local,
        };
        cas.import_file(&file, digest, size, meta)
            .await
            .with_context(|| format!("importing {}", media.id))
            .map_err(import_failed)?;
        uris.insert(media.id.clone(), content_uri(&digest));
        content.push(ContentRef {
            sha256: digest,
            size_bytes: size,
            mime_type: SafeText::new(media.mime_type.clone()).context("mime type").map_err(invalid)?,
        });
    }
    substitute(&mut fixture.presentation, &uris).map_err(invalid)?;
    let document: PresentationDocument = serde_json::from_value(fixture.presentation)
        .context("fixture presentation does not match the contract")
        .map_err(invalid)?;
    // Pin before activation: the renderer may resolve content immediately.
    let digests: Vec<Sha256Digest> = content.iter().map(|c| c.sha256).collect();
    cas.replace_pins(PinReason::ActivePresentation, PIN_HOLDER, digests)
        .await
        .context("pinning fixture content")
        .map_err(import_failed)?;
    let now = context.now().unix_millis();
    let activation = context
        .presentation
        .lock()
        .await
        .activate(document, content, None, ActivationSource::Fixture, now)
        .context("activating fixture")
        .map_err(|source| FixtureError { reason: "fixture_activation_failed", source })?;
    Ok(activation.generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_detail_is_one_bounded_printable_line() {
        let detail = bounded_detail(&format!("importing still\n\u{1b}[31m{}", "x".repeat(500)));
        assert_eq!(detail.chars().count(), DETAIL_LIMIT);
        assert!(!detail.chars().any(char::is_control));
    }

    #[test]
    fn media_paths_must_stay_inside_the_fixture() {
        let base = Path::new("/fixtures");
        assert!(inside(base, "media/still.png").is_ok());
        assert!(inside(base, "../etc/passwd").is_err());
        assert!(inside(base, "/etc/passwd").is_err());
        assert!(inside(base, "./media/still.png").is_err());
    }
}
