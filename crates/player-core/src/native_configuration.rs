//! Native configuration policy. Runtime and platform fields remain host-owned.
use jiff::Timestamp as JiffTimestamp;
use jiff::tz::TimeZone;
use player_client::player_api::MAX_CONFIG_BYTES;
use serde_json::{Map, Value};
use std::time::Duration;

const SUPPORTED_SCHEMA_VERSIONS: &[i64] = &[1];
const SECTIONS: &[&str] = &["cache", "sync", "reliability", "power"];

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

/// Configuration policy used by native coordination, independent of renderer appearance.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct NativeConfiguration {
    pub schema_version: i64,
    pub revision: i64,
    pub cache: Cache,
    pub sync: Sync,
    pub reliability: Option<Reliability>,
    pub active_hours: Option<ActiveHours>,
}

impl Default for NativeConfiguration {
    fn default() -> Self {
        Self {
            schema_version: 1,
            revision: 0,
            cache: Cache::default(),
            sync: Sync::default(),
            reliability: None,
            active_hours: None,
        }
    }
}

fn section<'a>(document: &'a Map<String, Value>, name: &str) -> Option<&'a Map<String, Value>> {
    document.get(name).and_then(Value::as_object)
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

impl NativeConfiguration {
    /// Validate the bounded envelope and project native values using the existing Player defaults.
    /// Runtime fields and platform policy stay with the host.
    pub fn parse(document: &Value) -> Result<Self, ConfigError> {
        let object = document.as_object().ok_or(ConfigError::NotObject)?;
        if serde_json::to_vec(document).map_or(true, |encoded| encoded.len() > MAX_CONFIG_BYTES) {
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
        Ok(Self { schema_version, revision, cache, sync, reliability, active_hours })
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn native_values_keep_existing_defaults_and_bounds() {
        let document = json!({"schemaVersion":1,"configRevision":7,
            "cache":{"maximumBytes":123.9,"minimumFreeBytes":-1},
            "sync":{"statusReportSeconds":5,"manifestReconciliationSeconds":120.9},
            "reliability":{"playbackStallSeconds":1,"restartWindowMinutes":100000,
                "maximumProcessRestarts":0,"safeModeEnabled":false},
            "power":{"activeHoursEnabled":true,"activeHoursTimezone":" UTC ",
                "activeHoursDays":[1,2.5,8,7],"activeHoursStart":"7:30","activeHoursEnd":"bad"},
            "playback":{"futureOption":{"transition":"new"}},
            "futurePlatform":{"policy":"host-owned"}});
        let parsed = NativeConfiguration::parse(&document).unwrap();
        assert_eq!(parsed.revision, 7);
        assert_eq!(parsed.cache, Cache { maximum_bytes: Some(123), minimum_free_bytes: None });
        assert_eq!(
            parsed.sync,
            Sync { status_report: Duration::from_secs(60), manifest_reconciliation: Duration::from_secs(120) }
        );
        assert_eq!(
            parsed.reliability,
            Some(Reliability {
                stall_threshold_ms: 10000,
                ladder_run_window_ms: 7 * 86400000,
                max_ladder_runs_before_safe_mode: 1,
                safe_mode_enabled: false
            })
        );
        let hours = parsed.active_hours.as_ref().unwrap();
        assert_eq!(hours.timezone, "UTC");
        assert_eq!(hours.days, vec![1, 7]);
        assert_eq!(hours.start_minutes, Some(450));
        assert_eq!(hours.end_minutes, None);
        assert!(evaluate_active_hours(Some(hours), 0).active);
        assert_eq!(
            NativeConfiguration::parse(&json!({"schemaVersion":1,"configRevision":0})).unwrap(),
            NativeConfiguration::default()
        );
    }

    #[test]
    fn envelope_and_native_sections_fail_closed() {
        for (document, error) in [
            (json!([]), ConfigError::NotObject),
            (json!({"schemaVersion":2,"configRevision":0}), ConfigError::UnsupportedSchema),
            (json!({"schemaVersion":1,"configRevision":-1}), ConfigError::InvalidRevision),
            (json!({"schemaVersion":1,"configRevision":1.5}), ConfigError::InvalidRevision),
            (json!({"schemaVersion":1,"configRevision":0,"cache":false}), ConfigError::InvalidSection),
            (
                json!({"schemaVersion":1,"configRevision":0,"future":"x".repeat(MAX_CONFIG_BYTES)}),
                ConfigError::TooLarge,
            ),
        ] {
            assert_eq!(NativeConfiguration::parse(&document), Err(error));
        }
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
}
