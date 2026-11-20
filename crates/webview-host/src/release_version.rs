//! The release version rule: names, update version codes, and channels
//! (`docs/release-process.md`). One rule, implemented in the Go server, Edge,
//! this crate (for the Windows and macOS Players), and the release scripts;
//! `packages/player-contracts/fixtures/release-versions.json` is the corpus
//! each implementation runs. Change them together.

/// `MAJOR.MINOR.PATCH` with an optional `-prerelease` of plain
/// characters: the server's envelope version pattern, mirrored exactly
/// so the player refuses what the server refuses.
pub fn is_version_name(value: &str) -> bool {
    if value.is_empty() || value.len() > 64 {
        return false;
    }
    let core = match value.split_once('-') {
        Some((core, pre)) => {
            if pre.is_empty() || !pre.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'.') {
                return false;
            }
            core
        }
        None => value,
    };
    let mut parts = core.split('.');
    let triple = [parts.next(), parts.next(), parts.next()];
    parts.next().is_none()
        && triple.into_iter().all(|part| {
            part.is_some_and(|digits| {
                !digits.is_empty() && digits.len() <= 9 && digits.bytes().all(|b| b.is_ascii_digit())
            })
        })
}

/// The legacy code of the first coordinated release, 0.26.0. Every version
/// below it keeps its legacy code; every unified code is above every one.
pub const UNIFIED_CUTOVER_CORE_CODE: u64 = 26_000;
/// The largest update version code; it keeps every code inside the Android
/// `versionCode` range.
pub const MAXIMUM_VERSION_CODE: u64 = 2_100_000_000;

/// A parsed version: its version code, the channel the name implies, and the
/// slot a Beta number or Stable takes in the code and the package version.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ParsedVersion {
    pub code: u64,
    pub channel: Option<&'static str>,
    pub slot: Option<u16>,
    pub parts: (u64, u64, u64),
}

/// Splits a version name. Below the cutover the code is the legacy `major *
/// 1_000_000 + minor * 1_000 + patch` and the prerelease suffix does not
/// count. From the cutover on a name is `X.Y.Z` (Stable) or `X.Y.Z-beta.N` (N
/// from 1 to 98), and the code is the core code times 100 plus a slot: N for a
/// Beta, 99 for Stable. A Beta sorts below its own Stable and above the
/// previous release, so a Beta can update to the next Beta or to Stable.
pub fn parse_version(version_name: &str) -> Option<ParsedVersion> {
    if !is_version_name(version_name) {
        return None;
    }
    let (core, suffix) = match version_name.split_once('-') {
        Some((core, suffix)) => (core, Some(suffix)),
        None => (version_name, None),
    };
    let mut parts = core.split('.');
    let (major, minor, patch) =
        (parts.next()?.parse::<u64>().ok()?, parts.next()?.parse::<u64>().ok()?, parts.next()?.parse::<u64>().ok()?);
    if parts.next().is_some() || major >= 1_000_000 || minor >= 1_000 || patch >= 1_000 {
        return None;
    }
    let core_code = major * 1_000_000 + minor * 1_000 + patch;
    if core_code < UNIFIED_CUTOVER_CORE_CODE {
        return Some(ParsedVersion { code: core_code, channel: None, slot: None, parts: (major, minor, patch) });
    }
    let (slot, channel) = match suffix {
        None => (99_u16, "stable"),
        Some(suffix) => {
            let number = suffix.strip_prefix("beta.")?;
            // 1 to 98 with no sign and no leading zero.
            if number.is_empty()
                || number.len() > 2
                || number.starts_with('0')
                || !number.bytes().all(|b| b.is_ascii_digit())
            {
                return None;
            }
            let number: u16 = number.parse().ok()?;
            if number > 98 {
                return None;
            }
            (number, "beta")
        }
    };
    let code = core_code * 100 + u64::from(slot);
    (code <= MAXIMUM_VERSION_CODE).then_some(ParsedVersion {
        code,
        channel: Some(channel),
        slot: Some(slot),
        parts: (major, minor, patch),
    })
}

/// The version code of a `release/VERSION` name, or `None` when it is not a
/// valid release version. The one ordering the server, the player, the
/// package, the Android build, and Tilecast Edge share;
/// `packages/player-contracts/fixtures/release-versions.json` is the corpus
/// each of them runs.
pub fn version_code(version_name: &str) -> Option<u64> {
    parse_version(version_name).map(|parsed| parsed.code)
}

/// The channel a version name implies: `stable` for `X.Y.Z` and `beta` for
/// `X.Y.Z-beta.N` from the cutover on, `None` below it.
pub fn version_channel(version_name: &str) -> Option<&'static str> {
    parse_version(version_name).and_then(|parsed| parsed.channel)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(serde::Deserialize)]
    struct VersionCorpus {
        codes: Vec<CorpusCode>,
        invalid: Vec<String>,
        channels: Vec<CorpusChannel>,
        ordered: Vec<String>,
        #[serde(rename = "cutoverCoreCode")]
        cutover_core_code: u64,
        #[serde(rename = "maximumCode")]
        maximum_code: u64,
    }
    #[derive(serde::Deserialize)]
    struct CorpusCode {
        name: String,
        code: u64,
    }
    #[derive(serde::Deserialize)]
    struct CorpusChannel {
        name: String,
        channel: Option<String>,
    }

    fn corpus() -> VersionCorpus {
        serde_json::from_str(include_str!("../../../packages/player-contracts/fixtures/release-versions.json"))
            .expect("the shared release version corpus parses")
    }

    #[test]
    fn version_codes_match_the_shared_corpus() {
        let corpus = corpus();
        assert_eq!(corpus.cutover_core_code, UNIFIED_CUTOVER_CORE_CODE);
        assert_eq!(corpus.maximum_code, MAXIMUM_VERSION_CODE);
        for case in &corpus.codes {
            assert_eq!(version_code(&case.name), Some(case.code), "{}", case.name);
        }
        for name in &corpus.invalid {
            assert_eq!(version_code(name), None, "{name:?} must be invalid");
        }
        for case in &corpus.channels {
            assert_eq!(version_channel(&case.name), case.channel.as_deref(), "{}", case.name);
        }
        let codes: Vec<u64> = corpus.ordered.iter().map(|name| version_code(name).expect("valid")).collect();
        assert!(codes.windows(2).all(|pair| pair[0] < pair[1]), "codes must strictly increase: {codes:?}");
    }

    #[test]
    fn version_codes_match_the_server_scheme() {
        assert_eq!(version_code("0.1.0"), Some(1_000));
        assert_eq!(version_code("0.2.3"), Some(2_003));
        assert_eq!(version_code("0.2.3-rc.1"), Some(2_003));
        assert_eq!(version_code("1.2.3"), Some(100_200_399), "a version above the cutover is Stable");
        assert_eq!(version_code("1.2.3-rc.1"), None, "a version above the cutover must be Stable or Beta");
        assert_eq!(version_code("1.2"), None);
        assert_eq!(version_code("1.2.3.4"), None);
        assert_eq!(version_code("1.1000.0"), None);
        assert_eq!(version_code("1.2.3-"), None);
        assert_eq!(version_code("1.2.3-rc!"), None);
        assert_eq!(version_code("abc"), None);
    }

    #[test]
    fn version_names_match_the_server_pattern() {
        assert!(is_version_name("0.1.0"));
        assert!(is_version_name("1.2.3-rc.1"));
        assert!(is_version_name("999999.999.999-x"));
        assert!(!is_version_name(""));
        assert!(!is_version_name("1.2"));
        assert!(!is_version_name("1.2.3.4"));
        assert!(!is_version_name("1.2.3-"));
        assert!(!is_version_name("1.2.3-rc-1"));
        assert!(!is_version_name("1.2.3-rc_1"));
        assert!(!is_version_name("v1.2.3"));
        assert!(!is_version_name("1.2.3 "));
        assert!(!is_version_name(&format!("1.2.{}-{}", "3".repeat(60), "x".repeat(10))));
    }
}
