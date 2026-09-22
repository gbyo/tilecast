//! The Tilecast Server as a CAS source (the origin behind the peer CDN).
//!
//! Resume semantics are the Linux player's (`core/download.ts`): resume with
//! `Range` guarded by `If-Range: <strong validator>`; a `200` answer to a
//! range request restarts from zero; `401/403` and `404/410` are final for
//! this source; everything else is transient. The store verifies every byte.

use async_trait::async_trait;
use edge_cas::{BlobSource, SourceError, SourceKind, SourceStream};
use edge_protocol::Sha256Digest;
use futures_util::StreamExt as _;

use crate::client::AuthenticatedServer;

/// One object at an authenticated player download path, such as a manifest
/// asset variant (`/api/v1/player/assets/<asset>/variants/<variant>`).
#[derive(Debug, Clone)]
pub struct OriginBlobSource {
    server: AuthenticatedServer,
    path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("download path must be a plain /api/v1/player/ path")]
pub struct InvalidDownloadPath;

impl OriginBlobSource {
    /// `path` comes from a server manifest; it must stay inside the player
    /// API and carry no query, fragment or dot segments.
    pub fn new(server: AuthenticatedServer, path: &str) -> Result<Self, InvalidDownloadPath> {
        let plain = path.starts_with("/api/v1/player/")
            && path.len() <= 512
            && !path.split('/').any(|segment| segment == "." || segment == "..")
            && path.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '-' | '_' | '.'));
        if !plain {
            return Err(InvalidDownloadPath);
        }
        Ok(Self { server, path: path.to_owned() })
    }
}

/// The server's media ETag for a variant (`media.ETag`).
fn validator(digest: &Sha256Digest) -> String {
    format!("\"sha256-{}\"", digest.to_hex())
}

fn content_range_start(value: &str) -> Option<u64> {
    value.strip_prefix("bytes ")?.split('-').next()?.parse().ok()
}

#[async_trait]
impl BlobSource for OriginBlobSource {
    fn kind(&self) -> SourceKind {
        SourceKind::Origin
    }

    fn label(&self) -> String {
        "origin".into()
    }

    async fn open(&self, digest: &Sha256Digest, size: u64, offset: u64) -> Result<SourceStream, SourceError> {
        let tag = validator(digest);
        let response = self
            .server
            .get_range(&self.path, offset, Some(&tag))
            .await
            .map_err(|e| SourceError::Retryable(e.reason_code().into()))?;
        let status = response.status().as_u16();
        let start = match status {
            200 => 0,
            206 => {
                let start = response
                    .headers()
                    .get(reqwest::header::CONTENT_RANGE)
                    .and_then(|v| v.to_str().ok())
                    .and_then(content_range_start)
                    .ok_or_else(|| SourceError::Fatal("206 without a usable Content-Range".into()))?;
                if start != offset {
                    return Err(SourceError::Fatal("range started at the wrong offset".into()));
                }
                start
            }
            401 | 403 => return Err(SourceError::Unauthorized),
            404 | 410 => return Err(SourceError::NotFound),
            _ => return Err(SourceError::Retryable(format!("http_{status}"))),
        };
        let total = if status == 200 { response.content_length() } else { Some(size) };
        let body = response.bytes_stream().map(|chunk| chunk.map_err(|_| SourceError::Retryable("read failed".into())));
        Ok(SourceStream { start, total_length: total, body: body.boxed() })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_range_parsing() {
        assert_eq!(content_range_start("bytes 100-199/200"), Some(100));
        assert_eq!(content_range_start("items 1-2/3"), None);
    }
}
