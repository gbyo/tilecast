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
        Err(error) => tracing::error!(component = "fixture", event = "fixture_failed", error = format!("{error:#}")),
    }
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

async fn activate(context: &DaemonContext, path: &Path) -> anyhow::Result<u64> {
    let cas = context.cas.clone().context("the content store is unavailable")?;
    let text = tokio::fs::read_to_string(path).await.with_context(|| format!("reading {}", path.display()))?;
    let mut fixture: FixtureFile = serde_json::from_str(&text).context("parsing fixture")?;
    let base = path.parent().context("fixture has no directory")?.to_path_buf();

    let mut uris = BTreeMap::new();
    let mut content = Vec::new();
    for media in &fixture.media {
        let file = inside(&base, &media.file)?;
        let hashed = file.clone();
        let (digest, size) = tokio::task::spawn_blocking(move || edge_cas::store::hash_file(&hashed))
            .await
            .context("hashing task")?
            .with_context(|| format!("hashing {}", file.display()))?;
        let meta = IngestMeta {
            domain: Domain::Media,
            content_type: Some(media.mime_type.clone()),
            peerable: false,
            source: SourceKind::Local,
        };
        cas.import_file(&file, digest, size, meta).await.with_context(|| format!("importing {}", media.id))?;
        uris.insert(media.id.clone(), content_uri(&digest));
        content.push(ContentRef {
            sha256: digest,
            size_bytes: size,
            mime_type: SafeText::new(media.mime_type.clone()).context("mime type")?,
        });
    }
    substitute(&mut fixture.presentation, &uris)?;
    let document: PresentationDocument =
        serde_json::from_value(fixture.presentation).context("fixture presentation does not match the contract")?;
    // Pin before activation: the renderer may resolve content immediately.
    let digests: Vec<Sha256Digest> = content.iter().map(|c| c.sha256).collect();
    cas.replace_pins(PinReason::ActivePresentation, PIN_HOLDER, digests).await?;
    let now = context.now().unix_millis();
    let activation = context
        .presentation
        .lock()
        .await
        .activate(document, content, None, ActivationSource::Fixture, now)
        .context("activating fixture")?;
    Ok(activation.generation)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn media_paths_must_stay_inside_the_fixture() {
        let base = Path::new("/fixtures");
        assert!(inside(base, "media/still.png").is_ok());
        assert!(inside(base, "../etc/passwd").is_err());
        assert!(inside(base, "/etc/passwd").is_err());
        assert!(inside(base, "./media/still.png").is_err());
    }
}
