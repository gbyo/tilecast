//! Offline selection of the server-compiled presentation manifest.
//!
//! This ports the precedence and half-open window rules from the existing
//! Linux player's `core/schedule.ts`. The selected IDs still refer to content
//! compiled by the server; this module does not compile presentations.

use jiff::civil::Date;
use jiff::tz::{AmbiguousOffset, TimeZone};
use jiff::{Span, Timestamp};
use serde::Deserialize;
use serde_json::Value;
use uuid::Uuid;

const MAX_SCHEDULES: usize = 512;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Takeover,
    QuickPresent,
    Schedule,
    Direct,
    None,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    pub playlist_id: Option<Uuid>,
    pub layout_id: Option<Uuid>,
    pub schedule_id: Option<Uuid>,
    pub takeover_id: Option<Uuid>,
    pub source: Source,
    pub next_transition_ms: Option<i64>,
    pub playback_anchor_ms: Option<i64>,
}

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ScheduleError {
    #[error("the manifest schedule is malformed or unsupported")]
    Invalid,
    #[error("the manifest has too many schedules")]
    TooMany,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    playlist: Option<IdOnly>,
    direct_fallback_playlist: Option<IdOnly>,
    layout: Option<IdOnly>,
    direct_fallback_layout: Option<IdOnly>,
    #[serde(default)]
    schedules: Vec<Schedule>,
    takeover: Option<Takeover>,
    emergency: Option<Takeover>,
    presentation_override: Option<Override>,
}

#[derive(Debug, Deserialize)]
struct IdOnly {
    id: Uuid,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Schedule {
    id: Uuid,
    playlist_id: Option<Uuid>,
    layout_id: Option<Uuid>,
    /// A Display Control action instead of content (`docs/display-control.md`).
    #[serde(default)]
    display_action: Option<Value>,
    #[serde(rename = "type")]
    kind: String,
    timezone: String,
    priority: i32,
    specificity: i32,
    start_date: Option<String>,
    end_date: Option<String>,
    one_time_start: Option<String>,
    one_time_end: Option<String>,
    daily_start: Option<String>,
    daily_end: Option<String>,
    days_of_week: Option<Vec<u8>>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Takeover {
    id: Uuid,
    playlist_id: Uuid,
    activated_at: String,
    expires_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Override {
    content_type: String,
    content_id: Uuid,
    started_at: String,
    expires_at: Option<String>,
    playlist_id: Option<Uuid>,
    layout_id: Option<Uuid>,
}

#[derive(Clone, Copy)]
struct Window<'a> {
    schedule: &'a Schedule,
    start: i64,
    end: i64,
}

fn timestamp(value: &str) -> Result<i64, ScheduleError> {
    value.parse::<Timestamp>().map(|at| at.as_millisecond()).map_err(|_| ScheduleError::Invalid)
}

fn date(value: &str) -> Result<Date, ScheduleError> {
    value.parse().map_err(|_| ScheduleError::Invalid)
}

fn clock(value: Option<&str>) -> Result<(i8, i8), ScheduleError> {
    let bytes = value.ok_or(ScheduleError::Invalid)?.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' || !bytes.iter().enumerate().all(|(i, b)| i == 2 || b.is_ascii_digit()) {
        return Err(ScheduleError::Invalid);
    }
    let hour = ((bytes[0] - b'0') * 10 + bytes[1] - b'0') as i8;
    let minute = ((bytes[3] - b'0') * 10 + bytes[4] - b'0') as i8;
    if hour > 23 || minute > 59 {
        return Err(ScheduleError::Invalid);
    }
    Ok((hour, minute))
}

fn local_instant(day: Date, clock: (i8, i8), zone: &TimeZone, end: bool) -> Result<i64, ScheduleError> {
    let wanted = day.at(clock.0, clock.1, 0, 0);
    let mut ambiguous = zone.to_ambiguous_zoned(wanted);
    if matches!(ambiguous.offset(), AmbiguousOffset::Gap { .. }) {
        // The existing player advances a nonexistent wall minute to the
        // first real minute after the spring-forward gap, rather than
        // preserving the minute offset inside the gap.
        for minute in 1..=180 {
            let shifted = wanted.checked_add(Span::new().minutes(minute)).map_err(|_| ScheduleError::Invalid)?;
            ambiguous = zone.to_ambiguous_zoned(shifted);
            if !matches!(ambiguous.offset(), AmbiguousOffset::Gap { .. }) {
                break;
            }
        }
        if matches!(ambiguous.offset(), AmbiguousOffset::Gap { .. }) {
            return Err(ScheduleError::Invalid);
        }
    }
    let resolved = if end { ambiguous.later() } else { ambiguous.compatible() };
    resolved.map(|at| at.timestamp().as_millisecond()).map_err(|_| ScheduleError::Invalid)
}

fn windows(schedule: &Schedule, now: Timestamp) -> Result<Vec<Window<'_>>, ScheduleError> {
    if schedule.kind == "one_time" {
        let start = timestamp(schedule.one_time_start.as_deref().ok_or(ScheduleError::Invalid)?)?;
        let end = timestamp(schedule.one_time_end.as_deref().ok_or(ScheduleError::Invalid)?)?;
        if end <= start {
            return Err(ScheduleError::Invalid);
        }
        return Ok(vec![Window { schedule, start, end }]);
    }
    if schedule.kind != "weekly" {
        return Err(ScheduleError::Invalid);
    }
    let zone = TimeZone::get(&schedule.timezone).map_err(|_| ScheduleError::Invalid)?;
    let today = now.to_zoned(zone.clone()).date();
    let start_clock = clock(schedule.daily_start.as_deref())?;
    let end_clock = clock(schedule.daily_end.as_deref())?;
    let start_bound = schedule.start_date.as_deref().map(date).transpose()?;
    let end_bound = schedule.end_date.as_deref().map(date).transpose()?;
    let days = schedule.days_of_week.as_deref().ok_or(ScheduleError::Invalid)?;
    if days.len() > 7 || days.iter().any(|day| *day > 6) || start_bound.zip(end_bound).is_some_and(|(a, b)| a > b) {
        return Err(ScheduleError::Invalid);
    }
    let overnight = end_clock <= start_clock;
    let mut result = Vec::new();
    for offset in -1..=8 {
        let origin = today.checked_add(Span::new().days(offset)).map_err(|_| ScheduleError::Invalid)?;
        if !days.contains(&(origin.weekday().to_sunday_zero_offset() as u8))
            || start_bound.is_some_and(|bound| origin < bound)
            || end_bound.is_some_and(|bound| origin > bound)
        {
            continue;
        }
        let end_day = if overnight {
            origin.checked_add(Span::new().days(1)).map_err(|_| ScheduleError::Invalid)?
        } else {
            origin
        };
        let start = local_instant(origin, start_clock, &zone, false)?;
        let end = local_instant(end_day, end_clock, &zone, true)?;
        if end > start {
            result.push(Window { schedule, start, end });
        }
    }
    Ok(result)
}

/// Resolves the content to show at an instant, including the next boundary
/// that must wake the daemon even when the server is offline.
pub fn resolve(document: &Value, now_ms: i64) -> Result<Selection, ScheduleError> {
    let manifest: Manifest = serde_json::from_value(document.clone()).map_err(|_| ScheduleError::Invalid)?;
    if manifest.schedules.len() > MAX_SCHEDULES {
        return Err(ScheduleError::TooMany);
    }
    let now = Timestamp::from_millisecond(now_ms).map_err(|_| ScheduleError::Invalid)?;
    let takeover = manifest.takeover.as_ref().or(manifest.emergency.as_ref());
    let override_ = manifest.presentation_override.as_ref();
    let mut all_windows = Vec::new();
    for schedule in &manifest.schedules {
        if schedule.playlist_id.is_some() || schedule.layout_id.is_some() {
            all_windows.extend(windows(schedule, now)?);
        }
    }
    let mut future: Vec<i64> =
        all_windows.iter().flat_map(|window| [window.start, window.end]).filter(|at| *at > now_ms).collect();
    let takeover_times = takeover
        .map(|value| -> Result<_, ScheduleError> {
            Ok((timestamp(&value.activated_at)?, timestamp(&value.expires_at)?))
        })
        .transpose()?;
    if let Some((start, end)) = takeover_times {
        future.extend([start, end].into_iter().filter(|at| *at > now_ms));
    }
    let override_times = override_
        .map(|value| -> Result<_, ScheduleError> {
            Ok((timestamp(&value.started_at)?, value.expires_at.as_deref().map(timestamp).transpose()?))
        })
        .transpose()?;
    if let Some((start, end)) = override_times {
        future.extend([start].into_iter().chain(end).filter(|at| *at > now_ms));
    }
    let base = |playlist_id, layout_id, schedule_id, takeover_id, source, playback_anchor_ms| Selection {
        playlist_id,
        layout_id,
        schedule_id,
        takeover_id,
        source,
        next_transition_ms: future.iter().copied().min(),
        playback_anchor_ms,
    };
    if let (Some(takeover), Some((start, end))) = (takeover, takeover_times)
        && start <= now_ms
        && now_ms < end
    {
        return Ok(base(Some(takeover.playlist_id), None, None, Some(takeover.id), Source::Takeover, Some(start)));
    }
    if let (Some(override_), Some((start, end))) = (override_, override_times)
        && start <= now_ms
        && end.is_none_or(|end| now_ms < end)
    {
        let playlist_id =
            override_.playlist_id.or((override_.content_type == "playlist").then_some(override_.content_id));
        let layout_id = override_.layout_id.or((override_.content_type == "layout").then_some(override_.content_id));
        if playlist_id.is_none() == layout_id.is_none() {
            return Err(ScheduleError::Invalid);
        }
        return Ok(base(playlist_id, layout_id, None, None, Source::QuickPresent, Some(start)));
    }
    let mut active: Vec<_> =
        all_windows.into_iter().filter(|window| window.start <= now_ms && now_ms < window.end).collect();
    active.sort_by(|a, b| {
        b.schedule
            .priority
            .cmp(&a.schedule.priority)
            .then(b.schedule.specificity.cmp(&a.schedule.specificity))
            .then(b.start.cmp(&a.start))
            .then(a.schedule.id.cmp(&b.schedule.id))
    });
    if let Some(winner) = active.first() {
        return Ok(base(
            winner.schedule.playlist_id,
            winner.schedule.layout_id,
            Some(winner.schedule.id),
            None,
            Source::Schedule,
            Some(winner.start),
        ));
    }
    if let Some(playlist) = manifest.playlist.or(manifest.direct_fallback_playlist) {
        return Ok(base(Some(playlist.id), None, None, None, Source::Direct, None));
    }
    if let Some(layout) = manifest.layout.or(manifest.direct_fallback_layout) {
        return Ok(base(None, Some(layout.id), None, None, Source::Direct, None));
    }
    Ok(base(None, None, None, None, Source::None, None))
}

/// The Display Control action scheduled at an instant.
#[derive(Debug, Clone, PartialEq)]
pub struct DisplayPolicy {
    /// The winning schedule's action, exactly as the manifest carries it.
    pub action: Option<Value>,
    pub schedule_id: Option<Uuid>,
    pub next_transition_ms: Option<i64>,
}

/// Resolves scheduled display actions with the same windows and precedence
/// as content schedules (the reference player's `resolveDisplayPolicy`). A
/// display action never changes what content plays.
pub fn resolve_display_policy(document: &Value, now_ms: i64) -> Result<DisplayPolicy, ScheduleError> {
    #[derive(Deserialize)]
    struct Schedules {
        #[serde(default)]
        schedules: Vec<Schedule>,
    }
    let manifest: Schedules = serde_json::from_value(document.clone()).map_err(|_| ScheduleError::Invalid)?;
    if manifest.schedules.len() > MAX_SCHEDULES {
        return Err(ScheduleError::TooMany);
    }
    let now = Timestamp::from_millisecond(now_ms).map_err(|_| ScheduleError::Invalid)?;
    let mut policy_windows = Vec::new();
    for schedule in &manifest.schedules {
        if schedule.display_action.as_ref().is_some_and(|action| !action.is_null()) {
            policy_windows.extend(windows(schedule, now)?);
        }
    }
    let next_transition_ms =
        policy_windows.iter().flat_map(|window| [window.start, window.end]).filter(|at| *at > now_ms).min();
    let mut active: Vec<_> =
        policy_windows.into_iter().filter(|window| window.start <= now_ms && now_ms < window.end).collect();
    active.sort_by(|a, b| {
        b.schedule
            .priority
            .cmp(&a.schedule.priority)
            .then(b.schedule.specificity.cmp(&a.schedule.specificity))
            .then(b.start.cmp(&a.start))
            .then(a.schedule.id.cmp(&b.schedule.id))
    });
    let winner = active.first();
    Ok(DisplayPolicy {
        action: winner.and_then(|window| window.schedule.display_action.clone()),
        schedule_id: winner.map(|window| window.schedule.id),
        next_transition_ms,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const DIRECT: &str = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    const SCHEDULED: &str = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
    const SCHEDULE: &str = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

    fn base() -> Value {
        json!({"playlist": {"id": DIRECT}, "schedules": []})
    }

    fn weekly() -> Value {
        json!({"id": SCHEDULE, "playlistId": SCHEDULED, "type": "weekly", "timezone": "America/New_York",
            "priority": 10, "specificity": 1, "dailyStart": "09:00", "dailyEnd": "17:00", "daysOfWeek": [1,2,3,4,5]})
    }

    fn at(value: &str) -> i64 {
        timestamp(value).unwrap()
    }

    #[test]
    fn direct_and_weekly_precedence_with_exact_boundary() {
        let mut manifest = base();
        manifest["schedules"] = json!([weekly()]);
        let selected = resolve(&manifest, at("2026-07-17T15:00:00Z")).unwrap();
        assert_eq!(selected.source, Source::Schedule);
        assert_eq!(selected.playlist_id.unwrap().to_string(), SCHEDULED);
        assert_eq!(selected.next_transition_ms, Some(at("2026-07-17T21:00:00Z")));
        let ended = resolve(&manifest, at("2026-07-17T21:00:00Z")).unwrap();
        assert_eq!(ended.source, Source::Direct);
    }

    #[test]
    fn overnight_window_uses_its_start_day_and_dst_fold_spans_both_occurrences() {
        let mut manifest = base();
        let mut overnight = weekly();
        overnight["dailyStart"] = json!("22:00");
        overnight["dailyEnd"] = json!("06:00");
        overnight["daysOfWeek"] = json!([5]);
        overnight["startDate"] = json!("2026-07-17");
        overnight["endDate"] = json!("2026-07-17");
        manifest["schedules"] = json!([overnight]);
        assert_eq!(resolve(&manifest, at("2026-07-18T06:00:00Z")).unwrap().source, Source::Schedule);
        assert_eq!(resolve(&manifest, at("2026-07-18T11:00:00Z")).unwrap().source, Source::Direct);

        let mut fall = weekly();
        fall["dailyStart"] = json!("01:30");
        fall["dailyEnd"] = json!("01:45");
        fall["daysOfWeek"] = json!([0]);
        manifest["schedules"] = json!([fall]);
        assert_eq!(resolve(&manifest, at("2026-11-01T06:35:00Z")).unwrap().source, Source::Schedule);

        let mut spring = weekly();
        spring["dailyStart"] = json!("02:30");
        spring["dailyEnd"] = json!("04:00");
        spring["daysOfWeek"] = json!([0]);
        manifest["schedules"] = json!([spring]);
        assert_eq!(resolve(&manifest, at("2026-03-08T07:15:00Z")).unwrap().source, Source::Schedule);
    }

    #[test]
    fn takeover_then_override_then_one_time_then_direct() {
        let mut manifest = base();
        manifest["schedules"] = json!([{"id": SCHEDULE, "playlistId": SCHEDULED, "type": "one_time", "timezone": "UTC",
            "priority": 1, "specificity": 1, "oneTimeStart": "2026-07-17T10:00:00Z", "oneTimeEnd": "2026-07-17T12:00:00Z"}]);
        manifest["presentationOverride"] = json!({"contentType": "playlist", "contentId": DIRECT,
            "startedAt": "2026-07-17T10:15:00Z", "expiresAt": "2026-07-17T11:45:00Z"});
        manifest["takeover"] = json!({"id": SCHEDULE, "playlistId": SCHEDULED,
            "activatedAt": "2026-07-17T10:30:00Z", "expiresAt": "2026-07-17T11:00:00Z"});
        assert_eq!(resolve(&manifest, at("2026-07-17T10:05:00Z")).unwrap().source, Source::Schedule);
        assert_eq!(resolve(&manifest, at("2026-07-17T10:20:00Z")).unwrap().source, Source::QuickPresent);
        assert_eq!(resolve(&manifest, at("2026-07-17T10:45:00Z")).unwrap().source, Source::Takeover);
        assert_eq!(resolve(&manifest, at("2026-07-17T11:00:00Z")).unwrap().source, Source::QuickPresent);
        assert_eq!(resolve(&manifest, at("2026-07-17T12:00:00Z")).unwrap().source, Source::Direct);
    }

    #[test]
    fn invalid_schedule_cannot_displace_a_good_presentation() {
        let mut manifest = base();
        manifest["schedules"] = json!([{"id": SCHEDULE, "playlistId": SCHEDULED, "type": "weekly",
            "timezone": "Not/AZone", "priority": 1, "specificity": 1, "dailyStart": "09:00", "dailyEnd": "17:00", "daysOfWeek": [1]}]);
        assert_eq!(resolve(&manifest, at("2026-07-17T15:00:00Z")), Err(ScheduleError::Invalid));
    }

    #[test]
    fn display_actions_follow_schedule_windows_and_never_change_content() {
        const OFF: &str = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
        const DIM: &str = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        let mut manifest = base();
        manifest["schedules"] = json!([
            {"id": OFF, "displayAction": {"type": "display_power_off"}, "type": "weekly", "timezone": "UTC",
             "priority": 1, "specificity": 1, "dailyStart": "20:00", "dailyEnd": "06:00", "daysOfWeek": [0,1,2,3,4,5,6]},
            {"id": DIM, "displayAction": {"type": "display_set_brightness", "brightness": 20}, "type": "one_time",
             "timezone": "UTC", "priority": 5, "specificity": 1,
             "oneTimeStart": "2026-07-17T21:00:00Z", "oneTimeEnd": "2026-07-17T22:00:00Z"}
        ]);
        let day = resolve_display_policy(&manifest, at("2026-07-17T12:00:00Z")).unwrap();
        assert_eq!(day.action, None);
        assert_eq!(day.next_transition_ms, Some(at("2026-07-17T20:00:00Z")));
        let night = resolve_display_policy(&manifest, at("2026-07-17T20:30:00Z")).unwrap();
        assert_eq!(night.action, Some(json!({"type": "display_power_off"})));
        assert_eq!(night.schedule_id, Some(OFF.parse().unwrap()));
        assert_eq!(night.next_transition_ms, Some(at("2026-07-17T21:00:00Z")));
        let dimmed = resolve_display_policy(&manifest, at("2026-07-17T21:30:00Z")).unwrap();
        assert_eq!(dimmed.schedule_id, Some(DIM.parse().unwrap()), "the higher priority wins");
        // Content selection ignores display schedules entirely.
        assert_eq!(resolve(&manifest, at("2026-07-17T20:30:00Z")).unwrap().source, Source::Direct);
    }
}
