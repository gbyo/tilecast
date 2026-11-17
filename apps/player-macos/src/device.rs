//! macOS device facts for pairing metadata and telemetry. Every fact
//! degrades to a documented fallback: pairing must work on any supported Mac,
//! including one with no display attached.

/// Every Mac is made by Apple.
pub fn manufacturer() -> String {
    "Apple".to_owned()
}

/// The hardware model identifier (`Mac14,2`), or `Mac <arch>`.
pub fn model() -> String {
    sysctl::string(c"hw.model").unwrap_or_else(|| format!("Mac {}", std::env::consts::ARCH))
}

/// The OS release with its build (`macOS 15.3 (24D60)`).
pub fn os_release() -> String {
    match (sysctl::string(c"kern.osproductversion"), sysctl::string(c"kern.osversion")) {
        (Some(version), Some(build)) => format!("macOS {version} ({build})"),
        (Some(version), None) => format!("macOS {version}"),
        _ => format!("macOS {}", std::env::consts::ARCH),
    }
}

/// The user's locale as a BCP 47 tag (`en-US`). The region override
/// (`en_US@rg=gbzzzz`) is dropped, as on the other Players.
pub fn locale() -> String {
    platform_locale().and_then(|tag| bcp47(&tag)).unwrap_or_else(|| "en-US".to_owned())
}

#[cfg(target_os = "macos")]
fn platform_locale() -> Option<String> {
    Some(objc2_foundation::NSLocale::currentLocale().languageIdentifier().to_string())
}

#[cfg(not(target_os = "macos"))]
fn platform_locale() -> Option<String> {
    None
}

fn bcp47(identifier: &str) -> Option<String> {
    let tag = identifier.split('@').next()?.replace('_', "-");
    let valid = !tag.is_empty()
        && tag.len() <= 35
        && tag.split('-').all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_alphanumeric()));
    valid.then_some(tag)
}

/// The main display's size in device pixels (backing pixels, not points),
/// or `None` without a display. CoreGraphics display queries are safe off
/// the main thread, unlike `NSScreen`.
#[cfg(target_os = "macos")]
pub fn display_size() -> Option<(u32, u32)> {
    use objc2_core_graphics::{CGDisplayCopyDisplayMode, CGDisplayMode, CGMainDisplayID};
    let mode = CGDisplayCopyDisplayMode(CGMainDisplayID())?;
    let width = u32::try_from(CGDisplayMode::pixel_width(Some(&mode))).ok()?;
    let height = u32::try_from(CGDisplayMode::pixel_height(Some(&mode))).ok()?;
    (width > 0 && height > 0).then_some((width, height))
}

#[cfg(not(target_os = "macos"))]
pub fn display_size() -> Option<(u32, u32)> {
    None
}

/// Seconds since the kernel booted, sleep included.
pub fn device_uptime_seconds() -> Option<i64> {
    let boot = sysctl::boot_time()?;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?;
    let uptime = now.checked_sub(boot)?;
    i64::try_from(uptime.as_secs()).ok()
}

#[cfg(target_os = "macos")]
mod sysctl {
    #![allow(unsafe_code)]

    use std::ffi::CStr;
    use std::time::Duration;

    /// A string-valued sysctl, trimmed; `None` when absent or empty.
    pub fn string(name: &CStr) -> Option<String> {
        let mut len: libc::size_t = 0;
        // SAFETY: `name` is NUL-terminated; a null output buffer asks only
        // for the size, written to `len`.
        if unsafe { libc::sysctlbyname(name.as_ptr(), std::ptr::null_mut(), &mut len, std::ptr::null_mut(), 0) } != 0 {
            return None;
        }
        let mut buffer = vec![0u8; len];
        // SAFETY: `buffer` is writable for `len` bytes, and the kernel writes
        // at most `len` bytes and stores the written length in `len`.
        if unsafe { libc::sysctlbyname(name.as_ptr(), buffer.as_mut_ptr().cast(), &mut len, std::ptr::null_mut(), 0) }
            != 0
        {
            return None;
        }
        buffer.truncate(len);
        let text = CStr::from_bytes_until_nul(&buffer).ok()?.to_str().ok()?.trim();
        (!text.is_empty()).then(|| text.to_owned())
    }

    /// `kern.boottime` as a duration since the Unix epoch.
    pub fn boot_time() -> Option<Duration> {
        let mut boot = libc::timeval { tv_sec: 0, tv_usec: 0 };
        let mut len = std::mem::size_of::<libc::timeval>();
        // SAFETY: `boot` is a writable `timeval` of `len` bytes, the type
        // the kernel documents for `kern.boottime`.
        let status = unsafe {
            libc::sysctlbyname(c"kern.boottime".as_ptr(), (&raw mut boot).cast(), &mut len, std::ptr::null_mut(), 0)
        };
        if status != 0 || len != std::mem::size_of::<libc::timeval>() {
            return None;
        }
        let seconds = u64::try_from(boot.tv_sec).ok().filter(|seconds| *seconds > 0)?;
        let micros = u32::try_from(boot.tv_usec).ok()?;
        Some(Duration::new(seconds, micros.checked_mul(1_000)?))
    }
}

#[cfg(not(target_os = "macos"))]
mod sysctl {
    use std::ffi::CStr;
    use std::time::Duration;

    pub fn string(_name: &CStr) -> Option<String> {
        None
    }

    pub fn boot_time() -> Option<Duration> {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locale_identifiers_become_bcp47_tags() {
        assert_eq!(bcp47("en_US").as_deref(), Some("en-US"));
        assert_eq!(bcp47("en_US@rg=gbzzzz").as_deref(), Some("en-US"));
        assert_eq!(bcp47("zh-Hans-CN").as_deref(), Some("zh-Hans-CN"));
        assert_eq!(bcp47("es-419").as_deref(), Some("es-419"));
        assert!(bcp47("").is_none());
        assert!(bcp47("en__US").is_none());
        assert!(bcp47("en US").is_none());
    }

    #[test]
    fn facts_are_never_empty() {
        assert_eq!(manufacturer(), "Apple");
        assert!(!model().is_empty());
        assert!(os_release().starts_with("macOS "));
        assert!(bcp47(&locale()).is_some());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_reports_real_facts() {
        let model = model();
        assert!(model.contains(',') && model.chars().any(|c| c.is_ascii_digit()), "{model}");
        let release = os_release();
        assert!(release.contains('(') && release.ends_with(')'), "{release}");
        let uptime = device_uptime_seconds().expect("uptime");
        assert!(uptime > 0);
        // A test run without a window server session (CI over SSH) may have
        // no main display; any reported size must be real pixels.
        if let Some((width, height)) = display_size() {
            assert!(width >= 640 && height >= 480, "{width}x{height}");
        }
    }
}
