//! Windows device facts for pairing metadata. Every fact degrades to a
//! documented fallback: pairing must work on any Windows 10/11 machine, not
//! only on ones with complete firmware tables.

use player_client::pairing::DeviceMetadata;
use player_types::PlayerId;

/// The display size when the OS reports none (off-Windows builds, or a
/// session without a primary monitor). Pairing metadata requires a size.
pub const HEADLESS_DISPLAY: (u32, u32) = (1920, 1080);

/// The display size to report: an explicit size first, then the primary
/// monitor the production window covers, then the documented fallback.
pub fn display_size(display: Option<(u32, u32)>) -> (u32, u32) {
    display.or_else(crate::win32::primary_display_size).unwrap_or(HEADLESS_DISPLAY)
}

fn bios_string(value: &str) -> Option<String> {
    crate::win32::machine_registry_string(r"HARDWARE\DESCRIPTION\System\BIOS", value)
        .map(|text| text.trim().to_owned())
        .filter(|text| !text.is_empty())
}

/// The system manufacturer from firmware (`To be filled by O.E.M.` and
/// friends pass through: the server only needs a stable label).
pub fn manufacturer() -> String {
    bios_string("SystemManufacturer").unwrap_or_else(|| "unknown".to_owned())
}

/// The system product name from firmware.
pub fn model() -> String {
    bios_string("SystemProductName").unwrap_or_else(|| format!("Windows {}", std::env::consts::ARCH))
}

/// The OS release (`ProductName`, build number): the version APIs lie
/// without an embedded manifest, so this reads the registry instead.
pub fn os_release() -> String {
    match (crate::win32::os_product_name(), crate::win32::os_build_number()) {
        (Some(product), Some(build)) => format!("{product} (build {build})"),
        (Some(product), None) => product,
        _ => format!("Windows {}", std::env::consts::ARCH),
    }
}

/// The user's default locale (`en-US`).
pub fn locale() -> String {
    crate::win32::user_locale_name().unwrap_or_else(|| "en-US".to_owned())
}

/// The system IANA time zone, as the reference players report it.
pub fn timezone() -> String {
    jiff::tz::TimeZone::system()
        .iana_name()
        .map(|name| name.chars().filter(|c| !c.is_control()).take(80).collect())
        .unwrap_or_else(|| "UTC".into())
}

/// Pairing metadata for `player`, with an explicit display size when
/// the caller knows better than the primary monitor.
pub fn metadata(player: PlayerId, display: Option<(u32, u32)>) -> DeviceMetadata {
    DeviceMetadata::new(
        *player.as_uuid(),
        crate::PLAYER_FAMILY,
        &manufacturer(),
        &model(),
        &os_release(),
        crate::RELEASE_VERSION,
        display_size(display),
        &locale(),
        &timezone(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metadata_is_server_shaped_on_any_platform() {
        let player = PlayerId::from_uuid(uuid::Uuid::new_v4());
        let facts = metadata(player, None);
        assert_eq!(facts.platform, "windows");
        assert_eq!(facts.screen_width, HEADLESS_DISPLAY.0);
        assert_eq!(facts.screen_height, HEADLESS_DISPLAY.1);
        assert!(!facts.manufacturer.is_empty());
        assert!(!facts.model.is_empty());
        assert!(!facts.android_version.is_empty());
        assert_eq!(facts.player_version, crate::RELEASE_VERSION);
        assert!(!facts.locale.is_empty());
        assert!(!facts.timezone.is_empty());
        let json = serde_json::to_value(&facts).expect("serializes");
        assert_eq!(json["playerInstallationId"], player.as_uuid().to_string());
    }
}
