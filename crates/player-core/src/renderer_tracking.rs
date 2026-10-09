//! Activation-bound renderer observations, independent of host transport.
use std::collections::{BTreeSet, HashSet};

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
    has_error: bool,
    current_item: Option<(String, Timestamp)>,
    meaningful: bool,
    content_progress: bool,
    content_items: BTreeSet<String>,
    logged: HashSet<(String, String, ProgressEvidence)>,
}

impl RendererTracker {
    pub fn activate(&mut self, reference: RendererActivationRef) {
        self.current = Some(reference);
        self.meaningful = false;
        self.content_progress = false;
        self.content_items.clear();
        self.logged.clear();
        self.accepted = None;
        self.last_error = None;
        self.has_error = false;
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
        self.has_error = false;
        self.current_item = None;
        self.meaningful = false;
        self.content_progress = false;
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
            self.has_error = false;
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
        self.has_error = true;
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
        if !is_meaningful(report.kind, expectation) {
            return decision;
        }
        let content = is_content_evidence(report.kind, expectation) && report.item_id.is_some();
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
    pub fn has_error(&self) -> bool {
        self.has_error
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
        tracker.accept(one, reference(2));
        assert!(!tracker.accepted_current());
        tracker.disconnected(one);
        assert!(tracker.progress(two, &report(2, ProgressEvidence::ImageShown), Expectation::Still, now).meaningful);
    }

    #[test]
    fn errors_require_current_connection_and_activation_and_reset_on_replacement() {
        let one = uuid::Uuid::from_u128(1);
        let two = uuid::Uuid::from_u128(2);
        let mut tracker = RendererTracker::default();
        tracker.activate(reference(1));
        tracker.connected(one);
        assert!(!tracker.reject(two, reference(1), None));
        assert!(!tracker.reject(one, reference(2), None));
        assert!(!tracker.has_error());
        assert!(tracker.reject(one, reference(1), None));
        assert!(tracker.has_error());
        assert!(tracker.last_error().is_none());
        tracker.activate(reference(2));
        assert!(!tracker.has_error());
        assert!(tracker.reject(one, reference(2), Some(ShortToken::new("failed").unwrap())));
        assert_eq!(tracker.last_error().unwrap().as_str(), "failed");
        tracker.connected(two);
        assert!(!tracker.has_error());
        assert!(!tracker.reject(one, reference(2), None));
        assert!(tracker.reject(two, reference(2), None));
        tracker.disconnected(one);
        assert!(tracker.has_error());
        tracker.disconnected(two);
        assert!(!tracker.has_error());
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
