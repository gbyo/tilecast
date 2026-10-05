use std::{env, fs};

fn main() {
    let path = "../../release/VERSION";
    println!("cargo:rerun-if-changed={path}");
    println!("cargo:rerun-if-env-changed=TILECAST_EDGE_VERSION");
    let version = env::var("TILECAST_EDGE_VERSION").unwrap_or_else(|_| fs::read_to_string(path).expect("Edge VERSION"));
    let version = version.trim();
    assert!(!version.is_empty() && !version.contains(['\n', '\r']), "one Edge release version is required");
    println!("cargo:rustc-env=TILECAST_EDGE_RELEASE_VERSION={version}");
}
