#![allow(clippy::unwrap_used)]

//! One serial lifecycle: the process holds a single live host, so the whole
//! open/drivers/close sequence runs in one test. Stores and facts are
//! in-memory fakes; no JNI, Keystore, or network is touched.

use std::path::Path;
use std::sync::Arc;

use tilecast_player_core::host::{close_host, open_host_with, with_host};
use tilecast_player_core::pairing_host::MemMetadataSource;
use tilecast_player_core::stores::MemStoreCalls;

const USER_AGENT: &str = "Tilecast-Player-Android/0.25.0 (test)";

fn open(files_dir: &Path) -> i64 {
    let calls = Arc::new(MemStoreCalls::default());
    let meta = Arc::new(MemMetadataSource::with_facts(
        r#"{"manufacturer":"test","model":"test","osRelease":"14","playerVersion":"0.25.0","screenWidth":1920,"screenHeight":1080,"locale":"en-US","timezone":"UTC"}"#,
    ));
    open_host_with(files_dir, calls, meta, USER_AGENT, None).expect("open")
}

#[test]
fn host_lifecycle_opens_state_cas_and_core() {
    let files = tempfile::tempdir().unwrap();
    let files_dir = files.path().join("files");
    std::fs::create_dir_all(&files_dir).unwrap();

    let handle = open(&files_dir);
    assert_eq!(handle, 1);

    // A second open fails while the first host is alive: one Core per process.
    let calls = Arc::new(MemStoreCalls::default());
    let meta = Arc::new(MemMetadataSource::with_facts("{}"));
    assert!(open_host_with(&files_dir, calls, meta, USER_AGENT, None).is_err());

    let status = with_host(handle, |host| host.status()).expect("status");
    // Readers run without the global lock held: a nested read on the same
    // thread completes instead of deadlocking on the live-host mutex.
    with_host(handle, |_| with_host(handle, |_| ()).expect("nested read")).expect("outer read");
    assert_eq!(status["bridge"], 2);
    assert_eq!(status["ok"], true);
    assert_eq!(status["paired"], false);
    assert!(status["stateDb"].as_str().expect("stateDb").ends_with("player-core/state.db"));
    assert!(status["casDir"].as_str().expect("casDir").ends_with("player-core/cas"));

    // Storage really opened: the Core database and CAS layout exist.
    let root = files_dir.join("player-core");
    assert!(root.join("state.db").is_file(), "state.db created");
    assert!(root.join("cas").join("sha256").is_dir(), "cas layout created");
    assert!(root.join("partial").is_dir(), "partial layout created");
    // The legacy Room file is untouched: Core never reuses it.
    assert!(!root.join("tilecast.db").exists(), "no Room reuse");

    // Drivers start idempotently; reset on a fresh host is a safe no-op.
    with_host(handle, |host| host.start_drivers()).expect("start");
    with_host(handle, |host| host.start_drivers()).expect("start again");
    with_host(handle, |host| host.reset_pairing()).expect("reset");

    close_host(handle).expect("close");
    assert!(with_host(handle, |_| ()).is_err(), "closed host is gone");
    assert!(close_host(handle).is_err(), "double close fails");

    // Reopen proves close released the singleton.
    let again = open(&files_dir);
    assert_eq!(again, 1);
    close_host(again).expect("close again");
}

#[test]
fn open_rejects_unusable_dirs_and_agents() {
    let calls = Arc::new(MemStoreCalls::default());
    let meta = Arc::new(MemMetadataSource::with_facts("{}"));
    assert!(open_host_with(Path::new(""), calls, meta, USER_AGENT, None).is_err());
    let calls = Arc::new(MemStoreCalls::default());
    let meta = Arc::new(MemMetadataSource::with_facts("{}"));
    assert!(open_host_with(Path::new("relative/path"), calls, meta, USER_AGENT, None).is_err());
    let files = tempfile::tempdir().unwrap();
    let calls = Arc::new(MemStoreCalls::default());
    let meta = Arc::new(MemMetadataSource::with_facts("{}"));
    assert!(open_host_with(files.path(), calls, meta, "", None).is_err());
}
