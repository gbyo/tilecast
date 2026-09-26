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

use std::time::Duration;

use jiff::Timestamp as JiffTimestamp;
use jiff::tz::TimeZone;
use serde_json::{Map, Value};

pub const SUPPORTED_SCHEMA_VERSIONS: &[i64] = &[1];

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

#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ConfigError {
    #[error("the configuration is not an object")]
    NotObject,
    #[error("the configuration schema version is missing or unsupported")]
    UnsupportedSchema,
    #[error("the configuration revision is missing or invalid")]
    InvalidRevision,
    #[error("a configuration section is not an object")]
    InvalidSection,
    #[error("the configuration exceeds its size bound")]
    TooLarge,
}

impl ConfigError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::NotObject => "config_malformed",
            Self::UnsupportedSchema => "config_schema_unsupported",
            Self::InvalidRevision => "config_revision_invalid",
            Self::InvalidSection => "config_section_invalid",
            Self::TooLarge => "config_too_large",
        }
    }
}

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

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Cache {
    pub maximum_bytes: Option<u64>,
    pub minimum_free_bytes: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Sync {
    pub status_report: Duration,
    pub manifest_reconciliation: Duration,
}

impl Default for Sync {
    fn default() -> Self {
        Self { status_report: Duration::from_secs(60), manifest_reconciliation: Duration::from_secs(300) }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Reliability {
    pub stall_threshold_ms: i64,
    pub ladder_run_window_ms: i64,
    pub max_ladder_runs_before_safe_mode: usize,
    pub safe_mode_enabled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveHours {
    pub timezone: String,
    /// ISO weekdays the window may start on: 1 = Monday .. 7 = Sunday.
    pub days: Vec<i8>,
    pub start_minutes: Option<i32>,
    pub end_minutes: Option<i32>,
}

#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Power {
    pub active_hours: Option<ActiveHours>,
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

/// A validated configuration document and the values the daemon applies.
#[derive(Debug, Clone, PartialEq)]
pub struct PlayerConfig {
    pub schema_version: i64,
    pub revision: i64,
    pub branding: Branding,
    pub playback: Playback,
    pub cache: Cache,
    pub sync: Sync,
    pub reliability: Option<Reliability>,
    pub power: Power,
    pub linux_kiosk: LinuxKiosk,
}

impl Default for PlayerConfig {
    /// What applies before any configuration was accepted: the reference
    /// player's defaults for every setting.
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            branding: Branding::default(),
            playback: Playback::default(),
            cache: Cache::default(),
            sync: Sync::default(),
            reliability: None,
            power: Power {
                active_hours: None,
                outside_display: "black".to_owned(),
                outside_text: "Powered by Tilecast".to_owned(),
            },
            linux_kiosk: LinuxKiosk::default(),
        }
    }
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

fn bytes(values: Option<&Map<String, Value>>, key: &str) -> Option<u64> {
    number(values, key).filter(|value| *value >= 0.0 && *value <= 9.0e18).map(|value| value as u64)
}

fn parse_hhmm(value: &str) -> Option<i32> {
    let (hours, minutes) = value.trim().split_once(':')?;
    if hours.is_empty() || hours.len() > 2 || minutes.len() != 2 {
        return None;
    }
    let (hours, minutes): (i32, i32) = (hours.parse().ok()?, minutes.parse().ok()?);
    ((0..=23).contains(&hours) && (0..=59).contains(&minutes)).then_some(hours * 60 + minutes)
}

impl PlayerConfig {
    /// Validates a document from the server or from local state.
    pub fn parse(document: &Value) -> Result<Self, ConfigError> {
        let object = document.as_object().ok_or(ConfigError::NotObject)?;
        if serde_json::to_vec(document)
            .map_or(true, |encoded| encoded.len() > edge_server::player_api::MAX_CONFIG_BYTES)
        {
            return Err(ConfigError::TooLarge);
        }
        let schema_version = object
            .get("schemaVersion")
            .and_then(Value::as_i64)
            .filter(|version| SUPPORTED_SCHEMA_VERSIONS.contains(version))
            .ok_or(ConfigError::UnsupportedSchema)?;
        let revision = object
            .get("configRevision")
            .and_then(Value::as_i64)
            .filter(|revision| *revision >= 0)
            .ok_or(ConfigError::InvalidRevision)?;
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

        let cache_values = section(object, "cache");
        let cache = Cache {
            maximum_bytes: bytes(cache_values, "maximumBytes"),
            minimum_free_bytes: bytes(cache_values, "minimumFreeBytes"),
        };

        let sync_values = section(object, "sync");
        let sync_defaults = Sync::default();
        let sync = Sync {
            status_report: number(sync_values, "statusReportSeconds")
                .filter(|seconds| *seconds >= 15.0 && *seconds <= 86_400.0)
                .map_or(sync_defaults.status_report, |seconds| Duration::from_secs(seconds as u64)),
            manifest_reconciliation: number(sync_values, "manifestReconciliationSeconds")
                .filter(|seconds| *seconds >= 60.0 && *seconds <= 86_400.0)
                .map_or(sync_defaults.manifest_reconciliation, |seconds| Duration::from_secs(seconds as u64)),
        };

        let reliability = section(object, "reliability").map(|values| {
            let values = Some(values);
            Reliability {
                stall_threshold_ms: number(values, "playbackStallSeconds")
                    .map_or(3 * 60_000, |seconds| ((seconds * 1_000.0) as i64).clamp(10_000, 86_400_000)),
                ladder_run_window_ms: number(values, "restartWindowMinutes")
                    .map_or(60 * 60_000, |minutes| ((minutes * 60_000.0) as i64).clamp(60_000, 7 * 86_400_000)),
                max_ladder_runs_before_safe_mode: number(values, "maximumProcessRestarts")
                    .map_or(3, |count| (count.floor() as i64).clamp(1, 1_000) as usize),
                safe_mode_enabled: values
                    .and_then(|values| values.get("safeModeEnabled"))
                    .is_none_or(|value| value.as_bool() != Some(false)),
            }
        });

        let power_values = section(object, "power");
        let active_hours = power_values
            .filter(|values| values.get("activeHoursEnabled").and_then(Value::as_bool) == Some(true))
            .map(|values| ActiveHours {
                timezone: values
                    .get("activeHoursTimezone")
                    .and_then(Value::as_str)
                    .map_or("UTC", str::trim)
                    .chars()
                    .take(64)
                    .collect(),
                days: values
                    .get("activeHoursDays")
                    .and_then(Value::as_array)
                    .map(|days| {
                        days.iter()
                            .filter_map(Value::as_f64)
                            .filter(|day| (1.0..=7.0).contains(day) && day.fract() == 0.0)
                            .map(|day| day as i8)
                            .take(7)
                            .collect()
                    })
                    .unwrap_or_default(),
                start_minutes: values.get("activeHoursStart").and_then(Value::as_str).and_then(parse_hhmm),
                end_minutes: values.get("activeHoursEnd").and_then(Value::as_str).and_then(parse_hhmm),
            });
        let outside_display = match text(power_values, "outsideActiveHoursDisplay", 32).as_deref() {
            Some(mode @ ("bouncing_logo" | "custom_text")) => mode.to_owned(),
            _ => "black".to_owned(),
        };
        let outside_text = text(power_values, "outsideActiveHoursText", 240)
            .or_else(|| branding.footer_text.clone())
            .unwrap_or_else(|| "Powered by Tilecast".to_owned());
        let power = Power { active_hours, outside_display, outside_text };

        let kiosk_values = section(object, "linuxKiosk");
        let flag =
            |key: &str| kiosk_values.and_then(|values| values.get(key)).is_none_or(|v| v.as_bool() != Some(false));
        let linux_kiosk = LinuxKiosk {
            fullscreen_enabled: flag("fullscreenEnabled"),
            prevent_display_sleep: flag("preventDisplaySleep"),
        };

        Ok(Self { schema_version, revision, branding, playback, cache, sync, reliability, power, linux_kiosk })
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

/// Whether the screen should present content now, and roughly when that
/// next changes. Windows are half-open `[start, end)` in an IANA timezone;
/// an end at or before the start is an overnight window belonging to the
/// start day. A disabled, unreadable or empty schedule is always active: a
/// broken schedule must never darken a screen that should show content
/// (the reference player's `evaluateActiveHours`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActiveHoursResult {
    pub active: bool,
    pub ms_until_transition: Option<i64>,
}

pub fn evaluate_active_hours(hours: Option<&ActiveHours>, now_ms: i64) -> ActiveHoursResult {
    let always = ActiveHoursResult { active: true, ms_until_transition: None };
    let Some(hours) = hours else { return always };
    let (Some(start), Some(end)) = (hours.start_minutes, hours.end_minutes) else { return always };
    if hours.days.is_empty() {
        return always;
    }
    let Ok(zone) = TimeZone::get(&hours.timezone) else { return always };
    let Ok(instant) = JiffTimestamp::from_millisecond(now_ms) else { return always };
    let local = instant.to_zoned(zone);
    let weekday = local.weekday().to_monday_one_offset();
    let minutes = i32::from(local.hour()) * 60 + i32::from(local.minute());
    let previous = if weekday == 1 { 7 } else { weekday - 1 };
    let overnight = end <= start;
    let active = if overnight {
        (hours.days.contains(&weekday) && minutes >= start) || (hours.days.contains(&previous) && minutes < end)
    } else {
        hours.days.contains(&weekday) && minutes >= start && minutes < end
    };
    let day = 24 * 60;
    let next = [start, end]
        .iter()
        .map(|edge| {
            let delta = edge - minutes;
            if delta <= 0 { delta + day } else { delta }
        })
        .min()
        .unwrap_or(day);
    // Minute precision is enough: the caller re-evaluates at this point and
    // on every other wake.
    let seconds_into_minute = i64::from(local.second()) * 1_000 + i64::from(local.millisecond());
    ActiveHoursResult { active, ms_until_transition: Some((i64::from(next) * 60_000 - seconds_into_minute).max(1_000)) }
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
        assert_eq!(config.branding.background(), DEFAULT_BACKGROUND);
        assert_eq!(config.branding.text(), "#abcdef");
        assert_eq!(config.branding.disabled_title.as_deref(), Some("Closed"));
        assert_eq!(config.sync.status_report, Duration::from_secs(60), "below 15 s is ignored");
        assert_eq!(config.sync.manifest_reconciliation, Duration::from_secs(120));
        let reliability = config.reliability.unwrap();
        assert_eq!(reliability.stall_threshold_ms, 10_000);
        assert_eq!(reliability.max_ladder_runs_before_safe_mode, 1);
        assert!(!reliability.safe_mode_enabled);
        assert!(!config.linux_kiosk.prevent_display_sleep);
        assert!(config.linux_kiosk.fullscreen_enabled);
    }

    fn hours(days: &[i8], start: &str, end: &str) -> ActiveHours {
        ActiveHours {
            timezone: "America/Chicago".to_owned(),
            days: days.to_vec(),
            start_minutes: parse_hhmm(start),
            end_minutes: parse_hhmm(end),
        }
    }

    fn at(text: &str) -> i64 {
        text.parse::<JiffTimestamp>().unwrap().as_millisecond()
    }

    #[test]
    fn active_hours_follow_the_reference_rules() {
        let weekdays = hours(&[1, 2, 3, 4, 5], "07:30", "17:00");
        // Thursday 2026-09-24 08:00 in Chicago is 13:00 UTC.
        assert!(evaluate_active_hours(Some(&weekdays), at("2026-09-24T13:00:00Z")).active);
        // 17:00 local is the half-open end.
        let end = evaluate_active_hours(Some(&weekdays), at("2026-09-24T22:00:00Z"));
        assert!(!end.active);
        // Saturday is not listed.
        assert!(!evaluate_active_hours(Some(&weekdays), at("2026-09-26T15:00:00Z")).active);
        let result = evaluate_active_hours(Some(&weekdays), at("2026-09-24T12:00:00Z"));
        assert!(!result.active);
        assert_eq!(result.ms_until_transition, Some(30 * 60_000), "07:00 local, window opens at 07:30");

        let overnight = hours(&[5], "22:00", "06:00");
        // Friday 23:00 and Saturday 05:00 local belong to Friday's window.
        assert!(evaluate_active_hours(Some(&overnight), at("2026-09-26T04:00:00Z")).active);
        assert!(evaluate_active_hours(Some(&overnight), at("2026-09-26T10:00:00Z")).active);
        assert!(!evaluate_active_hours(Some(&overnight), at("2026-09-26T11:00:00Z")).active);

        for broken in [hours(&[], "07:00", "17:00"), hours(&[1], "7am", "17:00"), {
            let mut value = hours(&[1], "07:00", "17:00");
            value.timezone = "Mars/Olympus".to_owned();
            value
        }] {
            assert!(evaluate_active_hours(Some(&broken), at("2026-09-26T04:00:00Z")).active);
        }
        assert!(evaluate_active_hours(None, 0).active);
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
