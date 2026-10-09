//! Native activation, compatibility, evidence, and recovery coordination.
use player_types::{
    Timestamp,
    bounded::{SafeText, ShortToken},
    ids::ActivationId,
};

use crate::{
    ConnectedRendererProfile, HealAction, PackagedRendererProfile, PreparedActivationError, RendererActivation,
    RendererActivationRef, RendererMetadata, RendererPort, RendererPortError, RendererProfileMismatch,
    RendererProgressDecision, RendererRequirement, RendererTracker, SemanticRendererCommand, SemanticRendererProgress,
    SupervisorConfig, SupervisorState,
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
        self.supervisor.reset_clock(now.unix_millis());
        Ok(reference)
    }

    pub fn connected(&mut self, connection: uuid::Uuid, now: Timestamp) {
        self.connection = Some(connection);
        self.connected = None;
        self.tracker.connected(connection);
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
        if decision.meaningful {
            self.supervisor.on_progress(now.unix_millis(), &self.config);
        }
        decision
    }

    pub fn has_activation_evidence(&self) -> bool {
        self.current.as_ref().is_some_and(|(_, metadata)| {
            if metadata.requires_content_evidence { self.tracker.content_progress() } else { self.tracker.meaningful() }
        })
    }

    pub fn evaluate_recovery(&mut self, now: Timestamp) -> HealAction {
        if self.connected.is_none() || self.current.is_none() {
            self.supervisor.reset_clock(now.unix_millis());
            return HealAction::None;
        }
        self.supervisor.evaluate(now.unix_millis(), &self.config)
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
        event.metadata = Some(serde_json::json!({"escalationStep": self.supervisor.escalation_step}));
        Some(event)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        CaptureState, Expectation, ObjectBinding, ProgressEvidence, RendererCaptureRequest, RendererSupport,
        RuntimePayload, VerifiedContentRef,
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
            vec![VerifiedContentRef { sha256: digest, size_bytes: 8, mime_type: SafeText::new("image/png").unwrap() }],
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
        assert_eq!(event.metadata, Some(json!({"escalationStep": core.supervisor.escalation_step})));
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
    fn restored_safe_mode_holds_until_an_explicit_exit() {
        let mut core = coordinator();
        core.restore_safe_mode("renderer recovery exhausted repeatedly", now(1_000));
        assert!(core.is_safe_mode());
        assert_eq!(core.evaluate_recovery(now(10_000_000)), HealAction::None);
        assert!(core.clear_safe_mode(now(10_000_001)));
        assert!(!core.is_safe_mode());
    }
}
