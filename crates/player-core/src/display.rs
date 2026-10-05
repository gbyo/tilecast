//! Native Display Control payload and scheduled-action policy. Hardware stays host-owned.
use crate::Dependencies;
use player_state::repo::{binding, commands::CommandResult, manifests, playback};
use player_types::Timestamp;
use serde_json::{Map, Value};

pub const COMMANDS: &[&str] = &[
    "display_power_on",
    "display_power_off",
    "display_set_input",
    "display_set_volume",
    "display_mute",
    "display_unmute",
    "display_set_brightness",
    "display_probe",
];

/// One validated display action, from a command or a schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    PowerOn,
    PowerOff,
    SetInput(String),
    SetVolume(u8),
    Mute,
    Unmute,
    SetBrightness(u8),
    Probe,
}

impl Action {
    pub fn command_type(&self) -> &'static str {
        match self {
            Self::PowerOn => "display_power_on",
            Self::PowerOff => "display_power_off",
            Self::SetInput(_) => "display_set_input",
            Self::SetVolume(_) => "display_set_volume",
            Self::Mute => "display_mute",
            Self::Unmute => "display_unmute",
            Self::SetBrightness(_) => "display_set_brightness",
            Self::Probe => "display_probe",
        }
    }
}

/// Why an action was refused before any provider saw it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Invalid {
    /// The payload breaks the shared contract.
    Payload,
}

/// Provider observations, independent of CEC or another hardware transport.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerReport {
    On,
    Off,
    TurningOn,
    TurningOff,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerOutcome {
    Confirmed,
    Mismatch,
    Changing,
    Unconfirmed,
}

impl PowerOutcome {
    pub fn code(self) -> &'static str {
        match self {
            Self::Confirmed => "display_state_confirmed",
            Self::Mismatch => "display_state_mismatch",
            Self::Changing | Self::Unconfirmed => "display_command_sent",
        }
    }
}

/// A successful send is not confirmation. A report toward the requested
/// state stays unconfirmed; an opposite report takes precedence over intent.
pub fn power_outcome(on: bool, observed: Option<PowerReport>) -> PowerOutcome {
    match (on, observed) {
        (_, None) => PowerOutcome::Unconfirmed,
        (true, Some(PowerReport::On)) | (false, Some(PowerReport::Off)) => PowerOutcome::Confirmed,
        (true, Some(PowerReport::TurningOn)) | (false, Some(PowerReport::TurningOff)) => PowerOutcome::Changing,
        _ => PowerOutcome::Mismatch,
    }
}

fn percent(value: &Value) -> Option<u8> {
    let number = value.as_i64().or_else(|| value.as_f64().filter(|v| v.fract() == 0.0).map(|v| v as i64))?;
    u8::try_from(number).ok().filter(|v| *v <= 100)
}

/// Validates a command or schedule payload exactly as the reference player
/// and the server do: known type, only `input`, `volume` or `brightness`,
/// the one field the type needs, integers 0–100, and an input of at most 32
/// characters from `[A-Za-z0-9._:-]`.
pub fn parse(command_type: &str, payload: &Map<String, Value>) -> Result<Action, Invalid> {
    if !COMMANDS.contains(&command_type)
        || payload.keys().any(|k| !matches!(k.as_str(), "input" | "volume" | "brightness"))
    {
        return Err(Invalid::Payload);
    }
    let input = payload.get("input");
    let volume = payload.get("volume");
    let brightness = payload.get("brightness");
    let only = |field: Option<&Value>| {
        [input, volume, brightness].iter().filter(|f| f.is_some()).count() == usize::from(field.is_some())
            && field.is_some()
    };
    let none = input.is_none() && volume.is_none() && brightness.is_none();
    match command_type {
        "display_power_on" if none => Ok(Action::PowerOn),
        "display_power_off" if none => Ok(Action::PowerOff),
        "display_mute" if none => Ok(Action::Mute),
        "display_unmute" if none => Ok(Action::Unmute),
        "display_probe" if none => Ok(Action::Probe),
        "display_set_volume" if only(volume) => volume.and_then(percent).map(Action::SetVolume).ok_or(Invalid::Payload),
        "display_set_brightness" if only(brightness) => {
            brightness.and_then(percent).map(Action::SetBrightness).ok_or(Invalid::Payload)
        }
        "display_set_input" if only(input) => {
            let text = input.and_then(Value::as_str).ok_or(Invalid::Payload)?;
            let shaped = !text.is_empty()
                && text.len() <= 32
                && text.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b':' | b'-'));
            if !shaped {
                return Err(Invalid::Payload);
            }
            Ok(Action::SetInput(text.to_owned()))
        }
        _ => Err(Invalid::Payload),
    }
}

/// A schedule's `displayAction` object. Probe is a command, never a policy.
pub fn parse_policy(action: &Value) -> Result<Action, Invalid> {
    let object = action.as_object().ok_or(Invalid::Payload)?;
    let kind = object.get("type").and_then(Value::as_str).ok_or(Invalid::Payload)?;
    if kind == "display_probe" {
        return Err(Invalid::Payload);
    }
    let payload: Map<String, Value> =
        object.iter().filter(|(k, _)| *k != "type").map(|(k, v)| (k.clone(), v.clone())).collect();
    parse(kind, &payload)
}

/// Closed scheduled requests; a provider owns hardware-specific validation.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PolicyRequest {
    Action(Action),
    Clear,
    Invalid,
}

impl PolicyRequest {
    pub fn state_name(&self) -> &'static str {
        if matches!(self, Self::Action(Action::PowerOff)) { "powered_off_by_policy" } else { "normal" }
    }
}

#[async_trait::async_trait]
pub trait DisplayControlProvider: Send + Sync {
    async fn apply_policy(&self, request: &PolicyRequest, now: Timestamp) -> CommandResult;
}

#[derive(Debug, Default)]
pub struct PolicyPass {
    pub changed: bool,
    pub wake_in_ms: Option<u64>,
}

/// Native schedule selection and retry settlement. Probe and readback timers
/// remain with the provider and never block presentation coordination.
#[derive(Debug)]
pub struct DisplayPolicyCoordinator {
    dependencies: Dependencies,
    applied: Option<Option<String>>,
    seen: Option<String>,
}

impl DisplayPolicyCoordinator {
    pub fn new(dependencies: Dependencies) -> Self {
        Self { dependencies, applied: None, seen: None }
    }

    pub fn capabilities_changed(&mut self) {
        self.applied = None;
    }

    pub async fn reconcile(&mut self, provider: &impl DisplayControlProvider) -> PolicyPass {
        let db = &self.dependencies.state;
        let Some(bound) = db.run(|c| binding::get(c)).await.ok().flatten() else { return PolicyPass::default() };
        let Some(screen_id) = bound.screen_id else { return PolicyPass::default() };
        let binding =
            manifests::Binding { installation_id: bound.installation_id, screen_id, server_url: bound.server_url };
        let Some(stored) =
            db.run(move |c| manifests::get_for(c, manifests::Stage::Active, &binding)).await.ok().flatten()
        else {
            return PolicyPass::default();
        };
        let Ok(flags) = db.run(|c| playback::get(c)).await else { return PolicyPass::default() };
        let now_ms =
            self.dependencies.clock.now().unix_millis().saturating_add(flags.server_clock_offset_ms.unwrap_or(0));
        match crate::resolve_display_policy(&stored.document, now_ms) {
            Ok(policy) => self.apply_resolved(provider, policy, now_ms).await,
            Err(error) => {
                tracing::warn!(component = "display", event = "policy_invalid", error = %error);
                PolicyPass::default()
            }
        }
    }

    async fn apply_resolved(
        &mut self,
        provider: &impl DisplayControlProvider,
        policy: crate::DisplayPolicy,
        now_ms: i64,
    ) -> PolicyPass {
        let mut pass = PolicyPass {
            changed: false,
            wake_in_ms: policy
                .next_transition_ms
                .map(|next| next.saturating_sub(now_ms).clamp(50, i64::MAX) as u64 + 100),
        };
        let key = policy.action.as_ref().map(|action| format!("{:?}:{action}", policy.schedule_id));
        if key != self.seen {
            pass.changed = true;
            self.seen = key.clone();
            self.applied = None;
        }
        if self.applied.as_ref() == Some(&key) {
            return pass;
        }
        let request = match policy.action {
            None => PolicyRequest::Clear,
            Some(action) => parse_policy(&action).map(PolicyRequest::Action).unwrap_or(PolicyRequest::Invalid),
        };
        let result = provider.apply_policy(&request, self.dependencies.clock.now()).await;
        if request != PolicyRequest::Clear {
            tracing::info!(
                component = "display",
                event = "policy_applied",
                policy = request.state_name(),
                success = result.success,
                code = result.code.as_str()
            );
        }
        if result.success || matches!(result.code.as_str(), "display_invalid_payload" | "display_unsupported") {
            self.applied = Some(key);
            pass.changed = true;
        }
        pass
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::Mutex;

    #[test]
    fn a_send_or_transition_never_confirms_the_requested_power_state() {
        assert_eq!(power_outcome(true, None), PowerOutcome::Unconfirmed);
        assert_eq!(power_outcome(false, None), PowerOutcome::Unconfirmed);
        assert_eq!(power_outcome(true, Some(PowerReport::TurningOn)), PowerOutcome::Changing);
        assert_eq!(power_outcome(false, Some(PowerReport::TurningOff)), PowerOutcome::Changing);
        assert_eq!(power_outcome(true, Some(PowerReport::Off)), PowerOutcome::Mismatch);
        assert_eq!(power_outcome(true, Some(PowerReport::TurningOff)), PowerOutcome::Mismatch);
        assert_eq!(power_outcome(false, Some(PowerReport::TurningOn)), PowerOutcome::Mismatch);
        assert_eq!(power_outcome(true, Some(PowerReport::On)), PowerOutcome::Confirmed);
        assert_eq!(power_outcome(false, Some(PowerReport::Off)), PowerOutcome::Confirmed);
    }

    #[test]
    fn native_payloads_preserve_provider_input_names_and_enforce_bounds() {
        let payload = |value: Value| value.as_object().unwrap().clone();
        assert_eq!(
            parse("display_set_input", &payload(json!({"input":"hdmi1"}))),
            Ok(Action::SetInput("hdmi1".into()))
        );
        assert_eq!(
            parse("display_set_input", &payload(json!({"input":"2.0.0.0"}))),
            Ok(Action::SetInput("2.0.0.0".into()))
        );
        assert_eq!(parse("display_set_volume", &payload(json!({"volume":40}))), Ok(Action::SetVolume(40)));
        assert_eq!(
            parse("display_set_brightness", &payload(json!({"brightness":100.0}))),
            Ok(Action::SetBrightness(100))
        );
        for (kind, value) in [
            ("display_power_on", json!({"volume":1})),
            ("display_set_volume", json!({"volume":101})),
            ("display_set_volume", json!({"volume":1.5})),
            ("display_set_volume", json!({"volume":"50"})),
            ("display_set_volume", json!({})),
            ("display_set_volume", json!({"volume":5,"brightness":5})),
            ("display_set_brightness", json!({"brightness":-1})),
            ("display_set_input", json!({"input":"; reboot"})),
            ("display_set_input", json!({"input":"x".repeat(33)})),
            ("display_set_input", json!({"input":1})),
            ("display_mute", json!({"extra":true})),
            ("display_shell", json!({})),
        ] {
            assert_eq!(parse(kind, &payload(value.clone())), Err(Invalid::Payload), "{kind} {value}");
        }
        assert_eq!(parse_policy(&json!({"type":"display_probe"})), Err(Invalid::Payload));
        assert_eq!(parse_policy(&json!("display_power_off")), Err(Invalid::Payload));
    }

    struct Provider {
        requests: Mutex<Vec<PolicyRequest>>,
        result: Mutex<CommandResult>,
    }
    #[async_trait::async_trait]
    impl DisplayControlProvider for Provider {
        async fn apply_policy(&self, request: &PolicyRequest, _: Timestamp) -> CommandResult {
            self.requests.lock().unwrap().push(request.clone());
            self.result.lock().unwrap().clone()
        }
    }

    #[tokio::test]
    async fn uncertain_results_retry_but_unsupported_waits_for_a_capability_change() {
        let dir = tempfile::tempdir().unwrap();
        let state =
            player_state::StateDb::open(dir.path().join("state.db"), player_state::OpenOptions::default()).unwrap();
        let now = Timestamp::from_unix_millis(1000).unwrap();
        let mut core =
            DisplayPolicyCoordinator::new(Dependencies { state, clock: player_types::time::ManualClock::new(now) });
        let provider = Provider {
            requests: Mutex::new(vec![]),
            result: Mutex::new(CommandResult::failed("display_command_failed", "No acknowledgement.")),
        };
        let policy = crate::DisplayPolicy {
            action: Some(json!({"type":"display_power_off"})),
            schedule_id: Some(uuid::Uuid::from_u128(1)),
            next_transition_ms: Some(2000),
        };
        let first = core.apply_resolved(&provider, policy.clone(), 1000).await;
        assert!(first.changed);
        assert_eq!(first.wake_in_ms, Some(1100));
        assert!(!core.apply_resolved(&provider, policy.clone(), 1000).await.changed);
        assert_eq!(provider.requests.lock().unwrap().len(), 2, "uncertain result retries");
        *provider.result.lock().unwrap() = CommandResult::failed("display_unsupported", "No provider.");
        assert!(core.apply_resolved(&provider, policy.clone(), 1000).await.changed);
        core.apply_resolved(&provider, policy.clone(), 1000).await;
        assert_eq!(provider.requests.lock().unwrap().len(), 3, "unsupported result settles");
        core.capabilities_changed();
        core.apply_resolved(&provider, policy.clone(), 1000).await;
        assert_eq!(provider.requests.lock().unwrap().len(), 4, "new capability permits retry");
        core.apply_resolved(
            &provider,
            crate::DisplayPolicy { schedule_id: Some(uuid::Uuid::from_u128(2)), ..policy },
            1000,
        )
        .await;
        assert_eq!(provider.requests.lock().unwrap().len(), 5, "a replacement schedule applies even the same action");
        assert_eq!(provider.requests.lock().unwrap()[0].state_name(), "powered_off_by_policy");
        *provider.result.lock().unwrap() = CommandResult::ok("display_policy_cleared", "Cleared.");
        core.apply_resolved(
            &provider,
            crate::DisplayPolicy { action: None, schedule_id: None, next_transition_ms: None },
            1000,
        )
        .await;
        assert_eq!(provider.requests.lock().unwrap().last(), Some(&PolicyRequest::Clear));
        assert_eq!(PolicyRequest::Clear.state_name(), "normal");
    }
}
