//! Proof: the Rust allowlist loader accepts the real built Runtime.
//! Needs `npm run build:runtime --workspace @tilecast/player-runtime` first;
//! without the bundle it passes vacuously, like the database-gated tests
//! without a database, unless `TILECAST_REQUIRE_BUILT_RUNTIME` is set, as CI
//! sets it.
use std::path::PathBuf;

#[test]
fn the_built_runtime_loads_and_verifies() {
    let dir = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../packages/player-runtime/dist/runtime");
    if !dir.join("runtime-manifest.json").is_file() {
        assert!(std::env::var_os("TILECAST_REQUIRE_BUILT_RUNTIME").is_none(), "no built runtime at {}", dir.display());
        println!("no built runtime; run npm run build:runtime --workspace @tilecast/player-runtime");
        return;
    }
    let loaded = tilecast_windows::runtime_files::RuntimeFiles::load(&dir).expect("loads");
    assert!(loaded.files.contains_key("index.html"));
    assert!(loaded.files.contains_key("runtime.js"));
    assert_eq!(loaded.version, "0.1.0");
    println!("runtime {}: {} files verified", loaded.version, loaded.files.len());
}
