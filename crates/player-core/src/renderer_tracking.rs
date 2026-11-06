//! Activation-bound renderer observations, independent of host transport.
use std::collections::{BTreeMap, BTreeSet, HashSet};

use player_types::{
    Timestamp,
    bounded::{SafeText, ShortToken},
};

use crate::{
    ActivityRendererSignal, Expectation, ProgressEvidence, RendererActivationRef, is_content_evidence, is_meaningful,
};

#[derive(Debug, Clone)]
pub struct SemanticRendererProgress {
    pub activation: RendererActivationRef,
    pub kind: ProgressEvidence,
    pub item_id: Option<SafeText<160>>,
    pub zone_id: Option<SafeText<160>>,
}

#[derive(Debug, Clone, Copy, Default)]
pub struct RendererProgressDecision {
    pub current: bool,
    pub meaningful: bool,
    pub log_evidence: bool,
    pub activity_signal: Option<ActivityRendererSignal>,
}

/// Observation state for the current renderer connection and activation.
/// Connection identifiers are opaque host-generated values, never peer identities.
#[derive(Debug, Default)]
pub struct RendererTracker {
    connection: Option<uuid::Uuid>,
    current: Option<RendererActivationRef>,
    accepted: Option<RendererActivationRef>,
    last_progress: Option<Timestamp>,
    last_error: Option<ShortToken>,
    refused: bool,
    current_item: Option<(String, Timestamp)>,
    meaningful: bool,
    content_progress: bool,
    content_items: BTreeSet<String>,
    layouts: BTreeMap<String, LayoutEvidence>,
    logged: HashSet<(String, String, ProgressEvidence)>,
}

const MAX_LAYOUT_ITEMS: usize = 64;
const MAX_LAYOUT_ZONES: usize = 64;

/// First-render evidence for one Layout item. The Runtime declares each zone
/// it mounted before the canvas is shown, so a Layout proves its content only
/// once every declared zone rendered. A Layout that declares nothing (for
/// example, background only) is proven by its canvas.
#[derive(Debug, Default)]
struct LayoutEvidence {
    shown: bool,
    owed: BTreeSet<String>,
    rendered: BTreeSet<String>,
}

impl LayoutEvidence {
    fn proven(&self) -> bool {
        (self.shown || !self.rendered.is_empty()) && self.owed.is_subset(&self.rendered)
    }
}

impl RendererTracker {
    pub fn activate(&mut self, reference: RendererActivationRef) {
        self.current = Some(reference);
        self.meaningful = false;
        self.content_progress = false;
        self.content_items.clear();
        self.layouts.clear();
        self.logged.clear();
        self.accepted = None;
        self.last_progress = None;
        self.current_item = None;
        self.last_error = None;
        self.refused = false;
    }

    pub fn clear(&mut self) {
        self.current = None;
        self.meaningful = false;
    }

    pub fn connected(&mut self, connection: uuid::Uuid) {
        self.connection = Some(connection);
        self.accepted = None;
        self.last_progress = None;
        self.last_error = None;
        self.refused = false;
        self.current_item = None;
        self.meaningful = false;
        self.content_progress = false;
        // Fixture checks count items per renderer connection, so proof from
        // the previous connection does not carry over.
        self.content_items.clear();
        self.layouts.clear();
        // A replacement renderer must prove the activation again, so its
        // first evidence is logged even when the previous one logged it.
        self.logged.clear();
    }

    pub fn disconnected(&mut self, connection: uuid::Uuid) {
        if self.connection == Some(connection) {
            self.connection = None;
            self.accepted = None;
            self.last_progress = None;
            self.last_error = None;
            self.refused = false;
            self.current_item = None;
        }
    }

    fn matches(&self, connection: uuid::Uuid, activation: RendererActivationRef) -> bool {
        self.connection == Some(connection) && self.current == Some(activation)
    }

    pub fn accept(&mut self, connection: uuid::Uuid, activation: RendererActivationRef) {
        if self.matches(connection, activation) {
            self.accepted = Some(activation);
        }
    }

    /// The renderer refused the whole activation. Only a refusal, never an
    /// item failure, makes the activation unfit for promotion.
    pub fn reject(
        &mut self,
        connection: uuid::Uuid,
        activation: RendererActivationRef,
        code: Option<ShortToken>,
    ) -> bool {
        if !self.matches(connection, activation) {
            return false;
        }
        self.last_error = code;
        self.refused = true;
        true
    }

    /// One item of the activation failed. The Runtime isolates the item and
    /// keeps rotating, so this is a diagnostic, not a refusal: the activation
    /// still proves itself, or fails its trial, by content evidence.
    pub fn item_failed(
        &mut self,
        connection: uuid::Uuid,
        activation: RendererActivationRef,
        code: Option<ShortToken>,
    ) -> bool {
        if !self.matches(connection, activation) {
            return false;
        }
        self.last_error = code;
        true
    }

    pub fn progress(
        &mut self,
        connection: uuid::Uuid,
        report: &SemanticRendererProgress,
        expectation: Expectation,
        now: Timestamp,
    ) -> RendererProgressDecision {
        if !self.matches(connection, report.activation) {
            return RendererProgressDecision::default();
        }
        let activity_signal = match report.kind {
            ProgressEvidence::ItemStarted => Some(ActivityRendererSignal::ItemStarted),
            ProgressEvidence::ItemTransition => Some(ActivityRendererSignal::ItemTransition),
            ProgressEvidence::WidgetEmpty => Some(ActivityRendererSignal::WidgetEmpty),
            _ => None,
        };
        let mut decision =
            RendererProgressDecision { current: true, activity_signal, ..RendererProgressDecision::default() };
        if expectation == Expectation::Layout
            && matches!(report.kind, ProgressEvidence::LayoutZoneDeclared | ProgressEvidence::LayoutZoneRotating)
        {
            if let Some(layout) = self.layout(report)
                && let Some(zone) = &report.zone_id
                && layout.owed.len() < MAX_LAYOUT_ZONES
            {
                layout.owed.insert(zone.as_str().to_owned());
            }
            return decision;
        }
        if !is_meaningful(report.kind, expectation) {
            return decision;
        }
        let content = if expectation == Expectation::Layout {
            self.layout_rendered(report)
        } else {
            is_content_evidence(report.kind, expectation) && report.item_id.is_some()
        };
        let key = (
            report.item_id.as_ref().map(|item| item.as_str().to_owned()).unwrap_or_default(),
            report.zone_id.as_ref().map(|zone| zone.as_str().to_owned()).unwrap_or_default(),
            report.kind,
        );
        let fresh = report.kind == ProgressEvidence::WebsiteLoaded || !self.logged.contains(&key);
        if self.logged.len() < 512 && fresh {
            self.logged.insert(key);
            decision.log_evidence = true;
        }
        self.last_progress = Some(now);
        if report.kind == ProgressEvidence::ItemStarted
            && let Some(item) = &report.item_id
        {
            self.current_item = Some((item.as_str().to_owned(), now));
        }
        self.meaningful = true;
        self.content_progress |= content;
        if content
            && self.content_items.len() < 256
            && let Some(item) = &report.item_id
        {
            self.content_items.insert(item.as_str().to_owned());
        }
        decision.meaningful = true;
        decision
    }

    fn layout(&mut self, report: &SemanticRendererProgress) -> Option<&mut LayoutEvidence> {
        let item = report.item_id.as_ref()?.as_str();
        if !self.layouts.contains_key(item) && self.layouts.len() >= MAX_LAYOUT_ITEMS {
            return None;
        }
        Some(self.layouts.entry(item.to_owned()).or_default())
    }

    fn layout_rendered(&mut self, report: &SemanticRendererProgress) -> bool {
        if !is_content_evidence(report.kind, Expectation::Layout) {
            return false;
        }
        let Some(layout) = self.layout(report) else { return false };
        match report.kind {
            ProgressEvidence::LayoutShown => layout.shown = true,
            ProgressEvidence::LayoutZoneRendered => {
                if let Some(zone) = &report.zone_id
                    && layout.rendered.len() < MAX_LAYOUT_ZONES
                {
                    layout.rendered.insert(zone.as_str().to_owned());
                }
            }
            _ => {}
        }
        layout.proven()
    }

    pub fn accepted_current(&self) -> bool {
        self.current.is_some() && self.accepted == self.current
    }

    pub fn meaningful(&self) -> bool {
        self.meaningful
    }
    pub fn content_progress(&self) -> bool {
        self.content_progress
    }
    pub fn content_items(&self) -> &BTreeSet<String> {
        &self.content_items
    }
    pub fn current_item(&self) -> Option<(String, Timestamp)> {
        self.current_item.clone()
    }
    pub fn last_progress(&self) -> Option<Timestamp> {
        self.last_progress
    }
    pub fn last_error(&self) -> Option<&ShortToken> {
        self.last_error.as_ref()
    }
    pub fn refused(&self) -> bool {
        self.refused
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use player_types::ids::ActivationId;

    fn reference(generation: u64) -> RendererActivationRef {
        RendererActivationRef { activation_id: ActivationId::from_uuid(uuid::Uuid::nil()), generation }
    }

    fn report(generation: u64, kind: ProgressEvidence) -> SemanticRendererProgress {
        SemanticRendererProgress {
            activation: reference(generation),
            kind,
            item_id: Some(SafeText::new("image").unwrap()),
            zone_id: None,
        }
    }

    fn layout_report(kind: ProgressEvidence, zone: Option<&str>) -> SemanticRendererProgress {
        SemanticRendererProgress {
            activation: reference(1),
            kind,
            item_id: Some(SafeText::new("layout").unwrap()),
            zone_id: zone.map(|zone| SafeText::new(zone).unwrap()),
        }
    }

    #[test]
    fn layout_content_requires_every_declared_zone() {
        let one = uuid::Uuid::from_u128(1);
        let now = Timestamp::from_unix_millis(0).unwrap();
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(1));
        tracker.connected(one);
        let send = |tracker: &mut RendererTracker, kind, zone| {
            tracker.progress(one, &layout_report(kind, zone), Expectation::Layout, now);
        };
        send(&mut tracker, ProgressEvidence::LayoutZoneDeclared, Some("clock"));
        send(&mut tracker, ProgressEvidence::LayoutZoneRotating, Some("promo"));
        send(&mut tracker, ProgressEvidence::LayoutShown, None);
        assert!(tracker.meaningful() && !tracker.content_progress());
        send(&mut tracker, ProgressEvidence::LayoutZoneRendered, Some("clock"));
        assert!(!tracker.content_progress());
        send(&mut tracker, ProgressEvidence::LayoutZoneRendered, Some("promo"));
        assert!(tracker.content_progress());
        assert!(tracker.content_items().contains("layout"));

        // A Layout with no declared zones is proven by its canvas.
        tracker.activate(reference(1));
        send(&mut tracker, ProgressEvidence::LayoutShown, None);
        assert!(tracker.content_progress());
    }

    #[test]
    fn stale_connections_and_activations_cannot_accept_or_prove_content() {
        let one = uuid::Uuid::from_u128(1);
        let two = uuid::Uuid::from_u128(2);
        let now = Timestamp::from_unix_millis(0).unwrap();
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(2));
        tracker.connected(one);
        tracker.accept(one, reference(1));
        assert!(!tracker.accepted_current());
        assert!(!tracker.progress(one, &report(1, ProgressEvidence::ImageShown), Expectation::Still, now).current);
        tracker.accept(one, reference(2));
        assert!(tracker.accepted_current());
        assert!(tracker.progress(one, &report(2, ProgressEvidence::ImageShown), Expectation::Still, now).meaningful);
        assert!(tracker.content_progress());
        tracker.connected(two);
        assert!(!tracker.content_progress());
        assert!(tracker.content_items().is_empty());
        tracker.accept(one, reference(2));
        assert!(!tracker.accepted_current());
        tracker.disconnected(one);
        assert!(tracker.progress(two, &report(2, ProgressEvidence::ImageShown), Expectation::Still, now).meaningful);
    }

    #[test]
    fn a_new_activation_does_not_inherit_progress_or_the_current_item() {
        let one = uuid::Uuid::from_u128(1);
        let now = Timestamp::from_unix_millis(1_000).unwrap();
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(1));
        tracker.connected(one);
        tracker.accept(one, reference(1));
        assert!(tracker.progress(one, &report(1, ProgressEvidence::ItemStarted), Expectation::Still, now).meaningful);
        assert_eq!(tracker.last_progress(), Some(now));
        assert_eq!(tracker.current_item().unwrap().0, "image");
        tracker.activate(reference(2));
        assert_eq!(tracker.last_progress(), None);
        assert_eq!(tracker.current_item(), None);
        let later = Timestamp::from_unix_millis(2_000).unwrap();
        assert!(tracker.progress(one, &report(2, ProgressEvidence::ItemStarted), Expectation::Still, later).meaningful);
        assert_eq!(tracker.last_progress(), Some(later));
    }

    #[test]
    fn refusals_require_current_connection_and_activation_and_reset_on_replacement() {
        let one = uuid::Uuid::from_u128(1);
        let two = uuid::Uuid::from_u128(2);
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(1));
        tracker.connected(one);
        assert!(!tracker.reject(two, reference(1), None));
        assert!(!tracker.reject(one, reference(2), None));
        assert!(!tracker.refused());
        assert!(tracker.reject(one, reference(1), None));
        assert!(tracker.refused());
        assert!(tracker.last_error().is_none());
        tracker.activate(reference(2));
        assert!(!tracker.refused());
        assert!(tracker.reject(one, reference(2), Some(ShortToken::new("failed").unwrap())));
        assert_eq!(tracker.last_error().unwrap().as_str(), "failed");
        tracker.connected(two);
        assert!(!tracker.refused());
        assert!(!tracker.reject(one, reference(2), None));
        assert!(tracker.reject(two, reference(2), None));
        tracker.disconnected(one);
        assert!(tracker.refused());
        tracker.disconnected(two);
        assert!(!tracker.refused());
    }

    #[test]
    fn item_failures_are_diagnostics_and_never_refuse_the_activation() {
        let one = uuid::Uuid::from_u128(1);
        let two = uuid::Uuid::from_u128(2);
        let now = Timestamp::from_unix_millis(0).unwrap();
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(1));
        tracker.connected(one);
        tracker.accept(one, reference(1));
        assert!(!tracker.item_failed(two, reference(1), None), "a stale connection reports nothing");
        assert!(!tracker.item_failed(one, reference(2), None), "a stale activation reports nothing");
        assert!(tracker.item_failed(one, reference(1), Some(ShortToken::new("playback-error").unwrap())));
        assert_eq!(tracker.last_error().unwrap().as_str(), "playback-error");
        assert!(!tracker.refused(), "an isolated item failure is not a refusal");
        assert!(tracker.accepted_current());
        // The Runtime moves on to the next item, which proves the activation.
        assert!(tracker.progress(one, &report(1, ProgressEvidence::ImageShown), Expectation::Still, now).meaningful);
        assert!(tracker.content_progress() && !tracker.refused());
    }

    #[test]
    fn item_signals_do_not_substitute_for_content_evidence_and_logs_are_bounded() {
        let connection = uuid::Uuid::nil();
        let now = Timestamp::from_unix_millis(0).unwrap();
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(1));
        tracker.connected(connection);
        let started = tracker.progress(connection, &report(1, ProgressEvidence::ItemStarted), Expectation::Still, now);
        assert_eq!(started.activity_signal, Some(ActivityRendererSignal::ItemStarted));
        assert!(started.meaningful);
        assert!(!tracker.content_progress());
        let empty = tracker.progress(connection, &report(1, ProgressEvidence::WidgetEmpty), Expectation::Website, now);
        assert_eq!(empty.activity_signal, Some(ActivityRendererSignal::WidgetEmpty));
        assert!(!empty.meaningful);
        for index in 0..1000 {
            let mut evidence = report(1, ProgressEvidence::ImageShown);
            evidence.item_id = Some(SafeText::new(format!("item-{index}")).unwrap());
            tracker.progress(connection, &evidence, Expectation::Still, now);
        }
        assert_eq!(tracker.logged.len(), 512);
        assert_eq!(tracker.content_items().len(), 256);
    }

    #[test]
    fn a_replacement_renderer_logs_its_evidence_again() {
        let one = uuid::Uuid::from_u128(1);
        let two = uuid::Uuid::from_u128(2);
        let now = Timestamp::from_unix_millis(0).unwrap();
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(1));
        tracker.connected(one);
        let shown = report(1, ProgressEvidence::ImageShown);
        assert!(tracker.progress(one, &shown, Expectation::Still, now).log_evidence);
        assert!(!tracker.progress(one, &shown, Expectation::Still, now).log_evidence);
        tracker.disconnected(one);
        tracker.connected(two);
        assert!(tracker.progress(two, &shown, Expectation::Still, now).log_evidence);
    }
}
