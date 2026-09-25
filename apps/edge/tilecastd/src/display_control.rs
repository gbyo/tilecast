//! Display Control on Tilecast Edge (M9): the shared contract of
//! `docs/display-control.md` over HDMI-CEC and DDC/CI.
//!
//! Commands, scheduled display actions and the heartbeat use the reference
//! Linux player's vocabulary (`apps/player-linux/src/core/display-control.ts`),
//! because the server and Studio read it. What Edge adds is readback:
//!
//! * `display_state_confirmed`: the display reported the requested state
//!   afterwards (CEC Report Power Status, a DDC/CI Get VCP);
//! * `display_command_sent`: the display acknowledged the request, but it
//!   reports no state that confirms it (CEC input selection, a TV that does
//!   not answer power queries, a TV that is still waking);
//! * `display_state_mismatch`: the display reports a different state
//!   afterwards. The command failed, although the request was delivered.
//!
//! A heartbeat's `displayPowerStateConfirmed` is true only for a state the TV
//! itself reported. Hardware work runs on a blocking thread, one operation at
//! a time, and never delays playback.

use std::sync::Arc;
use std::time::{Duration, Instant};

use edge_platform::display::{
    DdcValue, DisplayHardware, Feature, OperationError, PowerStatus, Probe, Roots, Settings, cec, ddc,
};
use edge_protocol::Timestamp;
use edge_protocol::bounded::{DetailText, ShortText, ShortToken, Token};
use edge_protocol::capability::{AttributeValue, Capability, CapabilityId, ids};
use edge_state::repo::commands::CommandResult;
use serde_json::{Map, Value, json};

use crate::config::EdgeConfig;
use crate::daemon::DaemonContext;

/// The display command types of the shared catalog.
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

/// Longest one hardware operation may hold the display.
const OPERATION_TIMEOUT: Duration = Duration::from_secs(20);
/// Full re-probe: hot-plugged displays and adapters appear within this.
const PROBE_INTERVAL: Duration = Duration::from_secs(300);
/// TV power readback while CEC is usable.
const POWER_INTERVAL: Duration = Duration::from_secs(60);
const MAX_SLEEP: Duration = Duration::from_secs(60);
const MAX_ERROR_CHARS: usize = 240;

/// One validated display action, from a command or a schedule.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Action {
    PowerOn,
    PowerOff,
    SetInput(u16),
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
    /// A valid input identifier that is not a CEC physical address.
    Input,
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
            cec::parse_physical_address(text).map(Action::SetInput).ok_or(Invalid::Input)
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

#[derive(Debug, Clone, PartialEq, Eq)]
struct PowerView {
    state: &'static str,
    confirmed: bool,
    observed_at: Option<Timestamp>,
}

impl Default for PowerView {
    fn default() -> Self {
        Self { state: "unknown", confirmed: false, observed_at: None }
    }
}

fn power_name(status: PowerStatus) -> &'static str {
    match status {
        PowerStatus::On => "on",
        PowerStatus::Standby => "off",
        PowerStatus::TransitioningToOn | PowerStatus::TransitioningToStandby => "transitioning",
    }
}

#[derive(Debug, Clone, Default)]
struct Snapshot {
    probe: Option<Probe>,
    power: PowerView,
    /// `normal` or `powered_off_by_policy`, from the scheduled action.
    policy: Option<&'static str>,
    error: Option<String>,
}

#[derive(Debug)]
pub struct DisplayControl {
    hardware: DisplayHardware,
    snapshot: std::sync::Mutex<Snapshot>,
    operations: Arc<tokio::sync::Mutex<()>>,
}

fn bounded(text: &str) -> String {
    text.chars().take(MAX_ERROR_CHARS).collect()
}

impl DisplayControl {
    pub fn new(config: &EdgeConfig) -> Self {
        let defaults = Roots::default();
        Self::with_hardware(DisplayHardware {
            roots: Roots {
                dev_dir: config.dev.hardware_dev_dir.clone().unwrap_or(defaults.dev_dir),
                sys_dir: config.dev.hardware_sys_dir.clone().unwrap_or(defaults.sys_dir),
            },
            settings: Settings {
                cec_enabled: config.display.cec_enabled,
                ddc_enabled: config.display.ddc_enabled,
                cec_adapter: config.display.cec_adapter_number(),
                ..Settings::default()
            },
        })
    }

    pub fn with_hardware(hardware: DisplayHardware) -> Self {
        Self {
            hardware,
            snapshot: std::sync::Mutex::new(Snapshot::default()),
            operations: Arc::new(tokio::sync::Mutex::new(())),
        }
    }

    fn snapshot(&self) -> std::sync::MutexGuard<'_, Snapshot> {
        self.snapshot.lock().unwrap_or_else(|poison| poison.into_inner())
    }

    /// Runs `work` on a blocking thread while holding the operation lock.
    /// The lock moves into the thread, so a timed-out operation still keeps
    /// the display to itself until it really ends.
    async fn hardware<T: Send + 'static>(
        &self,
        work: impl FnOnce(&DisplayHardware) -> T + Send + 'static,
    ) -> Option<T> {
        let guard = Arc::clone(&self.operations).lock_owned().await;
        let hardware = self.hardware.clone();
        let task = tokio::task::spawn_blocking(move || {
            let result = work(&hardware);
            drop(guard);
            result
        });
        match tokio::time::timeout(OPERATION_TIMEOUT, task).await {
            Ok(Ok(result)) => Some(result),
            Ok(Err(_)) => None,
            Err(_) => {
                tracing::warn!(component = "display", event = "operation_timeout");
                None
            }
        }
    }

    pub fn is_probed(&self) -> bool {
        self.snapshot().probe.is_some()
    }

    fn cec_feature(&self) -> Option<Feature> {
        self.snapshot().probe.as_ref().map(|probe| probe.cec.feature)
    }

    /// Probes both providers and records what they can do.
    pub async fn probe(&self, now: Timestamp) -> Option<Probe> {
        let probe = self.hardware(|hardware| hardware.probe()).await?;
        let mut snapshot = self.snapshot();
        if let Some(status) = probe.cec.power {
            snapshot.power = PowerView { state: power_name(status), confirmed: true, observed_at: Some(now) };
        } else if !probe.cec.feature.is_usable() {
            snapshot.power = PowerView::default();
        }
        if snapshot.probe.as_ref() != Some(&probe) {
            tracing::info!(
                component = "display",
                event = "probed",
                cec = probe.cec.feature.reason.unwrap_or("available"),
                ddc = probe.ddc.brightness.reason.unwrap_or("available")
            );
        }
        snapshot.probe = Some(probe.clone());
        Some(probe)
    }

    /// Reads the TV's power status while CEC is usable.
    pub async fn refresh_power(&self, now: Timestamp) {
        if !self.cec_feature().is_some_and(|feature| feature.is_usable()) {
            return;
        }
        match self.hardware(|hardware| hardware.cec_power_status()).await {
            Some(Ok(Some(status))) => {
                self.snapshot().power =
                    PowerView { state: power_name(status), confirmed: true, observed_at: Some(now) };
            }
            Some(Ok(None)) => {
                let mut snapshot = self.snapshot();
                snapshot.power.confirmed = false;
            }
            Some(Err(error)) => {
                tracing::info!(component = "display", event = "power_readback_failed", reason = error.reason_code());
                let mut snapshot = self.snapshot();
                snapshot.power.confirmed = false;
            }
            None => {}
        }
    }

    pub fn set_policy_state(&self, state: &'static str) {
        self.snapshot().policy = Some(state);
    }

    fn record(&self, result: &CommandResult) {
        self.snapshot().error = (!result.success).then(|| bounded(&result.message));
    }

    /// Runs one validated action and says exactly what is known afterwards.
    pub async fn execute(&self, action: &Action, now: Timestamp) -> CommandResult {
        if !self.is_probed() || *action == Action::Probe {
            let probe = self.probe(now).await;
            if *action == Action::Probe {
                return match probe {
                    Some(probe) => CommandResult::ok("display_probe_completed", &summary(&probe)),
                    None => CommandResult::failed("display_command_failed", "The display probe did not finish."),
                };
            }
        }
        let result = self.execute_probed(action, now).await;
        self.record(&result);
        result
    }

    async fn execute_probed(&self, action: &Action, now: Timestamp) -> CommandResult {
        let Some(probe) = self.snapshot().probe.clone() else {
            return CommandResult::failed("display_command_failed", "The display probe did not finish.");
        };
        let unusable = |what: &str, feature: Feature| {
            CommandResult::failed(
                "display_unsupported",
                &format!("{what} is unavailable on this player ({}).", feature.reason.unwrap_or("unavailable")),
            )
        };
        match action {
            Action::PowerOn | Action::PowerOff => {
                if !probe.cec.feature.is_usable() {
                    return unusable("HDMI-CEC power control", probe.cec.feature);
                }
                let on = *action == Action::PowerOn;
                match self.hardware(move |hardware| hardware.cec_power(on)).await {
                    Some(Ok(outcome)) => self.power_result(on, outcome.observed, now),
                    Some(Err(error)) => failed(&error),
                    None => CommandResult::failed("display_command_failed", "The display did not answer in time."),
                }
            }
            Action::SetInput(address) => {
                if !probe.cec.feature.is_usable() {
                    return unusable("HDMI-CEC input selection", probe.cec.feature);
                }
                let address = *address;
                match self.hardware(move |hardware| hardware.cec_set_input(address)).await {
                    Some(Ok(())) => CommandResult::ok(
                        "display_command_sent",
                        &format!(
                            "Active Source {} was sent. HDMI-CEC does not report the selected input.",
                            cec::format_physical_address(address)
                        ),
                    ),
                    Some(Err(error)) => failed(&error),
                    None => CommandResult::failed("display_command_failed", "The display did not answer in time."),
                }
            }
            Action::SetBrightness(value) => {
                self.ddc_percent(probe.ddc.brightness, ddc::VCP_BRIGHTNESS, *value, "brightness").await
            }
            Action::SetVolume(value) => {
                self.ddc_percent(probe.ddc.volume, ddc::VCP_AUDIO_VOLUME, *value, "volume").await
            }
            Action::Mute | Action::Unmute => {
                if !probe.ddc.mute.is_usable() {
                    return unusable("DDC/CI mute", probe.ddc.mute);
                }
                let (raw, word) =
                    if *action == Action::Mute { (ddc::MUTE_ON, "muted") } else { (ddc::MUTE_OFF, "unmuted") };
                match self.hardware(move |hardware| hardware.ddc_set(ddc::VCP_AUDIO_MUTE, DdcValue::Raw(raw))).await {
                    Some(Ok(outcome)) if outcome.read_back.current == raw => {
                        CommandResult::ok("display_state_confirmed", &format!("The display reports it is {word}."))
                    }
                    Some(Ok(_)) => CommandResult::failed(
                        "display_state_mismatch",
                        &format!("The display did not report {word} after the request."),
                    ),
                    Some(Err(error)) => failed(&error),
                    None => CommandResult::failed("display_command_failed", "The display did not answer in time."),
                }
            }
            Action::Probe => CommandResult::ok("display_probe_completed", &summary(&probe)),
        }
    }

    async fn ddc_percent(&self, feature: Feature, code: u8, value: u8, name: &str) -> CommandResult {
        if !feature.is_usable() {
            return CommandResult::failed(
                "display_unsupported",
                &format!("DDC/CI {name} is unavailable on this player ({}).", feature.reason.unwrap_or("unavailable")),
            );
        }
        match self.hardware(move |hardware| hardware.ddc_set(code, DdcValue::Percent(value))).await {
            Some(Ok(outcome)) => {
                let reported = ddc::scale_from_display(outcome.read_back.current, outcome.read_back.maximum);
                if outcome.read_back.current == outcome.requested {
                    CommandResult::ok("display_state_confirmed", &format!("The display reports {name} {reported}%."))
                } else {
                    CommandResult::failed(
                        "display_state_mismatch",
                        &format!("The display reports {name} {reported}% after the request for {value}%."),
                    )
                }
            }
            Some(Err(error)) => failed(&error),
            None => CommandResult::failed("display_command_failed", "The display did not answer in time."),
        }
    }

    fn power_result(&self, on: bool, observed: Option<PowerStatus>, now: Timestamp) -> CommandResult {
        let (wanted, toward, opposite) = if on {
            (
                PowerStatus::On,
                PowerStatus::TransitioningToOn,
                [PowerStatus::Standby, PowerStatus::TransitioningToStandby],
            )
        } else {
            (
                PowerStatus::Standby,
                PowerStatus::TransitioningToStandby,
                [PowerStatus::On, PowerStatus::TransitioningToOn],
            )
        };
        let word = if on { "on" } else { "in standby" };
        let mut snapshot = self.snapshot();
        match observed {
            Some(status) if status == wanted => {
                snapshot.power = PowerView { state: power_name(status), confirmed: true, observed_at: Some(now) };
                CommandResult::ok("display_state_confirmed", &format!("The display reports it is {word}."))
            }
            Some(status) if opposite.contains(&status) => {
                snapshot.power = PowerView { state: power_name(status), confirmed: true, observed_at: Some(now) };
                CommandResult::failed(
                    "display_state_mismatch",
                    &format!("The display acknowledged the request but still reports {}.", power_name(status)),
                )
            }
            Some(status) => {
                debug_assert_eq!(status, toward);
                snapshot.power = PowerView { state: "transitioning", confirmed: false, observed_at: Some(now) };
                CommandResult::ok(
                    "display_command_sent",
                    "The display acknowledged the request and reports that it is changing state.",
                )
            }
            None => {
                snapshot.power = PowerView { state: "transitioning", confirmed: false, observed_at: None };
                CommandResult::ok(
                    "display_command_sent",
                    "The display acknowledged the request but does not report its power state.",
                )
            }
        }
    }

    /// The Display Control section of the ordinary heartbeat. Absent until
    /// the first probe, as on the reference player.
    pub fn heartbeat(&self, heartbeat: &mut Value) {
        let snapshot = self.snapshot();
        let Some(probe) = snapshot.probe.as_ref() else { return };
        let mut providers: Vec<&str> = Vec::new();
        let mut capabilities = Map::new();
        if probe.cec.feature.is_usable() {
            providers.push("hdmi_cec");
            for name in ["power", "input", "probe"] {
                capabilities.insert(name.into(), json!("hdmi_cec"));
            }
        }
        let ddc = [("brightness", probe.ddc.brightness), ("volume", probe.ddc.volume), ("mute", probe.ddc.mute)];
        if ddc.iter().any(|(_, feature)| feature.is_usable()) {
            providers.push("ddc_ci");
            for (name, feature) in ddc {
                if feature.is_usable() {
                    capabilities.insert(name.into(), json!("ddc_ci"));
                }
            }
            capabilities.entry("probe").or_insert(json!("ddc_ci"));
        }
        let supported = !providers.is_empty();
        let power = if probe.cec.feature.is_usable() {
            snapshot.power.clone()
        } else {
            PowerView { state: if supported { "unknown" } else { "unsupported" }, confirmed: false, observed_at: None }
        };
        heartbeat["displayControlProvider"] = json!(providers.first().copied().unwrap_or("unsupported"));
        heartbeat["displayControlProviders"] = json!(if supported { providers } else { vec!["unsupported"] });
        heartbeat["displayControlCapabilities"] = Value::Object(capabilities);
        heartbeat["displayPowerState"] = json!(power.state);
        heartbeat["displayPowerStateConfirmed"] = json!(power.confirmed);
        if let Some(at) = power.observed_at {
            heartbeat["displayPowerStateObservedAt"] = json!(at.to_string());
        }
        heartbeat["displayControlPolicyState"] =
            json!(snapshot.policy.unwrap_or(if supported { "normal" } else { "unknown" }));
        let error = snapshot.error.clone().or_else(|| {
            (!supported).then(|| {
                format!(
                    "No supported HDMI-CEC or DDC/CI provider was detected (cec: {}; ddc: {}).",
                    probe.cec.feature.reason.unwrap_or("available"),
                    probe.ddc.brightness.reason.unwrap_or("available")
                )
            })
        });
        if let Some(error) = error {
            heartbeat["displayControlError"] = json!(bounded(&error));
        }
    }

    /// Local capabilities (`tilecastctl capabilities`). Absent until probed.
    pub fn capabilities(&self, now: Timestamp) -> Vec<Capability> {
        let snapshot = self.snapshot();
        let Some(probe) = snapshot.probe.as_ref() else { return Vec::new() };
        let mut out = Vec::new();
        let mut cec_attributes = Vec::new();
        if let Some(adapter) = probe.cec.adapter {
            cec_attributes.push(("adapter", AttributeValue::Text(ShortText::lossy(&format!("cec{adapter}")))));
        }
        if let Some(address) = probe.cec.physical_address {
            cec_attributes.push((
                "physicalAddress",
                AttributeValue::Text(ShortText::lossy(&cec::format_physical_address(address))),
            ));
        }
        cec_attributes.push(("powerReadback", AttributeValue::Bool(probe.cec.power.is_some())));
        out.extend(capability(ids::DISPLAY_CEC_POWER, probe.cec.feature, "linux-cec", &cec_attributes, now));
        let mut input_attributes = cec_attributes.clone();
        input_attributes.retain(|(name, _)| *name != "powerReadback");
        input_attributes.push(("confirmable", AttributeValue::Bool(false)));
        out.extend(capability(ids::DISPLAY_CEC_INPUT, probe.cec.feature, "linux-cec", &input_attributes, now));
        let mut ddc_attributes = Vec::new();
        if let Some(connector) = &probe.ddc.connector {
            ddc_attributes.push(("connector", AttributeValue::Text(ShortText::lossy(connector))));
        }
        for (id, feature) in [
            (ids::DISPLAY_DDC_BRIGHTNESS, probe.ddc.brightness),
            (ids::DISPLAY_DDC_VOLUME, probe.ddc.volume),
            (ids::DISPLAY_DDC_MUTE, probe.ddc.mute),
        ] {
            out.extend(capability(id, feature, "linux-ddc", &ddc_attributes, now));
        }
        out
    }
}

fn failed(error: &OperationError) -> CommandResult {
    let (code, text) = match error {
        OperationError::Unavailable(_) => ("display_unsupported", "The display control provider is unavailable."),
        OperationError::Cec(edge_platform::display::CecError::DisplayNotResponding) => {
            ("display_command_failed", "The TV did not acknowledge the HDMI-CEC message.")
        }
        OperationError::Ddc(edge_platform::display::DdcError::NotResponding) => {
            ("display_command_failed", "The display does not answer DDC/CI.")
        }
        _ => ("display_command_failed", "The display control request failed."),
    };
    CommandResult::failed(code, &format!("{text} ({})", error.reason_code()))
}

fn summary(probe: &Probe) -> String {
    let name = |feature: Feature| match feature.reason {
        Some(reason) => format!("{:?} ({reason})", feature.state).to_lowercase(),
        None => format!("{:?}", feature.state).to_lowercase(),
    };
    format!(
        "hdmi_cec power and input: {}; ddc_ci brightness: {}, volume: {}, mute: {}.",
        name(probe.cec.feature),
        name(probe.ddc.brightness),
        name(probe.ddc.volume),
        name(probe.ddc.mute)
    )
}

fn detail(reason: &str) -> Option<&'static str> {
    Some(match reason {
        "cec_adapter_absent" => "No HDMI-CEC adapter is registered with the kernel.",
        "cec_device_node_missing" => "The CEC adapter has no device node.",
        "cec_permission_denied" => "tilecastd may not open the CEC adapter; check the tilecast-display udev rule.",
        "cec_transmit_unsupported" => "The CEC adapter can only receive.",
        "cec_logical_address_unavailable" => "No HDMI-CEC logical address could be claimed.",
        "cec_display_not_responding" => "The TV does not acknowledge HDMI-CEC messages.",
        "cec_power_status_unavailable" => "The TV accepts commands but does not report its power status.",
        "display_disconnected" => "No display is connected.",
        "ddc_bus_absent" => "No DRM connector exposes a DDC bus.",
        "i2c_dev_unavailable" => "The i2c-dev kernel module is not loaded.",
        "i2c_permission_denied" => {
            "tilecastd may not open the display's I2C bus; check the tilecast-display udev rule."
        }
        "ddc_ci_not_responding" => "The display does not answer DDC/CI; it may be turned off in the display's menu.",
        "vcp_feature_unsupported" => "The display does not implement this DDC/CI feature.",
        "ddc_ci_invalid_reply" => "The display's DDC/CI replies are invalid.",
        "ddc_ci_all_responses_null" => "The display answers every DDC/CI request as busy.",
        "ddc_ci_all_responses_zero" => "The I2C bus returns only zeros; the display may not support DDC/CI.",
        "disabled_by_operator" => "Disabled in /etc/tilecast-edge/edge.toml.",
        _ => return None,
    })
}

fn capability(
    id: &str,
    feature: Feature,
    provider: &str,
    attributes: &[(&str, AttributeValue)],
    now: Timestamp,
) -> Option<Capability> {
    let mut capability = Capability::new(CapabilityId::new(id).ok()?, feature.state, now);
    capability.provider = ShortToken::new(provider).ok();
    capability.reason_code = feature.reason.and_then(|reason| ShortToken::new(reason).ok());
    capability.detail = feature.reason.and_then(detail).map(DetailText::lossy);
    for (name, value) in attributes {
        if let Ok(key) = Token::<48>::new(*name) {
            capability.attributes.insert(key, value.clone());
        }
    }
    Some(capability)
}

// ------------------------------------------------------------ policy task

/// The committed manifest and the corrected wall clock, or `None` without a
/// bound screen.
async fn committed(context: &DaemonContext) -> Option<(Value, i64)> {
    let db = context.db()?;
    let bound = db.run(|c| edge_state::repo::binding::get(c)).await.ok().flatten()?;
    let binding = edge_state::repo::manifests::Binding {
        installation_id: bound.installation_id,
        screen_id: bound.screen_id?,
        server_url: bound.server_url,
    };
    let stored = db
        .run(move |c| edge_state::repo::manifests::get_for(c, edge_state::repo::manifests::Stage::Active, &binding))
        .await
        .ok()
        .flatten()?;
    let offset = db.run(|c| edge_state::repo::playback::get(c)).await.ok()?.server_clock_offset_ms.unwrap_or(0);
    Some((stored.document, context.now().unix_millis().saturating_add(offset)))
}

/// Applies scheduled display actions, reads back the TV's power state and
/// re-probes for hot-plugged hardware. Without hardware it only probes, at
/// the probe interval.
pub async fn run(context: Arc<DaemonContext>) {
    let display = Arc::clone(&context.display);
    let mut last_probe: Option<Instant> = None;
    let mut last_power = Instant::now();
    let mut applied: Option<String> = None;
    loop {
        let mut changed = false;
        if last_probe.is_none_or(|at| at.elapsed() >= PROBE_INTERVAL) {
            let before = display.capabilities(context.now());
            display.probe(context.now()).await;
            last_probe = Some(Instant::now());
            last_power = Instant::now();
            changed |= materially_changed(&before, &display.capabilities(context.now()));
        } else if last_power.elapsed() >= POWER_INTERVAL {
            display.refresh_power(context.now()).await;
            last_power = Instant::now();
        }

        let mut wake_in = MAX_SLEEP;
        if let Some((document, now_ms)) = committed(&context).await {
            match crate::schedule::resolve_display_policy(&document, now_ms) {
                Ok(policy) => {
                    if let Some(next) = policy.next_transition_ms {
                        wake_in = wake_in.min(Duration::from_millis((next - now_ms).clamp(50, i64::MAX) as u64 + 100));
                    }
                    let key = policy.action.as_ref().map(|action| format!("{:?}:{action}", policy.schedule_id));
                    if key != applied {
                        applied = key;
                        changed = true;
                        apply(&context, &display, policy.action.as_ref()).await;
                    }
                }
                Err(error) => {
                    tracing::warn!(component = "display", event = "policy_invalid", error = %error);
                }
            }
        }
        if changed {
            crate::capabilities::refresh(&context).await;
            context.report_status_soon();
        }
        tokio::select! {
            () = context.shutdown.cancelled() => return,
            () = context.display_wake.notified() => {}
            () = tokio::time::sleep(wake_in) => {}
        }
    }
}

async fn apply(context: &DaemonContext, display: &DisplayControl, action: Option<&Value>) {
    let Some(action) = action else {
        display.set_policy_state("normal");
        return;
    };
    let parsed = parse_policy(action);
    let state = if parsed.as_ref().is_ok_and(|action| *action == Action::PowerOff) {
        "powered_off_by_policy"
    } else {
        "normal"
    };
    display.set_policy_state(state);
    let result = match parsed {
        Ok(action) => display.execute(&action, context.now()).await,
        Err(_) => {
            let result = CommandResult::failed("display_invalid_payload", "The scheduled display action is invalid.");
            display.record(&result);
            result
        }
    };
    tracing::info!(
        component = "display",
        event = "policy_applied",
        policy = state,
        success = result.success,
        code = result.code.as_str()
    );
}

fn materially_changed(before: &[Capability], after: &[Capability]) -> bool {
    edge_protocol::capability::CapabilitySnapshot::materially_differs(before, after)
}

#[cfg(test)]
mod tests {
    use super::*;
    use edge_protocol::capability::CapabilityState;

    fn payload(value: Value) -> Map<String, Value> {
        value.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn payloads_are_validated_like_the_reference_player() {
        assert_eq!(parse("display_power_on", &Map::new()), Ok(Action::PowerOn));
        assert_eq!(parse("display_set_volume", &payload(json!({"volume": 40}))), Ok(Action::SetVolume(40)));
        assert_eq!(
            parse("display_set_brightness", &payload(json!({"brightness": 100.0}))),
            Ok(Action::SetBrightness(100))
        );
        assert_eq!(parse("display_set_input", &payload(json!({"input": "2.0.0.0"}))), Ok(Action::SetInput(0x2000)));
        for (kind, bad) in [
            ("display_power_on", json!({"volume": 1})),
            ("display_set_volume", json!({"volume": 101})),
            ("display_set_volume", json!({"volume": 1.5})),
            ("display_set_volume", json!({"volume": "50"})),
            ("display_set_volume", json!({})),
            ("display_set_volume", json!({"volume": 5, "brightness": 5})),
            ("display_set_brightness", json!({"brightness": -1})),
            ("display_set_input", json!({"input": "; reboot"})),
            ("display_set_input", json!({"input": "x".repeat(33)})),
            ("display_set_input", json!({"input": 1})),
            ("display_mute", json!({"extra": true})),
            ("display_shell", json!({})),
        ] {
            assert_eq!(parse(kind, &payload(bad.clone())), Err(Invalid::Payload), "{kind} {bad}");
        }
        assert_eq!(parse("display_set_input", &payload(json!({"input": "hdmi1"}))), Err(Invalid::Input));
        assert_eq!(parse_policy(&json!({"type": "display_power_off"})), Ok(Action::PowerOff));
        assert_eq!(parse_policy(&json!({"type": "display_probe"})), Err(Invalid::Payload), "probe is not a policy");
        assert_eq!(parse_policy(&json!("display_power_off")), Err(Invalid::Payload));
    }

    fn unprobed() -> (tempfile::TempDir, DisplayControl) {
        let dir = tempfile::tempdir().expect("tempdir");
        let hardware = DisplayHardware {
            roots: Roots { dev_dir: dir.path().join("dev"), sys_dir: dir.path().join("sys") },
            settings: Settings::default(),
        };
        (dir, DisplayControl::with_hardware(hardware))
    }

    fn now() -> Timestamp {
        Timestamp::parse("2026-09-25T12:00:00Z").expect("time")
    }

    #[tokio::test]
    async fn without_hardware_every_command_is_a_typed_refusal_and_the_heartbeat_says_unsupported() {
        let (_dir, display) = unprobed();
        let mut heartbeat = json!({});
        display.heartbeat(&mut heartbeat);
        assert_eq!(heartbeat, json!({}), "nothing is reported before the first probe");

        let result = display.execute(&Action::PowerOn, now()).await;
        assert_eq!((result.success, result.code.as_str()), (false, "display_unsupported"));
        assert!(result.message.contains("cec_adapter_absent"), "{}", result.message);
        let result = display.execute(&Action::SetBrightness(50), now()).await;
        assert_eq!(result.code, "display_unsupported");
        assert!(result.message.contains("ddc_bus_absent"));
        let probe = display.execute(&Action::Probe, now()).await;
        assert_eq!((probe.success, probe.code.as_str()), (true, "display_probe_completed"));

        display.heartbeat(&mut heartbeat);
        assert_eq!(heartbeat["displayControlProvider"], "unsupported");
        assert_eq!(heartbeat["displayControlProviders"], json!(["unsupported"]));
        assert_eq!(heartbeat["displayControlCapabilities"], json!({}));
        assert_eq!(heartbeat["displayPowerState"], "unsupported");
        assert_eq!(heartbeat["displayPowerStateConfirmed"], false);
        assert!(heartbeat["displayControlError"].as_str().unwrap().len() <= MAX_ERROR_CHARS);

        let capabilities = display.capabilities(now());
        let ids: Vec<&str> = capabilities.iter().map(|c| c.id.as_str()).collect();
        assert_eq!(
            ids,
            [
                "display.cec.power",
                "display.cec.input",
                "display.ddc.brightness",
                "display.ddc.volume",
                "display.ddc.mute"
            ]
        );
        assert!(capabilities.iter().all(|c| c.state == CapabilityState::Unsupported && c.reason_code.is_some()));
    }

    #[test]
    fn power_is_confirmed_only_by_the_reported_state() {
        let (_dir, display) = unprobed();
        let on = display.power_result(true, Some(PowerStatus::On), now());
        assert_eq!((on.success, on.code.as_str()), (true, "display_state_confirmed"));
        assert_eq!(display.snapshot().power, PowerView { state: "on", confirmed: true, observed_at: Some(now()) });

        let waking = display.power_result(true, Some(PowerStatus::TransitioningToOn), now());
        assert_eq!((waking.success, waking.code.as_str()), (true, "display_command_sent"));
        assert!(!display.snapshot().power.confirmed);

        let silent = display.power_result(false, None, now());
        assert_eq!(silent.code, "display_command_sent");
        assert_eq!(display.snapshot().power.observed_at, None, "nothing was observed");

        let refused = display.power_result(false, Some(PowerStatus::On), now());
        assert_eq!((refused.success, refused.code.as_str()), (false, "display_state_mismatch"));
        assert_eq!(display.snapshot().power.state, "on", "the TV's own report wins over the request");
    }
}
