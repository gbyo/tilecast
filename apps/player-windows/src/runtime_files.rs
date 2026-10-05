//! The packaged Runtime artifact allowlist. Hosts serve only files the
//! artifact's own `runtime-manifest.json` lists, at their exact sizes; the
//! manifest also carries SHA-256 hashes, which release tooling verifies.
//!
//! Resolution order (first hit wins): the directory beside the installed
//! executable (`runtime/`), then `TILECAST_RUNTIME_DIR` for development.
//! There is no network fetch and no fallback to another host's copy: the
//! player renders exactly what it shipped with.

use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// Files every Runtime artifact must publish.
const REQUIRED_FILES: &[&str] = &["index.html", "runtime.js"];

#[derive(Debug, Clone)]
pub struct RuntimeFile {
    pub bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone)]
pub struct RuntimeFiles {
    pub directory: PathBuf,
    pub version: String,
    pub files: HashMap<String, RuntimeFile>,
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeError {
    #[error("no packaged runtime found: {0}")]
    Missing(String),
    #[error("the runtime manifest is invalid: {0}")]
    Invalid(String),
}

impl RuntimeFiles {
    /// Loads and validates the allowlist in `directory`.
    pub fn load(directory: &Path) -> Result<Self, RuntimeError> {
        let manifest_path = directory.join("runtime-manifest.json");
        let encoded = std::fs::read(&manifest_path)
            .map_err(|error| RuntimeError::Missing(format!("cannot read {}: {error}", manifest_path.display())))?;
        if encoded.len() > 1 << 20 {
            return Err(RuntimeError::Invalid("manifest is too large".into()));
        }
        let manifest: serde_json::Value = serde_json::from_slice(&encoded)
            .map_err(|error| RuntimeError::Invalid(format!("manifest is not JSON: {error}")))?;
        let version = manifest.get("version").and_then(serde_json::Value::as_str).unwrap_or("unknown").to_owned();
        let entries = manifest
            .get("files")
            .and_then(serde_json::Value::as_array)
            .ok_or_else(|| RuntimeError::Invalid("manifest has no files array".into()))?;
        if entries.len() > 1024 {
            return Err(RuntimeError::Invalid("manifest lists too many files".into()));
        }
        let mut files = HashMap::new();
        for entry in entries {
            let path = entry.get("path").and_then(serde_json::Value::as_str).unwrap_or_default();
            let bytes = entry.get("bytes").and_then(serde_json::Value::as_u64).unwrap_or(u64::MAX);
            let sha256 = entry.get("sha256").and_then(serde_json::Value::as_str).unwrap_or_default();
            // Only paths the scheme grammar accepts can ever be served; the
            // manifest must not widen that.
            let url = format!("{}://{}/{}", crate::schemes::RUNTIME_SCHEME, crate::schemes::RUNTIME_HOST, path);
            if crate::schemes::parse_runtime_url(&url).is_none() || bytes > 64 << 20 || sha256.len() != 64 {
                continue;
            }
            files.insert(path.to_owned(), RuntimeFile { bytes, sha256: sha256.to_owned() });
        }
        for required in REQUIRED_FILES {
            if !files.contains_key(*required) {
                return Err(RuntimeError::Invalid(format!("manifest is missing {required}")));
            }
        }
        let loaded = Self { directory: directory.to_owned(), version, files };
        loaded.verify()?;
        Ok(loaded)
    }

    /// Verifies every manifested file's size and SHA-256. The artifact is
    /// immutable; a mismatch is tampering or corruption, and the player
    /// refuses to render it.
    pub fn verify(&self) -> Result<(), RuntimeError> {
        for (path, expected) in &self.files {
            let mut file = self.directory.clone();
            for segment in path.split('/') {
                file.push(segment);
            }
            if !file.starts_with(&self.directory) {
                return Err(RuntimeError::Invalid(format!("manifest escapes its directory: {path}")));
            }
            let body = std::fs::read(&file)
                .map_err(|_| RuntimeError::Invalid(format!("manifested file is missing: {path}")))?;
            if body.len() as u64 != expected.bytes {
                return Err(RuntimeError::Invalid(format!("size mismatch: {path}")));
            }
            let digest = ring::digest::digest(&ring::digest::SHA256, &body);
            let actual: String = digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect();
            if actual != expected.sha256 {
                return Err(RuntimeError::Invalid(format!("hash mismatch: {path}")));
            }
        }
        Ok(())
    }

    /// The expected entry for a validated request path, if the manifest
    /// publishes it.
    pub fn entry(&self, path: &str) -> Option<&RuntimeFile> {
        self.files.get(path)
    }

    /// Reads a validated request path, refusing anything that does not
    /// match the manifest exactly. The grammar already excludes traversal;
    /// the prefix check below is belt and braces.
    pub fn read(&self, path: &str) -> Option<Vec<u8>> {
        let expected = self.entry(path)?;
        let mut file = self.directory.clone();
        for segment in path.split('/') {
            file.push(segment);
        }
        if !file.starts_with(&self.directory) {
            return None;
        }
        let body = std::fs::read(&file).ok()?;
        if body.len() as u64 != expected.bytes {
            return None;
        }
        Some(body)
    }
}

/// The packaged runtime directory: beside the executable, or
/// `TILECAST_RUNTIME_DIR` for development.
pub fn runtime_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("TILECAST_RUNTIME_DIR").map(PathBuf::from)
        && dir.join("runtime-manifest.json").is_file()
    {
        return Some(dir);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?.join("runtime");
    dir.join("runtime-manifest.json").is_file().then_some(dir)
}

pub fn mime_type(path: &str) -> &'static str {
    match path.rsplit_once('.').map(|(_, extension)| extension) {
        Some("html") => "text/html; charset=utf-8",
        Some("js") => "text/javascript; charset=utf-8",
        Some("css") => "text/css; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("woff2") => "font/woff2",
        Some("txt") => "text/plain; charset=utf-8",
        Some("json") => "application/json",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn artifact(dir: &Path, extra: &str) {
        let index = b"<html></html>";
        let runtime = b"console.log(1);";
        std::fs::write(dir.join("index.html"), index).expect("test fixture");
        std::fs::write(dir.join("runtime.js"), runtime).expect("test fixture");
        let sha = |bytes: &[u8]| sha256_hex(bytes);
        let manifest = serde_json::json!({
            "name": "@tilecast/player-runtime",
            "version": "0.1.0",
            "contractVersion": 1,
            "files": [
                {"path": "index.html", "bytes": index.len(), "sha256": sha(index)},
                {"path": "runtime.js", "bytes": runtime.len(), "sha256": sha(runtime)},
                serde_json::from_str::<serde_json::Value>(extra).expect("test fixture"),
            ],
        });
        std::fs::write(dir.join("runtime-manifest.json"), serde_json::to_vec(&manifest).expect("test fixture"))
            .expect("test fixture");
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        let digest = ring::digest::digest(&ring::digest::SHA256, bytes);
        digest.as_ref().iter().map(|byte| format!("{byte:02x}")).collect()
    }

    #[test]
    fn only_manifested_files_at_manifested_sizes_are_served() {
        let dir = tempfile::tempdir().expect("test fixture");
        artifact(dir.path(), r#"{"path": "extra.txt", "bytes": 5, "sha256": "00"}"#);
        let runtime = RuntimeFiles::load(dir.path()).expect("loads");
        assert_eq!(runtime.version, "0.1.0");
        assert_eq!(runtime.read("index.html").expect("test fixture"), b"<html></html>");
        // Not in the manifest: never served.
        assert!(runtime.read("extra.txt").is_none());
        // In the manifest but the wrong size on disk: never served.
        std::fs::write(dir.path().join("runtime.js"), b"tampered with extra bytes").expect("test fixture");
        assert!(runtime.read("runtime.js").is_none());
        // Same-size tampering is caught at load: the hash does not match.
        std::fs::write(dir.path().join("runtime.js"), b"console.log(2);").expect("test fixture");
        assert!(matches!(RuntimeFiles::load(dir.path()), Err(RuntimeError::Invalid(_))));
    }

    #[test]
    fn incomplete_artifacts_are_rejected() {
        let dir = tempfile::tempdir().expect("test fixture");
        assert!(matches!(RuntimeFiles::load(dir.path()), Err(RuntimeError::Missing(_))));
        artifact(dir.path(), r#"{"path": "../state.db", "bytes": 1, "sha256": "ab"}"#);
        // The traversal entry is skipped, the required files still load.
        assert!(RuntimeFiles::load(dir.path()).is_ok());
        let manifest = serde_json::json!({"version": "0.1.0", "files": []});
        std::fs::write(dir.path().join("runtime-manifest.json"), serde_json::to_vec(&manifest).expect("test fixture"))
            .expect("test fixture");
        assert!(matches!(RuntimeFiles::load(dir.path()), Err(RuntimeError::Invalid(_))));
    }

    #[test]
    fn mime_types_match_the_reference_hosts() {
        assert_eq!(mime_type("index.html"), "text/html; charset=utf-8");
        assert_eq!(mime_type("assets/app.js"), "text/javascript; charset=utf-8");
        assert_eq!(mime_type("runtime.css"), "text/css; charset=utf-8");
        assert_eq!(mime_type("logo.svg"), "image/svg+xml");
        assert_eq!(mime_type("font.woff2"), "font/woff2");
        assert_eq!(mime_type("nope.bin"), "application/octet-stream");
    }
}
