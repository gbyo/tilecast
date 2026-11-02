//! The player configuration document (`GET /api/v1/player/config`,
//! `apps/server/internal/settings/service.go#PlayerConfiguration`) as the
//! daemon applies it.
//!
//! Structure is validated strictly: the document must be an object with a
//! supported `schemaVersion`, an integer `configRevision`, and every known
//! section it carries must be an object. Anything else is refused and the
//! last accepted configuration stays in force. Individual values are read
//! the way the reference Linux player reads them (`apps/player-linux`): a
//! value of the wrong type falls back to that setting's default, so an
//! older or newer server never darkens a screen over one field.
//!
//! Author and manifest values stay authoritative where the player contract
//! says so: playback defaults apply only to items that delegate to them
//! (`usePlayerDefaults`) or leave a value unset.

use serde_json::{Map, Value};

pub use player_core::ConfigurationError as ConfigError;

const SECTIONS: &[&str] = &[
    "branding",
    "playback",
    "cache",
    "sync",
    "website",
    "reliability",
    "power",
    "managedKiosk",
    "linuxKiosk",
    "accessibility",
    "updates",
    "presentationNetwork",
];

pub const DEFAULT_BACKGROUND: &str = "#0E141B";
pub const DEFAULT_TEXT: &str = "#F5F7FA";
/// Where playback projection data for the runtime is bounded.
pub const MAX_PLAYBACK_CONTEXT_BYTES: usize = 16 * 1024;

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

impl Playback {
    /// Item-level resume after a restart. The server sends default-true;
    /// only an explicit false disables it.
    pub fn resume_after_restart(&self) -> bool {
        !matches!(self.context.get("resumeAfterRestart"), Some(Value::Bool(false)))
    }
}

/// The `website` section: player-wide Website defaults and overrides, read
/// as the reference Linux player reads them (`core/player.ts`, website items).
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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct LinuxKiosk {
    pub fullscreen_enabled: bool,
    pub prevent_display_sleep: bool,
}

impl Default for LinuxKiosk {
    fn default() -> Self {
        Self { fullscreen_enabled: true, prevent_display_sleep: true }
    }
}

/// Values used by Edge's Runtime projection. Core does not interpret these fields.
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimeConfiguration {
    pub branding: Branding,
    pub playback: Playback,
    pub power: Power,
    pub website: Website,
}

impl Default for RuntimeConfiguration {
    fn default() -> Self {
        Self {
            branding: Branding::default(),
            playback: Playback::default(),
            power: Power { outside_display: "black".to_owned(), outside_text: "Powered by Tilecast".to_owned() },
            website: Website::default(),
        }
    }
}

/// Configuration applied by Linux platform services.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlatformConfiguration {
    pub linux_kiosk: LinuxKiosk,
    /// Missing network settings leave the existing assignment in force.
    pub presentation_network: Option<Value>,
}

/// Accepted configuration split by its behavioral owner.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct PlayerConfig {
    pub native: player_core::NativeConfiguration,
    pub runtime: RuntimeConfiguration,
    pub platform: PlatformConfiguration,
}

fn section<'a>(document: &'a Map<String, Value>, name: &str) -> Option<&'a Map<String, Value>> {
    document.get(name).and_then(Value::as_object)
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
    values?.get(key)?.as_f64().filter(|value| value.is_finite())
}

impl PlayerConfig {
    /// Validates a document from the server or from local state.
    pub fn parse(document: &Value) -> Result<Self, ConfigError> {
        let native = player_core::NativeConfiguration::parse(document)?;
        Self::project(document, native)
    }

    /// Edge supplies Runtime and Linux projections after Core validates native policy.
    pub fn project(document: &Value, native: player_core::NativeConfiguration) -> Result<Self, ConfigError> {
        let object = document.as_object().ok_or(ConfigError::NotObject)?;
        for name in SECTIONS {
            if object.get(*name).is_some_and(|value| !value.is_object() && !value.is_null()) {
                return Err(ConfigError::InvalidSection);
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

        let kiosk_values = section(object, "linuxKiosk");
        let flag =
            |key: &str| kiosk_values.and_then(|values| values.get(key)).is_none_or(|v| v.as_bool() != Some(false));
        let linux_kiosk = LinuxKiosk {
            fullscreen_enabled: flag("fullscreenEnabled"),
            prevent_display_sleep: flag("preventDisplaySleep"),
        };

        let presentation_network = object.get("presentationNetwork").filter(|value| value.is_object()).cloned();
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

        Ok(Self {
            native,
            runtime: RuntimeConfiguration { branding, playback, power, website },
            platform: PlatformConfiguration { linux_kiosk, presentation_network },
        })
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

/// Resolves one manifest item against the playback defaults. `item` is the
/// manifest item object; its own `durationMs` has already been validated.
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
    use serde_json::json;

    fn document(overrides: Value) -> Value {
        let mut value = json!({"schemaVersion": 1, "configRevision": 4, "generatedAt": "2026-09-24T00:00:00Z"});
        for (key, field) in overrides.as_object().unwrap() {
            value[key] = field.clone();
        }
        value
    }

    #[test]
    fn resume_after_restart_defaults_true_and_only_false_disables() {
        assert!(Playback::default().resume_after_restart());
        let mut explicit = Playback::default();
        explicit.context.insert("resumeAfterRestart".into(), Value::Bool(false));
        assert!(!explicit.resume_after_restart());
        let mut truthy = Playback::default();
        truthy.context.insert("resumeAfterRestart".into(), Value::Bool(true));
        assert!(truthy.resume_after_restart());
        let mut garbage = Playback::default();
        garbage.context.insert("resumeAfterRestart".into(), Value::String("eventually".into()));
        assert!(garbage.resume_after_restart());
    }

    #[test]
    fn website_section_reads_like_the_reference_player() {
        let config = PlayerConfig::parse(&document(json!({"website": {
            "timeoutSeconds": 45, "defaultZoomPercent": 150, "cookiePolicy": "first_and_third_party",
            "defaultFailureBehavior": "skip", "clearOnRestart": true}})))
        .unwrap();
        assert_eq!(
            config.runtime.website,
            Website {
                timeout_seconds: Some(45),
                default_zoom_percent: Some(150),
                cookie_policy: Some("first_and_third_party".to_owned()),
                default_failure_behavior: Some("skip".to_owned()),
                clear_on_restart: true,
            }
        );
        // A value of the wrong type or outside its range falls back to the default.
        let config = PlayerConfig::parse(&document(json!({"website": {
            "timeoutSeconds": "45", "defaultZoomPercent": 5000, "cookiePolicy": "everything",
            "clearOnRestart": "yes"}})))
        .unwrap();
        assert_eq!(config.runtime.website, Website::default());
    }

    #[test]
    fn runtime_options_survive_native_configuration_preparation() {
        let document = document(json!({
            "playback": {"futureRuntimeOption": {"transition": "new", "values": [1, 2, 3]}},
            "cache": {"maximumBytes": 4096},
            "linuxKiosk": {"preventDisplaySleep": false}
        }));
        let native = player_core::NativeConfiguration::parse(&document).unwrap();
        let projected = PlayerConfig::project(&document, native.clone()).unwrap();
        assert_eq!(projected.native, native);
        assert_eq!(
            projected.runtime.playback.context["futureRuntimeOption"],
            document["playback"]["futureRuntimeOption"]
        );
        assert_eq!(projected.native.cache.maximum_bytes, Some(4096));
        assert!(!projected.platform.linux_kiosk.prevent_display_sleep);
    }

    #[test]
    fn structure_is_strict() {
        assert!(PlayerConfig::parse(&document(json!({}))).is_ok());
        assert_eq!(PlayerConfig::parse(&json!([1])), Err(ConfigError::NotObject));
        assert_eq!(PlayerConfig::parse(&document(json!({"schemaVersion": 2}))), Err(ConfigError::UnsupportedSchema));
        assert_eq!(PlayerConfig::parse(&document(json!({"schemaVersion": "1"}))), Err(ConfigError::UnsupportedSchema));
        assert_eq!(PlayerConfig::parse(&document(json!({"configRevision": -1}))), Err(ConfigError::InvalidRevision));
        assert_eq!(PlayerConfig::parse(&document(json!({"configRevision": 1.5}))), Err(ConfigError::InvalidRevision));
        assert_eq!(PlayerConfig::parse(&document(json!({"power": "on"}))), Err(ConfigError::InvalidSection));
        let big = "x".repeat(edge_server::player_api::MAX_CONFIG_BYTES);
        assert_eq!(
            PlayerConfig::parse(&document(json!({"branding": {"footerText": big}}))),
            Err(ConfigError::TooLarge)
        );
    }

    #[test]
    fn values_fall_back_like_the_reference_player() {
        let config = PlayerConfig::parse(&document(json!({
            "branding": {"backgroundColor": "red", "textColor": "#abcdef", "disabledTitle": "  Closed  "},
            "sync": {"statusReportSeconds": 5, "manifestReconciliationSeconds": 120},
            "reliability": {"playbackStallSeconds": 1, "maximumProcessRestarts": 0, "safeModeEnabled": false},
            "linuxKiosk": {"preventDisplaySleep": false},
        })))
        .unwrap();
        assert_eq!(config.runtime.branding.background(), DEFAULT_BACKGROUND);
        assert_eq!(config.runtime.branding.text(), "#abcdef");
        assert_eq!(config.runtime.branding.disabled_title.as_deref(), Some("Closed"));
        assert_eq!(config.native.sync.status_report, std::time::Duration::from_secs(60), "below 15 s is ignored");
        assert_eq!(config.native.sync.manifest_reconciliation, std::time::Duration::from_secs(120));
        let reliability = config.native.reliability.unwrap();
        assert_eq!(reliability.stall_threshold_ms, 10_000);
        assert_eq!(reliability.max_ladder_runs_before_safe_mode, 1);
        assert!(!reliability.safe_mode_enabled);
        assert!(!config.platform.linux_kiosk.prevent_display_sleep);
        assert!(config.platform.linux_kiosk.fullscreen_enabled);
    }

    fn item(value: Value) -> Map<String, Value> {
        value.as_object().unwrap().clone()
    }

    #[test]
    fn playback_defaults_match_the_shared_projection() {
        // The cases of apps/player-linux/src/core/playback-defaults.test.ts.
        let playback = Playback { default_image_duration_ms: 8_000, ..Playback::default() };
        let video = item(json!({"assetType": "video", "usePlayerDefaults": true, "volume": 1, "audioEnabled": true}));
        assert_eq!(item_settings(&video, &playback, None).duration_ms, None);
        assert_eq!(fallback_duration_ms("website", 8_000), Some(60_000));
        assert_eq!(fallback_duration_ms("widget", 8_000), Some(30_000));
        assert_eq!(fallback_duration_ms("layout", 8_000), Some(30_000));

        let delegating = Playback {
            default_image_duration_ms: 22_000,
            default_fit_mode: Some("cover".into()),
            default_transition: Some("fade".into()),
            default_audio_enabled: false,
            default_volume: 0.25,
            ..Playback::default()
        };
        let image = item(json!({"assetType": "image", "durationMs": 10000, "fitMode": "contain", "transition": "none",
                                 "audioEnabled": true, "volume": 1, "usePlayerDefaults": true}));
        assert_eq!(
            item_settings(&image, &delegating, Some(10_000)),
            ItemSettings {
                duration_ms: Some(22_000),
                fit_mode: "cover",
                transition: "fade",
                audio_enabled: false,
                volume: 0.25
            }
        );
        let authored = item(json!({"assetType": "image", "durationMs": 10000, "fitMode": "stretch",
                                    "transition": "crossfade", "audioEnabled": true, "volume": 0.9,
                                    "usePlayerDefaults": false}));
        assert_eq!(
            item_settings(&authored, &delegating, Some(10_000)),
            ItemSettings {
                duration_ms: Some(10_000),
                fit_mode: "stretch",
                transition: "crossfade",
                audio_enabled: true,
                volume: 0.9
            }
        );
        // An unset authored value takes the configured default.
        let sparse = item(json!({"assetType": "image"}));
        assert_eq!(
            item_settings(&sparse, &delegating, None),
            ItemSettings {
                duration_ms: Some(22_000),
                fit_mode: "cover",
                transition: "fade",
                audio_enabled: false,
                volume: 0.25
            }
        );
    }
}
