//! MSIX package identity checks for updates: the player reads the
//! downloaded package's `AppxManifest.xml` and confirms its identity
//! matches the verified envelope before deployment. Name, architecture,
//! and version are the player's checks; Windows verifies the package
//! signature and publisher trust at deployment time.

use std::io::Read as _;
use std::path::Path;

/// The one stable MSIX package identity.
pub const PACKAGE_NAME: &str = "Tilecast.TilecastPlayer";
const MANIFEST_PATH: &str = "AppxManifest.xml";
/// Far above a real manifest; bounds the XML scan.
const MAX_MANIFEST_BYTES: u64 = 256 * 1024;

/// The package `<Identity>`: name, architecture, version, publisher.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackageIdentity {
    pub name: String,
    pub architecture: String,
    pub version: crate::update::MsixVersion,
    pub publisher: String,
}

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum MsixError {
    #[error("the package cannot be read: {0}")]
    Unreadable(String),
    #[error("the package has no manifest")]
    ManifestMissing,
    #[error("the package manifest is invalid")]
    ManifestInvalid,
    #[error("the package is for another application: {0}")]
    WrongName(String),
    #[error("the package is for another architecture: {0}")]
    WrongArchitecture(String),
    #[error("the package version does not match the release: {0}")]
    WrongVersion(String),
}

/// The MSIX processor architecture for an envelope architecture.
pub fn msix_arch(envelope_arch: &str) -> Option<&'static str> {
    match envelope_arch {
        "x86_64" => Some("x64"),
        "aarch64" => Some("arm64"),
        _ => None,
    }
}

/// The `file:///` URI of a local drive-letter package path, for the
/// deployment API. `None` for anything that is not an absolute local
/// path with a Unicode file name.
pub fn package_uri(msix: &Path) -> Option<String> {
    use std::path::{Component, Prefix};
    let mut parts = msix.components();
    let disk = match parts.next()? {
        Component::Prefix(prefix) => match prefix.kind() {
            Prefix::Disk(disk) => disk as char,
            _ => return None,
        },
        _ => return None,
    };
    let mut uri = format!("file:///{disk}:");
    for part in parts {
        match part {
            Component::RootDir => continue,
            Component::Normal(name) => {
                uri.push('/');
                for byte in name.to_str()?.bytes() {
                    match byte {
                        b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                            uri.push(byte as char);
                        }
                        _ => uri.push_str(&format!("%{byte:02X}")),
                    }
                }
            }
            _ => return None,
        }
    }
    Some(uri)
}

/// Reads the package identity from the manifest inside the package. The
/// manifest is bounded; only the `<Identity>` element is scanned.
pub fn read_identity(msix: &Path) -> Result<PackageIdentity, MsixError> {
    let file = std::fs::File::open(msix).map_err(|error| MsixError::Unreadable(error.to_string()))?;
    let mut archive = zip::ZipArchive::new(file).map_err(|error| MsixError::Unreadable(error.to_string()))?;
    let manifest = archive.by_name(MANIFEST_PATH).map_err(|error| match error {
        zip::result::ZipError::FileNotFound => MsixError::ManifestMissing,
        other => MsixError::Unreadable(other.to_string()),
    })?;
    if manifest.size() > MAX_MANIFEST_BYTES {
        return Err(MsixError::ManifestInvalid);
    }
    let mut xml = String::new();
    manifest.take(MAX_MANIFEST_BYTES).read_to_string(&mut xml).map_err(|_| MsixError::ManifestInvalid)?;
    parse_identity(&xml)
}

/// Confirms the package is this application, for this architecture, at
/// the release version. The publisher is Windows' check at deployment.
pub fn check_identity(
    identity: &PackageIdentity,
    expected_version: crate::update::MsixVersion,
    envelope_arch: &str,
) -> Result<(), MsixError> {
    if identity.name != PACKAGE_NAME {
        return Err(MsixError::WrongName(identity.name.clone()));
    }
    let arch = msix_arch(envelope_arch).ok_or_else(|| MsixError::WrongArchitecture(envelope_arch.to_owned()))?;
    if identity.architecture != arch {
        return Err(MsixError::WrongArchitecture(identity.architecture.clone()));
    }
    if identity.version != expected_version {
        return Err(MsixError::WrongVersion(identity.version.to_string()));
    }
    Ok(())
}

/// The `<Identity>` attributes, in document order. A small cursor
/// parser: values may contain anything except their own quote, so a
/// substring search would misread them.
fn attributes(element: &str) -> Option<Vec<(String, String)>> {
    let mut rest = element.strip_prefix("<Identity")?;
    let mut out = Vec::new();
    loop {
        rest = rest.trim_start();
        if rest.is_empty() || rest.starts_with(['/', '>']) {
            return Some(out);
        }
        let end = rest.find('=')?;
        let name = rest[..end].trim_end();
        if name.is_empty() || !name.bytes().all(|b| b.is_ascii_alphanumeric()) {
            return None;
        }
        rest = &rest[end + 1..];
        let quote = rest.chars().next()?;
        if quote != '"' && quote != '\'' {
            return None;
        }
        let end = rest[1..].find(quote)?;
        out.push((name.to_owned(), rest[1..1 + end].to_owned()));
        rest = &rest[1 + end + 1..];
    }
}

fn parse_identity(xml: &str) -> Result<PackageIdentity, MsixError> {
    let start = xml.find("<Identity").ok_or(MsixError::ManifestInvalid)?;
    // An attribute boundary: `<Identity` must not be a prefix of a
    // longer element name.
    if xml[start + "<Identity".len()..].chars().next().is_some_and(|c| c.is_alphanumeric()) {
        return Err(MsixError::ManifestInvalid);
    }
    let rest = &xml[start..];
    let end = rest.find('>').ok_or(MsixError::ManifestInvalid)?;
    if end > 4096 {
        return Err(MsixError::ManifestInvalid);
    }
    let found = attributes(&rest[..end]).ok_or(MsixError::ManifestInvalid)?;
    let get = |name: &str| found.iter().find(|(key, _)| key == name).map(|(_, value)| value.clone());
    Ok(PackageIdentity {
        name: get("Name").ok_or(MsixError::ManifestInvalid)?,
        architecture: get("ProcessorArchitecture").ok_or(MsixError::ManifestInvalid)?,
        version: parse_version(&get("Version").ok_or(MsixError::ManifestInvalid)?).ok_or(MsixError::ManifestInvalid)?,
        publisher: get("Publisher").ok_or(MsixError::ManifestInvalid)?,
    })
}

fn parse_version(value: &str) -> Option<crate::update::MsixVersion> {
    let mut parts = value.split('.');
    let version = crate::update::MsixVersion {
        major: parts.next()?.parse().ok()?,
        minor: parts.next()?.parse().ok()?,
        build: parts.next()?.parse().ok()?,
        revision: parts.next()?.parse().ok()?,
    };
    if parts.next().is_some() {
        return None;
    }
    Some(version)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn manifest(name: &str, arch: &str, version: &str) -> String {
        format!(
            concat!(
                r#"<?xml version="1.0" encoding="utf-8"?>"#,
                r#"<Package xmlns="http://schemas.microsoft.com/appx/manifest/foundation/windows10">"#,
                r#"<Identity Name="{name}" ProcessorArchitecture="{arch}" Publisher="CN=Tilecast" Version="{version}" />"#,
                r#"</Package>"#,
            ),
            name = name,
            arch = arch,
            version = version
        )
    }

    fn package(dir: &std::path::Path, xml: Option<&str>) -> std::path::PathBuf {
        let path = dir.join("tilecast-windows-0.2.0-x86_64.msix");
        let file = std::fs::File::create(&path).expect("package file");
        let mut writer = zip::ZipWriter::new(file);
        if let Some(xml) = xml {
            writer.start_file(MANIFEST_PATH, zip::write::SimpleFileOptions::default()).expect("zip entry");
            std::io::Write::write_all(&mut writer, xml.as_bytes()).expect("zip write");
        }
        writer.finish().expect("zip finish");
        path
    }

    fn tempdir() -> tempfile::TempDir {
        tempfile::tempdir().expect("tempdir")
    }

    #[test]
    fn matching_packages_verify() {
        let dir = tempdir();
        let path = package(dir.path(), Some(&manifest(PACKAGE_NAME, "x64", "0.2.0.2")));
        let identity = read_identity(&path).expect("identity");
        assert_eq!(identity.publisher, "CN=Tilecast");
        let expected = crate::update::msix_version("0.2.0", "stable").expect("maps");
        assert_eq!(identity.version, expected);
        check_identity(&identity, expected, "x86_64").expect("matches");
    }

    #[test]
    fn mismatched_packages_are_refused() {
        let dir = tempdir();
        let expected = crate::update::msix_version("0.2.0", "stable").expect("maps");
        for (name, arch, version, error) in [
            ("Tilecast.Other", "x64", "0.2.0.2", "name"),
            (PACKAGE_NAME, "arm64", "0.2.0.2", "arch"),
            (PACKAGE_NAME, "x64", "0.2.0.1", "beta revision"),
            (PACKAGE_NAME, "x64", "0.3.0.2", "newer"),
        ] {
            let path = package(dir.path(), Some(&manifest(name, arch, version)));
            let identity = read_identity(&path).expect("identity");
            assert!(check_identity(&identity, expected, "x86_64").is_err(), "{error}");
        }
    }

    #[test]
    fn broken_packages_are_refused() {
        let dir = tempdir();
        let missing = package(dir.path(), None);
        assert!(matches!(read_identity(&missing), Err(MsixError::ManifestMissing)));
        let corrupt = dir.path().join("corrupt.msix");
        std::fs::write(&corrupt, b"not a zip").expect("fixture");
        assert!(matches!(read_identity(&corrupt), Err(MsixError::Unreadable(_))));
        let absent = dir.path().join("absent.msix");
        assert!(matches!(read_identity(&absent), Err(MsixError::Unreadable(_))));
        for (xml, why) in [
            ("<Package></Package>", "no identity"),
            (&manifest(PACKAGE_NAME, "x64", "0.2"), "short version"),
            (&manifest(PACKAGE_NAME, "x64", "0.2.0.2.5"), "long version"),
        ] {
            let path = package(dir.path(), Some(xml));
            assert!(matches!(read_identity(&path), Err(MsixError::ManifestInvalid)), "{why}");
        }
    }

    #[test]
    fn arch_spellings_map() {
        assert_eq!(msix_arch("x86_64"), Some("x64"));
        assert_eq!(msix_arch("aarch64"), Some("arm64"));
        assert_eq!(msix_arch("x64"), None);
    }

    #[test]
    fn relative_paths_have_no_package_uri() {
        assert_eq!(package_uri(Path::new("tilecast-windows-0.2.0-x86_64.msix")), None);
    }

    /// The release manifest template renders to an identity the
    /// player accepts: template, parser, and version mapping agree.
    #[test]
    fn release_template_renders_a_verifiable_identity() {
        const TEMPLATE: &str = include_str!("../release/AppxManifest.xml.template");
        assert!(TEMPLATE.contains("@TILECAST_MSIX_VERSION@"));
        assert!(TEMPLATE.contains("@TILECAST_MSIX_ARCH@"));
        assert!(TEMPLATE.contains("@TILECAST_MSIX_PUBLISHER@"));
        assert!(TEMPLATE.contains(PACKAGE_NAME));
        // The packaged install starts at logon; the manifest must keep the
        // declared startup task (docs/tilecast-windows.md).
        assert!(TEMPLATE.contains("windows.startupTask"));
        assert!(TEMPLATE.contains("TilecastPlayerAutostart"));
        let rendered = TEMPLATE
            .replace("@TILECAST_MSIX_VERSION@", "0.2.0.2")
            .replace("@TILECAST_MSIX_ARCH@", "x64")
            .replace("@TILECAST_MSIX_PUBLISHER@", "CN=Tilecast Test");
        assert!(!rendered.contains("@TILECAST_MSIX_"));
        let dir = tempdir();
        let path = package(dir.path(), Some(&rendered));
        let identity = read_identity(&path).expect("template identity");
        assert_eq!(identity.name, PACKAGE_NAME);
        assert_eq!(identity.publisher, "CN=Tilecast Test");
        let expected = crate::update::msix_version("0.2.0", "stable").expect("maps");
        check_identity(&identity, expected, "x86_64").expect("matches");
    }

    #[cfg(windows)]
    #[test]
    fn drive_paths_become_file_uris() {
        assert_eq!(
            package_uri(Path::new(r"C:\Temp\Tilecast\tilecast-windows-0.2.0-x86_64.msix")).as_deref(),
            Some("file:///C:/Temp/Tilecast/tilecast-windows-0.2.0-x86_64.msix")
        );
        assert_eq!(package_uri(Path::new(r"C:\My Temp\a b.msix")).as_deref(), Some("file:///C:/My%20Temp/a%20b.msix"));
        assert_eq!(package_uri(Path::new(r"\\server\share\a.msix")), None);
    }
}
