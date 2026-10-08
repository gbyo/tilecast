//! Versioned Player Capability registry vocabulary.
//!
//! Mirrors `packages/player-contracts/player-capabilities.json`: the
//! cross-player capability IDs hosts report in the generic
//! `playerCapabilities` heartbeat section and packages invoke through
//! `players.display-control@1`. Values only; hosts report what they
//! actually support, and the server validates every entry against the
//! registry. The legacy display-control names map here so reporters
//! populate both representations from one probe.

/// The single shipped registry version.
pub const REGISTRY_VERSION: u32 = 1;

pub const DISPLAY_POWER: &str = "display.power";
pub const DISPLAY_INPUT: &str = "display.input";
pub const DISPLAY_VOLUME: &str = "display.volume";
pub const DISPLAY_MUTE: &str = "display.mute";
pub const DISPLAY_BRIGHTNESS: &str = "display.brightness";

/// Every registry capability ID, in canonical order.
pub const ALL: &[&str] = &[DISPLAY_POWER, DISPLAY_INPUT, DISPLAY_VOLUME, DISPLAY_MUTE, DISPLAY_BRIGHTNESS];

/// The closed provider vocabulary. `unsupported` is not a provider: a
/// host that supports nothing reports nothing.
pub fn is_provider(provider: &str) -> bool {
    matches!(provider, "hdmi_cec" | "ddc_ci" | "network" | "rs232")
}

/// Maps a legacy display-control capability name to its registry ID.
/// `probe` and unknown names are not registry capabilities.
pub fn registry_id_for_display_control(legacy: &str) -> Option<&'static str> {
    match legacy {
        "power" => Some(DISPLAY_POWER),
        "input" => Some(DISPLAY_INPUT),
        "volume" => Some(DISPLAY_VOLUME),
        "mute" => Some(DISPLAY_MUTE),
        "brightness" => Some(DISPLAY_BRIGHTNESS),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn legacy_names_map_to_the_registry() {
        for (legacy, id) in [
            ("power", DISPLAY_POWER),
            ("input", DISPLAY_INPUT),
            ("volume", DISPLAY_VOLUME),
            ("mute", DISPLAY_MUTE),
            ("brightness", DISPLAY_BRIGHTNESS),
        ] {
            assert_eq!(registry_id_for_display_control(legacy), Some(id));
            assert!(ALL.contains(&id));
        }
        assert_eq!(registry_id_for_display_control("probe"), None);
        assert_eq!(registry_id_for_display_control("shell"), None);
        assert_eq!(ALL.len(), 5);
    }

    #[test]
    fn provider_vocabulary_is_closed() {
        for provider in ["hdmi_cec", "ddc_ci", "network", "rs232"] {
            assert!(is_provider(provider), "{provider}");
        }
        for provider in ["", "unsupported", "telepathy"] {
            assert!(!is_provider(provider), "{provider}");
        }
    }
}
