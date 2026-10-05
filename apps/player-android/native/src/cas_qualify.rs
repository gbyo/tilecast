//! On-device CAS qualification for Android storage.
//!
//! `player-cas` was qualified on Linux and macOS hosts. This harness proves
//! the same guarantees hold on Android app-private storage: verified commits,
//! size and digest enforcement, symlink refusal, partial resume, crash
//! reconciliation, pin-aware eviction, and free-space reserve behavior. It
//! runs against a scratch directory, never against the live host state, and
//! removes the scratch directory when it finishes.
//!
//! Kotlin drives it through `nativeQualifyCas` from the instrumented
//! qualification test only. Production never calls it.

use std::path::{Path, PathBuf};

use player_cas::space::SpaceProbe;
use player_cas::store::VerifyOutcome;
use player_cas::{CasError, ContentStore, IngestMeta, LruByDomain, StorePolicy};
use player_state::repo::cas::{Domain, PinReason, SourceKind};
use player_state::{OpenOptions, StateDb};
use player_types::Sha256Digest;

use crate::host::{AndroidSecureOpener, StatvfsProbe, SystemClock};

/// One qualification check and its outcome. Details stay short and carry no
/// paths: the scratch location is an app-private implementation detail.
#[derive(Debug)]
pub struct QualCheck {
    pub name: &'static str,
    pub passed: bool,
    pub detail: String,
}

impl QualCheck {
    fn pass(name: &'static str, detail: impl Into<String>) -> Self {
        Self { name, passed: true, detail: detail.into() }
    }

    fn fail(name: &'static str, detail: impl Into<String>) -> Self {
        Self { name, passed: false, detail: detail.into() }
    }
}

/// Small store limit so the eviction checks run with kilobyte objects.
const QUALIFY_LIMIT_BYTES: u64 = 8 * 1024;

fn meta() -> IngestMeta {
    IngestMeta { domain: Domain::Media, content_type: None, source: SourceKind::Local }
}

fn payload(tag: &str, size: usize) -> Vec<u8> {
    let mut bytes = format!("tilecast-cas-qualify:{tag}:").into_bytes();
    bytes.resize(size, 0xA5);
    bytes
}

async fn open_scratch(scratch: &Path) -> Result<(StateDb, ContentStore, PathBuf, PathBuf), String> {
    let cas_dir = scratch.join("cas");
    let partial_dir = scratch.join("partial");
    let db =
        StateDb::open(scratch.join("state.db"), OpenOptions::default()).map_err(|_| "state open failed".to_owned())?;
    let clock = std::sync::Arc::new(SystemClock);
    let policy = StorePolicy { limit_bytes: QUALIFY_LIMIT_BYTES, reserved_free_bytes: 0 };
    let store = ContentStore::open(
        cas_dir.clone(),
        partial_dir.clone(),
        db.clone(),
        clock,
        std::sync::Arc::new(StatvfsProbe),
        std::sync::Arc::new(AndroidSecureOpener),
        policy,
        std::sync::Arc::new(LruByDomain),
    )
    .await
    .map_err(|_| "cas open failed".to_owned())?;
    Ok((db, store, cas_dir, partial_dir))
}

async fn check_space_probe(partial_dir: &Path) -> QualCheck {
    let name = "space_probe";
    match StatvfsProbe.available_bytes(partial_dir) {
        Ok(bytes) if bytes > 0 => QualCheck::pass(name, format!("{bytes} bytes available")),
        Ok(_) => QualCheck::fail(name, "probe reported zero bytes"),
        Err(_) => QualCheck::fail(name, "probe failed"),
    }
}

async fn check_commit_and_serve(store: &ContentStore) -> QualCheck {
    let name = "commit_and_serve";
    let bytes = payload("serve", 2048);
    let digest = Sha256Digest::of(&bytes);
    let outcome: Result<String, String> = async {
        let mut session = store
            .begin_write(digest, bytes.len() as u64, meta())
            .await
            .map_err(|_| "begin failed")?
            .ok_or("already present")?;
        session.write(&bytes).map_err(|_| "write failed")?;
        let record = session.commit().await.map_err(|_| "commit failed")?;
        if record.sha256 != digest || record.size_bytes != bytes.len() as u64 {
            return Err("record mismatch".to_owned());
        }
        let path = store.verified_path(&digest).await.map_err(|_| "verified_path failed")?;
        if path.is_none() {
            return Err("no verified path".to_owned());
        }
        let served = store.open_verified(&digest).await.map_err(|_| "open failed")?;
        let Some((mut file, _)) = served else { return Err("not served".to_owned()) };
        use std::io::Read as _;
        let mut back = Vec::new();
        file.read_to_end(&mut back).map_err(|_| "read failed")?;
        if back != bytes {
            return Err("served bytes differ".to_owned());
        }
        Ok(format!("{} bytes round-tripped", bytes.len()))
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_size_bound(store: &ContentStore) -> QualCheck {
    let name = "size_bound";
    let bytes = payload("size", 512);
    let digest = Sha256Digest::of(&bytes);
    let outcome: Result<String, String> = async {
        let mut session =
            store.begin_write(digest, 16, meta()).await.map_err(|_| "begin failed")?.ok_or("already present")?;
        match session.write(&bytes) {
            Err(CasError::TooLarge { expected: 16 }) => {}
            Err(_) => return Err("wrong oversize error".to_owned()),
            Ok(()) => return Err("oversize write accepted".to_owned()),
        }
        session.discard().await.map_err(|_| "discard failed")?;
        let mut session = store
            .begin_write(digest, bytes.len() as u64 + 1, meta())
            .await
            .map_err(|_| "begin failed")?
            .ok_or("already present")?;
        session.write(&bytes).map_err(|_| "write failed")?;
        match session.commit().await {
            Err(CasError::SizeMismatch { .. }) => {}
            Err(_) => return Err("wrong short-commit error".to_owned()),
            Ok(_) => return Err("short commit accepted".to_owned()),
        }
        Ok("oversize and short writes rejected".to_owned())
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_digest_enforced(store: &ContentStore) -> QualCheck {
    let name = "digest_enforced";
    let bytes = payload("digest", 1024);
    let mut tampered = bytes.clone();
    tampered[100] ^= 0xFF;
    let digest = Sha256Digest::of(&bytes);
    let outcome: Result<String, String> = async {
        let mut session = store
            .begin_write(digest, bytes.len() as u64, meta())
            .await
            .map_err(|_| "begin failed")?
            .ok_or("already present")?;
        session.write(&tampered).map_err(|_| "write failed")?;
        match session.commit().await {
            Err(CasError::DigestMismatch { .. }) => {}
            Err(_) => return Err("wrong digest error".to_owned()),
            Ok(_) => return Err("wrong bytes committed".to_owned()),
        }
        if store.stat(&digest).await.map_err(|_| "stat failed")?.is_some() {
            return Err("rejected bytes left a record".to_owned());
        }
        Ok("digest mismatch rejected".to_owned())
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_tamper_detected(store: &ContentStore, scratch: &Path) -> QualCheck {
    let name = "tamper_detected";
    let bytes = payload("tamper", 1024);
    let digest = Sha256Digest::of(&bytes);
    let outcome: Result<String, String> = async {
        let mut session = store
            .begin_write(digest, bytes.len() as u64, meta())
            .await
            .map_err(|_| "begin failed")?
            .ok_or("already present")?;
        session.write(&bytes).map_err(|_| "write failed")?;
        session.commit().await.map_err(|_| "commit failed")?;
        let path = store.verified_path(&digest).await.map_err(|_| "no path")?.ok_or("no path")?;
        if !path.starts_with(scratch) {
            return Err("path escapes scratch".to_owned());
        }
        let mut damaged = bytes.clone();
        damaged[0] ^= 0xFF;
        std::fs::write(&path, &damaged).map_err(|_| "tamper write failed")?;
        match store.verify(&digest).await.map_err(|_| "verify failed")? {
            VerifyOutcome::Corrupt => {}
            _ => return Err("tamper not reported corrupt".to_owned()),
        }
        if store.stat(&digest).await.map_err(|_| "stat failed")?.is_some() {
            return Err("corrupt object still listed".to_owned());
        }
        Ok("tampered object quarantined".to_owned())
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_symlink_import_refused(store: &ContentStore, scratch: &Path) -> QualCheck {
    let name = "symlink_import_refused";
    let outcome: Result<String, String> = async {
        let target = scratch.join("import-target");
        let bytes = payload("link-target", 256);
        std::fs::write(&target, &bytes).map_err(|_| "target write failed")?;
        let digest = Sha256Digest::of(&bytes);
        let link = scratch.join("import-link");
        #[cfg(unix)]
        std::os::unix::fs::symlink(&target, &link).map_err(|_| "symlink failed")?;
        #[cfg(not(unix))]
        return Err("symlinks unavailable".to_owned());
        match store.import_file(&link, digest, bytes.len() as u64, meta()).await {
            Err(CasError::SizeMismatch { .. }) => {}
            Err(_) => return Err("wrong link-import error".to_owned()),
            Ok(_) => return Err("symlink imported".to_owned()),
        }
        match store.import_file(scratch, digest, bytes.len() as u64, meta()).await {
            Err(CasError::SizeMismatch { .. }) => {}
            Err(_) => return Err("wrong directory-import error".to_owned()),
            Ok(_) => return Err("directory imported".to_owned()),
        }
        let record = store
            .import_file(&target, digest, bytes.len() as u64, meta())
            .await
            .map_err(|_| "regular import failed")?;
        if record.sha256 != digest {
            return Err("imported record mismatch".to_owned());
        }
        Ok("links and directories refused, regular file imported".to_owned())
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_symlink_object_not_served(store: &ContentStore) -> QualCheck {
    let name = "symlink_object_not_served";
    let bytes = payload("link-object", 512);
    let digest = Sha256Digest::of(&bytes);
    let outcome: Result<String, String> = async {
        let mut session = store
            .begin_write(digest, bytes.len() as u64, meta())
            .await
            .map_err(|_| "begin failed")?
            .ok_or("already present")?;
        session.write(&bytes).map_err(|_| "write failed")?;
        session.commit().await.map_err(|_| "commit failed")?;
        let path = store.verified_path(&digest).await.map_err(|_| "no path")?.ok_or("no path")?;
        let backup = path.with_extension("bak");
        std::fs::rename(&path, &backup).map_err(|_| "backup failed")?;
        #[cfg(unix)]
        std::os::unix::fs::symlink(&backup, &path).map_err(|_| "symlink failed")?;
        #[cfg(not(unix))]
        return Err("symlinks unavailable".to_owned());
        let served = store.open_verified(&digest).await;
        let _ = std::fs::remove_file(&path);
        let _ = std::fs::remove_file(&backup);
        let served = served.map_err(|_| "open failed")?;
        if served.is_some() {
            return Err("symlinked object served".to_owned());
        }
        Ok("symlinked object refused".to_owned())
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

/// Writes half of `digest` and drops the session without suspending, which
/// is what a crash leaves behind. Returns the payload for the resume half.
async fn crash_partial_write(store: &ContentStore) -> Result<(Sha256Digest, Vec<u8>), QualCheck> {
    let bytes = payload("crash", 2048);
    let digest = Sha256Digest::of(&bytes);
    let half = bytes.len() / 2;
    let opened = store
        .begin_write(digest, bytes.len() as u64, meta())
        .await
        .map_err(|_| QualCheck::fail("crash_resume", "begin failed"))?;
    let Some(mut session) = opened else {
        return Err(QualCheck::fail("crash_resume", "already present"));
    };
    session.write(&bytes[..half]).map_err(|_| QualCheck::fail("crash_resume", "write failed"))?;
    Ok((digest, bytes))
}

async fn check_crash_resume(store: &ContentStore, digest: Sha256Digest, bytes: &[u8]) -> QualCheck {
    let name = "crash_resume";
    let outcome: Result<String, String> = async {
        let opened = store.begin_write(digest, bytes.len() as u64, meta()).await.map_err(|_| "reopen begin failed")?;
        let Some(mut session) = opened else { return Err("crashed write looks complete".to_owned()) };
        let offset = session.offset() as usize;
        if offset != bytes.len() / 2 {
            return Err(format!("resumed at {offset}, expected half"));
        }
        session.write(&bytes[offset..]).map_err(|_| "write failed")?;
        let record = session.commit().await.map_err(|_| "commit failed")?;
        if record.sha256 != digest {
            return Err("resumed record mismatch".to_owned());
        }
        Ok(format!("resumed at {offset} bytes after reopen"))
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_pins_survive_eviction(store: &ContentStore) -> QualCheck {
    let name = "pins_survive_eviction";
    let outcome: Result<String, String> = async {
        store.set_policy(StorePolicy { limit_bytes: QUALIFY_LIMIT_BYTES, reserved_free_bytes: 0 });
        let pinned_bytes = payload("pinned", 2048);
        let pinned = Sha256Digest::of(&pinned_bytes);
        let mut session = store
            .begin_write(pinned, pinned_bytes.len() as u64, meta())
            .await
            .map_err(|_| "begin failed")?
            .ok_or("already present")?;
        session.write(&pinned_bytes).map_err(|_| "write failed")?;
        session.commit().await.map_err(|_| "commit failed")?;
        store.replace_pins(PinReason::Manual, "qualify", vec![pinned]).await.map_err(|_| "pin failed")?;
        for index in 0..6 {
            let bytes = payload(&format!("evict-{index}"), 2048);
            let digest = Sha256Digest::of(&bytes);
            let opened = store.begin_write(digest, bytes.len() as u64, meta()).await.map_err(|_| "begin failed")?;
            let Some(mut session) = opened else { continue };
            session.write(&bytes).map_err(|_| "write failed")?;
            session.commit().await.map_err(|_| "commit failed")?;
        }
        if store.stat(&pinned).await.map_err(|_| "stat failed")?.is_none() {
            return Err("pinned object evicted".to_owned());
        }
        let usage = store.usage().await.map_err(|_| "usage failed")?;
        if usage.used_bytes > QUALIFY_LIMIT_BYTES {
            return Err(format!("store holds {} bytes over the limit", usage.used_bytes));
        }
        store.replace_pins(PinReason::Manual, "qualify", Vec::new()).await.map_err(|_| "unpin failed")?;
        Ok(format!("pinned object kept, store holds {} bytes", usage.used_bytes))
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_space_reserve(store: &ContentStore, partial_dir: &Path) -> QualCheck {
    let name = "space_reserve";
    let outcome: Result<String, String> = async {
        let available = StatvfsProbe.available_bytes(partial_dir).map_err(|_| "probe failed")?;
        store.set_policy(StorePolicy {
            limit_bytes: u64::MAX,
            reserved_free_bytes: available.saturating_add(1024 * 1024),
        });
        let bytes = payload("reserve", 1024);
        let digest = Sha256Digest::of(&bytes);
        match store.begin_write(digest, bytes.len() as u64, meta()).await {
            Err(CasError::InsufficientSpace { .. }) => {}
            Err(_) => return Err("wrong reserve error".to_owned()),
            Ok(_) => return Err("write allowed below the reserve".to_owned()),
        }
        store.set_policy(StorePolicy { limit_bytes: u64::MAX, reserved_free_bytes: 0 });
        let opened = store.begin_write(digest, bytes.len() as u64, meta()).await.map_err(|_| "begin failed")?;
        if let Some(session) = opened {
            session.discard().await.map_err(|_| "discard failed")?;
        }
        Ok(format!("reserve enforced with {available} bytes free"))
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

async fn check_remove_refuses_pinned(store: &ContentStore) -> QualCheck {
    let name = "remove_refuses_pinned";
    let bytes = payload("remove", 512);
    let digest = Sha256Digest::of(&bytes);
    let outcome: Result<String, String> = async {
        let mut session = store
            .begin_write(digest, bytes.len() as u64, meta())
            .await
            .map_err(|_| "begin failed")?
            .ok_or("already present")?;
        session.write(&bytes).map_err(|_| "write failed")?;
        session.commit().await.map_err(|_| "commit failed")?;
        store.replace_pins(PinReason::Manual, "qualify", vec![digest]).await.map_err(|_| "pin failed")?;
        match store.remove(&digest).await {
            Err(CasError::Pinned(_)) => {}
            Err(_) => return Err("wrong pinned-remove error".to_owned()),
            Ok(()) => return Err("pinned object removed".to_owned()),
        }
        store.replace_pins(PinReason::Manual, "qualify", Vec::new()).await.map_err(|_| "unpin failed")?;
        store.remove(&digest).await.map_err(|_| "remove failed")?;
        if store.stat(&digest).await.map_err(|_| "stat failed")?.is_some() {
            return Err("removed object still listed".to_owned());
        }
        Ok("pinned remove refused, unpinned remove kept".to_owned())
    }
    .await;
    match outcome {
        Ok(detail) => QualCheck::pass(name, detail),
        Err(detail) => QualCheck::fail(name, detail),
    }
}

/// Runs the full checklist against `scratch`, which is cleared first and
/// removed afterwards. Every check is independent: one failure never stops
/// the rest.
pub async fn qualify(scratch: &Path) -> Vec<QualCheck> {
    let mut checks = Vec::new();
    let _ = std::fs::remove_dir_all(scratch);
    if std::fs::create_dir_all(scratch).is_err() {
        checks.push(QualCheck::fail("scratch_unusable", "scratch dir failed"));
        return checks;
    }
    let opened = open_scratch(scratch).await;
    let Ok((db, store, _cas_dir, partial_dir)) = opened else {
        checks.push(QualCheck::fail("open_store", "scratch store failed"));
        return checks;
    };
    checks.push(check_space_probe(&partial_dir).await);
    checks.push(check_commit_and_serve(&store).await);
    checks.push(check_size_bound(&store).await);
    checks.push(check_digest_enforced(&store).await);
    checks.push(check_tamper_detected(&store, scratch).await);
    checks.push(check_symlink_import_refused(&store, scratch).await);
    checks.push(check_symlink_object_not_served(&store).await);
    let crashed = crash_partial_write(&store).await;
    drop(store);
    drop(db);
    let reopened = open_scratch(scratch).await;
    let Ok((_db, store, _cas, partial_dir)) = reopened else {
        checks.push(QualCheck::fail("crash_resume", "reopen failed"));
        return checks;
    };
    match crashed {
        Ok((digest, bytes)) => checks.push(check_crash_resume(&store, digest, &bytes).await),
        Err(check) => checks.push(check),
    }
    checks.push(check_pins_survive_eviction(&store).await);
    checks.push(check_space_reserve(&store, &partial_dir).await);
    checks.push(check_remove_refuses_pinned(&store).await);
    drop(store);
    match std::fs::remove_dir_all(scratch) {
        Ok(()) => checks.push(QualCheck::pass("cleanup", "scratch removed")),
        Err(_) => checks.push(QualCheck::fail("cleanup", "scratch left behind")),
    }
    checks
}

/// The bridge envelope: `ok` is true only when every check passed.
pub fn report_json(checks: &[QualCheck]) -> serde_json::Value {
    let ok = !checks.is_empty() && checks.iter().all(|check| check.passed);
    serde_json::json!({
        "ok": ok,
        "checks": checks.iter().map(|check| serde_json::json!({
            "name": check.name,
            "passed": check.passed,
            "detail": check.detail,
        })).collect::<Vec<_>>(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn runtime() -> tokio::runtime::Runtime {
        tokio::runtime::Builder::new_current_thread().enable_all().build().expect("runtime")
    }

    #[test]
    fn checklist_passes_on_host_storage() {
        let dir = tempfile::tempdir().expect("tempdir");
        let checks = runtime().block_on(qualify(&dir.path().join("cas-qualify")));
        let failed: Vec<&str> = checks.iter().filter(|check| !check.passed).map(|check| check.name).collect();
        assert!(failed.is_empty(), "failed checks: {failed:?}");
        assert!(checks.len() >= 12, "checklist shrank: {}", checks.len());
        assert!(!dir.path().join("cas-qualify").exists());
    }

    #[test]
    fn report_marks_any_failure() {
        let checks = vec![QualCheck::pass("a", "fine"), QualCheck::fail("b", "broken")];
        let report = report_json(&checks);
        assert_eq!(report["ok"], false);
        assert_eq!(report["checks"][1]["name"], "b");
        assert_eq!(report["checks"][1]["passed"], false);
    }

    #[test]
    fn empty_checklist_is_not_ok() {
        assert_eq!(report_json(&[])["ok"], false);
    }
}
