//! `tilecast-runtime-conformance`: runs one Player Runtime conformance
//! fixture under WebView2 and records the results.
//!
//! Test-only; never installed. It loads the exact production Runtime
//! artifact the player serves, from the exact production trusted origin
//! (`tilecast://runtime/index.html`), through the product's scheme
//! handlers and verified CAS serving, and injects the shared conformance
//! fixture host instead of the product bridge. The Electron runner
//! (`apps/player-linux/conformance`) does the same under Chromium, the WPE
//! runner (`apps/edge/renderer-wpe/tests/conformance.c`) under WebKit, and
//! `packages/player-runtime/conformance/compare.mjs` compares them.
//!
//! ```text
//! tilecast-runtime-conformance --runtime-dir DIR --host-script FILE
//!   --fixture FILE --cas-root DIR --out DIR [--size WxH] [--timeout S]
//! ```
//!
//! Screenshots are written as `<out>/<checkpoint>.png`; the results as
//! `<out>/result.json`. Exit codes mirror the WPE runner: 64 for usage,
//! 66 for unreadable inputs, 70 for harness failures, 2 for the fixture
//! timeout, 3 for a dead renderer, 0 once `result.json` is written.

use std::collections::{BTreeMap, HashMap};
use std::path::{Path, PathBuf};
use std::sync::Arc;

use player_cas::{ContentStore, IngestMeta, LruByDomain, StorePolicy};
use player_state::repo::cas::{Domain, SourceKind};
use player_state::{OpenOptions, StateDb};
use player_types::Sha256Digest;

/// Usage errors (sysexits, mirroring the WPE runner).
const EXIT_USAGE: i32 = 64;
const EXIT_INPUT: i32 = 66;
const EXIT_SOFTWARE: i32 = 70;
const EXIT_TIMEOUT: i32 = 2;
const EXIT_RENDERER_GONE: i32 = 3;

struct Options {
    runtime_dir: PathBuf,
    host_script: PathBuf,
    fixture: PathBuf,
    cas_root: PathBuf,
    out_dir: PathBuf,
    width: i32,
    height: i32,
    timeout_secs: u64,
}

/// `--name value` or `--name=value`. A runner that accepted only one
/// spelling would silently fall back to a default for the other.
fn option_value(args: &[String], name: &str) -> Option<String> {
    let flag = format!("--{name}");
    let prefix = format!("--{name}=");
    args.iter().enumerate().find_map(|(index, arg)| {
        if arg == &flag { args.get(index + 1).cloned() } else { arg.strip_prefix(&prefix).map(str::to_owned) }
    })
}

fn parse_options(args: &[String]) -> Result<Options, String> {
    let required = |name: &str| option_value(args, name).ok_or_else(|| format!("missing --{name}")).map(PathBuf::from);
    let (mut width, mut height) = (1280, 720);
    if let Some(size) = option_value(args, "size") {
        let (w, h) = size.split_once('x').ok_or_else(|| "invalid --size".to_string())?;
        width = w.parse().map_err(|_| "invalid --size".to_string())?;
        height = h.parse().map_err(|_| "invalid --size".to_string())?;
        if width < 320 || height < 200 || width > 7680 || height > 4320 {
            return Err("invalid --size".to_string());
        }
    }
    let timeout_secs = match option_value(args, "timeout") {
        Some(value) => value.parse().map_err(|_| "invalid --timeout".to_string())?,
        None => 180,
    };
    if timeout_secs == 0 || timeout_secs > 3600 {
        return Err("invalid --timeout".to_string());
    }
    Ok(Options {
        runtime_dir: required("runtime-dir")?,
        host_script: required("host-script")?,
        fixture: required("fixture")?,
        cas_root: required("cas-root")?,
        out_dir: required("out")?,
        width,
        height,
        timeout_secs,
    })
}

/// A checkpoint or fixture name becomes a path segment; the Electron runner's rule.
fn checkpoint_name_is_safe(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name.bytes().all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

/// Fixture media by digest, from the fixture's `media` map (`name` →
/// `tcmedia://sha256/<hex>`, as `run.mjs` writes it).
fn fixture_digests(fixture: &serde_json::Value) -> Result<BTreeMap<String, Sha256Digest>, String> {
    let mut digests = BTreeMap::new();
    let media = fixture.get("media").and_then(|media| media.as_object());
    for (name, uri) in media.into_iter().flat_map(|media| media.iter()) {
        let uri = uri.as_str().ok_or_else(|| format!("media {name} is not a URI"))?;
        let hex =
            uri.strip_prefix("tcmedia://sha256/").ok_or_else(|| format!("media {name} is not content-addressed"))?;
        let digest = Sha256Digest::parse(hex).map_err(|_| format!("media {name} names a bad digest"))?;
        digests.insert(name.clone(), digest);
    }
    Ok(digests)
}

fn fixture_object(cas_root: &Path, digest: &Sha256Digest) -> PathBuf {
    let hex = digest.to_string();
    cas_root.join("sha256").join(&hex[..2]).join(hex)
}

/// The fixture store carries PNG images and one MP4 clip; sniff the magic
/// rather than trusting a name, as the WPE runner's media socket does.
fn sniff_mime_type(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png");
    }
    if head.len() >= 12 && head[4..8] == *b"ftyp" {
        return Some("video/mp4");
    }
    None
}

/// Rewrites the fixture's content addresses to the capability URIs the
/// player would send, then builds the document-start bootstrap: the
/// runner object the fixture host needs, then the shared host script.
/// The fixture travels as re-serialized JSON, never pasted as text.
fn build_bootstrap(
    fixture: &serde_json::Value,
    grants: &HashMap<Sha256Digest, String>,
    host_source: &str,
) -> Result<String, String> {
    let mut serialized =
        serde_json::to_string(fixture).map_err(|error| format!("the fixture does not serialize: {error}"))?;
    for (digest, uri) in grants {
        let addressed = format!("tcmedia://sha256/{digest}");
        if !serialized.contains(&addressed) {
            return Err(format!("the fixture never uses its media {addressed}"));
        }
        serialized = serialized.replace(&addressed, uri);
    }
    if serialized.contains("tcmedia://sha256/") {
        return Err("the fixture names media outside its media map".to_string());
    }
    Ok(format!(
        "globalThis.__tilecastConformanceRunner = Object.freeze({{\n\
         fixture: {serialized},\n\
         snapshot: (name) => new Promise((resolve, reject) => {{\n\
         const id = `snapshot-${{++globalThis.__tcSnapshotSeq}}`;\n\
         globalThis.__tcSnapshotPending[id] = {{ resolve, reject }};\n\
         chrome.webview.postMessage(JSON.stringify({{ tcConformance: 'snapshot', id, name }}));\n\
         }}),\n\
         finish: (result) => chrome.webview.postMessage(JSON.stringify({{ tcConformance: 'finish', result }}))\n\
         }});\n\
         globalThis.__tcSnapshotSeq = 0;\n\
         globalThis.__tcSnapshotPending = Object.create(null);\n\
         chrome.webview.addEventListener('message', (event) => {{\n\
         const reply = event.data;\n\
         if (!reply || reply.tcConformanceReply === undefined) return;\n\
         const pending = globalThis.__tcSnapshotPending[reply.tcConformanceReply];\n\
         if (!pending) return;\n\
         delete globalThis.__tcSnapshotPending[reply.tcConformanceReply];\n\
         if (reply.ok) pending.resolve(); else pending.reject(new Error(reply.error || 'snapshot failed'));\n\
         }});\n\
         {host_source}"
    ))
}

/// Reads a PNG's IHDR dimensions without an image dependency, so a
/// scaled capture fails loudly instead of poisoning the comparison.
fn png_dimensions(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") || bytes[12..16] != *b"IHDR" {
        return None;
    }
    Some((u32::from_be_bytes(bytes[16..20].try_into().ok()?), u32::from_be_bytes(bytes[20..24].try_into().ok()?)))
}

fn write_result(out_dir: &Path, result: &serde_json::Value) -> Result<(), String> {
    std::fs::write(out_dir.join("result.json"), serde_json::to_string_pretty(result).unwrap_or_default())
        .map_err(|error| format!("result.json: {error}"))?;
    Ok(())
}

fn failure_result(fixture_name: &str, failure: &str) -> serde_json::Value {
    serde_json::json!({
        "fixture": fixture_name,
        "engine": { "userAgent": tilecast_windows::ui::engine_version() },
        "checkpoints": [],
        "failure": failure,
    })
}

/// Off Windows there is no WebView2 and no disk probe; the harness still
/// imports fixture media so everything before the renderer stays tested.
#[cfg(not(windows))]
#[derive(Debug)]
struct HarnessSpace;

#[cfg(not(windows))]
impl player_cas::space::SpaceProbe for HarnessSpace {
    fn available_bytes(&self, _path: &Path) -> std::io::Result<u64> {
        Ok(1 << 40)
    }
}

fn scratch_dir(name: &str) -> Result<PathBuf, String> {
    let dir = std::env::temp_dir().join(format!("tilecast-conformance-{}-{}", std::process::id(), name));
    std::fs::create_dir_all(&dir).map_err(|error| format!("{}: {error}", dir.display()))?;
    Ok(dir)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|duration| duration.as_millis() as i64)
        .unwrap_or(0)
}

/// Imports the fixture's media through the verified commit path and mints
/// the generation-1 grants the player would send, returning each digest's
/// capability URI.
async fn prepare_fixture_media(
    cas: &ContentStore,
    media: &Arc<std::sync::Mutex<tilecast_windows::media::MediaRegistry>>,
    session: uuid::Uuid,
    cas_root: &Path,
    digests: &BTreeMap<String, Sha256Digest>,
) -> Result<HashMap<Sha256Digest, String>, String> {
    let mut refs = Vec::with_capacity(digests.len());
    for (name, digest) in digests {
        let file = fixture_object(cas_root, digest);
        let head = std::fs::File::open(&file)
            .map_err(|_| format!("media {name} is missing from the fixture store"))
            .and_then(|mut file| {
                use std::io::Read as _;
                let mut head = [0u8; 12];
                file.read_exact(&mut head).map_err(|_| format!("media {name} is too small"))?;
                Ok(head)
            })?;
        let mime = sniff_mime_type(&head).ok_or_else(|| format!("media {name} is neither PNG nor MP4"))?;
        let size = std::fs::metadata(&file).map_err(|_| format!("media {name} is missing"))?.len();
        cas.import_file(
            &file,
            *digest,
            size,
            IngestMeta { domain: Domain::Media, content_type: Some(mime.to_string()), source: SourceKind::Local },
        )
        .await
        .map_err(|error| format!("media {name} failed verification: {error}"))?;
        refs.push(player_core::VerifiedContentRef {
            sha256: *digest,
            size_bytes: size,
            mime_type: player_types::bounded::SafeText::new(mime).map_err(|_| format!("media {name} mime"))?,
        });
    }
    let mut registry = media.lock().unwrap_or_else(|poison| poison.into_inner());
    registry.bind_renderer(tilecast_windows::media::RendererInstance { session });
    let minted = registry.prepare(session, 1, now_ms(), &refs).map_err(|error| format!("grants: {error}"))?;
    registry.activate(session, 1, now_ms()).map_err(|error| format!("grants: {error}"))?;
    Ok(minted.into_iter().map(|(digest, capability)| (digest, capability.uri())).collect())
}

async fn run_fixture(options: &Options) -> Result<i32, (i32, String)> {
    let fixture_text =
        std::fs::read_to_string(&options.fixture).map_err(|error| (EXIT_INPUT, format!("fixture: {error}")))?;
    let fixture: serde_json::Value =
        serde_json::from_str(&fixture_text).map_err(|error| (EXIT_INPUT, format!("fixture: {error}")))?;
    let fixture_name = fixture.get("name").and_then(|name| name.as_str()).unwrap_or("fixture").to_owned();
    // The name joins the scratch path that is removed recursively at the end.
    if !checkpoint_name_is_safe(&fixture_name) {
        return Err((EXIT_INPUT, "the fixture name is not a safe path segment".to_string()));
    }
    let host_source =
        std::fs::read_to_string(&options.host_script).map_err(|error| (EXIT_INPUT, format!("host script: {error}")))?;
    if host_source.len() > 1024 * 1024 {
        return Err((EXIT_INPUT, "the host script is too large".to_string()));
    }
    std::fs::create_dir_all(&options.out_dir).map_err(|error| (EXIT_SOFTWARE, format!("out: {error}")))?;
    let digests = fixture_digests(&fixture).map_err(|message| (EXIT_INPUT, message))?;

    // The product's runtime loader verifies the artifact's manifest
    // before a byte is served: the harness cannot run a doctored one.
    let runtime = tilecast_windows::runtime_files::RuntimeFiles::load(&options.runtime_dir)
        .map_err(|error| (EXIT_INPUT, format!("runtime: {error}")))?;
    let scratch = scratch_dir(&fixture_name).map_err(|message| (EXIT_SOFTWARE, message))?;
    let db = StateDb::open(scratch.join("state.db"), OpenOptions::default())
        .map_err(|error| (EXIT_SOFTWARE, format!("state: {error}")))?;
    let policy = StorePolicy { limit_bytes: 64 * 1024 * 1024, reserved_free_bytes: 0 };
    // The harness measures real disk space on Windows; elsewhere it only
    // needs the store to open so the pre-renderer path stays testable.
    #[cfg(windows)]
    let space: Arc<dyn player_cas::space::SpaceProbe> = Arc::new(tilecast_windows::space::DiskSpaceProbe);
    #[cfg(not(windows))]
    let space: Arc<dyn player_cas::space::SpaceProbe> = Arc::new(HarnessSpace);
    let cas = ContentStore::open(
        scratch.join("cas"),
        scratch.join("partial"),
        db,
        tilecast_windows::clock::system_clock(),
        space,
        Arc::new(tilecast_windows::secure_open::WindowsSecureOpener),
        policy,
        Arc::new(LruByDomain),
    )
    .await
    .map_err(|error| (EXIT_SOFTWARE, format!("store: {error}")))?;
    let media = Arc::new(std::sync::Mutex::new(tilecast_windows::media::MediaRegistry::new()));
    let session = uuid::Uuid::new_v4();
    let grants = prepare_fixture_media(&cas, &media, session, &options.cas_root, &digests)
        .await
        .map_err(|message| (EXIT_SOFTWARE, message))?;
    let bootstrap = build_bootstrap(&fixture, &grants, &host_source).map_err(|message| (EXIT_SOFTWARE, message))?;
    let user_data_dir = scratch.join("webview");
    std::fs::create_dir_all(&user_data_dir).map_err(|error| (EXIT_SOFTWARE, format!("webview data: {error}")))?;

    let services = tilecast_windows::ui::UiServices {
        runtime,
        media,
        cas,
        session,
        user_data_dir,
        capabilities: serde_json::Value::Null,
        info: serde_json::Value::Null,
        conformance: Some(tilecast_windows::ui::ConformanceUi {
            bootstrap,
            width: options.width,
            height: options.height,
        }),
        main_window: std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0)),
    };
    let (ui, mut events) = tilecast_windows::ui::spawn_ui(services)
        .await
        .map_err(|error| (EXIT_SOFTWARE, format!("renderer: {error}")))?;
    let outcome = drive_fixture(&ui, &mut events, options, &fixture_name).await;
    ui.shutdown();
    let _ = std::fs::remove_dir_all(&scratch);
    outcome
}

fn reply_to(ui: &tilecast_windows::ui::UiHandle, id: &str, ok: bool, error: Option<String>) {
    let mut reply = serde_json::json!({ "tcConformanceReply": id, "ok": ok });
    if let Some(error) = error {
        reply["error"] = serde_json::Value::String(error);
    }
    let _ = ui.post(reply);
}

async fn handle_snapshot(ui: &tilecast_windows::ui::UiHandle, options: &Options, id: &str, name: &serde_json::Value) {
    let Some(name) = name.as_str().filter(|name| checkpoint_name_is_safe(name)) else {
        reply_to(ui, id, false, Some("invalid checkpoint name".to_string()));
        return;
    };
    let pending = match ui.capture_preview() {
        Ok(pending) => pending,
        Err(error) => {
            reply_to(ui, id, false, Some(format!("capture: {error}")));
            return;
        }
    };
    let bytes = match pending.await {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(reason)) => {
            reply_to(ui, id, false, Some(reason));
            return;
        }
        Err(_) => {
            reply_to(ui, id, false, Some("the renderer is gone".to_string()));
            return;
        }
    };
    match png_dimensions(&bytes) {
        Some((width, height)) if width == options.width as u32 && height == options.height as u32 => {}
        dimensions => {
            reply_to(
                ui,
                id,
                false,
                Some(format!("the capture is {dimensions:?}, the viewport is {}x{}", options.width, options.height)),
            );
            return;
        }
    }
    if let Err(error) = std::fs::write(options.out_dir.join(format!("{name}.png")), &bytes) {
        reply_to(ui, id, false, Some(format!("snapshot: {error}")));
        return;
    }
    reply_to(ui, id, true, None);
}

async fn drive_fixture(
    ui: &tilecast_windows::ui::UiHandle,
    events: &mut tokio::sync::mpsc::Receiver<tilecast_windows::ui::UiEvent>,
    options: &Options,
    fixture_name: &str,
) -> Result<i32, (i32, String)> {
    let deadline = tokio::time::sleep(std::time::Duration::from_secs(options.timeout_secs));
    tokio::pin!(deadline);
    loop {
        tokio::select! {
            () = &mut deadline => {
                let result = failure_result(fixture_name, "timed out");
                write_result(&options.out_dir, &result).map_err(|message| (EXIT_SOFTWARE, message))?;
                return Ok(EXIT_TIMEOUT);
            }
            event = events.recv() => {
                let Some(event) = event else {
                    let result = failure_result(fixture_name, "the renderer thread ended");
                    write_result(&options.out_dir, &result).map_err(|message| (EXIT_SOFTWARE, message))?;
                    return Ok(EXIT_RENDERER_GONE);
                };
                match event {
                    tilecast_windows::ui::UiEvent::ConformanceMessage { body } => {
                        let message: serde_json::Value = serde_json::from_str(&body)
                            .map_err(|_| (EXIT_SOFTWARE, "a harness message was not JSON".to_string()))?;
                        match message.get("tcConformance").and_then(|kind| kind.as_str()) {
                            Some("snapshot") => {
                                let id = message.get("id").and_then(|id| id.as_str()).unwrap_or("").to_owned();
                                let name = message.get("name").cloned().unwrap_or(serde_json::Value::Null);
                                handle_snapshot(ui, options, &id, &name).await;
                            }
                            Some("finish") => {
                                let result = message.get("result").cloned().unwrap_or(serde_json::Value::Null);
                                write_result(&options.out_dir, &result)
                                    .map_err(|message| (EXIT_SOFTWARE, message))?;
                                return Ok(0);
                            }
                            _ => return Err((EXIT_SOFTWARE, "a harness message was not understood".to_string())),
                        }
                    }
                    tilecast_windows::ui::UiEvent::ProcessFailed { kind } => {
                        let result = failure_result(fixture_name, &format!("renderer process gone: {kind}"));
                        write_result(&options.out_dir, &result).map_err(|message| (EXIT_SOFTWARE, message))?;
                        return Ok(EXIT_RENDERER_GONE);
                    }
                    tilecast_windows::ui::UiEvent::Fatal { reason } => {
                        let result = failure_result(fixture_name, &format!("renderer fatal: {reason}"));
                        write_result(&options.out_dir, &result).map_err(|message| (EXIT_SOFTWARE, message))?;
                        return Ok(EXIT_RENDERER_GONE);
                    }
                    // The harness binds its grants before the page loads; the
                    // product bridge never speaks in conformance mode, and
                    // conformance fixtures never create remote surfaces.
                    tilecast_windows::ui::UiEvent::Session { .. }
                    | tilecast_windows::ui::UiEvent::Runtime(_)
                    | tilecast_windows::ui::UiEvent::Remote { .. } => {}
                }
            }
        }
    }
}

#[tokio::main(flavor = "multi_thread")]
async fn main() {
    let args: Vec<String> = std::env::args().collect();
    let code = match parse_options(&args) {
        Err(message) => {
            eprintln!("conformance: {message}");
            EXIT_USAGE
        }
        Ok(options) => match run_fixture(&options).await {
            Ok(code) => code,
            Err((code, message)) => {
                eprintln!("conformance: {message}");
                code
            }
        },
    };
    std::process::exit(code);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().map(|value| (*value).to_string()).collect()
    }

    #[test]
    fn options_reject_usage_errors() {
        let full = args(&[
            "tilecast-runtime-conformance",
            "--runtime-dir",
            "r",
            "--host-script",
            "h",
            "--fixture",
            "f",
            "--cas-root",
            "c",
            "--out",
            "o",
        ]);
        let options = parse_options(&full).expect("parses");
        assert_eq!((options.width, options.height, options.timeout_secs), (1280, 720, 180));
        assert!(parse_options(&args(&["tilecast-runtime-conformance"])).is_err());
        assert!(
            parse_options(&args(&[
                "tilecast-runtime-conformance",
                "--runtime-dir",
                "r",
                "--host-script",
                "h",
                "--fixture",
                "f",
                "--cas-root",
                "c",
                "--out",
                "o",
                "--size",
                "99999x10",
            ]))
            .is_err()
        );
        assert!(
            parse_options(&args(&[
                "tilecast-runtime-conformance",
                "--runtime-dir",
                "r",
                "--host-script",
                "h",
                "--fixture",
                "f",
                "--cas-root",
                "c",
                "--out",
                "o",
                "--timeout",
                "0",
            ]))
            .is_err()
        );
    }

    #[test]
    fn size_accepts_both_spellings() {
        let base = ["x", "--runtime-dir", "r", "--host-script", "h", "--fixture", "f", "--cas-root", "c", "--out", "o"];
        let with = |extra: &[&str]| {
            let mut words: Vec<&str> = base.to_vec();
            words.extend_from_slice(extra);
            parse_options(&args(&words)).expect("parses")
        };
        let spaced = with(&["--size", "1920x1080"]);
        let joined = with(&["--size=1920x1080"]);
        assert_eq!((spaced.width, spaced.height), (1920, 1080));
        assert_eq!((joined.width, joined.height), (1920, 1080));
        assert_eq!((with(&[]).width, with(&[]).height), (1280, 720));
    }

    #[test]
    fn checkpoint_names_become_filenames_safely() {
        assert!(checkpoint_name_is_safe("checkpoint-1_a"));
        assert!(!checkpoint_name_is_safe("../escape"));
        assert!(!checkpoint_name_is_safe(""));
        assert!(!checkpoint_name_is_safe(&"x".repeat(65)));
    }

    #[test]
    fn media_magic_decides_the_mime_type() {
        assert_eq!(sniff_mime_type(b"\x89PNG\r\n\x1a\n...."), Some("image/png"));
        assert_eq!(sniff_mime_type(b"\x00\x00\x00\x20ftypisom...."), Some("video/mp4"));
        assert_eq!(sniff_mime_type(b"GIF89a...."), None);
        assert_eq!(sniff_mime_type(b"short"), None);
    }

    #[test]
    fn png_dimensions_read_ihdr() {
        let mut bytes = b"\x89PNG\r\n\x1a\n".to_vec();
        bytes.extend_from_slice(&13u32.to_be_bytes());
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&1280u32.to_be_bytes());
        bytes.extend_from_slice(&720u32.to_be_bytes());
        bytes.extend_from_slice(&[8, 2, 0, 0, 0]);
        assert_eq!(png_dimensions(&bytes), Some((1280, 720)));
        assert_eq!(png_dimensions(b"not a png at all.............."), None);
        assert_eq!(png_dimensions(&bytes[..20]), None);
    }

    #[test]
    fn bootstrap_rewrites_every_address_and_nothing_else() {
        let digest = Sha256Digest::of(b"pixels");
        let fixture = serde_json::json!({
            "name": "image",
            "media": { "landscape": format!("tcmedia://sha256/{digest}") },
            "steps": [{ "present": { "src": format!("tcmedia://sha256/{digest}") } }],
        });
        let mut grants = HashMap::new();
        grants.insert(digest, "tcmedia://cap/abc123".to_string());
        let bootstrap = build_bootstrap(&fixture, &grants, "/* host */").expect("builds");
        assert!(bootstrap.contains("tcmedia://cap/abc123"));
        assert!(bootstrap.contains("__tilecastConformanceRunner"));
        assert!(bootstrap.contains("/* host */"));
        assert!(!bootstrap.contains("tcmedia://sha256/"));

        let stray = serde_json::json!({ "media": {}, "steps": [{ "present": { "src": "tcmedia://sha256/dead" } }] });
        assert!(build_bootstrap(&stray, &HashMap::new(), "").is_err());
        let unused = serde_json::json!({ "media": {}, "steps": [] });
        assert!(build_bootstrap(&unused, &grants, "").is_err());
    }
}
