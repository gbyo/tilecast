use std::{env, fs};

fn main() {
    let path = "release/VERSION";
    println!("cargo:rerun-if-changed={path}");
    println!("cargo:rerun-if-env-changed=TILECAST_MACOS_VERSION");
    let version =
        env::var("TILECAST_MACOS_VERSION").unwrap_or_else(|_| fs::read_to_string(path).expect("macOS VERSION"));
    let version = version.trim();
    assert!(!version.is_empty() && !version.contains(['\n', '\r']), "one macOS release version is required");
    println!("cargo:rustc-env=TILECAST_MACOS_RELEASE_VERSION={version}");
}
