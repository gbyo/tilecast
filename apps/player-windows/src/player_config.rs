//! Player configuration projection: the native section Core validates,
//! plus the Runtime section (branding, playback defaults, power surfaces,
//! website policy) the projection and the Runtime read. The parsing mirrors
//! the reference hosts': the same document projects to the same behavior.

use player_core::NativeConfiguration;
use serde_json::{Map, Value};

pub const DEFAULT_BACKGROUND: &str = "#0E141B";
pub const DEFAULT_TEXT: &str = "#F5F7FA";
/// Where playback projection data for the runtime is bounded.
pub const MAX_PLAYBACK_CONTEXT_BYTES: usize = 16 * 1024;

const SECTIONS: &[&str] = &["branding", "playback", "power", "website"];

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Branding {
    pub background_color: Option<String>,
    pub text_color: Option<String>,
    pub no_content_title: Option<String>,
    pub no_content_message: Option<String>,
    pub disabled_title: Option<String>,
    pub disabled_message: Option<String>,
    pub footer_text: Option<String>,
}

impl Branding {
    pub fn background(&self) -> &str {
        self.background_color.as_deref().unwrap_or(DEFAULT_BACKGROUND)
    }

    pub fn text(&self) -> &str {
        self.text_color.as_deref().unwrap_or(DEFAULT_TEXT)
    }
}

/// Playback defaults (`resolvePlaybackItemSettings` in the shared runtime's
/// projection code).
#[derive(Debug, Clone, PartialEq)]
pub struct Playback {
    pub default_volume: f64,
    pub default_fit_mode: Option<String>,
    pub default_image_duration_ms: u64,
    pub default_transition: Option<String>,
    pub default_audio_enabled: bool,
    pub identify_shows_location: bool,
    pub screen_location: String,
    /// The section as sent, for the runtime's layout and widget projection
    /// (regional formatting, layout playlist-zone defaults).
    pub context: Map<String, Value>,
}

impl Default for Playback {
    fn default() -> Self {
        Self {
            default_volume: 0.5,
            default_fit_mode: None,
            default_image_duration_ms: 10_000,
            default_transition: None,
            default_audio_enabled: true,
            identify_shows_location: true,
            screen_location: String::new(),
            context: Map::new(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Website {
    /// Overrides a Website's own load timeout.
    pub timeout_seconds: Option<u64>,
    /// Applies when a Website has no zoom of its own.
    pub default_zoom_percent: Option<u64>,
    /// Overrides a Website's own cookie policy.
    pub cookie_policy: Option<String>,
    /// Applies when a Website has no failure behavior of its own.
    pub default_failure_behavior: Option<String>,
    /// Clear remote website data when the player starts.
    pub clear_on_restart: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Power {
    pub outside_display: String,
    pub outside_text: String,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct RuntimeConfiguration {
    pub branding: Branding,
    pub playback: Playback,
    pub power: Power,
    pub website: Website,
}

/// The configuration in force.
#[derive(Debug, Clone, Default)]
pub struct WindowsPlayerConfig {
    pub native: NativeConfiguration,
    pub runtime: RuntimeConfiguration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ConfigError {
    reason: &'static str,
}

impl ConfigError {
    pub fn reason_code(&self) -> &'static str {
        self.reason
    }
}

fn section<'a>(object: &'a Map<String, Value>, name: &str) -> Option<&'a Map<String, Value>> {
    object.get(name).and_then(Value::as_object)
}

fn text(values: Option<&Map<String, Value>>, key: &str, max_chars: usize) -> Option<String> {
    let value = values?.get(key)?.as_str()?.trim();
    (!value.is_empty()).then(|| value.chars().filter(|c| !c.is_control()).take(max_chars).collect())
}

fn color(values: Option<&Map<String, Value>>, key: &str) -> Option<String> {
    let value = values?.get(key)?.as_str()?;
    let bytes = value.as_bytes();
    (bytes.len() == 7 && bytes[0] == b'#' && bytes[1..].iter().all(u8::is_ascii_hexdigit)).then(|| value.to_owned())
}

fn number(values: Option<&Map<String, Value>>, key: &str) -> Option<f64> {
    values.and_then(|values| values.get(key)).and_then(Value::as_f64).filter(|value| value.is_finite())
}

impl WindowsPlayerConfig {
    /// Projects an accepted document. The native section must parse; the
    /// Runtime sections must be objects when present.
    pub fn project(document: &Value, native: NativeConfiguration) -> Result<Self, ConfigError> {
        let object = document.as_object().ok_or(ConfigError { reason: "configuration_invalid" })?;
        for name in SECTIONS {
            if object.get(*name).is_some_and(|value| !value.is_object() && !value.is_null()) {
                return Err(ConfigError { reason: "configuration_invalid" });
            }
        }

        let branding_values = section(object, "branding");
        let branding = Branding {
            background_color: color(branding_values, "backgroundColor"),
            text_color: color(branding_values, "textColor"),
            no_content_title: text(branding_values, "noContentTitle", 120),
            no_content_message: text(branding_values, "noContentMessage", 480),
            disabled_title: text(branding_values, "disabledTitle", 120),
            disabled_message: text(branding_values, "disabledMessage", 480),
            footer_text: text(branding_values, "footerText", 240),
        };

        let playback_values = section(object, "playback");
        let defaults = Playback::default();
        let mut context = playback_values.cloned().unwrap_or_default();
        if serde_json::to_vec(&context).map_or(true, |encoded| encoded.len() > MAX_PLAYBACK_CONTEXT_BYTES) {
            context = Map::new();
        }
        let playback = Playback {
            default_volume: number(playback_values, "defaultVolume")
                .map_or(defaults.default_volume, |volume| volume.clamp(0.0, 1.0)),
            default_fit_mode: text(playback_values, "defaultFitMode", 16),
            default_image_duration_ms: number(playback_values, "defaultImageDurationSeconds")
                .filter(|seconds| *seconds >= 0.0 && *seconds <= 86_400.0)
                .map_or(defaults.default_image_duration_ms, |seconds| (seconds * 1_000.0) as u64),
            default_transition: text(playback_values, "defaultTransition", 16),
            default_audio_enabled: playback_values
                .and_then(|values| values.get("defaultAudioEnabled"))
                .is_none_or(|value| value.as_bool() != Some(false)),
            identify_shows_location: playback_values
                .and_then(|values| values.get("identifyShowsLocation"))
                .is_none_or(|value| value.as_bool() != Some(false)),
            screen_location: text(playback_values, "screenLocation", 240).unwrap_or_default(),
            context,
        };

        let power_values = section(object, "power");
        let outside_display = match text(power_values, "outsideActiveHoursDisplay", 32).as_deref() {
            Some(mode @ ("bouncing_logo" | "custom_text")) => mode.to_owned(),
            _ => "black".to_owned(),
        };
        let outside_text = text(power_values, "outsideActiveHoursText", 240)
            .or_else(|| branding.footer_text.clone())
            .unwrap_or_else(|| "Powered by Tilecast".to_owned());
        let power = Power { outside_display, outside_text };

        let website_section = section(object, "website");
        let token = |key: &str, allowed: &[&str]| {
            text(website_section, key, 32).filter(|value| allowed.contains(&value.as_str()))
        };
        let website = Website {
            timeout_seconds: number(website_section, "timeoutSeconds")
                .filter(|seconds| *seconds >= 1.0 && *seconds <= 600.0)
                .map(|seconds| seconds as u64),
            default_zoom_percent: number(website_section, "defaultZoomPercent")
                .filter(|percent| *percent >= 25.0 && *percent <= 500.0)
                .map(|percent| percent as u64),
            cookie_policy: token("cookiePolicy", &["disabled", "first_party", "first_and_third_party"]),
            default_failure_behavior: token(
                "defaultFailureBehavior",
                &["placeholder", "fallback_image", "skip", "last_success"],
            ),
            clear_on_restart: website_section
                .and_then(|values| values.get("clearOnRestart"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        };

        Ok(Self { native, runtime: RuntimeConfiguration { branding, playback, power, website } })
    }

    /// The document without its per-response timestamp, for recognizing a
    /// resend of the same revision.
    pub fn comparable(document: &Value) -> Value {
        let mut copy = document.clone();
        if let Some(object) = copy.as_object_mut() {
            object.remove("generatedAt");
        }
        copy
    }
}

/// The item settings the reference player derives from an item and the
/// playback defaults (`resolvePlaybackItemSettings`).
#[derive(Debug, Clone, PartialEq)]
pub struct ItemSettings {
    pub duration_ms: Option<u64>,
    pub fit_mode: &'static str,
    pub transition: &'static str,
    pub audio_enabled: bool,
    pub volume: f64,
}

/// `fallbackDurationMsFor` from the shared runtime's projection code.
pub fn fallback_duration_ms(asset_type: &str, default_image_ms: u64) -> Option<u64> {
    match asset_type {
        "image" => Some(default_image_ms),
        "video" => None,
        "website" => Some(60_000),
        _ => Some(30_000),
    }
}

fn fit(value: &str) -> &'static str {
    match value {
        "cover" => "cover",
        "stretch" => "stretch",
        _ => "contain",
    }
}

fn transition(value: &str) -> &'static str {
    match value {
        "fade" => "fade",
        "crossfade" => "crossfade",
        _ => "none",
    }
}

pub fn item_settings(
    item: &Map<String, Value>,
    playback: &Playback,
    authored_duration_ms: Option<u64>,
) -> ItemSettings {
    let asset_type = item.get("assetType").and_then(Value::as_str).unwrap_or("");
    let fallback = fallback_duration_ms(asset_type, playback.default_image_duration_ms);
    let delegates = item.get("usePlayerDefaults").and_then(Value::as_bool) == Some(true);
    let authored = |key: &str| item.get(key).and_then(Value::as_str).filter(|value| !value.is_empty());
    let default_fit = playback.default_fit_mode.as_deref().unwrap_or("contain");
    let default_transition = playback.default_transition.as_deref().unwrap_or("none");
    let fit_mode = if delegates { default_fit } else { authored("fitMode").unwrap_or(default_fit) };
    let transition_mode =
        if delegates { default_transition } else { authored("transition").unwrap_or(default_transition) };
    let item_volume = item.get("volume").and_then(Value::as_f64).filter(|volume| volume.is_finite());
    let volume = match (delegates, item_volume) {
        (false, Some(volume)) => volume,
        _ => playback.default_volume,
    }
    .clamp(0.0, 1.0);
    let audio_enabled = match (delegates, item.get("audioEnabled").and_then(Value::as_bool)) {
        (false, Some(enabled)) => enabled,
        _ => playback.default_audio_enabled,
    };
    let duration_ms = if delegates && asset_type == "image" { fallback } else { authored_duration_ms.or(fallback) };
    ItemSettings {
        duration_ms,
        fit_mode: fit(fit_mode),
        transition: transition(transition_mode),
        audio_enabled,
        volume,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_only_documents_project() {
        let native = NativeConfiguration::parse(&serde_json::json!({
            "schemaVersion": 1,
            "configRevision": 3,
            "cache": {},
            "sync": {},
        }))
        .expect("native parses");
        let config =
            WindowsPlayerConfig::project(&serde_json::json!({"schemaVersion": 1, "configRevision": 3}), native)
                .expect("projects");
        assert_eq!(config.native.revision, 3);
        assert_eq!(config.runtime.playback.default_image_duration_ms, 10_000);
        assert!(WindowsPlayerConfig::project(&serde_json::json!([]), NativeConfiguration::default()).is_err());
    }

    #[test]
    fn runtime_sections_project_with_bounds() {
        let native = NativeConfiguration::parse(&serde_json::json!({
            "schemaVersion": 1,
            "configRevision": 3,
            "cache": {},
            "sync": {},
        }))
        .expect("native parses");
        let config = WindowsPlayerConfig::project(
            &serde_json::json!({
                "schemaVersion": 1,
                "configRevision": 3,
                "branding": {"backgroundColor": "#112233", "footerText": "Lobby"},
                "playback": {"defaultVolume": 0.25, "defaultFitMode": "cover", "screenLocation": "HQ"},
                "power": {"outsideActiveHoursDisplay": "bouncing_logo"},
                "website": {"cookiePolicy": "disabled", "clearOnRestart": true},
            }),
            native,
        )
        .expect("projects");
        assert_eq!(config.runtime.branding.background(), "#112233");
        assert_eq!(config.runtime.playback.default_volume, 0.25);
        assert_eq!(config.runtime.power.outside_display, "bouncing_logo");
        assert_eq!(config.runtime.website.cookie_policy.as_deref(), Some("disabled"));
        assert!(config.runtime.website.clear_on_restart);
    }

    #[test]
    fn item_settings_follow_the_reference_resolution() {
        let playback = Playback::default();
        let item = serde_json::json!({"assetType": "image"}).as_object().expect("test fixture").clone();
        let settings = item_settings(&item, &playback, None);
        assert_eq!((settings.duration_ms, settings.fit_mode), (Some(10_000), "contain"));
        let item = serde_json::json!({
            "assetType": "video", "fitMode": "cover", "transition": "fade", "volume": 0.9, "audioEnabled": false,
        })
        .as_object()
        .expect("test fixture")
        .clone();
        let settings = item_settings(&item, &playback, Some(5_000));
        assert_eq!(settings.duration_ms, Some(5_000));
        assert_eq!((settings.fit_mode, settings.transition), ("cover", "fade"));
        assert!(!settings.audio_enabled);
        assert_eq!(settings.volume, 0.9);
        // Unknown modes fall back; delegation takes the player defaults.
        let item = serde_json::json!({"assetType": "image", "fitMode": "spin", "usePlayerDefaults": true})
            .as_object()
            .expect("test fixture")
            .clone();
        let settings = item_settings(&item, &playback, None);
        assert_eq!(settings.fit_mode, "contain");
    }
}
