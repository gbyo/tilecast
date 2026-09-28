//! Staging a release from its signed archive (`tilecast-edge-<version>-<arch>.tar.zst`).
//!
//! The caller passes a file that it owns and that nobody else can write
//! (`tilecast-edge-update` copies the content-store object into its private
//! directory while it hashes it), so the bytes verified here are the bytes
//! that are unpacked.
//!
//! Order of checks:
//!
//! 1. the whole archive: size and SHA-256 against the signed envelope;
//! 2. first pass: the release manifest and its signature, exactly once each;
//!    the manifest's digest against the envelope, then its signature with the
//!    Tilecast key, then its version and SBOM digest against the envelope;
//! 3. second pass: every regular file the manifest names is written through
//!    the M7 verified writer (size, SHA-256, mode). Any other entry type, a
//!    duplicate, a path outside the manifest or a missing file stops the
//!    stage, and the partial staging directory is removed.
//!
//! The archive is read with pure Rust decoders (`ruzstd`, `tar`); nothing is
//! unpacked by path, and no entry's own name, mode, owner or link target is
//! ever used.

use std::collections::BTreeSet;
use std::fs::File;
use std::io::{Read, Seek, SeekFrom};

use sha2::{Digest as _, Sha256};

use crate::envelope::VerifiedEnvelope;
use crate::install::{Layout, StageOutcome, stage_with, write_archive_file};
use crate::manifest::{
    MANIFEST_NAME, MAX_FILES, MAX_MANIFEST_BYTES, MAX_SIGNATURE_BYTES, ReleaseError, SBOM_PATH, SIGNATURE_NAME,
    VerifiedRelease, hex, is_release_path, verify_manifest_bytes,
};

/// At most this many entries (files and directories) in one archive.
const MAX_ENTRIES: usize = MAX_FILES * 3;

/// Hashes an open file from its start.
pub fn hash_open_file(file: &mut File) -> std::io::Result<(String, u64)> {
    file.seek(SeekFrom::Start(0))?;
    let mut hasher = Sha256::new();
    let mut buffer = vec![0u8; 1024 * 1024];
    let mut total = 0u64;
    loop {
        let read = file.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total += read as u64;
        hasher.update(&buffer[..read]);
    }
    Ok((hex(&hasher.finalize()), total))
}

fn entries_of(file: &mut File) -> Result<tar::Archive<impl Read + '_>, ReleaseError> {
    file.seek(SeekFrom::Start(0))?;
    let decoder =
        ruzstd::decoding::StreamingDecoder::new(file).map_err(|_| ReleaseError::ArchiveInvalid("not a zstd stream"))?;
    Ok(tar::Archive::new(decoder))
}

/// The entry's path relative to the release root: the leading `./` that
/// `tar -C tree .` writes is dropped. `None` for the root itself.
fn relative_path(entry: &tar::Entry<'_, impl Read>) -> Result<Option<String>, ReleaseError> {
    let raw = entry.path_bytes();
    let text = std::str::from_utf8(&raw).map_err(|_| ReleaseError::ArchiveInvalid("path is not UTF-8"))?;
    let trimmed = text.strip_prefix("./").unwrap_or(text).trim_end_matches('/');
    if trimmed.is_empty() || trimmed == "." {
        return Ok(None);
    }
    if !is_release_path(trimmed) {
        return Err(ReleaseError::ArchiveInvalid("unsafe path"));
    }
    Ok(Some(trimmed.to_owned()))
}

fn read_bounded(entry: &mut impl Read, size: u64, max: u64) -> Result<Vec<u8>, ReleaseError> {
    if size > max {
        return Err(ReleaseError::ArchiveInvalid("manifest entry too large"));
    }
    let mut bytes = Vec::with_capacity(size as usize);
    entry.take(max + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 != size {
        return Err(ReleaseError::ArchiveInvalid("short entry"));
    }
    Ok(bytes)
}

/// Checks the archive against the envelope and returns its verified release
/// manifest. Nothing is written.
pub fn verify_archive(
    archive: &mut File,
    envelope: &VerifiedEnvelope,
    key: &[u8; 32],
) -> Result<VerifiedRelease, ReleaseError> {
    let (digest, size) = hash_open_file(archive)?;
    if size != envelope.envelope.artifact_size_bytes {
        return Err(ReleaseError::ArchiveMismatch("archive size"));
    }
    if digest != envelope.envelope.artifact_sha256 {
        return Err(ReleaseError::ArchiveMismatch("archive digest"));
    }
    let mut manifest = None;
    let mut signature = None;
    let mut count = 0usize;
    let mut archive_reader = entries_of(archive)?;
    for entry in archive_reader.entries().map_err(|_| ReleaseError::ArchiveInvalid("tar"))? {
        let mut entry = entry.map_err(|_| ReleaseError::ArchiveInvalid("tar entry"))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(ReleaseError::ArchiveInvalid("too many entries"));
        }
        let Some(path) = relative_path(&entry)? else { continue };
        let size = entry.header().size().map_err(|_| ReleaseError::ArchiveInvalid("entry size"))?;
        let slot = match path.as_str() {
            MANIFEST_NAME => (&mut manifest, MAX_MANIFEST_BYTES),
            SIGNATURE_NAME => (&mut signature, MAX_SIGNATURE_BYTES),
            _ => continue,
        };
        if entry.header().entry_type() != tar::EntryType::Regular {
            return Err(ReleaseError::ArchiveInvalid("manifest is not a regular file"));
        }
        if slot.0.is_some() {
            return Err(ReleaseError::ArchiveInvalid("duplicate manifest"));
        }
        *slot.0 = Some(read_bounded(&mut entry, size, slot.1)?);
    }
    let manifest = manifest.ok_or(ReleaseError::MissingManifest)?;
    let signature = signature.ok_or(ReleaseError::MissingSignature)?;
    // The envelope binds these exact bytes; check that before the signature
    // is even parsed.
    if hex(&Sha256::digest(&manifest)) != envelope.envelope.release_manifest_sha256 {
        return Err(ReleaseError::ArchiveMismatch("release manifest digest"));
    }
    let release = verify_manifest_bytes(manifest, signature, key)?;
    let inner = &release.manifest;
    if inner.version_name != envelope.envelope.version_name
        || inner.version_code != envelope.envelope.version_code
        || inner.arch != envelope.envelope.arch
    {
        return Err(ReleaseError::ArchiveMismatch("release version"));
    }
    if inner.file(SBOM_PATH).map(|file| file.sha256.as_str()) != Some(envelope.envelope.sbom_sha256.as_str()) {
        return Err(ReleaseError::ArchiveMismatch("SBOM digest"));
    }
    Ok(release)
}

/// Stages the release in `archive` under `layout`, verified as described in
/// the module documentation. A release that is already installed is
/// verified and left alone.
pub fn stage_from_archive(
    archive: &mut File,
    envelope: &VerifiedEnvelope,
    layout: &Layout,
    key: &[u8; 32],
) -> Result<(StageOutcome, VerifiedRelease), ReleaseError> {
    envelope.check_host()?;
    let release = verify_archive(archive, envelope, key)?;
    let outcome = stage_with(&release, layout, key, |staging| extract(archive, &release, staging))?;
    Ok((outcome, release))
}

fn extract(archive: &mut File, release: &VerifiedRelease, staging: &std::path::Path) -> Result<(), ReleaseError> {
    let mut seen = BTreeSet::new();
    let mut count = 0usize;
    let mut archive_reader = entries_of(archive)?;
    for entry in archive_reader.entries().map_err(|_| ReleaseError::ArchiveInvalid("tar"))? {
        let entry = entry.map_err(|_| ReleaseError::ArchiveInvalid("tar entry"))?;
        count += 1;
        if count > MAX_ENTRIES {
            return Err(ReleaseError::ArchiveInvalid("too many entries"));
        }
        let Some(path) = relative_path(&entry)? else { continue };
        match entry.header().entry_type() {
            tar::EntryType::Directory => continue,
            tar::EntryType::Regular => {}
            _ => return Err(ReleaseError::ArchiveInvalid("unsupported entry type")),
        }
        if !seen.insert(path.clone()) {
            return Err(ReleaseError::ArchiveInvalid("duplicate entry"));
        }
        if matches!(path.as_str(), MANIFEST_NAME | SIGNATURE_NAME) {
            // Written by the stage from the verified bytes.
            continue;
        }
        let Some(file) = release.manifest.file(&path) else {
            return Err(ReleaseError::ArchiveInvalid("entry not in the release manifest"));
        };
        let size = entry.header().size().map_err(|_| ReleaseError::ArchiveInvalid("entry size"))?;
        if size != file.size {
            return Err(ReleaseError::FileUnavailable(file.path.clone()));
        }
        write_archive_file(entry, staging, file)?;
    }
    for file in &release.manifest.files {
        if !seen.contains(&file.path) {
            return Err(ReleaseError::FileUnavailable(file.path.clone()));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::install::{current_version, installed_versions, verify_installed};
    use crate::testing::{Signer, layout};

    struct Fixture {
        _root: tempfile::TempDir,
        layout: Layout,
        signer: Signer,
        archive: std::path::PathBuf,
        envelope: VerifiedEnvelope,
        tree: std::path::PathBuf,
    }

    fn fixture() -> Fixture {
        let root = tempfile::tempdir().unwrap();
        let signer = Signer::new();
        let tree = root.path().join("tree");
        signer.write_release(&tree, "0.2.0");
        let archive = root.path().join("release.tar.zst");
        crate::testing::write_archive(&tree, &archive);
        let envelope = signer.envelope(&tree, &archive, 6);
        Fixture { layout: layout(root.path()), _root: root, signer, archive, envelope, tree }
    }

    #[test]
    fn a_signed_archive_stages_without_activation() {
        let f = fixture();
        let mut file = File::open(&f.archive).unwrap();
        let (outcome, release) = stage_from_archive(&mut file, &f.envelope, &f.layout, &f.signer.public()).unwrap();
        assert_eq!(outcome, StageOutcome::Staged { version: "0.2.0".into() });
        assert_eq!(release.manifest.version_code, 2000);
        verify_installed(&f.layout.version_dir("0.2.0"), &f.signer.public()).unwrap();
        assert_eq!(current_version(&f.layout), None, "staging never switches current");
        let again = stage_from_archive(&mut file, &f.envelope, &f.layout, &f.signer.public()).unwrap().0;
        assert_eq!(again, StageOutcome::AlreadyStaged { version: "0.2.0".into() });
    }

    #[test]
    fn a_changed_archive_byte_is_refused_before_it_is_read() {
        let f = fixture();
        let mut bytes = std::fs::read(&f.archive).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&f.archive, &bytes).unwrap();
        let mut file = File::open(&f.archive).unwrap();
        let error = stage_from_archive(&mut file, &f.envelope, &f.layout, &f.signer.public()).unwrap_err();
        assert!(matches!(error, ReleaseError::ArchiveMismatch("archive digest")), "{error}");
        assert!(installed_versions(&f.layout).unwrap().is_empty());
    }

    #[test]
    fn a_bad_inner_signature_or_file_digest_is_refused() {
        // Inner manifest signed by another key, archive and envelope consistent.
        let f = fixture();
        let other = Signer::new();
        let manifest = std::fs::read(f.tree.join(MANIFEST_NAME)).unwrap();
        other.sign(&f.tree, &manifest);
        crate::testing::write_archive(&f.tree, &f.archive);
        let envelope = f.signer.envelope(&f.tree, &f.archive, 6);
        let mut file = File::open(&f.archive).unwrap();
        let error = stage_from_archive(&mut file, &envelope, &f.layout, &f.signer.public()).unwrap_err();
        assert!(matches!(error, ReleaseError::BadSignature), "{error}");

        // A file changed after the inner manifest was signed.
        let f = fixture();
        std::fs::write(f.tree.join("bin/tilecastd"), b"bin/tilecastd 0.2.X").unwrap();
        crate::testing::write_archive(&f.tree, &f.archive);
        let envelope = f.signer.envelope(&f.tree, &f.archive, 6);
        let mut file = File::open(&f.archive).unwrap();
        let error = stage_from_archive(&mut file, &envelope, &f.layout, &f.signer.public()).unwrap_err();
        assert!(matches!(error, ReleaseError::DigestMismatch(_)), "{error}");
        assert!(installed_versions(&f.layout).unwrap().is_empty(), "no partial version is left");
        assert!(!f.layout.install_root.join("0.2.0.staging").exists());
    }

    #[test]
    fn links_and_unlisted_entries_are_refused() {
        let f = fixture();
        std::os::unix::fs::symlink("/etc/shadow", f.tree.join("share/link")).unwrap();
        crate::testing::write_archive(&f.tree, &f.archive);
        let envelope = f.signer.envelope(&f.tree, &f.archive, 6);
        let mut file = File::open(&f.archive).unwrap();
        let error = stage_from_archive(&mut file, &envelope, &f.layout, &f.signer.public()).unwrap_err();
        assert!(matches!(error, ReleaseError::ArchiveInvalid("unsupported entry type")), "{error}");

        let f = fixture();
        std::fs::write(f.tree.join("share/unlisted"), b"x").unwrap();
        crate::testing::write_archive(&f.tree, &f.archive);
        let envelope = f.signer.envelope(&f.tree, &f.archive, 6);
        let mut file = File::open(&f.archive).unwrap();
        let error = stage_from_archive(&mut file, &envelope, &f.layout, &f.signer.public()).unwrap_err();
        assert!(matches!(error, ReleaseError::ArchiveInvalid("entry not in the release manifest")), "{error}");
    }

    #[test]
    fn an_envelope_for_another_release_is_refused() {
        let f = fixture();
        let mut document: serde_json::Value = serde_json::from_slice(&f.envelope.envelope_bytes).unwrap();
        document["releaseManifestSha256"] = serde_json::json!("0".repeat(64));
        let bytes = serde_json::to_vec(&document).unwrap();
        let envelope =
            crate::envelope::verify_envelope(&bytes, &f.signer.signature(&bytes), &f.signer.public()).unwrap();
        let mut file = File::open(&f.archive).unwrap();
        let error = stage_from_archive(&mut file, &envelope, &f.layout, &f.signer.public()).unwrap_err();
        assert!(matches!(error, ReleaseError::ArchiveMismatch("release manifest digest")), "{error}");
    }
}
