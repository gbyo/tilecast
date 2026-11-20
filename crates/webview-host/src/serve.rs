//! Answers for the trusted Runtime's custom-scheme requests, shared by the
//! platform WebView resource handlers. A platform hands over the request
//! URL, method, `Range` header, and whether the requesting document is the
//! trusted top-level Runtime; it gets back a status, headers, and a body
//! description it streams with its own API.
//!
//! The policy lives here once: only manifested Runtime files, only granted
//! verified CAS objects for the current renderer session, exact sizes,
//! single-range `206`/`416` semantics for `<video>`, `HEAD` without a
//! body, Runtime-origin CORS for font loads, confined frame documents, and
//! one indistinguishable `404` for every refusal.

use std::sync::Mutex;

use crate::media::{MediaGrant, MediaGrantKind, MediaRegistry};
use crate::ranges::RangeOutcome;
use crate::schemes::SchemeRequest;

/// One resource request, as the platform received it.
#[derive(Debug, Clone, Copy)]
pub struct Request<'a> {
    pub url: &'a str,
    pub method: &'a str,
    /// The `Range` header value, if any.
    pub range: Option<&'a str>,
    /// Whether the requesting document is the trusted top-level Runtime
    /// document. Granted media and frames are served only to it.
    pub from_runtime: bool,
}

/// What the response body is. A platform streams `File` from `offset` for
/// exactly `len` bytes and never reads past it.
#[derive(Debug)]
pub enum Body {
    Empty,
    Bytes(Vec<u8>),
    File { file: std::fs::File, offset: u64, len: u64 },
}

impl Body {
    /// The number of bytes the body carries.
    pub fn len(&self) -> u64 {
        match self {
            Self::Empty => 0,
            Self::Bytes(bytes) => bytes.len() as u64,
            Self::File { len, .. } => *len,
        }
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub reason: &'static str,
    /// Header names and values, in order. `Content-Length` always names
    /// the full selected representation, also for `HEAD`.
    pub headers: Vec<(&'static str, String)>,
    pub body: Body,
}

impl Response {
    /// The one answer for every refusal: the renderer learns nothing about
    /// what exists.
    pub fn not_found() -> Self {
        Self {
            status: 404,
            reason: "Not Found",
            headers: vec![
                ("Content-Type", "text/plain".to_owned()),
                ("Content-Length", "9".to_owned()),
                ("Cache-Control", "no-store".to_owned()),
            ],
            body: Body::Bytes(b"not found".to_vec()),
        }
    }

    fn method_not_allowed() -> Self {
        Self {
            status: 405,
            reason: "Method Not Allowed",
            headers: vec![
                ("Content-Type", "text/plain".to_owned()),
                ("Content-Length", "18".to_owned()),
                ("Cache-Control", "no-store".to_owned()),
            ],
            body: Body::Bytes(b"method not allowed".to_vec()),
        }
    }

    fn unsatisfiable(size_bytes: u64) -> Self {
        Self {
            status: 416,
            reason: "Range Not Satisfiable",
            headers: vec![("Content-Range", format!("bytes */{size_bytes}")), ("Cache-Control", "no-store".to_owned())],
            body: Body::Empty,
        }
    }

    /// The value of the first header named `name`, ignoring case.
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(key, _)| key.eq_ignore_ascii_case(name)).map(|(_, value)| value.as_str())
    }

    /// The headers as one CRLF-terminated block (WebView2's form).
    pub fn header_block(&self) -> String {
        self.headers.iter().map(|(name, value)| format!("{name}: {value}\r\n")).collect()
    }
}

/// What a request may read: the packaged Runtime, the media registry, the
/// verified store, and the live renderer session grants are bound to.
#[derive(Debug, Clone, Copy)]
pub struct Resources<'a> {
    pub runtime: &'a crate::runtime_files::RuntimeFiles,
    pub media: &'a Mutex<MediaRegistry>,
    pub cas: &'a player_cas::ContentStore,
    pub session: uuid::Uuid,
}

/// Answers one custom-scheme request. CAS opens are bounded metadata work
/// plus a no-follow open; the body is a file range the platform streams.
pub async fn answer(resources: Resources<'_>, request: Request<'_>, now_ms: i64) -> Response {
    if request.method != "GET" && request.method != "HEAD" {
        return Response::method_not_allowed();
    }
    let head_only = request.method == "HEAD";
    let parsed = crate::schemes::parse_request_url(request.url);
    // Everything but the Runtime's own files needs the trusted document.
    if !matches!(parsed, Some(SchemeRequest::Runtime(_)) | None) && !request.from_runtime {
        return Response::not_found();
    }
    let lock = || resources.media.lock().unwrap_or_else(|poison| poison.into_inner());
    match parsed {
        Some(SchemeRequest::Runtime(file)) => runtime_file(resources.runtime, &file.path, head_only),
        Some(SchemeRequest::Media(media)) => {
            let grant = lock().resolve(resources.session, &media.capability, now_ms).cloned();
            serve_grant(resources.cas, grant, request.range, head_only).await
        }
        Some(SchemeRequest::MediaVariant(variant)) => {
            let grant = lock().resolve_variant(resources.session, variant.asset_id, variant.variant_id, now_ms);
            serve_grant(resources.cas, grant, request.range, head_only).await
        }
        Some(SchemeRequest::Widget(widget)) => {
            // Media capabilities presented here resolve to nothing: grant
            // usage is pinned at mint time.
            let grant = lock().resolve_frame(resources.session, &widget.capability, now_ms).cloned();
            serve_frame(resources.cas, grant, request.range, head_only).await
        }
        None => Response::not_found(),
    }
}

fn runtime_file(runtime: &crate::runtime_files::RuntimeFiles, path: &str, head_only: bool) -> Response {
    let Some(body) = runtime.read(path) else {
        return Response::not_found();
    };
    Response {
        status: 200,
        reason: "OK",
        headers: vec![
            ("Content-Type", crate::runtime_files::mime_type(path).to_owned()),
            ("Content-Length", body.len().to_string()),
            ("Accept-Ranges", "none".to_owned()),
            ("Cache-Control", "no-store".to_owned()),
        ],
        body: if head_only { Body::Empty } else { Body::Bytes(body) },
    }
}

/// Opens a grant's verified object and checks it is exactly the granted
/// size. Every failure is the same `None`.
async fn open_granted(cas: &player_cas::ContentStore, grant: &MediaGrant) -> Option<std::fs::File> {
    let Ok(Some((file, record))) = cas.open_verified(&grant.sha256).await else {
        return None;
    };
    (record.size_bytes == grant.size_bytes).then_some(file)
}

/// Serves one resolved media grant: capability and variant loads share
/// everything past authorization.
async fn serve_grant(
    cas: &player_cas::ContentStore,
    grant: Option<MediaGrant>,
    range: Option<&str>,
    head_only: bool,
) -> Response {
    let Some(grant) = grant.filter(|grant| grant.kind == MediaGrantKind::Media) else {
        return Response::not_found();
    };
    let Some(file) = open_granted(cas, &grant).await else {
        return Response::not_found();
    };
    let size = grant.size_bytes;
    // Font faces load in CORS mode; only the Runtime document may read
    // media cross-origin. Images and video stay no-cors.
    let mut headers = vec![("Content-Type", grant.mime_type.clone())];
    let (status, reason, offset, len) = match crate::ranges::parse_range(range, size) {
        RangeOutcome::Entire => (200, "OK", 0, size),
        RangeOutcome::Partial(interval) => {
            headers.push(("Content-Range", interval.content_range(size)));
            (206, "Partial Content", interval.start, interval.len())
        }
        RangeOutcome::Unsatisfiable => return Response::unsatisfiable(size),
    };
    headers.extend([
        ("Content-Length", len.to_string()),
        ("Accept-Ranges", "bytes".to_owned()),
        ("Cache-Control", "no-store".to_owned()),
        ("Access-Control-Allow-Origin", crate::schemes::RUNTIME_ORIGIN.to_owned()),
    ]);
    let body = if head_only || len == 0 { Body::Empty } else { Body::File { file, offset, len } };
    Response { status, reason, headers, body }
}

/// Serves one resolved frame grant: whole documents only, confined by the
/// shared frame sandbox policy. Any `Range` answers `416` because a partial
/// frame can never execute.
async fn serve_frame(
    cas: &player_cas::ContentStore,
    grant: Option<MediaGrant>,
    range: Option<&str>,
    head_only: bool,
) -> Response {
    let Some(grant) = grant else {
        return Response::not_found();
    };
    let kind = match grant.kind {
        MediaGrantKind::Frame => player_types::frames::FrameKind::Widget,
        MediaGrantKind::PluginFrame => player_types::frames::FrameKind::ExternalPlugin,
        MediaGrantKind::Media => return Response::not_found(),
    };
    if range.is_some() {
        return Response::unsatisfiable(grant.size_bytes);
    }
    let Some(file) = open_granted(cas, &grant).await else {
        return Response::not_found();
    };
    let headers = crate::schemes::frame_headers(grant.size_bytes, kind);
    let body = if head_only || grant.size_bytes == 0 {
        Body::Empty
    } else {
        Body::File { file, offset: 0, len: grant.size_bytes }
    };
    Response { status: 200, reason: "OK", headers, body }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::media::RendererInstance;
    use player_types::Sha256Digest;
    use player_types::bounded::SafeText;
    use std::io::{Read as _, Seek as _};
    use std::sync::Arc;

    #[derive(Debug)]
    struct Space;
    impl player_cas::space::SpaceProbe for Space {
        fn available_bytes(&self, _path: &std::path::Path) -> std::io::Result<u64> {
            Ok(u64::MAX / 4)
        }
    }

    #[derive(Debug)]
    struct Opener;
    impl player_cas::SecureOpener for Opener {
        fn open_regular(&self, path: &std::path::Path, max_bytes: u64) -> std::io::Result<player_cas::RegularOpen> {
            match std::fs::File::open(path) {
                Ok(file) => {
                    let len = file.metadata()?.len();
                    if len > max_bytes {
                        return Ok(player_cas::RegularOpen::Refused);
                    }
                    Ok(player_cas::RegularOpen::Opened(file, len))
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(player_cas::RegularOpen::Missing),
                Err(error) => Err(error),
            }
        }
    }

    struct Fixture {
        _dir: tempfile::TempDir,
        runtime: crate::runtime_files::RuntimeFiles,
        media: Mutex<MediaRegistry>,
        cas: player_cas::ContentStore,
        session: uuid::Uuid,
        /// The granted video capability URL and its bytes.
        video: (String, Vec<u8>),
        font: String,
    }

    impl Fixture {
        fn resources(&self) -> Resources<'_> {
            Resources { runtime: &self.runtime, media: &self.media, cas: &self.cas, session: self.session }
        }

        async fn get(&self, url: &str, range: Option<&str>) -> Response {
            answer(self.resources(), Request { url, method: "GET", range, from_runtime: true }, 1_000).await
        }
    }

    fn sha256_hex(bytes: &[u8]) -> String {
        Sha256Digest::of(bytes).to_string()
    }

    async fn fixture() -> Fixture {
        let dir = tempfile::tempdir().expect("tempdir");
        let runtime_dir = dir.path().join("runtime");
        std::fs::create_dir_all(&runtime_dir).expect("runtime dir");
        let index = b"<!doctype html><title>t</title>";
        let script = b"console.log('runtime');";
        std::fs::write(runtime_dir.join("index.html"), index).expect("index");
        std::fs::write(runtime_dir.join("runtime.js"), script).expect("script");
        let manifest = serde_json::json!({
            "version": "0.1.0",
            "files": [
                {"path": "index.html", "bytes": index.len(), "sha256": sha256_hex(index)},
                {"path": "runtime.js", "bytes": script.len(), "sha256": sha256_hex(script)},
            ],
        });
        std::fs::write(runtime_dir.join("runtime-manifest.json"), manifest.to_string()).expect("manifest");
        let runtime = crate::runtime_files::RuntimeFiles::load(&runtime_dir).expect("runtime loads");

        let db = player_state::StateDb::open(dir.path().join("state.db"), player_state::OpenOptions::default())
            .expect("state");
        let cas = player_cas::ContentStore::open(
            dir.path().join("cas"),
            dir.path().join("partial"),
            db,
            crate::clock::system_clock(),
            Arc::new(Space),
            Arc::new(Opener),
            player_cas::StorePolicy { limit_bytes: 64 << 20, reserved_free_bytes: 0 },
            Arc::new(player_cas::LruByDomain),
        )
        .await
        .expect("store");

        // A video-sized object, so ranges cross more than one read.
        let video: Vec<u8> = (0..3 * 1024 * 1024u32).map(|n| (n % 251) as u8).collect();
        let font = b"wOF2 test font".to_vec();
        let mut refs = Vec::new();
        for (name, bytes, mime) in [("video.mp4", &video, "video/mp4"), ("font.woff2", &font, "font/woff2")] {
            let path = dir.path().join(name);
            std::fs::write(&path, bytes).expect("object");
            let digest = Sha256Digest::of(bytes);
            cas.import_file(
                &path,
                digest,
                bytes.len() as u64,
                player_cas::IngestMeta {
                    domain: player_state::repo::cas::Domain::Media,
                    content_type: Some(mime.to_owned()),
                    source: player_state::repo::cas::SourceKind::Local,
                },
            )
            .await
            .expect("import");
            refs.push(player_core::VerifiedContentRef {
                sha256: digest,
                size_bytes: bytes.len() as u64,
                mime_type: SafeText::new(mime).expect("mime"),
                stream: None,
            });
        }
        let session = uuid::Uuid::new_v4();
        let mut registry = MediaRegistry::new();
        registry.bind_renderer(RendererInstance { session });
        let minted = registry.prepare(session, 1, 0, &refs).expect("prepare");
        registry.activate(session, 1, 0).expect("activate");
        let video_url = minted[&Sha256Digest::of(&video)].uri();
        let font_url = minted[&Sha256Digest::of(&font)].uri();
        Fixture {
            _dir: dir,
            runtime,
            media: Mutex::new(registry),
            cas,
            session,
            video: (video_url, video),
            font: font_url,
        }
    }

    fn body_bytes(body: Body) -> Vec<u8> {
        match body {
            Body::Empty => Vec::new(),
            Body::Bytes(bytes) => bytes,
            Body::File { mut file, offset, len } => {
                file.seek(std::io::SeekFrom::Start(offset)).expect("seek");
                let mut out = vec![0; len as usize];
                file.read_exact(&mut out).expect("read");
                out
            }
        }
    }

    #[tokio::test]
    async fn runtime_files_serve_only_manifested_paths() {
        let fixture = fixture().await;
        let index = fixture.get("tilecast://runtime/index.html", None).await;
        assert_eq!(index.status, 200);
        assert_eq!(index.header("Content-Type"), Some("text/html; charset=utf-8"));
        assert_eq!(body_bytes(index.body), b"<!doctype html><title>t</title>");
        for url in [
            "tilecast://runtime/runtime-manifest.json",
            "tilecast://runtime/missing.js",
            "tilecast://runtime/../state.db",
            "tilecast://runtime/%2e%2e/state.db",
            "tilecast://runtime/index.html?x=1",
            "tilecast://other/index.html",
            "file:///etc/passwd",
            "http://localhost/index.html",
        ] {
            let response = fixture.get(url, None).await;
            assert_eq!(response.status, 404, "{url}");
            assert_eq!(body_bytes(response.body), b"not found", "{url}");
        }
        let head = answer(
            fixture.resources(),
            Request { url: "tilecast://runtime/runtime.js", method: "HEAD", range: None, from_runtime: false },
            0,
        )
        .await;
        assert_eq!(head.status, 200);
        assert_eq!(head.header("Content-Length"), Some("23"));
        assert!(head.body.is_empty());
        let post = answer(
            fixture.resources(),
            Request { url: "tilecast://runtime/index.html", method: "POST", range: None, from_runtime: true },
            0,
        )
        .await;
        assert_eq!(post.status, 405);
    }

    #[tokio::test]
    async fn media_serves_ranges_for_video() {
        let fixture = fixture().await;
        let (url, bytes) = &fixture.video;
        let size = bytes.len();
        let whole = fixture.get(url, None).await;
        assert_eq!(whole.status, 200);
        assert_eq!(whole.header("Content-Length"), Some(size.to_string().as_str()));
        assert_eq!(whole.header("Accept-Ranges"), Some("bytes"));
        assert_eq!(whole.header("Content-Type"), Some("video/mp4"));
        assert_eq!(body_bytes(whole.body), *bytes);

        // The probe a media element sends first, then a seek into the
        // middle, then an open-ended tail.
        let probe = fixture.get(url, Some("bytes=0-1")).await;
        assert_eq!(probe.status, 206);
        assert_eq!(probe.header("Content-Range"), Some(format!("bytes 0-1/{size}").as_str()));
        assert_eq!(body_bytes(probe.body), bytes[0..2]);
        let middle = fixture.get(url, Some("bytes=1048576-2097151")).await;
        assert_eq!(middle.status, 206);
        assert_eq!(middle.header("Content-Length"), Some("1048576"));
        assert_eq!(body_bytes(middle.body), bytes[1_048_576..2_097_152]);
        let tail = fixture.get(url, Some(&format!("bytes={}-", size - 10))).await;
        assert_eq!(body_bytes(tail.body), bytes[size - 10..]);

        let unsatisfiable = fixture.get(url, Some(&format!("bytes={size}-"))).await;
        assert_eq!(unsatisfiable.status, 416);
        assert_eq!(unsatisfiable.header("Content-Range"), Some(format!("bytes */{size}").as_str()));

        let head = answer(
            fixture.resources(),
            Request { url, method: "HEAD", range: Some("bytes=0-99"), from_runtime: true },
            1_000,
        )
        .await;
        assert_eq!(head.status, 206);
        assert_eq!(head.header("Content-Length"), Some("100"));
        assert!(head.body.is_empty());
    }

    #[tokio::test]
    async fn fonts_are_readable_by_the_runtime_origin_only() {
        let fixture = fixture().await;
        let font = fixture.get(&fixture.font, None).await;
        assert_eq!(font.status, 200);
        assert_eq!(font.header("Access-Control-Allow-Origin"), Some("tilecast://runtime"));
        assert_eq!(font.header("Content-Type"), Some("font/woff2"));
    }

    #[tokio::test]
    async fn refused_media_is_indistinguishable() {
        let fixture = fixture().await;
        let (url, _) = &fixture.video;
        let refusals = [
            // Not the trusted document.
            answer(fixture.resources(), Request { url, method: "GET", range: None, from_runtime: false }, 1_000).await,
            // Unknown and malformed capabilities.
            fixture.get(&format!("tcmedia://cap/{}", "0".repeat(64)), None).await,
            fixture.get("tcmedia://cap/not-a-capability", None).await,
            // A digest is never a grant.
            fixture.get(&format!("tcmedia://sha256/{}", Sha256Digest::of(&fixture.video.1)), None).await,
            // Another renderer session.
            answer(
                Resources { session: uuid::Uuid::new_v4(), ..fixture.resources() },
                Request { url, method: "GET", range: None, from_runtime: true },
                1_000,
            )
            .await,
            // A media capability on the frame scheme.
            fixture.get(&url.replace("tcmedia://", "tcwidget://"), None).await,
        ];
        for response in refusals {
            assert_eq!(response.status, 404);
            assert_eq!(response.header_block(), Response::not_found().header_block());
            assert_eq!(body_bytes(response.body), b"not found");
        }
    }

    #[tokio::test]
    async fn retired_and_rebound_grants_stop_resolving() {
        let fixture = fixture().await;
        let (url, _) = fixture.video.clone();
        assert_eq!(fixture.get(&url, None).await.status, 200);
        // A renderer restart binds a new session: the old grants die with
        // the old session, and the new session never inherits them.
        let restarted = uuid::Uuid::new_v4();
        fixture.media.lock().expect("registry").bind_renderer(RendererInstance { session: restarted });
        assert_eq!(fixture.get(&url, None).await.status, 404);
        let rebound = Resources { session: restarted, ..fixture.resources() };
        let response =
            answer(rebound, Request { url: &url, method: "GET", range: None, from_runtime: true }, 1_000).await;
        assert_eq!(response.status, 404);
    }

    #[tokio::test]
    async fn a_corrupted_object_is_not_served() {
        let fixture = fixture().await;
        let (url, bytes) = &fixture.video;
        let digest = Sha256Digest::of(bytes);
        let cas_dir = fixture._dir.path().join("cas");
        let object = walk(&cas_dir).into_iter().find(|path| {
            path.file_name().and_then(|name| name.to_str()).is_some_and(|name| name.contains(&digest.to_string()))
        });
        let object = object.expect("the imported object is on disk");
        std::fs::write(&object, b"truncated").expect("corrupt");
        assert_eq!(fixture.get(url, None).await.status, 404);
    }

    fn walk(dir: &std::path::Path) -> Vec<std::path::PathBuf> {
        let mut out = Vec::new();
        for entry in std::fs::read_dir(dir).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() { out.extend(walk(&path)) } else { out.push(path) }
        }
        out
    }
}
