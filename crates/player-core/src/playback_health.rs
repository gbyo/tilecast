//! Content-aware playback health.
//!
//! Three things are easy to confuse: the renderer is connected, the renderer
//! still answers, and the content on screen is doing what that content owes.
//! Only the last is playback health. This module decides it from the evidence
//! a Runtime reports, and it is the native counterpart of the reference
//! player's `render-progress.ts`.
//!
//! The central rule: absence of new pixels is not absence of healthy
//! playback, and generic renderer liveness never hides evidence that is still
//! owed.
//!
//! - A still image, a Website or a Widget owes one first render. After that it
//!   may stay unchanged indefinitely.
//! - A Layout owes a first render from every zone it declared. Only a zone it
//!   declared as rotating owes continuing evidence; a static zone renders once.
//! - Video owes continuing playback progress.
//! - Indefinite content (status surfaces, anything with no richer signal) owes
//!   renderer liveness only.
//!
//! Hosts never interpret Runtime payloads. The Runtime declares a Layout's
//! zones through evidence, so Core never guesses which placements the Runtime
//! actually rendered.

use std::collections::{BTreeMap, BTreeSet};

use crate::{Expectation, ProgressEvidence};

/// Zones tracked per item. A Layout has far fewer; the bound keeps a faulty
/// renderer from growing this state.
const MAX_ZONES: usize = 64;

/// How long each kind of owed evidence may be silent before it is a stall.
/// These match the reference player's defaults.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct HealthTolerances {
    /// Video position must advance at least this often.
    pub video_progress_ms: i64,
    /// An item must produce its first render within this long.
    pub first_render_ms: i64,
    /// A Layout zone must produce its owed evidence at least this often.
    pub layout_zone_ms: i64,
    /// Indefinite content only has to show the renderer still answers.
    pub renderer_health_ms: i64,
}

impl Default for HealthTolerances {
    fn default() -> Self {
        Self {
            video_progress_ms: 20_000,
            first_render_ms: 90_000,
            layout_zone_ms: 5 * 60_000,
            renderer_health_ms: 10 * 60_000,
        }
    }
}

/// Why playback is considered stalled. The names are the vocabulary the
/// reference player already reports in heartbeats and telemetry.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StallReason {
    /// Video progress stopped.
    VideoFrozen,
    /// The item never produced its first render.
    NeverRendered,
    /// A Layout zone owes render evidence it has not produced.
    LayoutZonesSilent,
    /// Nothing at all has been reported, including liveness.
    RendererNotResponding,
}

impl StallReason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::VideoFrozen => "video_position_frozen",
            Self::NeverRendered => "website_never_rendered",
            Self::LayoutZonesSilent => "layout_zones_silent",
            Self::RendererNotResponding => "renderer_not_responding",
        }
    }
}

impl Expectation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Still => "still",
            Self::Video => "video",
            Self::Website => "website",
            Self::Layout => "layout",
            Self::Indefinite => "indefinite",
        }
    }
}

/// A stall: what is wrong, since when, and where.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Stall {
    pub reason: StallReason,
    pub expectation: Expectation,
    /// When the owed evidence was last seen, or when the item began if it was
    /// never seen. This is when the screen started being wrong, not when the
    /// stall was noticed.
    pub since_ms: i64,
    pub item_id: Option<String>,
    pub zone_id: Option<String>,
}

impl Stall {
    pub fn duration_ms(&self, now_ms: i64) -> i64 {
        (now_ms - self.since_ms).max(0)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PlaybackHealth {
    Healthy,
    Stalled(Stall),
}

impl PlaybackHealth {
    pub fn is_healthy(&self) -> bool {
        matches!(self, Self::Healthy)
    }
    pub fn stall(&self) -> Option<&Stall> {
        match self {
            Self::Healthy => None,
            Self::Stalled(stall) => Some(stall),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ItemHealth {
    item_id: String,
    expectation: Expectation,
    started_at_ms: i64,
    last_progress_ms: i64,
    /// The item has produced its first render.
    rendered: bool,
    /// Zones the Runtime declared as owing a first render.
    required_zones: BTreeSet<String>,
    /// The subset that also owes continuing evidence.
    rotating_zones: BTreeSet<String>,
    zone_rendered_at_ms: BTreeMap<String, i64>,
}

impl ItemHealth {
    fn new(item_id: &str, expectation: Expectation, now_ms: i64) -> Self {
        Self {
            item_id: item_id.to_owned(),
            expectation,
            started_at_ms: now_ms,
            last_progress_ms: now_ms,
            rendered: false,
            required_zones: BTreeSet::new(),
            rotating_zones: BTreeSet::new(),
            zone_rendered_at_ms: BTreeMap::new(),
        }
    }

    fn stall(&self, reason: StallReason, since_ms: i64, zone: Option<&str>) -> PlaybackHealth {
        PlaybackHealth::Stalled(Stall {
            reason,
            expectation: self.expectation,
            since_ms,
            item_id: Some(self.item_id.clone()),
            zone_id: zone.map(str::to_owned),
        })
    }
}

/// The health of the item the renderer is presenting.
#[derive(Debug, Default)]
pub(crate) struct PlaybackHealthTracker {
    item: Option<ItemHealth>,
}

impl PlaybackHealthTracker {
    pub fn clear(&mut self) {
        self.item = None;
    }

    /// The item on screen, for diagnostics.
    pub fn current(&self) -> Option<(&str, Expectation)> {
        self.item.as_ref().map(|item| (item.item_id.as_str(), item.expectation))
    }

    /// Applies one report. Returns whether it concerns the item on screen; a
    /// late report for an item that already left is ignored entirely.
    pub fn record(
        &mut self,
        kind: ProgressEvidence,
        expectation: Expectation,
        item_id: Option<&str>,
        zone_id: Option<&str>,
        now_ms: i64,
    ) -> bool {
        if kind == ProgressEvidence::ItemStarted {
            let Some(id) = item_id else { return false };
            // A new occurrence gets a fresh window to prove itself in.
            self.item = Some(ItemHealth::new(id, expectation, now_ms));
            return true;
        }
        match (self.item.as_ref(), item_id) {
            (Some(item), Some(id)) if item.item_id != id => return false,
            // Core joined an item that was already on screen, for example
            // after the daemon restarted while the renderer kept showing a
            // static page. The first render happened before Core was watching
            // and its declarations are lost, so nothing earlier is owed.
            (None, Some(id)) => {
                let mut item = ItemHealth::new(id, expectation, now_ms);
                item.rendered = true;
                self.item = Some(item);
            }
            _ => {}
        }
        let Some(item) = self.item.as_mut() else { return true };
        match kind {
            ProgressEvidence::ItemTransition => item.last_progress_ms = now_ms,
            ProgressEvidence::VideoProgress => {
                item.rendered = true;
                item.last_progress_ms = now_ms;
            }
            ProgressEvidence::FrameChanged if item.expectation == Expectation::Video => {
                item.rendered = true;
                item.last_progress_ms = now_ms;
            }
            ProgressEvidence::ImageShown
            | ProgressEvidence::WidgetShown
            | ProgressEvidence::LayoutShown
            | ProgressEvidence::WebsiteLoaded => {
                item.rendered = true;
                item.last_progress_ms = now_ms;
            }
            ProgressEvidence::LayoutZoneRendered => {
                item.rendered = true;
                item.last_progress_ms = now_ms;
                if let Some(zone) = zone_id
                    && (item.zone_rendered_at_ms.len() < MAX_ZONES || item.zone_rendered_at_ms.contains_key(zone))
                {
                    item.zone_rendered_at_ms.insert(zone.to_owned(), now_ms);
                }
            }
            ProgressEvidence::LayoutZoneDeclared | ProgressEvidence::LayoutZoneRotating => {
                if let Some(zone) = zone_id
                    && (item.required_zones.len() < MAX_ZONES || item.required_zones.contains(zone))
                {
                    item.required_zones.insert(zone.to_owned());
                    if kind == ProgressEvidence::LayoutZoneRotating {
                        item.rotating_zones.insert(zone.to_owned());
                    }
                }
            }
            // Liveness answers "is the renderer there". It is progress only
            // for content that owes nothing else.
            ProgressEvidence::WidgetAlive
            | ProgressEvidence::LayoutAlive
            | ProgressEvidence::WebsiteAlive
            | ProgressEvidence::SurfaceShown => {
                if item.expectation == Expectation::Indefinite {
                    item.last_progress_ms = now_ms;
                }
            }
            ProgressEvidence::WidgetEmpty | ProgressEvidence::FrameChanged | ProgressEvidence::ItemStarted => {}
        }
        true
    }

    /// Judges the item against what its kind of content owes.
    pub fn assess(&self, now_ms: i64, tolerances: &HealthTolerances) -> PlaybackHealth {
        let Some(item) = &self.item else { return PlaybackHealth::Healthy };
        let since_start = now_ms - item.started_at_ms;
        match item.expectation {
            Expectation::Indefinite => {
                if now_ms - item.last_progress_ms > tolerances.renderer_health_ms {
                    return item.stall(StallReason::RendererNotResponding, item.last_progress_ms, None);
                }
            }
            // Playback position must keep advancing; silence is the signal.
            Expectation::Video => {
                if now_ms - item.last_progress_ms > tolerances.video_progress_ms {
                    return item.stall(StallReason::VideoFrozen, item.last_progress_ms, None);
                }
            }
            // One first render, then the content may legitimately sit still.
            Expectation::Still | Expectation::Website => {
                if !item.rendered && since_start > tolerances.first_render_ms {
                    return item.stall(StallReason::NeverRendered, item.started_at_ms, None);
                }
            }
            Expectation::Layout => {
                if !item.rendered && since_start > tolerances.first_render_ms {
                    return item.stall(StallReason::NeverRendered, item.started_at_ms, None);
                }
                // A zone that never rendered is the clearest failure: part of
                // the screen is blank, however healthy the other zones are.
                if since_start > tolerances.layout_zone_ms
                    && let Some(zone) =
                        item.required_zones.iter().find(|zone| !item.zone_rendered_at_ms.contains_key(*zone))
                {
                    return item.stall(StallReason::LayoutZonesSilent, item.started_at_ms, Some(zone));
                }
                // A rotating zone that rendered and then went quiet is a stall
                // the layout as a whole would otherwise hide.
                for zone in &item.rotating_zones {
                    if let Some(at) = item.zone_rendered_at_ms.get(zone)
                        && now_ms - at > tolerances.layout_zone_ms
                    {
                        return item.stall(StallReason::LayoutZonesSilent, *at, Some(zone));
                    }
                }
            }
        }
        PlaybackHealth::Healthy
    }
}

/// Whether a report is a sign of life at all. Declarations describe what the
/// Layout owes; an empty Widget is explicitly not progress; a changed frame
/// only counts where motion is expected.
pub(crate) fn bears_liveness(kind: ProgressEvidence, expectation: Expectation) -> bool {
    match kind {
        ProgressEvidence::WidgetEmpty | ProgressEvidence::LayoutZoneDeclared | ProgressEvidence::LayoutZoneRotating => {
            false
        }
        ProgressEvidence::FrameChanged => expectation == Expectation::Video,
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SEC: i64 = 1_000;
    const MIN: i64 = 60_000;

    fn tracker_for(expectation: Expectation, item: &str) -> PlaybackHealthTracker {
        let mut tracker = PlaybackHealthTracker::default();
        assert!(tracker.record(ProgressEvidence::ItemStarted, expectation, Some(item), None, 0));
        tracker
    }

    fn assess(tracker: &PlaybackHealthTracker, now_ms: i64) -> PlaybackHealth {
        tracker.assess(now_ms, &HealthTolerances::default())
    }

    #[test]
    fn a_rendered_website_or_widget_may_stay_unchanged_indefinitely() {
        let mut tracker = tracker_for(Expectation::Website, "site");
        tracker.record(ProgressEvidence::WebsiteLoaded, Expectation::Website, Some("site"), None, 5 * SEC);
        for at in [3 * MIN, 30 * MIN, 24 * 60 * MIN] {
            tracker.record(ProgressEvidence::WebsiteAlive, Expectation::Website, Some("site"), None, at);
            assert_eq!(assess(&tracker, at), PlaybackHealth::Healthy);
        }
    }

    #[test]
    fn a_website_that_never_rendered_stalls_however_alive_the_renderer_is() {
        let mut tracker = tracker_for(Expectation::Website, "site");
        assert_eq!(assess(&tracker, 89 * SEC), PlaybackHealth::Healthy);
        tracker.record(ProgressEvidence::WebsiteAlive, Expectation::Website, Some("site"), None, 100 * SEC);
        let health = assess(&tracker, 100 * SEC);
        let stall = health.stall().expect("liveness cannot stand in for a first render");
        assert_eq!((stall.reason, stall.since_ms), (StallReason::NeverRendered, 0));
        assert_eq!(stall.item_id.as_deref(), Some("site"));
    }

    #[test]
    fn a_layout_owes_every_declared_zone_its_first_render_but_a_static_zone_owes_nothing_more() {
        let mut tracker = tracker_for(Expectation::Layout, "layout");
        let layout = |tracker: &mut PlaybackHealthTracker, kind, zone: Option<&str>, at| {
            tracker.record(kind, Expectation::Layout, Some("layout"), zone, at)
        };
        layout(&mut tracker, ProgressEvidence::LayoutZoneDeclared, Some("clock"), SEC);
        layout(&mut tracker, ProgressEvidence::LayoutZoneDeclared, Some("banner"), SEC);
        layout(&mut tracker, ProgressEvidence::LayoutShown, None, 2 * SEC);
        layout(&mut tracker, ProgressEvidence::LayoutZoneRendered, Some("clock"), 3 * SEC);
        assert_eq!(
            assess(&tracker, 4 * MIN),
            PlaybackHealth::Healthy,
            "tolerance for the pending zone has not run out"
        );
        let stalled = assess(&tracker, 6 * MIN);
        let stall = stalled.stall().expect("the banner never rendered");
        assert_eq!((stall.reason, stall.zone_id.as_deref()), (StallReason::LayoutZonesSilent, Some("banner")));
        assert_eq!(stall.since_ms, 0);
        layout(&mut tracker, ProgressEvidence::LayoutZoneRendered, Some("banner"), 6 * MIN);
        for at in [10 * MIN, 8 * 60 * MIN] {
            layout(&mut tracker, ProgressEvidence::LayoutAlive, None, at);
            assert_eq!(assess(&tracker, at), PlaybackHealth::Healthy, "both static zones rendered once");
        }
    }

    #[test]
    fn a_rotating_zone_that_goes_quiet_is_not_hidden_by_layout_liveness() {
        let mut tracker = tracker_for(Expectation::Layout, "layout");
        let mut report = |kind, zone: Option<&str>, at| {
            tracker.record(kind, Expectation::Layout, Some("layout"), zone, at);
        };
        report(ProgressEvidence::LayoutZoneDeclared, Some("static"), 0);
        report(ProgressEvidence::LayoutZoneRotating, Some("promo"), 0);
        report(ProgressEvidence::LayoutShown, None, SEC);
        report(ProgressEvidence::LayoutZoneRendered, Some("static"), SEC);
        report(ProgressEvidence::LayoutZoneRendered, Some("promo"), SEC);
        report(ProgressEvidence::LayoutZoneRendered, Some("promo"), 60 * SEC);
        for at in (1..=12).map(|n| 60 * SEC + n * 30 * SEC) {
            report(ProgressEvidence::LayoutAlive, None, at);
        }
        assert_eq!(assess(&tracker, 4 * MIN), PlaybackHealth::Healthy);
        let health = assess(&tracker, 60 * SEC + 5 * MIN + SEC);
        let stall = health.stall().expect("promo stopped rendering");
        assert_eq!((stall.reason, stall.zone_id.as_deref()), (StallReason::LayoutZonesSilent, Some("promo")));
        assert_eq!(stall.since_ms, 60 * SEC, "measured from when the zone was last seen");
    }

    #[test]
    fn video_stalls_when_progress_stops_and_ignores_liveness_pings() {
        let mut tracker = tracker_for(Expectation::Video, "clip");
        tracker.record(ProgressEvidence::VideoProgress, Expectation::Video, Some("clip"), None, 5 * SEC);
        assert_eq!(assess(&tracker, 24 * SEC), PlaybackHealth::Healthy);
        tracker.record(ProgressEvidence::WidgetAlive, Expectation::Video, Some("clip"), None, 30 * SEC);
        let health = assess(&tracker, 30 * SEC);
        assert_eq!(health.stall().map(|stall| stall.reason), Some(StallReason::VideoFrozen));
        tracker.record(ProgressEvidence::VideoProgress, Expectation::Video, Some("clip"), None, 31 * SEC);
        assert_eq!(assess(&tracker, 31 * SEC), PlaybackHealth::Healthy);
    }

    #[test]
    fn indefinite_content_owes_renderer_liveness_only() {
        let mut tracker = tracker_for(Expectation::Indefinite, "status");
        tracker.record(ProgressEvidence::WidgetAlive, Expectation::Indefinite, Some("status"), None, 9 * MIN);
        assert_eq!(assess(&tracker, 18 * MIN), PlaybackHealth::Healthy);
        let health = assess(&tracker, 19 * MIN + SEC);
        assert_eq!(health.stall().map(|stall| stall.reason), Some(StallReason::RendererNotResponding));
    }

    #[test]
    fn reports_for_a_departed_item_are_ignored_and_a_new_occurrence_starts_fresh() {
        let mut tracker = tracker_for(Expectation::Website, "old");
        assert!(!tracker.record(ProgressEvidence::WebsiteLoaded, Expectation::Website, Some("other"), None, SEC));
        assert_eq!(assess(&tracker, 100 * SEC).stall().map(|s| s.reason), Some(StallReason::NeverRendered));
        assert!(tracker.record(ProgressEvidence::ItemStarted, Expectation::Website, Some("new"), None, 100 * SEC));
        assert_eq!(assess(&tracker, 100 * SEC), PlaybackHealth::Healthy);
        assert_eq!(tracker.current(), Some(("new", Expectation::Website)));
    }

    #[test]
    fn joining_an_item_that_is_already_showing_owes_no_first_render() {
        let mut tracker = PlaybackHealthTracker::default();
        assert!(tracker.record(ProgressEvidence::WebsiteAlive, Expectation::Website, Some("site"), None, 0));
        assert_eq!(assess(&tracker, 30 * MIN), PlaybackHealth::Healthy);
    }

    #[test]
    fn zone_state_is_bounded() {
        let mut tracker = tracker_for(Expectation::Layout, "layout");
        for index in 0..(MAX_ZONES * 3) {
            let zone = format!("zone-{index}");
            tracker.record(ProgressEvidence::LayoutZoneRotating, Expectation::Layout, Some("layout"), Some(&zone), 0);
            tracker.record(ProgressEvidence::LayoutZoneRendered, Expectation::Layout, Some("layout"), Some(&zone), 0);
        }
        let item = tracker.item.as_ref().unwrap();
        assert_eq!(item.required_zones.len(), MAX_ZONES);
        assert_eq!(item.rotating_zones.len(), MAX_ZONES);
        assert_eq!(item.zone_rendered_at_ms.len(), MAX_ZONES);
    }

    #[test]
    fn only_real_signs_of_life_bear_liveness() {
        for kind in
            [ProgressEvidence::LayoutZoneDeclared, ProgressEvidence::LayoutZoneRotating, ProgressEvidence::WidgetEmpty]
        {
            assert!(!bears_liveness(kind, Expectation::Layout));
        }
        assert!(!bears_liveness(ProgressEvidence::FrameChanged, Expectation::Still));
        assert!(bears_liveness(ProgressEvidence::FrameChanged, Expectation::Video));
        assert!(bears_liveness(ProgressEvidence::LayoutAlive, Expectation::Layout));
    }

    #[test]
    fn rendered_flags_follow_content_evidence() {
        for (expectation, kind) in [
            (Expectation::Still, ProgressEvidence::ImageShown),
            (Expectation::Website, ProgressEvidence::WebsiteLoaded),
            (Expectation::Website, ProgressEvidence::WidgetShown),
            (Expectation::Layout, ProgressEvidence::LayoutShown),
        ] {
            assert!(crate::is_content_evidence(kind, expectation));
            let mut tracker = tracker_for(expectation, "item");
            tracker.record(kind, expectation, Some("item"), None, SEC);
            assert!(tracker.item.as_ref().unwrap().rendered);
        }
    }
}
