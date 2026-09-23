//! The content store. See the crate documentation for invariants.

use std::collections::HashMap;
use std::io::{Read as _, Seek as _, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use edge_platform::disk::SpaceProbe;
use edge_protocol::digest::Sha256Hasher;
use edge_protocol::time::SharedClock;
use edge_protocol::{Sha256Digest, Timestamp};
use edge_state::StateDb;
use edge_state::repo::cas::{
    self as repo, Domain, ObjectRecord, PartialRecord, PinReason, SourceKind as RecordSource, VerifyState,
};
use tokio::sync::OwnedMutexGuard;

use crate::policy::EvictionPolicy;

#[derive(Debug, thiserror::Error)]
pub enum CasError {
    #[error("filesystem error: {0}")]
    Io(#[from] std::io::Error),
    #[error("state error: {0}")]
    State(#[from] edge_state::StateError),
    #[error("not enough free space for {needed} bytes")]
    InsufficientSpace { needed: u64 },
    #[error("object would exceed the cache limit even after eviction")]
    OverLimit,
    #[error("received more bytes than the expected {expected}")]
    TooLarge { expected: u64 },
    #[error("object is {actual} bytes, expected {expected}")]
    SizeMismatch { expected: u64, actual: u64 },
    #[error("object digest does not match {expected}")]
    DigestMismatch { expected: Sha256Digest },
    #[error("object {0:?} is pinned")]
    Pinned(Sha256Digest),
    #[error("background task failed")]
    Task,
}

/// Size limits applied to ingest.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct StorePolicy {
    pub limit_bytes: u64,
    pub reserved_free_bytes: u64,
}

/// Metadata recorded with a newly ingested object.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IngestMeta {
    pub domain: Domain,
    pub content_type: Option<String>,
    pub source: RecordSource,
}

struct Inner {
    cas_dir: PathBuf,
    partial_dir: PathBuf,
    db: StateDb,
    clock: SharedClock,
    space: Arc<dyn SpaceProbe>,
    policy: Mutex<StorePolicy>,
    eviction: Arc<dyn EvictionPolicy>,
    writers: Mutex<HashMap<Sha256Digest, Weak<tokio::sync::Mutex<()>>>>,
    touches: Mutex<HashMap<Sha256Digest, Timestamp>>,
}

#[derive(Clone)]
pub struct ContentStore {
    inner: Arc<Inner>,
}

impl std::fmt::Debug for ContentStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ContentStore").field("cas_dir", &self.inner.cas_dir).finish()
    }
}

fn object_path(cas_dir: &Path, digest: &Sha256Digest) -> PathBuf {
    cas_dir.join("sha256").join(digest.fanout()).join(digest.to_hex())
}

fn partial_path(partial_dir: &Path, digest: &Sha256Digest) -> PathBuf {
    partial_dir.join(format!("{}.part", digest.to_hex()))
}

fn fsync_dir(path: &Path) {
    // Best effort: not every filesystem supports directory fsync.
    if let Ok(dir) = std::fs::File::open(path) {
        let _ = dir.sync_all();
    }
}

/// Hashes a file and returns its digest and length.
pub fn hash_file(path: &Path) -> std::io::Result<(Sha256Digest, u64)> {
    let mut file = std::fs::File::open(path)?;
    let mut hasher = Sha256Hasher::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        hasher.update(&buffer[..read]);
        total += read as u64;
    }
    Ok((hasher.finish(), total))
}

impl ContentStore {
    /// Opens the store rooted at `cas_dir` (`<state>/cas`) with partials in
    /// `partial_dir`, reconciling files with metadata (crate invariant 2).
    pub async fn open(
        cas_dir: PathBuf,
        partial_dir: PathBuf,
        db: StateDb,
        clock: SharedClock,
        space: Arc<dyn SpaceProbe>,
        policy: StorePolicy,
        eviction: Arc<dyn EvictionPolicy>,
    ) -> Result<Self, CasError> {
        tokio::fs::create_dir_all(cas_dir.join("sha256")).await?;
        tokio::fs::create_dir_all(&partial_dir).await?;
        let store = Self {
            inner: Arc::new(Inner {
                cas_dir,
                partial_dir,
                db,
                clock,
                space,
                policy: Mutex::new(policy),
                eviction,
                writers: Mutex::new(HashMap::new()),
                touches: Mutex::new(HashMap::new()),
            }),
        };
        store.reconcile().await?;
        Ok(store)
    }

    pub fn set_policy(&self, policy: StorePolicy) {
        *self.inner.policy.lock().unwrap_or_else(|p| p.into_inner()) = policy;
    }

    pub fn policy(&self) -> StorePolicy {
        *self.inner.policy.lock().unwrap_or_else(|p| p.into_inner())
    }

    pub fn cas_dir(&self) -> &Path {
        &self.inner.cas_dir
    }

    fn now(&self) -> Timestamp {
        self.inner.clock.now()
    }

    async fn reconcile(&self) -> Result<(), CasError> {
        let inner = Arc::clone(&self.inner);
        let now = self.now();
        let summary = tokio::task::spawn_blocking(move || -> Result<(usize, usize, usize, usize), CasError> {
            let (mut dropped_rows, mut adopted, mut removed_partials, mut removed_files) = (0, 0, 0, 0);
            // Rows whose files are gone.
            let digests = inner.db.run_blocking(|c| repo::all_digests(c))?;
            for digest in &digests {
                if !object_path(&inner.cas_dir, digest).is_file() {
                    inner.db.run_blocking(|c| repo::delete_object(c, digest))?;
                    dropped_rows += 1;
                }
            }
            // Object files without rows: verified before rename, so re-hash
            // and adopt when the bytes still match their name.
            let known: std::collections::HashSet<Sha256Digest> = digests.into_iter().collect();
            for fanout in std::fs::read_dir(inner.cas_dir.join("sha256"))?.flatten() {
                let Ok(entries) = std::fs::read_dir(fanout.path()) else { continue };
                for entry in entries.flatten() {
                    let path = entry.path();
                    let Some(name) = path.file_name().and_then(|n| n.to_str()) else { continue };
                    let Ok(digest) = Sha256Digest::parse(name) else {
                        let _ = std::fs::remove_file(&path);
                        removed_files += 1;
                        continue;
                    };
                    if known.contains(&digest) {
                        continue;
                    }
                    match hash_file(&path) {
                        Ok((actual, size)) if actual == digest => {
                            let record = ObjectRecord {
                                sha256: digest,
                                size_bytes: size,
                                domain: Domain::Media,
                                content_type: None,
                                source_kind: RecordSource::Local,
                                verify_state: VerifyState::Verified,
                                verified_at: now,
                                created_at: now,
                                last_accessed_at: now,
                            };
                            inner.db.run_blocking(|c| repo::put_object(c, &record))?;
                            adopted += 1;
                        }
                        _ => {
                            let _ = std::fs::remove_file(&path);
                            removed_files += 1;
                        }
                    }
                }
            }
            // Partials: keep only those with both a file and a row.
            let partial_rows = inner.db.run_blocking(|c| repo::all_partials(c))?;
            for row in &partial_rows {
                let path = partial_path(&inner.partial_dir, &row.sha256);
                match std::fs::metadata(&path) {
                    Ok(meta) => {
                        let present = meta.len().min(row.expected_size);
                        if meta.len() > row.expected_size {
                            let _ = std::fs::remove_file(&path);
                            inner.db.run_blocking(|c| repo::delete_partial(c, &row.sha256))?;
                            removed_partials += 1;
                        } else if present != row.bytes_present {
                            let updated = PartialRecord { bytes_present: present, ..row.clone() };
                            inner.db.run_blocking(|c| repo::put_partial(c, &updated, now))?;
                        }
                    }
                    Err(_) => {
                        inner.db.run_blocking(|c| repo::delete_partial(c, &row.sha256))?;
                        removed_partials += 1;
                    }
                }
            }
            let rows: std::collections::HashSet<Sha256Digest> = partial_rows.iter().map(|r| r.sha256).collect();
            for entry in std::fs::read_dir(&inner.partial_dir)?.flatten() {
                let path = entry.path();
                let digest = path
                    .file_name()
                    .and_then(|n| n.to_str())
                    .and_then(|n| n.strip_suffix(".part"))
                    .and_then(|hex| Sha256Digest::parse(hex).ok());
                if digest.is_none_or(|d| !rows.contains(&d)) {
                    let _ = std::fs::remove_file(&path);
                    removed_partials += 1;
                }
            }
            Ok((dropped_rows, adopted, removed_partials, removed_files))
        })
        .await
        .map_err(|_| CasError::Task)??;
        tracing::info!(
            component = "cas",
            event = "reconciled",
            dropped_rows = summary.0,
            adopted = summary.1,
            removed_partials = summary.2,
            removed_files = summary.3
        );
        Ok(())
    }

    /// Metadata for a stored object.
    pub async fn stat(&self, digest: &Sha256Digest) -> Result<Option<ObjectRecord>, CasError> {
        let digest = *digest;
        Ok(self.inner.db.run(move |c| repo::get_object(c, &digest)).await?)
    }

    /// Path of a verified object, for trusted local consumers that read by
    /// path (the renderer resolves the same layout from the CAS root). Only
    /// returned after verification; suspect objects are re-hashed first.
    pub async fn verified_path(&self, digest: &Sha256Digest) -> Result<Option<PathBuf>, CasError> {
        match self.ensure_verified(digest).await? {
            Some(_) => {
                self.touch(digest);
                Ok(Some(object_path(&self.inner.cas_dir, digest)))
            }
            None => Ok(None),
        }
    }

    /// Opens a verified object for reading (daemon-owned media access).
    pub async fn open_verified(
        &self,
        digest: &Sha256Digest,
    ) -> Result<Option<(std::fs::File, ObjectRecord)>, CasError> {
        let Some(record) = self.ensure_verified(digest).await? else {
            return Ok(None);
        };
        match std::fs::File::open(object_path(&self.inner.cas_dir, digest)) {
            Ok(file) => {
                self.touch(digest);
                Ok(Some((file, record)))
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(error.into()),
        }
    }

    async fn ensure_verified(&self, digest: &Sha256Digest) -> Result<Option<ObjectRecord>, CasError> {
        let Some(record) = self.stat(digest).await? else {
            return Ok(None);
        };
        if record.verify_state == VerifyState::Verified {
            return Ok(Some(record));
        }
        match self.verify(digest).await? {
            VerifyOutcome::Verified => Ok(self.stat(digest).await?),
            VerifyOutcome::Missing | VerifyOutcome::Corrupt => Ok(None),
        }
    }

    /// Re-hashes an object. A mismatch removes it (even if pinned: corrupt
    /// bytes must never be served) so it can be fetched again.
    pub async fn verify(&self, digest: &Sha256Digest) -> Result<VerifyOutcome, CasError> {
        let digest = *digest;
        let Some(record) = self.stat(&digest).await? else {
            return Ok(VerifyOutcome::Missing);
        };
        let path = object_path(&self.inner.cas_dir, &digest);
        let result = tokio::task::spawn_blocking(move || hash_file(&path)).await.map_err(|_| CasError::Task)?;
        let now = self.now();
        match result {
            Ok((actual, size)) if actual == digest && size == record.size_bytes => {
                self.inner.db.run(move |c| repo::mark_verified(c, &digest, now)).await?;
                Ok(VerifyOutcome::Verified)
            }
            Ok(_) => {
                tracing::warn!(component = "cas", event = "object_corrupt", sha256 = %digest.short());
                self.remove_unchecked(&digest).await?;
                Ok(VerifyOutcome::Corrupt)
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                self.inner.db.run(move |c| repo::delete_object(c, &digest)).await?;
                Ok(VerifyOutcome::Missing)
            }
            Err(error) => Err(error.into()),
        }
    }

    fn touch(&self, digest: &Sha256Digest) {
        let now = self.now();
        self.inner.touches.lock().unwrap_or_else(|p| p.into_inner()).insert(*digest, now);
    }

    /// Writes batched access times (call on a cadence and at shutdown).
    pub async fn flush_touches(&self) -> Result<(), CasError> {
        let touches: Vec<(Sha256Digest, Timestamp)> =
            self.inner.touches.lock().unwrap_or_else(|p| p.into_inner()).drain().collect();
        if touches.is_empty() {
            return Ok(());
        }
        self.inner.db.run(move |c| repo::touch_many(c, &touches)).await?;
        Ok(())
    }

    /// Replaces the pins `holder` holds for `reason` with exactly `digests`.
    pub async fn replace_pins(
        &self,
        reason: PinReason,
        holder: &str,
        digests: Vec<Sha256Digest>,
    ) -> Result<(), CasError> {
        let holder = holder.to_owned();
        let now = self.now();
        self.inner.db.run(move |c| repo::replace_pins(c, reason, &holder, &digests, now)).await?;
        Ok(())
    }

    pub async fn usage(&self) -> Result<repo::Usage, CasError> {
        Ok(self.inner.db.run(|c| repo::usage(c)).await?)
    }

    /// Removes an unpinned object.
    pub async fn remove(&self, digest: &Sha256Digest) -> Result<(), CasError> {
        let d = *digest;
        if self.inner.db.run(move |c| repo::is_pinned(c, &d)).await? {
            return Err(CasError::Pinned(*digest));
        }
        self.remove_unchecked(digest).await
    }

    async fn remove_unchecked(&self, digest: &Sha256Digest) -> Result<(), CasError> {
        let d = *digest;
        // Row first: a crash after this leaves an orphan file, which the
        // next reconciliation re-hashes and adopts or deletes.
        self.inner.db.run(move |c| repo::delete_object(c, &d)).await?;
        match tokio::fs::remove_file(object_path(&self.inner.cas_dir, digest)).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
        Ok(())
    }

    /// Frees at least `bytes` by evicting unpinned objects. Returns bytes freed.
    pub async fn evict(&self, bytes: u64) -> Result<u64, CasError> {
        let candidates = self.inner.db.run(|c| repo::eviction_candidates(c, 10_000)).await?;
        let selected = self.inner.eviction.select(&candidates, bytes);
        let mut freed = 0u64;
        for digest in selected {
            let size = candidates.iter().find(|c| c.sha256 == digest).map_or(0, |c| c.size_bytes);
            // Re-checked inside remove(): a pin taken since selection wins.
            match self.remove(&digest).await {
                Ok(()) => {
                    freed += size;
                    tracing::info!(component = "cas", event = "evicted", sha256 = %digest.short(), bytes = size);
                }
                Err(CasError::Pinned(_)) => {}
                Err(error) => return Err(error),
            }
            if freed >= bytes {
                break;
            }
        }
        Ok(freed)
    }

    /// Ensures `needed` more bytes fit under the limit and above the free
    /// space reserve, evicting unpinned objects if necessary.
    async fn make_room(&self, needed: u64) -> Result<(), CasError> {
        let policy = self.policy();
        let usage = self.usage().await?;
        let over_limit = (usage.used_bytes + usage.partial_bytes + needed).saturating_sub(policy.limit_bytes);
        if over_limit > 0 && self.evict(over_limit).await? < over_limit {
            return Err(CasError::OverLimit);
        }
        let available = self.inner.space.available_bytes(&self.inner.partial_dir)?;
        let shortfall = (needed + policy.reserved_free_bytes).saturating_sub(available);
        if shortfall > 0 && self.evict(shortfall).await? < shortfall {
            return Err(CasError::InsufficientSpace { needed });
        }
        Ok(())
    }

    async fn writer_lock(&self, digest: &Sha256Digest) -> OwnedMutexGuard<()> {
        let lock = {
            let mut writers = self.inner.writers.lock().unwrap_or_else(|p| p.into_inner());
            writers.retain(|_, weak| weak.strong_count() > 0);
            match writers.get(digest).and_then(Weak::upgrade) {
                Some(lock) => lock,
                None => {
                    let lock = Arc::new(tokio::sync::Mutex::new(()));
                    writers.insert(*digest, Arc::downgrade(&lock));
                    lock
                }
            }
        };
        lock.lock_owned().await
    }

    /// Starts (or resumes) writing `digest`. Returns `None` if a verified
    /// copy is already present. Waits if another writer holds the digest.
    pub async fn begin_write(
        &self,
        digest: Sha256Digest,
        expected_size: u64,
        meta: IngestMeta,
    ) -> Result<Option<WriteSession>, CasError> {
        let guard = self.writer_lock(&digest).await;
        if self.ensure_verified(&digest).await?.is_some() {
            return Ok(None);
        }
        let path = partial_path(&self.inner.partial_dir, &digest);
        let existing = self.inner.db.run(move |c| repo::get_partial(c, &digest)).await?;
        let on_disk = tokio::fs::metadata(&path).await.map(|m| m.len()).unwrap_or(0);
        let offset = match existing {
            Some(row) if row.expected_size == expected_size && on_disk <= expected_size => on_disk,
            _ => 0,
        };
        self.make_room(expected_size - offset).await?;
        let file = tokio::fs::OpenOptions::new()
            .create(true)
            .truncate(offset == 0)
            .write(true)
            .read(true)
            .open(&path)
            .await?
            .into_std()
            .await;
        let session = WriteSession {
            store: self.clone(),
            _guard: guard,
            digest,
            expected_size,
            meta,
            path,
            file: Some(file),
            written: offset,
        };
        session.persist_partial(None).await?;
        Ok(Some(session))
    }

    /// Imports a local file (legacy cache, fixtures) through the same verified
    /// commit path as a download. The source file is copied, never moved, so
    /// legacy state stays intact for rollback.
    pub async fn import_file(
        &self,
        source: &Path,
        digest: Sha256Digest,
        expected_size: u64,
        meta: IngestMeta,
    ) -> Result<ObjectRecord, CasError> {
        if let Some(mut session) = self.begin_write(digest, expected_size, meta).await? {
            session.restart()?;
            let mut input = std::fs::File::open(source)?;
            let mut buffer = vec![0u8; 1024 * 1024];
            loop {
                let read = input.read(&mut buffer)?;
                if read == 0 {
                    break;
                }
                session.write(&buffer[..read])?;
            }
            session.commit().await
        } else {
            self.stat(&digest).await?.ok_or(CasError::Task)
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum VerifyOutcome {
    Verified,
    Missing,
    Corrupt,
}

/// Exclusive write access to one digest's partial file.
pub struct WriteSession {
    store: ContentStore,
    _guard: OwnedMutexGuard<()>,
    digest: Sha256Digest,
    expected_size: u64,
    meta: IngestMeta,
    path: PathBuf,
    file: Option<std::fs::File>,
    written: u64,
}

impl std::fmt::Debug for WriteSession {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("WriteSession")
            .field("digest", &self.digest)
            .field("written", &self.written)
            .field("expected", &self.expected_size)
            .finish()
    }
}

impl WriteSession {
    pub fn digest(&self) -> Sha256Digest {
        self.digest
    }

    /// Bytes already present (the resume offset).
    pub fn offset(&self) -> u64 {
        self.written
    }

    pub fn expected_size(&self) -> u64 {
        self.expected_size
    }

    fn file(&mut self) -> std::io::Result<&mut std::fs::File> {
        self.file.as_mut().ok_or_else(|| std::io::Error::other("write session closed"))
    }

    /// Discards partial bytes and starts from zero (a source sent the full
    /// object instead of the requested range, or an integrity check failed).
    pub fn restart(&mut self) -> Result<(), CasError> {
        let file = self.file()?;
        file.set_len(0)?;
        file.seek(SeekFrom::Start(0))?;
        self.written = 0;
        Ok(())
    }

    /// Appends bytes. More bytes than expected is an error, and the caller
    /// must abandon the source.
    pub fn write(&mut self, bytes: &[u8]) -> Result<(), CasError> {
        use std::io::Write as _;
        if self.written + bytes.len() as u64 > self.expected_size {
            return Err(CasError::TooLarge { expected: self.expected_size });
        }
        let written = self.written;
        let file = self.file()?;
        file.seek(SeekFrom::Start(written))?;
        file.write_all(bytes)?;
        self.written += bytes.len() as u64;
        Ok(())
    }

    async fn persist_partial(&self, source: Option<&str>) -> Result<(), CasError> {
        let record = PartialRecord {
            sha256: self.digest,
            expected_size: self.expected_size,
            bytes_present: self.written,
            last_source: source.map(str::to_owned),
            source_validator: None,
        };
        let now = self.store.now();
        self.store.inner.db.run(move |c| repo::put_partial(c, &record, now)).await?;
        Ok(())
    }

    /// Keeps the partial for a later resume (after a transient failure).
    pub async fn suspend(mut self, last_source: &str) -> Result<(), CasError> {
        if let Some(file) = self.file.take() {
            file.sync_all()?;
        }
        self.persist_partial(Some(last_source)).await
    }

    /// Deletes the partial entirely.
    pub async fn discard(mut self) -> Result<(), CasError> {
        self.file.take();
        let _ = tokio::fs::remove_file(&self.path).await;
        let digest = self.digest;
        self.store.inner.db.run(move |c| repo::delete_partial(c, &digest)).await?;
        Ok(())
    }

    /// Verifies and promotes the object (crate invariants 1 and 2). On a
    /// size or digest mismatch the partial is deleted and nothing is
    /// promoted.
    pub async fn commit(mut self) -> Result<ObjectRecord, CasError> {
        let file = self.file.take().ok_or(CasError::Task)?;
        file.sync_all()?;
        drop(file);
        let path = self.path.clone();
        let (actual, size) =
            tokio::task::spawn_blocking(move || hash_file(&path)).await.map_err(|_| CasError::Task)??;
        if size != self.expected_size || actual != self.digest {
            let digest = self.digest;
            let _ = tokio::fs::remove_file(&self.path).await;
            self.store.inner.db.run(move |c| repo::delete_partial(c, &digest)).await?;
            return Err(if size != self.expected_size {
                CasError::SizeMismatch { expected: self.expected_size, actual: size }
            } else {
                CasError::DigestMismatch { expected: self.digest }
            });
        }
        let final_path = object_path(&self.store.inner.cas_dir, &self.digest);
        let fanout = final_path.parent().map(Path::to_path_buf).ok_or(CasError::Task)?;
        tokio::fs::create_dir_all(&fanout).await?;
        tokio::fs::rename(&self.path, &final_path).await?;
        fsync_dir(&fanout);
        fsync_dir(&self.store.inner.partial_dir);
        let now = self.store.now();
        let record = ObjectRecord {
            sha256: self.digest,
            size_bytes: self.expected_size,
            domain: self.meta.domain,
            content_type: self.meta.content_type.clone(),
            source_kind: self.meta.source,
            verify_state: VerifyState::Verified,
            verified_at: now,
            created_at: now,
            last_accessed_at: now,
        };
        let stored = record.clone();
        let digest = self.digest;
        self.store
            .inner
            .db
            .run(move |c| {
                repo::put_object(c, &stored)?;
                repo::delete_partial(c, &digest)
            })
            .await?;
        tracing::info!(component = "cas", event = "object_added", sha256 = %self.digest.short(), bytes = self.expected_size);
        Ok(record)
    }
}
