use std::{env, fs};

fn main() {
    let path = "release/VERSION";
    println!("cargo:rerun-if-changed={path}");
    println!("cargo:rerun-if-env-changed=TILECAST_WINDOWS_VERSION");
    let version =
        env::var("TILECAST_WINDOWS_VERSION").unwrap_or_else(|_| fs::read_to_string(path).expect("Windows VERSION"));
    let version = version.trim();
    assert!(!version.is_empty() && !version.contains(['\n', '\r']), "one Windows release version is required");
    println!("cargo:rustc-env=TILECAST_WINDOWS_RELEASE_VERSION={version}");
}
