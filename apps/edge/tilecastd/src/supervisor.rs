//! Renderer recovery ladder, ported from the Linux player's
//! `core/supervisor.ts` with the rungs redefined for a separate renderer
//! process (docs/tilecast-edge.md §11.2).
//!
//! Health is judged only by meaningful playback evidence from the renderer
//! ([`is_meaningful`]), never by the renderer being connected: a connected
//! renderer can show a frozen or blank screen. Decisions are pure functions
//! of `(state, now)`; the presentation engine owns timers and side effects.
//!
//! Ladder: re-activate the prepared presentation → reload the renderer's
//! trusted runtime → ask the renderer process to exit so systemd restarts it
//! → safe mode after repeated exhaustion. The daemon itself never restarts
//! for a renderer fault.

use edge_protocol::ipc::event::EvidenceKind;
use edge_protocol::ipc::presentation::ItemKind;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum HealAction {
    None,
    Reactivate,
    ReloadRenderer,
    RestartRenderer,
    EnterSafeMode,
}

const LADDER: [HealAction; 3] = [HealAction::Reactivate, HealAction::ReloadRenderer, HealAction::RestartRenderer];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SupervisorConfig {
    pub stall_threshold_ms: i64,
    pub action_spacing_ms: i64,
    pub healthy_clear_ms: i64,
    pub max_ladder_runs_before_safe_mode: usize,
    pub ladder_run_window_ms: i64,
    pub safe_mode_enabled: bool,
}

impl Default for SupervisorConfig {
    /// The legacy player's defaults.
    fn default() -> Self {
        Self {
            stall_threshold_ms: 3 * 60_000,
            action_spacing_ms: 90_000,
            healthy_clear_ms: 10 * 60_000,
            max_ladder_runs_before_safe_mode: 3,
            ladder_run_window_ms: 60 * 60_000,
            safe_mode_enabled: true,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SupervisorState {
    pub last_progress_at_ms: i64,
    pub healthy_since_ms: Option<i64>,
    pub escalation_step: usize,
    pub last_action_at_ms: Option<i64>,
    pub ladder_runs_at_ms: Vec<i64>,
    pub safe_mode: bool,
    pub safe_mode_reason: Option<String>,
}

impl SupervisorState {
    pub fn new(now_ms: i64) -> Self {
        Self {
            last_progress_at_ms: now_ms,
            healthy_since_ms: Some(now_ms),
            escalation_step: 0,
            last_action_at_ms: None,
            ladder_runs_at_ms: Vec::new(),
            safe_mode: false,
            safe_mode_reason: None,
        }
    }

    /// Records meaningful progress.
    pub fn on_progress(&mut self, now_ms: i64, config: &SupervisorConfig) {
        self.last_progress_at_ms = now_ms;
        let healthy_since = *self.healthy_since_ms.get_or_insert(now_ms);
        if now_ms - healthy_since >= config.healthy_clear_ms {
            self.escalation_step = 0;
            self.last_action_at_ms = None;
            self.ladder_runs_at_ms.clear();
        }
    }

    /// Restarts the stall clock without counting as progress (a new
    /// activation, or a renderer that just connected).
    pub fn reset_clock(&mut self, now_ms: i64) {
        self.last_progress_at_ms = now_ms;
    }

    /// Returns the heal action due now, if any, and updates the ladder.
    pub fn evaluate(&mut self, now_ms: i64, config: &SupervisorConfig) -> HealAction {
        if self.safe_mode || now_ms - self.last_progress_at_ms < config.stall_threshold_ms {
            return HealAction::None;
        }
        self.healthy_since_ms = None;
        if self.last_action_at_ms.is_some_and(|last| now_ms - last < config.action_spacing_ms) {
            return HealAction::None;
        }
        if self.escalation_step >= LADDER.len() {
            self.ladder_runs_at_ms.push(now_ms);
            self.ladder_runs_at_ms.retain(|t| now_ms - t <= config.ladder_run_window_ms);
            self.last_action_at_ms = Some(now_ms);
            if config.safe_mode_enabled && self.ladder_runs_at_ms.len() >= config.max_ladder_runs_before_safe_mode {
                self.safe_mode = true;
                self.safe_mode_reason = Some("renderer recovery exhausted repeatedly".into());
                return HealAction::EnterSafeMode;
            }
            self.escalation_step = 1;
            return LADDER[0];
        }
        let action = LADDER[self.escalation_step];
        self.escalation_step += 1;
        self.last_action_at_ms = Some(now_ms);
        action
    }

    pub fn clear_safe_mode(&mut self, now_ms: i64) {
        *self = Self { healthy_since_ms: None, ..Self::new(now_ms) };
    }
}

/// What kind of evidence the current content can produce, ported from the
/// legacy `contentExpectationFor`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Expectation {
    Still,
    Video,
    Website,
    Layout,
    /// Status surfaces and anything with no richer signal.
    Indefinite,
}

impl Expectation {
    pub fn for_item(kind: ItemKind) -> Self {
        match kind {
            ItemKind::Video => Self::Video,
            ItemKind::Image => Self::Still,
            ItemKind::Website | ItemKind::Youtube | ItemKind::Widget => Self::Website,
            ItemKind::Layout => Self::Layout,
        }
    }
}

/// Whether `kind` is meaningful progress for content with `expectation`.
///
/// Ported from `progressSignalFor` and render-progress rules: liveness pings
/// (`*_alive`) count only for indefinite content, frame changes only where
/// motion is expected, and an empty widget is not progress. This is the
/// guard that keeps a player from reporting healthy over a frozen display.
pub fn is_meaningful(kind: EvidenceKind, expectation: Expectation) -> bool {
    match kind {
        EvidenceKind::ItemStarted
        | EvidenceKind::ItemTransition
        | EvidenceKind::VideoProgress
        | EvidenceKind::ImageShown
        | EvidenceKind::WidgetShown
        | EvidenceKind::LayoutShown
        | EvidenceKind::LayoutZoneRendered
        | EvidenceKind::WebsiteLoaded
        | EvidenceKind::SurfaceShown => true,
        EvidenceKind::FrameChanged => expectation == Expectation::Video,
        EvidenceKind::WidgetAlive | EvidenceKind::LayoutAlive | EvidenceKind::WebsiteAlive => {
            expectation == Expectation::Indefinite
        }
        EvidenceKind::WidgetEmpty => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const MIN: i64 = 60_000;

    #[test]
    fn ladder_escalates_with_spacing_then_safe_mode() {
        let config = SupervisorConfig::default();
        let mut state = SupervisorState::new(0);
        assert_eq!(state.evaluate(2 * MIN, &config), HealAction::None, "not stalled yet");
        let mut now = 3 * MIN;
        let mut actions = Vec::new();
        for _ in 0..12 {
            let action = state.evaluate(now, &config);
            if action != HealAction::None {
                actions.push(action);
            }
            now += MIN / 2;
            assert!(!matches!(state.evaluate(now, &config), a if a != HealAction::None), "spacing respected");
            now += config.action_spacing_ms;
        }
        assert_eq!(
            &actions[..4],
            &[HealAction::Reactivate, HealAction::ReloadRenderer, HealAction::RestartRenderer, HealAction::Reactivate]
        );
        assert!(actions.contains(&HealAction::EnterSafeMode));
        assert!(state.safe_mode);
        assert_eq!(state.evaluate(now + 10 * MIN, &config), HealAction::None, "safe mode is terminal until cleared");
        state.clear_safe_mode(now);
        assert!(!state.safe_mode);
    }

    #[test]
    fn sustained_progress_clears_history() {
        let config = SupervisorConfig::default();
        let mut state = SupervisorState::new(0);
        assert_eq!(state.evaluate(3 * MIN, &config), HealAction::Reactivate);
        state.on_progress(4 * MIN, &config);
        state.on_progress(15 * MIN, &config);
        assert_eq!(state.escalation_step, 0);
    }

    #[test]
    fn liveness_is_not_progress_for_real_content() {
        assert!(!is_meaningful(EvidenceKind::WidgetAlive, Expectation::Website));
        assert!(is_meaningful(EvidenceKind::WidgetAlive, Expectation::Indefinite));
        assert!(!is_meaningful(EvidenceKind::FrameChanged, Expectation::Still));
        assert!(is_meaningful(EvidenceKind::VideoProgress, Expectation::Video));
        assert!(!is_meaningful(EvidenceKind::WidgetEmpty, Expectation::Website));
    }
}
