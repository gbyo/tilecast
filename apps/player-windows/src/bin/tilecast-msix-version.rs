//! Prints the release versions for a Tilecast release: the single
//! implementation of the version mapping, so the release build never
//! re-derives it in shell.
//!
//! Usage: `tilecast-msix-version <versionName> <stable|beta> [--json]`
//! Prints `Major.Minor.Build.Revision` and exits 0, or explains why the
//! release has no package version and exits 1. With `--json`, prints
//! the version code and package version as JSON for the release build.

fn main() {
    let mut args = std::env::args_os().skip(1);
    let (Some(version), Some(channel), rest) = (args.next(), args.next(), args.next()) else {
        eprintln!("usage: tilecast-msix-version <versionName> <stable|beta> [--json]");
        std::process::exit(2);
    };
    let json = match rest.as_deref().map(|arg| arg.to_str()) {
        None => false,
        Some(Some("--json")) => true,
        _ => {
            eprintln!("usage: tilecast-msix-version <versionName> <stable|beta> [--json]");
            std::process::exit(2);
        }
    };
    let (Some(version), Some(channel)) = (version.to_str(), channel.to_str()) else {
        eprintln!("tilecast-msix-version: arguments must be UTF-8");
        std::process::exit(1);
    };
    let mapped = tilecast_windows::update::msix_version(version, channel);
    let code = tilecast_windows::update::version_code(version);
    match (mapped, code) {
        (Some(mapped), Some(code)) => {
            if json {
                println!(r#"{{"versionCode":{code},"packageVersion":"{mapped}"}}"#);
            } else {
                println!("{mapped}");
            }
        }
        _ => {
            eprintln!("tilecast-msix-version: {version} ({channel}) has no MSIX package version");
            std::process::exit(1);
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn mapping_matches_the_library() {
        assert_eq!(tilecast_windows::update::msix_version("0.2.0", "stable").expect("maps").to_string(), "0.2.0.2");
    }
}
