//! Content store integrity, crash-safety and fallback tests.
#![allow(clippy::unwrap_used)]

use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use async_trait::async_trait;
use bytes::Bytes;
use edge_cas::fetch::{AttemptOutcome, LocalFileSource};
use edge_cas::store::VerifyOutcome;
use edge_cas::{
    BlobSource, CasError, ContentStore, FetchError, FetchObserver, FetchRequest, Fetcher, IngestMeta, LruByDomain,
    SourceError, SourceKind, SourceStream, StorePolicy,
};
use edge_platform::disk::FixedSpace;
use edge_protocol::Sha256Digest;
use edge_protocol::time::system_clock;
use edge_state::repo::cas::{Domain, PinReason, SourceKind as RecordSource};
use edge_state::{OpenOptions, StateDb};
use futures_util::StreamExt as _;

struct Env {
    dir: tempfile::TempDir,
    db: StateDb,
}

fn env() -> Env {
    let dir = tempfile::tempdir().unwrap();
    let db = StateDb::open(dir.path().join("state.db"), OpenOptions::default()).unwrap();
    Env { dir, db }
}

fn policy(limit: u64) -> StorePolicy {
    StorePolicy { limit_bytes: limit, reserved_free_bytes: 0 }
}

async fn store_with(env: &Env, limit: u64, free: u64) -> ContentStore {
    ContentStore::open(
        env.dir.path().join("cas"),
        env.dir.path().join("partial"),
        env.db.clone(),
        system_clock(),
        Arc::new(FixedSpace(free)),
        policy(limit),
        Arc::new(LruByDomain),
    )
    .await
    .unwrap()
}

async fn store(env: &Env) -> ContentStore {
    store_with(env, 1 << 30, 1 << 40).await
}

fn meta() -> IngestMeta {
    IngestMeta { domain: Domain::Media, content_type: Some("image/png".into()), source: RecordSource::Origin }
}

fn request(bytes: &[u8]) -> FetchRequest {
    FetchRequest { digest: Sha256Digest::of(bytes), size_bytes: bytes.len() as u64, meta: meta() }
}

/// A scripted in-memory source.
#[derive(Debug)]
struct Scripted {
    label: &'static str,
    bytes: Vec<u8>,
    /// Stop with a transient error after this many bytes of the stream.
    fail_after: Option<usize>,
    /// Ignore the requested offset and send everything (HTTP 200 to a Range).
    ignore_offset: bool,
    opens: Arc<Mutex<Vec<u64>>>,
    delay: Option<Duration>,
}

impl Scripted {
    fn new(label: &'static str, bytes: &[u8]) -> Self {
        Self {
            label,
            bytes: bytes.to_vec(),
            fail_after: None,
            ignore_offset: false,
            opens: Arc::default(),
            delay: None,
        }
    }
}

#[async_trait]
impl BlobSource for Scripted {
    fn kind(&self) -> SourceKind {
        SourceKind::Origin
    }
    fn label(&self) -> String {
        self.label.into()
    }
    async fn open(&self, _digest: &Sha256Digest, _size: u64, offset: u64) -> Result<SourceStream, SourceError> {
        self.opens.lock().unwrap().push(offset);
        if let Some(delay) = self.delay {
            tokio::time::sleep(delay).await;
        }
        let start = if self.ignore_offset { 0 } else { offset as usize };
        let mut body: Vec<u8> = self.bytes[start.min(self.bytes.len())..].to_vec();
        let mut chunks: Vec<Result<Bytes, SourceError>> = Vec::new();
        if let Some(limit) = self.fail_after {
            body.truncate(limit);
            chunks.push(Ok(Bytes::from(body)));
            chunks.push(Err(SourceError::Retryable("connection reset".into())));
        } else {
            for chunk in body.chunks(7) {
                chunks.push(Ok(Bytes::copy_from_slice(chunk)));
            }
        }
        Ok(SourceStream { start: start as u64, total_length: None, body: futures_util::stream::iter(chunks).boxed() })
    }
}

#[derive(Default)]
struct Outcomes(Mutex<Vec<(String, AttemptOutcome)>>);

impl FetchObserver for Outcomes {
    fn attempt(&self, source: &dyn BlobSource, outcome: AttemptOutcome, _bytes: u64, _elapsed: Duration) {
        self.0.lock().unwrap().push((source.label(), outcome));
    }
}

const DATA: &[u8] = b"Tilecast Edge content-addressed store test payload 0123456789";

#[tokio::test]
async fn fetch_verifies_and_promotes() {
    let env = env();
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 2);
    let sources: Vec<Arc<dyn BlobSource>> = vec![Arc::new(Scripted::new("origin-a", DATA))];
    let record = fetcher.fetch(&request(DATA), &sources, None).await.unwrap();
    assert_eq!(record.size_bytes, DATA.len() as u64);
    let path = store.verified_path(&record.sha256).await.unwrap().unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), DATA);
    assert!(path.ends_with(format!("sha256/{}/{}", record.sha256.fanout(), record.sha256.to_hex())));
    assert_eq!(
        store.stat(&record.sha256).await.unwrap().unwrap().source_kind,
        edge_state::repo::cas::SourceKind::Origin
    );
    // A second fetch is a no-op.
    let again = fetcher.fetch(&request(DATA), &[], None).await.unwrap();
    assert_eq!(again.sha256, record.sha256);
}

#[tokio::test]
async fn corrupt_same_size_bytes_never_enter_the_store() {
    let env = env();
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 2);
    let mut evil = DATA.to_vec();
    evil[3] ^= 0xff;
    let observer = Outcomes::default();
    let sources: Vec<Arc<dyn BlobSource>> =
        vec![Arc::new(Scripted::new("evil-source", &evil)), Arc::new(Scripted::new("origin", DATA))];
    let record = fetcher.fetch(&request(DATA), &sources, Some(&observer)).await.unwrap();
    assert_eq!(std::fs::read(store.verified_path(&record.sha256).await.unwrap().unwrap()).unwrap(), DATA);
    assert_eq!(
        *observer.0.lock().unwrap(),
        vec![
            ("evil-source".to_owned(), AttemptOutcome::IntegrityFailure),
            ("origin".to_owned(), AttemptOutcome::Completed)
        ]
    );

    // With only the corrupt source, nothing is promoted and no partial remains.
    let other = b"another object entirely";
    let mut corrupt = other.to_vec();
    corrupt[0] ^= 1;
    let result =
        fetcher.fetch(&request(other), &[Arc::new(Scripted::new("evil", &corrupt)) as Arc<dyn BlobSource>], None).await;
    assert!(matches!(result, Err(FetchError::Exhausted)));
    assert!(store.stat(&Sha256Digest::of(other)).await.unwrap().is_none());
}

#[tokio::test]
async fn oversized_stream_is_rejected() {
    let env = env();
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 1);
    let mut longer = DATA.to_vec();
    longer.extend_from_slice(b"trailing garbage");
    let observer = Outcomes::default();
    let result = fetcher
        .fetch(&request(DATA), &[Arc::new(Scripted::new("long", &longer)) as Arc<dyn BlobSource>], Some(&observer))
        .await;
    assert!(result.is_err());
    assert_eq!(observer.0.lock().unwrap()[0].1, AttemptOutcome::IntegrityFailure);
}

#[tokio::test]
async fn interrupted_transfer_resumes_from_another_source() {
    let env = env();
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 1);
    let mut first = Scripted::new("origin-a", DATA);
    first.fail_after = Some(20);
    let second = Scripted::new("origin", DATA);
    let second_opens = Arc::clone(&second.opens);
    let sources: Vec<Arc<dyn BlobSource>> = vec![Arc::new(first), Arc::new(second)];
    fetcher.fetch(&request(DATA), &sources, None).await.unwrap();
    assert_eq!(*second_opens.lock().unwrap(), vec![20], "second source resumed at the partial offset");
}

#[tokio::test]
async fn full_body_answer_to_a_range_restarts_the_partial() {
    let env = env();
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 1);
    let mut first = Scripted::new("origin-a", DATA);
    first.fail_after = Some(10);
    let mut second = Scripted::new("origin", DATA);
    second.ignore_offset = true;
    let sources: Vec<Arc<dyn BlobSource>> = vec![Arc::new(first), Arc::new(second)];
    let record = fetcher.fetch(&request(DATA), &sources, None).await.unwrap();
    assert_eq!(std::fs::read(store.verified_path(&record.sha256).await.unwrap().unwrap()).unwrap(), DATA);
}

#[tokio::test]
async fn partial_survives_a_crash_and_resumes_after_reopen() {
    let env = env();
    let digest = Sha256Digest::of(DATA);
    {
        let store = store(&env).await;
        let mut session = store.begin_write(digest, DATA.len() as u64, meta()).await.unwrap().unwrap();
        session.write(&DATA[..25]).unwrap();
        // Crash: the session is dropped without suspend or commit.
        drop(session);
    }
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 1);
    let source = Scripted::new("origin", DATA);
    let opens = Arc::clone(&source.opens);
    fetcher.fetch(&request(DATA), &[Arc::new(source) as Arc<dyn BlobSource>], None).await.unwrap();
    assert_eq!(*opens.lock().unwrap(), vec![25], "resumed from the bytes on disk");
}

#[tokio::test]
async fn reconciliation_handles_every_crash_boundary() {
    let env = env();
    let good = Sha256Digest::of(DATA);
    let cas = env.dir.path().join("cas/sha256");
    {
        let store = store(&env).await;
        store.import_file(&write_temp(&env, "good", DATA), good, DATA.len() as u64, meta()).await.unwrap();
    }
    // (a) Row without file: the file vanished.
    let vanished = Sha256Digest::of(b"vanished");
    {
        let store = store(&env).await;
        store.import_file(&write_temp(&env, "v", b"vanished"), vanished, 8, meta()).await.unwrap();
    }
    std::fs::remove_file(cas.join(vanished.fanout()).join(vanished.to_hex())).unwrap();
    // (b) File renamed into place but the row was never written.
    let adopted = Sha256Digest::of(b"adopt me");
    std::fs::create_dir_all(cas.join(adopted.fanout())).unwrap();
    std::fs::write(cas.join(adopted.fanout()).join(adopted.to_hex()), b"adopt me").unwrap();
    // (c) A file whose bytes do not match its name.
    let liar = Sha256Digest::of(b"liar");
    std::fs::create_dir_all(cas.join(liar.fanout())).unwrap();
    std::fs::write(cas.join(liar.fanout()).join(liar.to_hex()), b"not liar").unwrap();
    // (d) An orphan partial without a row, and junk in the CAS tree.
    std::fs::write(env.dir.path().join("partial").join(format!("{}.part", Sha256Digest::of(b"x").to_hex())), b"x")
        .unwrap();
    std::fs::write(cas.join(good.fanout()).join("not-a-digest"), b"junk").unwrap();

    let store = store(&env).await;
    assert!(store.stat(&good).await.unwrap().is_some());
    assert!(store.stat(&vanished).await.unwrap().is_none());
    let adopted_record = store.stat(&adopted).await.unwrap().unwrap();
    assert_eq!(
        adopted_record.source_kind,
        edge_state::repo::cas::SourceKind::Local,
        "adopted orphans are recorded as local"
    );
    assert!(store.stat(&liar).await.unwrap().is_none());
    assert!(!cas.join(liar.fanout()).join(liar.to_hex()).exists());
    assert_eq!(std::fs::read_dir(env.dir.path().join("partial")).unwrap().count(), 0);
    assert!(!cas.join(good.fanout()).join("not-a-digest").exists());
}

fn write_temp(env: &Env, name: &str, bytes: &[u8]) -> PathBuf {
    let path = env.dir.path().join(format!("{name}.src"));
    std::fs::write(&path, bytes).unwrap();
    path
}

#[tokio::test]
async fn concurrent_fetches_of_one_object_open_one_source() {
    let env = env();
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 4);
    let mut source = Scripted::new("origin", DATA);
    source.delay = Some(Duration::from_millis(100));
    let opens = Arc::clone(&source.opens);
    let source: Arc<dyn BlobSource> = Arc::new(source);
    let mut tasks = Vec::new();
    for _ in 0..4 {
        let fetcher = fetcher.clone();
        let source = Arc::clone(&source);
        tasks.push(tokio::spawn(async move { fetcher.fetch(&request(DATA), &[source], None).await }));
    }
    for task in tasks {
        task.await.unwrap().unwrap();
    }
    assert_eq!(opens.lock().unwrap().len(), 1);
}

#[tokio::test]
async fn eviction_respects_pins_and_limits() {
    let env = env();
    let store = store_with(&env, 100, 1 << 40).await;
    let a = vec![b'a'; 40];
    let b = vec![b'b'; 40];
    let c = vec![b'c'; 40];
    for bytes in [&a, &b] {
        store.import_file(&write_temp(&env, "x", bytes), Sha256Digest::of(bytes), 40, meta()).await.unwrap();
    }
    store.replace_pins(PinReason::ActivePresentation, "activation-1", vec![Sha256Digest::of(&a)]).await.unwrap();
    store.import_file(&write_temp(&env, "c", &c), Sha256Digest::of(&c), 40, meta()).await.unwrap();
    assert!(store.stat(&Sha256Digest::of(&a)).await.unwrap().is_some(), "pinned object kept");
    assert!(store.stat(&Sha256Digest::of(&b)).await.unwrap().is_none(), "unpinned object evicted");
    // Pin everything: a new object cannot fit and nothing is deleted.
    store
        .replace_pins(PinReason::ActivePresentation, "activation-1", vec![Sha256Digest::of(&a), Sha256Digest::of(&c)])
        .await
        .unwrap();
    let d = vec![b'd'; 40];
    let result = store.import_file(&write_temp(&env, "d", &d), Sha256Digest::of(&d), 40, meta()).await;
    assert!(matches!(result, Err(CasError::OverLimit)));
    assert!(matches!(store.remove(&Sha256Digest::of(&a)).await, Err(CasError::Pinned(_))));
}

#[tokio::test]
async fn free_space_reserve_is_enforced() {
    let env = env();
    let store = ContentStore::open(
        env.dir.path().join("cas"),
        env.dir.path().join("partial"),
        env.db.clone(),
        system_clock(),
        Arc::new(FixedSpace(1_000)),
        StorePolicy { limit_bytes: 1 << 30, reserved_free_bytes: 990 },
        Arc::new(LruByDomain),
    )
    .await
    .unwrap();
    let result =
        store.import_file(&write_temp(&env, "big", DATA), Sha256Digest::of(DATA), DATA.len() as u64, meta()).await;
    assert!(matches!(result, Err(CasError::InsufficientSpace { .. })));
}

#[tokio::test]
async fn suspect_objects_are_rehashed_before_use() {
    let env = env();
    let digest = Sha256Digest::of(DATA);
    let store = store(&env).await;
    store.import_file(&write_temp(&env, "d", DATA), digest, DATA.len() as u64, meta()).await.unwrap();
    env.db.run_blocking(|c| edge_state::repo::cas::mark_all_suspect(c)).unwrap();
    // Same-size corruption on disk after an unclean shutdown.
    let path = env.dir.path().join("cas/sha256").join(digest.fanout()).join(digest.to_hex());
    let mut bytes = DATA.to_vec();
    bytes[0] ^= 0x20;
    std::fs::write(&path, &bytes).unwrap();
    assert!(store.verified_path(&digest).await.unwrap().is_none());
    assert!(store.stat(&digest).await.unwrap().is_none());
    assert!(!path.exists());
    assert_eq!(store.verify(&digest).await.unwrap(), VerifyOutcome::Missing);
}

#[tokio::test]
async fn local_file_source_imports_and_resumes() {
    let env = env();
    let store = store(&env).await;
    let fetcher = Fetcher::new(store.clone(), 1);
    let path = write_temp(&env, "local", DATA);
    let source: Arc<dyn BlobSource> = Arc::new(LocalFileSource { path });
    let record = fetcher.fetch(&request(DATA), &[source], None).await.unwrap();
    assert_eq!(record.sha256, Sha256Digest::of(DATA));
}
