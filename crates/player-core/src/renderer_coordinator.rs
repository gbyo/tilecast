//! Native activation, compatibility, evidence, and recovery coordination.
use player_types::{
    Timestamp,
    bounded::{SafeText, ShortToken},
    ids::ActivationId,
};

use crate::{
    ConnectedRendererProfile, HealAction, HealthTolerances, PackagedRendererProfile, PlaybackHealth,
    PreparedActivationError, RendererActivation, RendererActivationRef, RendererMetadata, RendererPort,
    RendererPortError, RendererProfileMismatch, RendererProgressDecision, RendererRequirement, RendererTracker,
    SemanticRendererCommand, SemanticRendererProgress, Stall, StallReason, SupervisorConfig, SupervisorState,
    playback_health::{PlaybackHealthTracker, bears_liveness},
};

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RendererDispatch {
    Queued,
    Incompatible(Vec<(RendererRequirement, RendererProfileMismatch)>),
}

/// Recovery-ladder position for host status reporting. Hosts project these
/// values into heartbeats and diagnostics; Core keeps owning the ladder.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RecoverySnapshot {
    /// Current escalation step (Linux `recoveryLevel` parity).
    pub escalation_step: usize,
    /// Completed ladder runs inside the configured window.
    pub ladder_runs: usize,
    /// When the last recovery action ran, if any.
    pub last_action_at_ms: Option<i64>,
}

/// Why the last recovery action ran, for host logs, Activity and diagnostics.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RecoveryCause {
    pub action: HealAction,
    pub stall: Stall,
    /// When the action ran, in Unix milliseconds.
    pub at_ms: i64,
}

impl RecoveryCause {
    pub fn stalled_for_ms(&self) -> i64 {
        self.stall.duration_ms(self.at_ms)
    }
}

/// Hosts retain their projection inputs. Core owns native activation identity,
/// requirements, evidence expectations, and recovery timing, never Runtime fields.
#[derive(Debug)]
pub struct RendererCoordinator {
    packaged: PackagedRendererProfile,
    connected: Option<(uuid::Uuid, ConnectedRendererProfile)>,
    connection: Option<uuid::Uuid>,
    current: Option<(RendererActivationRef, RendererMetadata)>,
    next_generation: u64,
    tracker: RendererTracker,
    supervisor: SupervisorState,
    config: SupervisorConfig,
    health: PlaybackHealthTracker,
    tolerances: HealthTolerances,
    last_recovery: Option<RecoveryCause>,
}

impl RendererCoordinator {
    pub fn new(packaged: PackagedRendererProfile, config: SupervisorConfig, now: Timestamp) -> Self {
        Self {
            packaged,
            connected: None,
            connection: None,
            current: None,
            next_generation: 1,
            tracker: RendererTracker::default(),
            supervisor: SupervisorState::new(now.unix_millis()),
            config,
            health: PlaybackHealthTracker::default(),
            tolerances: HealthTolerances::default(),
            last_recovery: None,
        }
    }

    pub fn begin_activation(
        &mut self,
        activation_id: ActivationId,
        metadata: RendererMetadata,
        now: Timestamp,
    ) -> Result<RendererActivationRef, PreparedActivationError> {
        metadata.validate()?;
        let reference = RendererActivationRef { activation_id, generation: self.next_generation };
        self.next_generation += 1;
        self.current = Some((reference, metadata));
        self.tracker.activate(reference);
        self.health.clear();
        self.supervisor.reset_clock(now.unix_millis());
        Ok(reference)
    }

    pub fn connected(&mut self, connection: uuid::Uuid, now: Timestamp) {
        self.connection = Some(connection);
        self.connected = None;
        self.tracker.connected(connection);
        self.health.clear();
        self.supervisor.reset_clock(now.unix_millis());
    }

    pub fn ready(&mut self, connection: uuid::Uuid, profile: ConnectedRendererProfile) {
        if self.connection == Some(connection) {
            self.connected = Some((connection, profile));
        }
    }

    pub fn disconnected(&mut self, connection: uuid::Uuid) {
        self.tracker.disconnected(connection);
        if self.connection == Some(connection) {
            self.health.clear();
            self.connection = None;
            self.connected = None;
        }
    }

    pub fn dispatch(
        &self,
        connection: uuid::Uuid,
        activation: &RendererActivation,
        port: &dyn RendererPort,
    ) -> Result<RendererDispatch, RendererPortError> {
        let Some((live, connected)) = &self.connected else {
            return Err(RendererPortError::NotReady);
        };
        if *live != connection || self.connection != Some(connection) {
            return Err(RendererPortError::NotReady);
        }
        if !self.current.as_ref().is_some_and(|(reference, metadata)| {
            *reference == activation.reference() && metadata == activation.metadata()
        }) {
            return Err(RendererPortError::InvalidActivation);
        }
        let incompatible = activation.incompatibilities(&self.packaged, connected);
        if !incompatible.is_empty() {
            return Ok(RendererDispatch::Incompatible(incompatible));
        }
        port.activate(activation)?;
        Ok(RendererDispatch::Queued)
    }

    /// Preflight an explicit requirement set before replacing the current activation.
    pub fn supports(&self, requirements: &[RendererRequirement]) -> bool {
        let Some((connection, connected)) = &self.connected else { return false };
        self.connection == Some(*connection)
            && requirements.iter().all(|requirement| self.packaged.check_connected(connected, requirement).is_ok())
    }

    pub fn clear(&mut self) {
        self.current = None;
        self.tracker.clear();
        self.health.clear();
    }

    pub fn accepted(&mut self, connection: uuid::Uuid, reference: RendererActivationRef) {
        self.tracker.accept(connection, reference);
    }

    pub fn rejected(
        &mut self,
        connection: uuid::Uuid,
        reference: RendererActivationRef,
        code: Option<ShortToken>,
    ) -> bool {
        self.tracker.reject(connection, reference, code)
    }

    pub fn progress(
        &mut self,
        connection: uuid::Uuid,
        report: &SemanticRendererProgress,
        now: Timestamp,
    ) -> RendererProgressDecision {
        let Some((_, metadata)) = &self.current else {
            return RendererProgressDecision::default();
        };
        let expectation = metadata.expectation_for(report.item_id.as_ref().map(|id| id.as_str()));
        let decision = self.tracker.progress(connection, report, expectation, now);
        if decision.current {
            let now_ms = now.unix_millis();
            let concerns_current_item = self.health.record(
                report.kind,
                expectation,
                report.item_id.as_ref().map(|id| id.as_str()),
                report.zone_id.as_ref().map(|zone| zone.as_str()),
                now_ms,
            );
            // The supervisor is fed by playback health, not by the raw
            // arrival of evidence. Liveness from content that owes nothing
            // else keeps it fed, so a static layout, widget or website is
            // never mistaken for a stall. Liveness while content-specific
            // evidence is still owed does not, so generic renderer liveness
            // cannot hide a frozen zone, video or page that never rendered.
            if concerns_current_item
                && bears_liveness(report.kind, expectation)
                && self.health.assess(now_ms, &self.tolerances).is_healthy()
            {
                self.supervisor.on_progress(now_ms, &self.config);
            }
        }
        decision
    }

    pub fn has_activation_evidence(&self) -> bool {
        self.current.as_ref().is_some_and(|(_, metadata)| {
            if metadata.requires_content_evidence { self.tracker.content_progress() } else { self.tracker.meaningful() }
        })
    }

    pub fn evaluate_recovery(&mut self, now: Timestamp) -> HealAction {
        if !self.playback_expected() {
            // Policy/status surfaces such as off-hours sleep, disabled, setup,
            // pairing, and idle are intentional states with no playback
            // progress contract. Keep the stall clock current while they are
            // shown so an intentional static surface can never walk the
            // recovery ladder or enter safe mode.
            self.supervisor.reset_clock(now.unix_millis());
            return HealAction::None;
        }
        let stall = self.playback_health(now).stall().cloned();
        let action = self.supervisor.evaluate(now.unix_millis(), &self.config);
        if action != HealAction::None
            && let Some(stall) = stall
        {
            self.last_recovery = Some(RecoveryCause { action, stall, at_ms: now.unix_millis() });
        }
        action
    }

    fn playback_expected(&self) -> bool {
        self.connected.is_some() && self.current.as_ref().is_some_and(|(_, metadata)| !metadata.expectations.is_empty())
    }

    /// What the content on screen owes and whether it is paying. This is the
    /// one source for recovery diagnostics and telemetry; the supervisor's
    /// own thresholds and ladder are unchanged.
    ///
    /// Content-specific evidence that is owed comes first. When nothing owed
    /// is overdue but the renderer has reported nothing at all for the stall
    /// threshold, the renderer is not responding.
    pub fn playback_health(&self, now: Timestamp) -> PlaybackHealth {
        if self.supervisor.safe_mode || !self.playback_expected() {
            return PlaybackHealth::Healthy;
        }
        let now_ms = now.unix_millis();
        let health = self.health.assess(now_ms, &self.tolerances);
        if !health.is_healthy() {
            return health;
        }
        if now_ms - self.supervisor.last_progress_at_ms >= self.config.stall_threshold_ms {
            let (item_id, expectation) = self
                .health
                .current()
                .map_or((None, crate::Expectation::Indefinite), |(id, expectation)| (Some(id.to_owned()), expectation));
            return PlaybackHealth::Stalled(Stall {
                reason: StallReason::RendererNotResponding,
                expectation,
                since_ms: self.supervisor.last_progress_at_ms,
                item_id,
                zone_id: None,
            });
        }
        PlaybackHealth::Healthy
    }

    /// What kind of evidence the item on screen owes, once it has started.
    pub fn current_expectation(&self) -> Option<crate::Expectation> {
        self.health.current().map(|(_, expectation)| expectation)
    }

    /// Why the most recent recovery action ran.
    pub fn last_recovery(&self) -> Option<&RecoveryCause> {
        self.last_recovery.as_ref()
    }

    /// Only semantic renderer actions are issued here. Reprojection and the
    /// visual Safe Mode payload remain host/Runtime work.
    pub fn dispatch_recovery(
        &self,
        port: &dyn RendererPort,
        action: HealAction,
        command_id: uuid::Uuid,
    ) -> Result<(), RendererPortError> {
        match action {
            HealAction::ReloadRenderer => port.send_command(command_id, &SemanticRendererCommand::Reload),
            HealAction::RestartRenderer => port.request_restart(&ShortToken::new("recovery").expect("literal"), 5_000),
            _ => Ok(()),
        }
    }

    pub fn retry_recovery(&mut self, now: Timestamp) -> HealAction {
        self.supervisor.last_action_at_ms = None;
        self.evaluate_recovery(now)
    }

    pub fn clear_safe_mode(&mut self, now: Timestamp) -> bool {
        let was = self.supervisor.safe_mode;
        self.supervisor.clear_safe_mode(now.unix_millis());
        was
    }

    /// Restores safe mode persisted by a previous process. The restored
    /// mode holds until an explicit exit, like a freshly entered one; the
    /// stall clock restarts at boot so only new evidence clears the ladder.
    pub fn restore_safe_mode(&mut self, reason: &str, now: Timestamp) {
        self.supervisor.safe_mode = true;
        self.supervisor.safe_mode_reason = Some(reason.to_owned());
        self.supervisor.last_progress_at_ms = now.unix_millis();
        self.supervisor.healthy_since_ms = Some(now.unix_millis());
    }

    pub fn set_config(&mut self, config: SupervisorConfig) {
        self.config = config;
    }
    pub fn config(&self) -> SupervisorConfig {
        self.config
    }
    pub fn tracker(&self) -> &RendererTracker {
        &self.tracker
    }
    pub fn is_safe_mode(&self) -> bool {
        self.supervisor.safe_mode
    }

    /// Current recovery-ladder position for host status reporting: the
    /// escalation step (Linux `recoveryLevel` parity), completed ladder runs
    /// in the window, and when the last recovery action ran.
    pub fn recovery_snapshot(&self) -> RecoverySnapshot {
        RecoverySnapshot {
            escalation_step: self.supervisor.escalation_step,
            ladder_runs: self.supervisor.ladder_runs_at_ms.len(),
            last_action_at_ms: self.supervisor.last_action_at_ms,
        }
    }

    pub fn safe_mode_reason(&self) -> SafeText<240> {
        SafeText::lossy(self.supervisor.safe_mode_reason.as_deref().unwrap_or("recovery"))
    }

    pub fn recovery_event(&self, action: HealAction) -> Option<crate::ActivityEvent> {
        let (event_type, severity, code) = match action {
            HealAction::None => return None,
            HealAction::EnterSafeMode => ("safe_mode.entered", "critical", "enter_safe_mode"),
            HealAction::Reactivate => ("self_heal.attempted", "warning", "reactivate_content"),
            HealAction::ReloadRenderer => ("self_heal.attempted", "warning", "recreate_renderer"),
            HealAction::RestartRenderer => ("self_heal.attempted", "warning", "restart_renderer_process"),
        };
        let mut event = crate::ActivityEvent::new(event_type, "reliability");
        event.severity = Some(severity.into());
        event.failure_code = Some(code.into());
        let mut metadata = serde_json::json!({"escalationStep": self.supervisor.escalation_step});
        if let Some(cause) = self.last_recovery.as_ref().filter(|cause| cause.action == action) {
            let object = metadata.as_object_mut().expect("object literal");
            object.insert("stallReason".into(), cause.stall.reason.as_str().into());
            object.insert("expectation".into(), cause.stall.expectation.as_str().into());
            object.insert("stallDurationMs".into(), cause.stalled_for_ms().into());
            if let Some(item) = &cause.stall.item_id {
                object.insert("itemId".into(), item.as_str().into());
            }
            if let Some(zone) = &cause.stall.zone_id {
                object.insert("zoneId".into(), zone.as_str().into());
            }
        }
        event.metadata = Some(metadata);
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CaptureState, Expectation, ObjectBinding, ProgressEvidence, RendererCaptureRequest, RendererSupport,
        RuntimePayload, StallReason, VerifiedContentRef,
    };
    use player_types::{Sha256Digest, bounded::SafeText};
    use serde_json::json;
    use std::collections::{BTreeMap, BTreeSet, HashMap};
    use std::sync::Mutex;

    #[derive(Default)]
    struct Port {
        activations: Mutex<Vec<RendererActivation>>,
        commands: Mutex<Vec<SemanticRendererCommand>>,
        restarts: Mutex<Vec<(ShortToken, u32)>>,
    }
    impl RendererPort for Port {
        fn activate(&self, activation: &RendererActivation) -> Result<(), RendererPortError> {
            self.activations.lock().unwrap().push(activation.clone());
            Ok(())
        }
        fn clear(&self, _: &ShortToken) -> Result<(), RendererPortError> {
            Ok(())
        }
        fn send_command(&self, _: uuid::Uuid, command: &SemanticRendererCommand) -> Result<(), RendererPortError> {
            self.commands.lock().unwrap().push(command.clone());
            Ok(())
        }
        fn request_capture(&self, _: RendererCaptureRequest) -> Result<(), RendererPortError> {
            Ok(())
        }
        fn request_restart(&self, reason: &ShortToken, deadline_ms: u32) -> Result<(), RendererPortError> {
            self.restarts.lock().unwrap().push((reason.clone(), deadline_ms));
            Ok(())
        }
    }
    fn now(ms: i64) -> Timestamp {
        Timestamp::from_unix_millis(ms).unwrap()
    }
    fn support() -> RendererSupport {
        RendererSupport::new(
            BTreeSet::from([ShortToken::new("image").unwrap()]),
            BTreeSet::new(),
            BTreeMap::new(),
            BTreeMap::new(),
        )
        .unwrap()
    }
    fn coordinator() -> RendererCoordinator {
        RendererCoordinator::new(PackagedRendererProfile(support()), SupervisorConfig::default(), now(0))
    }
    fn metadata() -> RendererMetadata {
        RendererMetadata {
            requirements: vec![RendererRequirement::Feature(ShortToken::new("image").unwrap())],
            expectations: HashMap::from([(SafeText::new("item").unwrap(), Expectation::Still)]),
            requires_content_evidence: true,
            capture_state: CaptureState::Presentation,
        }
    }
    fn activation(coordinator: &mut RendererCoordinator, ms: i64) -> RendererActivation {
        let metadata = metadata();
        let reference = coordinator
            .begin_activation(ActivationId::from_uuid(uuid::Uuid::new_v4()), metadata.clone(), now(ms))
            .unwrap();
        let digest = Sha256Digest::of(b"verified");
        RendererActivation::new(
            reference,
            RuntimePayload::new(
                json!({"futureRuntimeField": {"curve": "new"}, "kind": "video", "resource": ""}),
                vec![ObjectBinding { pointer: SafeText::new("/resource").unwrap(), object: digest }],
            )
            .unwrap(),
            metadata,
            vec![VerifiedContentRef {
                sha256: digest,
                size_bytes: 8,
                mime_type: SafeText::new("image/png").unwrap(),
                stream: None,
            }],
            Vec::new(),
            None,
        )
        .unwrap()
    }
    fn progress(reference: RendererActivationRef, kind: ProgressEvidence) -> SemanticRendererProgress {
        SemanticRendererProgress {
            activation: reference,
            kind,
            item_id: Some(SafeText::new("item").unwrap()),
            zone_id: None,
        }
    }

    #[test]
    fn readiness_and_identity_guard_opaque_dispatch() {
        let mut core = coordinator();
        let port = Port::default();
        let prepared = activation(&mut core, 0);
        let one = uuid::Uuid::from_u128(1);
        let two = uuid::Uuid::from_u128(2);
        assert!(!core.supports(&prepared.metadata().requirements));
        assert_eq!(core.dispatch(one, &prepared, &port), Err(RendererPortError::NotReady));
        core.connected(one, now(0));
        core.ready(one, ConnectedRendererProfile(RendererSupport::default()));
        assert!(!core.supports(&prepared.metadata().requirements));
        assert!(matches!(core.dispatch(one, &prepared, &port), Ok(RendererDispatch::Incompatible(missing))
            if missing == vec![(prepared.metadata().requirements[0].clone(), RendererProfileMismatch::Connected)]));
        assert!(port.activations.lock().unwrap().is_empty());
        core.ready(one, ConnectedRendererProfile(support()));
        assert!(core.supports(&prepared.metadata().requirements));
        assert!(!core.supports(&[RendererRequirement::Feature(ShortToken::new("future").unwrap())]));
        assert_eq!(core.dispatch(one, &prepared, &port), Ok(RendererDispatch::Queued));
        assert_eq!(port.activations.lock().unwrap()[0], prepared);
        core.connected(two, now(1));
        core.ready(one, ConnectedRendererProfile(support()));
        assert_eq!(core.dispatch(two, &prepared, &port), Err(RendererPortError::NotReady));
        assert!(!core.supports(&prepared.metadata().requirements));
        core.ready(two, ConnectedRendererProfile(support()));
        assert_eq!(core.dispatch(one, &prepared, &port), Err(RendererPortError::NotReady));
        assert_eq!(core.dispatch(two, &prepared, &port), Ok(RendererDispatch::Queued));
        let next = activation(&mut core, 2);
        assert_eq!(next.reference().generation, prepared.reference().generation + 1);
        assert_ne!(next.reference().activation_id, prepared.reference().activation_id);
        assert_eq!(core.dispatch(two, &prepared, &port), Err(RendererPortError::InvalidActivation));
        let mut wrong_metadata = next.metadata().clone();
        wrong_metadata.requires_content_evidence = false;
        let wrong = RendererActivation::new(
            next.reference(),
            next.document().clone(),
            wrong_metadata,
            next.content().to_vec(),
            next.frames().to_vec(),
            None,
        )
        .unwrap();
        assert_eq!(core.dispatch(two, &wrong, &port), Err(RendererPortError::InvalidActivation));
        core.clear();
        assert_eq!(core.dispatch(two, &next, &port), Err(RendererPortError::InvalidActivation));
    }

    #[test]
    fn evidence_uses_explicit_metadata_and_reconnect_requires_fresh_reports() {
        let mut core = coordinator();
        let prepared = activation(&mut core, 0);
        let one = uuid::Uuid::from_u128(1);
        let two = uuid::Uuid::from_u128(2);
        core.connected(one, now(0));
        core.ready(one, ConnectedRendererProfile(support()));
        core.accepted(one, prepared.reference());
        assert!(core.tracker().accepted_current());
        // Opaque JSON says "video"; semantic metadata expects a Still.
        assert!(
            core.progress(one, &progress(prepared.reference(), ProgressEvidence::VideoProgress), now(1)).meaningful
        );
        assert!(!core.has_activation_evidence());
        assert!(core.progress(one, &progress(prepared.reference(), ProgressEvidence::ImageShown), now(2)).meaningful);
        assert!(core.has_activation_evidence());
        core.connected(two, now(3));
        core.ready(two, ConnectedRendererProfile(support()));
        assert!(!core.tracker().accepted_current());
        assert!(!core.has_activation_evidence());
        assert!(!core.progress(one, &progress(prepared.reference(), ProgressEvidence::ImageShown), now(4)).current);
        core.accepted(one, prepared.reference());
        assert!(!core.tracker().accepted_current());
        core.accepted(two, prepared.reference());
        assert!(core.progress(two, &progress(prepared.reference(), ProgressEvidence::ImageShown), now(5)).current);
        let next = activation(&mut core, 6);
        assert!(!core.has_activation_evidence());
        assert!(!core.progress(two, &progress(prepared.reference(), ProgressEvidence::ImageShown), now(7)).current);
        assert!(core.progress(two, &progress(next.reference(), ProgressEvidence::ImageShown), now(8)).current);
        core.disconnected(one);
        assert!(!core.tracker().accepted_current()); // New activation has not been accepted.
        core.accepted(two, next.reference());
        assert!(core.tracker().accepted_current());
        core.disconnected(two);
        assert!(!core.tracker().accepted_current());
    }

    #[test]
    fn recovery_waits_for_readiness_and_keeps_existing_rung_timing_and_commands() {
        let mut core = coordinator();
        let _prepared = activation(&mut core, 0);
        let port = Port::default();
        let connection = uuid::Uuid::from_u128(1);
        assert_eq!(core.evaluate_recovery(now(180_000)), HealAction::None);
        core.connected(connection, now(180_000));
        assert_eq!(core.evaluate_recovery(now(360_000)), HealAction::None);
        core.ready(connection, ConnectedRendererProfile(support()));
        assert_eq!(core.evaluate_recovery(now(539_999)), HealAction::None);
        assert_eq!(core.evaluate_recovery(now(540_000)), HealAction::Reactivate);
        let snapshot = core.recovery_snapshot();
        assert_eq!((snapshot.escalation_step, snapshot.ladder_runs), (1, 0));
        assert_eq!(snapshot.last_action_at_ms, Some(540_000));
        let reactivated = activation(&mut core, 540_000);
        assert_eq!(core.evaluate_recovery(now(630_000)), HealAction::None);
        let reload = core.evaluate_recovery(now(720_000));
        assert_eq!(reload, HealAction::ReloadRenderer);
        let event = core.recovery_event(reload).unwrap();
        assert_eq!(event.event_type, "self_heal.attempted");
        assert_eq!(event.severity.as_deref(), Some("warning"));
        assert_eq!(event.failure_code.as_deref(), Some("recreate_renderer"));
        // No item ever started, so the renderer was silent: the cause says so.
        assert_eq!(
            event.metadata,
            Some(json!({
                "escalationStep": core.supervisor.escalation_step,
                "stallReason": "renderer_not_responding",
                "expectation": "indefinite",
                "stallDurationMs": 180_000,
            }))
        );
        core.dispatch_recovery(&port, reload, uuid::Uuid::new_v4()).unwrap();
        assert_eq!(*port.commands.lock().unwrap(), vec![SemanticRendererCommand::Reload]);
        assert_eq!(core.evaluate_recovery(now(809_999)), HealAction::None);
        let restart = core.evaluate_recovery(now(810_000));
        assert_eq!(restart, HealAction::RestartRenderer);
        core.dispatch_recovery(&port, restart, uuid::Uuid::new_v4()).unwrap();
        assert_eq!(*port.restarts.lock().unwrap(), vec![(ShortToken::new("recovery").unwrap(), 5_000)]);
        core.progress(connection, &progress(reactivated.reference(), ProgressEvidence::ImageShown), now(811_000));
        core.progress(connection, &progress(reactivated.reference(), ProgressEvidence::ImageShown), now(1_411_000));
        assert_eq!(core.supervisor.escalation_step, 0);
        assert_eq!(
            core.recovery_snapshot(),
            RecoverySnapshot { escalation_step: 0, ladder_runs: 0, last_action_at_ms: None }
        );
        core.clear();
        assert_eq!(core.retry_recovery(now(2_000_000)), HealAction::None);
        assert!(!core.clear_safe_mode(now(2_000_000)));
    }

    #[test]
    fn recovery_ignores_presentations_without_playback_expectations() {
        let mut core = coordinator();
        let connection = uuid::Uuid::from_u128(1);
        core.connected(connection, now(0));
        core.ready(connection, ConnectedRendererProfile(support()));

        let reference = core
            .begin_activation(
                ActivationId::from_uuid(uuid::Uuid::new_v4()),
                RendererMetadata {
                    requirements: vec![],
                    expectations: HashMap::new(),
                    requires_content_evidence: false,
                    capture_state: CaptureState::Presentation,
                },
                now(0),
            )
            .unwrap();
        core.accepted(connection, reference);

        // An intentional policy/status surface can remain static for far
        // longer than the full recovery window without triggering a rung.
        for at in [180_000, 600_000, 3_600_000, 7_200_000] {
            assert_eq!(core.evaluate_recovery(now(at)), HealAction::None);
        }
        assert_eq!(
            core.recovery_snapshot(),
            RecoverySnapshot { escalation_step: 0, ladder_runs: 0, last_action_at_ms: None }
        );
        assert!(!core.is_safe_mode());

        // Returning to real content arms recovery again from the new
        // activation's clock rather than from time spent on the policy surface.
        let _prepared = activation(&mut core, 7_200_000);
        assert_eq!(core.evaluate_recovery(now(7_379_999)), HealAction::None);
        assert_eq!(core.evaluate_recovery(now(7_380_000)), HealAction::Reactivate);
    }

    /// One connected, accepted activation presenting a single item, driven by
    /// the same evidence a Runtime reports.
    struct Rig {
        core: RendererCoordinator,
        connection: uuid::Uuid,
        reference: RendererActivationRef,
    }

    impl Rig {
        fn new(expectation: Expectation) -> Self {
            let mut core = coordinator();
            let reference = core
                .begin_activation(
                    ActivationId::from_uuid(uuid::Uuid::new_v4()),
                    RendererMetadata {
                        requirements: vec![],
                        expectations: HashMap::from([(SafeText::new("item").unwrap(), expectation)]),
                        requires_content_evidence: true,
                        capture_state: CaptureState::Presentation,
                    },
                    now(0),
                )
                .unwrap();
            let connection = uuid::Uuid::from_u128(7);
            core.connected(connection, now(0));
            core.ready(connection, ConnectedRendererProfile(support()));
            core.accepted(connection, reference);
            Self { core, connection, reference }
        }

        fn report(&mut self, kind: ProgressEvidence, zone: Option<&str>, at_ms: i64) {
            let report = SemanticRendererProgress {
                activation: self.reference,
                kind,
                item_id: Some(SafeText::new("item").unwrap()),
                zone_id: zone.map(|zone| SafeText::new(zone).unwrap()),
            };
            self.core.progress(self.connection, &report, now(at_ms));
        }

        /// Runs the supervision tick every ten seconds from `from_ms` up to
        /// `until_ms` and returns every action that fired. `each` supplies the
        /// evidence the Runtime would report at that moment.
        fn run(&mut self, from_ms: i64, until_ms: i64, mut each: impl FnMut(&mut Self, i64)) -> Vec<(i64, HealAction)> {
            let mut actions = Vec::new();
            let mut at = from_ms;
            while at <= until_ms {
                each(self, at);
                let action = self.core.evaluate_recovery(now(at));
                if action != HealAction::None {
                    actions.push((at, action));
                }
                at += 10_000;
            }
            actions
        }
    }

    const SEC: i64 = 1_000;
    const MIN: i64 = 60_000;
    const HOUR: i64 = 60 * MIN;

    /// The Runtime reports its liveness every thirty seconds.
    fn every_30s(at: i64) -> bool {
        at % (30 * SEC) == 0
    }

    #[test]
    fn a_static_layout_with_periodic_liveness_never_recovers() {
        let mut rig = Rig::new(Expectation::Layout);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        rig.report(ProgressEvidence::LayoutZoneDeclared, Some("clock"), SEC);
        rig.report(ProgressEvidence::LayoutZoneDeclared, Some("banner"), SEC);
        rig.report(ProgressEvidence::LayoutShown, None, 2 * SEC);
        rig.report(ProgressEvidence::LayoutZoneRendered, Some("clock"), 3 * SEC);
        rig.report(ProgressEvidence::LayoutZoneRendered, Some("banner"), 3 * SEC);
        // Fourteen hours, far beyond the generic stall threshold and the
        // time the recovery ladder needs to reach Safe Mode.
        let actions = rig.run(10 * SEC, 14 * HOUR, |rig, at| {
            if every_30s(at) {
                rig.report(ProgressEvidence::LayoutAlive, None, at);
            }
        });
        assert_eq!(actions, vec![]);
        assert!(!rig.core.is_safe_mode());
        assert!(rig.core.playback_health(now(14 * HOUR)).is_healthy());
    }

    #[test]
    fn a_layout_with_a_zone_that_never_renders_recovers_once_tolerance_expires() {
        let mut rig = Rig::new(Expectation::Layout);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        rig.report(ProgressEvidence::LayoutZoneDeclared, Some("clock"), SEC);
        rig.report(ProgressEvidence::LayoutZoneDeclared, Some("banner"), SEC);
        rig.report(ProgressEvidence::LayoutShown, None, 2 * SEC);
        rig.report(ProgressEvidence::LayoutZoneRendered, Some("clock"), 3 * SEC);
        let actions = rig.run(10 * SEC, 20 * MIN, |rig, at| {
            if every_30s(at) {
                rig.report(ProgressEvidence::LayoutAlive, None, at);
            }
        });
        let (first_at, first) = actions[0];
        assert_eq!(first, HealAction::Reactivate);
        // Liveness may keep the supervisor fed while the zone's tolerance of
        // five minutes runs, but not after.
        assert!(first_at > 5 * MIN + 3 * MIN - 30 * SEC, "recovery began too early at {first_at}");
        assert!(first_at <= 5 * MIN + 3 * MIN + 30 * SEC, "recovery began too late at {first_at}");
        let cause = rig.core.last_recovery().unwrap();
        assert_eq!(cause.stall.reason, StallReason::LayoutZonesSilent);
        assert_eq!(cause.stall.zone_id.as_deref(), Some("banner"));
        assert_eq!(cause.stall.item_id.as_deref(), Some("item"));
    }

    #[test]
    fn a_rotating_zone_that_stops_is_detected_while_layout_liveness_continues() {
        let mut rig = Rig::new(Expectation::Layout);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        rig.report(ProgressEvidence::LayoutZoneDeclared, Some("clock"), SEC);
        rig.report(ProgressEvidence::LayoutZoneRotating, Some("promo"), SEC);
        rig.report(ProgressEvidence::LayoutShown, None, 2 * SEC);
        rig.report(ProgressEvidence::LayoutZoneRendered, Some("clock"), 3 * SEC);
        let promo_stops_at = 10 * MIN;
        let actions = rig.run(10 * SEC, 40 * MIN, |rig, at| {
            if at < promo_stops_at && at % (10 * SEC) == 0 {
                rig.report(ProgressEvidence::LayoutZoneRendered, Some("promo"), at);
            }
            if every_30s(at) {
                rig.report(ProgressEvidence::LayoutAlive, None, at);
                rig.report(ProgressEvidence::LayoutZoneRendered, Some("clock"), at);
            }
        });
        assert!(
            actions.iter().all(|(at, _)| *at > promo_stops_at),
            "a healthy rotating zone is never recovered: {actions:?}"
        );
        let (first_at, first) = actions[0];
        assert_eq!(first, HealAction::Reactivate);
        assert!(first_at > promo_stops_at + 5 * MIN);
        let cause = rig.core.last_recovery().unwrap();
        assert_eq!(
            (cause.stall.reason, cause.stall.zone_id.as_deref()),
            (StallReason::LayoutZonesSilent, Some("promo"))
        );
        assert!(cause.stall.since_ms >= promo_stops_at - 10 * SEC && cause.stall.since_ms <= promo_stops_at);
    }

    #[test]
    fn a_static_website_or_widget_never_recovers_after_its_first_render() {
        for (expectation, shown, alive) in [
            (Expectation::Website, ProgressEvidence::WebsiteLoaded, ProgressEvidence::WebsiteAlive),
            (Expectation::Website, ProgressEvidence::WidgetShown, ProgressEvidence::WidgetAlive),
        ] {
            let mut rig = Rig::new(expectation);
            rig.report(ProgressEvidence::ItemStarted, None, SEC);
            rig.report(shown, None, 5 * SEC);
            let actions = rig.run(10 * SEC, 14 * HOUR, |rig, at| {
                if every_30s(at) {
                    rig.report(alive, None, at);
                }
            });
            assert_eq!(actions, vec![], "{shown:?} then {alive:?}");
            assert!(!rig.core.is_safe_mode());
        }
    }

    #[test]
    fn a_website_that_never_renders_recovers_even_though_the_renderer_stays_alive() {
        let mut rig = Rig::new(Expectation::Website);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        let actions = rig.run(10 * SEC, 30 * MIN, |rig, at| {
            if every_30s(at) {
                rig.report(ProgressEvidence::WebsiteAlive, None, at);
            }
        });
        let (first_at, first) = actions[0];
        assert_eq!(first, HealAction::Reactivate);
        assert!(first_at > 90 * SEC + 3 * MIN - 30 * SEC && first_at <= 90 * SEC + 3 * MIN + 30 * SEC, "{first_at}");
        let cause = rig.core.last_recovery().unwrap();
        assert_eq!(cause.stall.reason, StallReason::NeverRendered);
        assert_eq!(cause.stall.since_ms, SEC);
    }

    #[test]
    fn a_frozen_video_recovers_and_the_ladder_still_escalates_to_safe_mode() {
        let mut rig = Rig::new(Expectation::Video);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        let freezes_at = MIN;
        let actions = rig.run(10 * SEC, 3 * HOUR, |rig, at| {
            if at < freezes_at && at % (2 * SEC) == 0 {
                rig.report(ProgressEvidence::VideoProgress, None, at);
            }
        });
        let sequence: Vec<HealAction> = actions.iter().map(|(_, action)| *action).collect();
        assert_eq!(
            &sequence[..4],
            &[HealAction::Reactivate, HealAction::ReloadRenderer, HealAction::RestartRenderer, HealAction::Reactivate]
        );
        assert_eq!(sequence.last(), Some(&HealAction::EnterSafeMode));
        assert!(rig.core.is_safe_mode());
        // Thresholds are unchanged: the first rung is the stall threshold
        // after the last progress, then the configured spacing.
        // The last progress landed on the tick before the freeze.
        assert_eq!(actions[0].0, freezes_at - 10 * SEC + 3 * MIN);
        assert_eq!(actions[1].0 - actions[0].0, 90 * SEC);
        let cause = rig.core.last_recovery().unwrap();
        assert_eq!(cause.action, HealAction::EnterSafeMode);
        assert_eq!(cause.stall.reason, StallReason::VideoFrozen);
        let event = rig.core.recovery_event(HealAction::EnterSafeMode).unwrap();
        assert_eq!(event.metadata.as_ref().unwrap()["stallReason"], "video_position_frozen");
        assert_eq!(event.metadata.as_ref().unwrap()["expectation"], "video");
        assert_eq!(event.metadata.as_ref().unwrap()["itemId"], "item");
    }

    #[test]
    fn a_static_page_stays_healthy_when_core_restarts_while_the_renderer_keeps_showing_it() {
        let mut rig = Rig::new(Expectation::Website);
        // No `item_started` or `website_loaded`: the renderer reported both
        // to the previous daemon process. Only its liveness arrives.
        let actions = rig.run(10 * SEC, 6 * HOUR, |rig, at| {
            if every_30s(at) {
                rig.report(ProgressEvidence::WebsiteAlive, None, at);
            }
        });
        assert_eq!(actions, vec![]);
    }

    #[test]
    fn liveness_for_a_departed_item_neither_feeds_nor_stalls_the_current_one() {
        let mut rig = Rig::new(Expectation::Website);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        rig.report(ProgressEvidence::WebsiteLoaded, None, 2 * SEC);
        let stale = SemanticRendererProgress {
            activation: rig.reference,
            kind: ProgressEvidence::WebsiteAlive,
            item_id: Some(SafeText::new("departed").unwrap()),
            zone_id: None,
        };
        rig.core.progress(rig.connection, &stale, now(2 * MIN));
        assert_eq!(rig.core.evaluate_recovery(now(3 * MIN + 2 * SEC)), HealAction::Reactivate);
    }

    #[test]
    fn declarations_and_empty_widgets_are_not_signs_of_life() {
        let mut rig = Rig::new(Expectation::Layout);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        rig.report(ProgressEvidence::LayoutShown, None, 2 * SEC);
        rig.report(ProgressEvidence::LayoutZoneDeclared, Some("zone"), 2 * MIN);
        rig.report(ProgressEvidence::WidgetEmpty, None, 2 * MIN);
        assert_eq!(rig.core.evaluate_recovery(now(3 * MIN + 3 * SEC)), HealAction::Reactivate);
    }

    #[test]
    fn a_silent_renderer_is_reported_as_not_responding_not_as_a_content_stall() {
        let mut rig = Rig::new(Expectation::Website);
        rig.report(ProgressEvidence::ItemStarted, None, SEC);
        rig.report(ProgressEvidence::WebsiteLoaded, None, 2 * SEC);
        assert!(rig.core.playback_health(now(3 * MIN)).is_healthy());
        let health = rig.core.playback_health(now(5 * MIN));
        let stall = health.stall().expect("no evidence for longer than the stall threshold");
        assert_eq!(stall.reason, StallReason::RendererNotResponding);
        assert_eq!(stall.expectation, Expectation::Website);
        assert_eq!(rig.core.evaluate_recovery(now(5 * MIN)), HealAction::Reactivate);
    }

    #[test]
    fn restored_safe_mode_holds_until_an_explicit_exit() {
        let mut core = coordinator();
        core.restore_safe_mode("renderer recovery exhausted repeatedly", now(1_000));
        assert!(core.is_safe_mode());
        assert_eq!(core.evaluate_recovery(now(10_000_000)), HealAction::None);
        assert!(core.clear_safe_mode(now(10_000_001)));
        assert!(!core.is_safe_mode());
    }
}
