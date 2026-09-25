//! Display control hardware: HDMI-CEC and DDC/CI (docs/tilecast-edge.md §12,
//! M9).
//!
//! Discovery reads sysfs; control uses the kernel devices directly
//! ([`kernel`]). `tilecastd` runs no `cec-ctl` or `ddcutil`, because it
//! starts no processes. Access is granted by udev (group
//! `tilecast-display`) to the daemon unit only, never by root.
//!
//! Everything here is synchronous and bounded; callers run it on a blocking
//! thread. A missing adapter, a missing node, a permission failure, an
//! unplugged display or a display that does not answer is a typed state,
//! never a panic and never a reason to stop playback.

pub mod cec;
pub mod ddc;
pub mod kernel;

use std::path::PathBuf;

use edge_protocol::capability::CapabilityState;

pub use cec::{CecError, PowerOutcome, PowerStatus, Readback};
pub use ddc::{DdcError, Timing, VcpValue};

const MAX_ENTRIES: usize = 64;

/// Where discovery looks. Tests point these at temporary trees.
#[derive(Debug, Clone)]
pub struct Roots {
    pub dev_dir: PathBuf,
    pub sys_dir: PathBuf,
}

impl Default for Roots {
    fn default() -> Self {
        Self { dev_dir: PathBuf::from("/dev"), sys_dir: PathBuf::from("/sys") }
    }
}

/// Operator settings (`[display]` in `edge.toml`).
#[derive(Debug, Clone)]
pub struct Settings {
    pub cec_enabled: bool,
    pub ddc_enabled: bool,
    /// Use only this adapter (`cecN`), instead of the first connected one.
    pub cec_adapter: Option<u8>,
    pub readback: Readback,
    pub timing: Timing,
}

impl Default for Settings {
    fn default() -> Self {
        Self {
            cec_enabled: true,
            ddc_enabled: true,
            cec_adapter: None,
            readback: Readback::default(),
            timing: Timing::default(),
        }
    }
}

/// A capability's state and machine-readable reason.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct Feature {
    pub state: CapabilityState,
    pub reason: Option<&'static str>,
}

impl Feature {
    pub const fn available() -> Self {
        Self { state: CapabilityState::Available, reason: None }
    }
    pub const fn new(state: CapabilityState, reason: &'static str) -> Self {
        Self { state, reason: Some(reason) }
    }
    pub fn is_usable(&self) -> bool {
        self.state.is_usable()
    }
}

fn device_open_feature(error: &std::io::Error, missing: &'static str, denied: &'static str) -> Feature {
    match error.kind() {
        std::io::ErrorKind::NotFound => Feature::new(CapabilityState::Blocked, missing),
        std::io::ErrorKind::PermissionDenied => Feature::new(CapabilityState::Blocked, denied),
        _ => Feature::new(CapabilityState::Supported, "device_open_failed"),
    }
}

fn cec_feature(error: CecError) -> Feature {
    match error {
        CecError::TransmitUnsupported => Feature::new(CapabilityState::Unsupported, error.reason_code()),
        _ => Feature::new(CapabilityState::Supported, error.reason_code()),
    }
}

fn ddc_feature(error: DdcError) -> Feature {
    match error {
        DdcError::NotResponding | DdcError::Unsupported => {
            Feature::new(CapabilityState::Unsupported, error.reason_code())
        }
        DdcError::BadReply | DdcError::Bus => Feature::new(CapabilityState::Supported, error.reason_code()),
    }
}

// ------------------------------------------------------------ discovery

fn numbered(name: &str, prefix: &str) -> Option<u16> {
    let digits = name.strip_prefix(prefix)?;
    if digits.is_empty() || digits.len() > 3 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    digits.parse().ok()
}

/// CEC adapters registered with the kernel (`/sys/class/cec/cecN`).
pub fn cec_adapters(roots: &Roots) -> Vec<u8> {
    let mut adapters: Vec<u8> = std::fs::read_dir(roots.sys_dir.join("class/cec"))
        .into_iter()
        .flatten()
        .flatten()
        .take(MAX_ENTRIES)
        .filter_map(|entry| numbered(entry.file_name().to_str()?, "cec"))
        .filter_map(|number| u8::try_from(number).ok().filter(|n| *n < 32))
        .collect();
    adapters.sort_unstable();
    adapters
}

/// One DRM connector and the I²C bus of its DDC channel.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Connector {
    /// The connector part of `cardN-<name>`, for example `HDMI-A-1`.
    pub name: String,
    pub connected: bool,
    pub ddc_bus: Option<u16>,
}

fn connector_name(entry: &str) -> Option<&str> {
    let (card, name) = entry.split_once('-')?;
    numbered(card, "card")?;
    let valid = !name.is_empty() && name.len() <= 32 && name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-');
    valid.then_some(name)
}

/// DRM connectors (`/sys/class/drm/cardN-*`) in name order. The DDC bus
/// number comes from the `ddc` link's final component (`i2c-N`) only.
pub fn drm_connectors(roots: &Roots) -> Vec<Connector> {
    let class = roots.sys_dir.join("class/drm");
    let mut connectors: Vec<Connector> = std::fs::read_dir(&class)
        .into_iter()
        .flatten()
        .flatten()
        .take(MAX_ENTRIES)
        .filter_map(|entry| {
            let file_name = entry.file_name();
            let name = connector_name(file_name.to_str()?)?.to_owned();
            let dir = class.join(&file_name);
            let status = crate::fs::read_regular(&dir.join("status"), 64).ok().flatten().unwrap_or_default();
            let connected = String::from_utf8_lossy(&status).trim() == "connected";
            let ddc_bus = std::fs::read_link(dir.join("ddc"))
                .ok()
                .and_then(|target| target.file_name().and_then(|n| n.to_str()).and_then(|n| numbered(n, "i2c-")));
            Some(Connector { name, connected, ddc_bus })
        })
        .collect();
    connectors.sort_by(|a, b| a.name.cmp(&b.name));
    connectors.dedup_by(|a, b| a.name == b.name && a.ddc_bus == b.ddc_bus);
    connectors
}

// ------------------------------------------------------------ probe

/// What CEC can do on this machine now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CecStatus {
    pub feature: Feature,
    pub adapter: Option<u8>,
    pub physical_address: Option<u16>,
    /// The TV's own power report, when it gave one.
    pub power: Option<PowerStatus>,
}

/// What DDC/CI can do on this machine now.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DdcStatus {
    pub connector: Option<String>,
    pub bus: Option<u16>,
    pub brightness: Feature,
    pub volume: Feature,
    pub mute: Feature,
}

impl DdcStatus {
    fn all(connector: Option<String>, bus: Option<u16>, feature: Feature) -> Self {
        Self { connector, bus, brightness: feature, volume: feature, mute: feature }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Probe {
    pub cec: CecStatus,
    pub ddc: DdcStatus,
}

/// Display control hardware access with fixed roots and settings.
#[derive(Debug, Clone, Default)]
pub struct DisplayHardware {
    pub roots: Roots,
    pub settings: Settings,
}

/// Why an operation could not run.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum OperationError {
    #[error("{}", .0.reason.unwrap_or("unavailable"))]
    Unavailable(Feature),
    #[error(transparent)]
    Cec(#[from] CecError),
    #[error(transparent)]
    Ddc(#[from] DdcError),
}

impl OperationError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::Unavailable(feature) => feature.reason.unwrap_or("unavailable"),
            Self::Cec(error) => error.reason_code(),
            Self::Ddc(error) => error.reason_code(),
        }
    }
}

impl DisplayHardware {
    fn open_cec(&self, adapter: u8) -> std::io::Result<kernel::CecDevice> {
        kernel::CecDevice::open(&self.roots.dev_dir, adapter)
    }

    /// Picks the adapter to use: the configured one, else the first whose
    /// physical address says a display is attached on the source side
    /// (not `f.f.f.f`, not the TV's own `0.0.0.0`).
    fn select_cec(&self) -> Result<(u8, kernel::CecDevice), (Option<u8>, Feature)> {
        if !self.settings.cec_enabled {
            return Err((None, Feature::new(CapabilityState::Blocked, "disabled_by_operator")));
        }
        let adapters = match self.settings.cec_adapter {
            Some(pinned) => cec_adapters(&self.roots).into_iter().filter(|a| *a == pinned).collect(),
            None => cec_adapters(&self.roots),
        };
        if adapters.is_empty() {
            return Err((None, Feature::new(CapabilityState::Unsupported, "cec_adapter_absent")));
        }
        let mut first_failure = None;
        let mut fallback = None;
        for adapter in adapters {
            match self.open_cec(adapter) {
                Ok(device) => {
                    let physical = device.phys_addr().unwrap_or(cec::PHYS_ADDR_INVALID);
                    if physical != cec::PHYS_ADDR_INVALID && physical != 0 {
                        return Ok((adapter, device));
                    }
                    fallback.get_or_insert((adapter, device));
                }
                Err(error) => {
                    first_failure.get_or_insert((
                        Some(adapter),
                        device_open_feature(&error, "cec_device_node_missing", "cec_permission_denied"),
                    ));
                }
            }
        }
        fallback.ok_or_else(|| first_failure.expect("an adapter failed to open"))
    }

    pub fn probe_cec(&self) -> CecStatus {
        let (adapter, device) = match self.select_cec() {
            Ok(selected) => selected,
            Err((adapter, feature)) => return CecStatus { feature, adapter, physical_address: None, power: None },
        };
        match cec::CecController::new(&device).probe() {
            Ok(probe) => CecStatus {
                feature: match probe.power {
                    Some(_) => Feature::available(),
                    None => Feature::new(CapabilityState::Degraded, "cec_power_status_unavailable"),
                },
                adapter: Some(adapter),
                physical_address: Some(probe.physical_address),
                power: probe.power,
            },
            Err(error) => CecStatus {
                feature: cec_feature(error),
                adapter: Some(adapter),
                physical_address: device.phys_addr().ok().filter(|p| *p != cec::PHYS_ADDR_INVALID),
                power: None,
            },
        }
    }

    fn select_ddc(&self) -> Result<(String, u16, kernel::I2cDevice), DdcStatus> {
        if !self.settings.ddc_enabled {
            return Err(DdcStatus::all(None, None, Feature::new(CapabilityState::Blocked, "disabled_by_operator")));
        }
        let connectors = drm_connectors(&self.roots);
        let with_bus: Vec<&Connector> = connectors.iter().filter(|c| c.ddc_bus.is_some()).collect();
        if with_bus.is_empty() {
            return Err(DdcStatus::all(None, None, Feature::new(CapabilityState::Unsupported, "ddc_bus_absent")));
        }
        let connected: Vec<&&Connector> = with_bus.iter().filter(|c| c.connected).collect();
        let Some(first) = connected.first() else {
            return Err(DdcStatus::all(None, None, Feature::new(CapabilityState::Supported, "display_disconnected")));
        };
        let mut failure = None;
        for connector in &connected {
            let bus = connector.ddc_bus.expect("filtered");
            match kernel::I2cDevice::open(&self.roots.dev_dir, bus, ddc::DDC_ADDRESS) {
                Ok(device) => return Ok((connector.name.clone(), bus, device)),
                Err(error) => {
                    failure.get_or_insert(DdcStatus::all(
                        Some(connector.name.clone()),
                        Some(bus),
                        device_open_feature(&error, "i2c_dev_unavailable", "i2c_permission_denied"),
                    ));
                }
            }
        }
        Err(failure.unwrap_or_else(|| {
            DdcStatus::all(
                Some(first.name.clone()),
                first.ddc_bus,
                Feature::new(CapabilityState::Supported, "device_open_failed"),
            )
        }))
    }

    pub fn probe_ddc(&self) -> DdcStatus {
        let (name, bus, device) = match self.select_ddc() {
            Ok(selected) => selected,
            Err(status) => return status,
        };
        let ddc = ddc::DdcController::new(&device, self.settings.timing.clone());
        let feature = |code| match ddc.get(code) {
            Ok(_) => Feature::available(),
            Err(error) => ddc_feature(error),
        };
        let brightness = feature(ddc::VCP_BRIGHTNESS);
        // A display that does not answer the first query will not answer the
        // others; do not spend the timeouts twice more.
        if brightness.reason == Some(DdcError::NotResponding.reason_code()) {
            return DdcStatus::all(Some(name), Some(bus), brightness);
        }
        DdcStatus {
            volume: feature(ddc::VCP_AUDIO_VOLUME),
            mute: feature(ddc::VCP_AUDIO_MUTE),
            brightness,
            connector: Some(name),
            bus: Some(bus),
        }
    }

    pub fn probe(&self) -> Probe {
        Probe { cec: self.probe_cec(), ddc: self.probe_ddc() }
    }

    fn cec_device(&self) -> Result<kernel::CecDevice, OperationError> {
        self.select_cec().map(|(_, device)| device).map_err(|(_, feature)| OperationError::Unavailable(feature))
    }

    pub fn cec_power(&self, on: bool) -> Result<PowerOutcome, OperationError> {
        let device = self.cec_device()?;
        Ok(cec::CecController::new(&device).set_power(on, &self.settings.readback)?)
    }

    pub fn cec_power_status(&self) -> Result<Option<PowerStatus>, OperationError> {
        let device = self.cec_device()?;
        Ok(cec::CecController::new(&device).power_status()?)
    }

    pub fn cec_set_input(&self, physical_address: u16) -> Result<(), OperationError> {
        let device = self.cec_device()?;
        Ok(cec::CecController::new(&device).set_active_source(physical_address)?)
    }

    /// Sets a DDC/CI feature to `percent` of its maximum (or to a raw value
    /// for mute) and returns the value the display reports afterwards.
    pub fn ddc_set(&self, code: u8, value: DdcValue) -> Result<DdcSetOutcome, OperationError> {
        let (_, _, device) = self.select_ddc().map_err(|status| OperationError::Unavailable(status.brightness))?;
        let ddc = ddc::DdcController::new(&device, self.settings.timing.clone());
        let current = ddc.get(code)?;
        let requested = match value {
            DdcValue::Percent(percent) => ddc::scale_to_display(percent, current.maximum),
            DdcValue::Raw(raw) => raw,
        };
        let read_back = ddc.set(code, requested)?;
        Ok(DdcSetOutcome { requested, read_back })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DdcValue {
    Percent(u8),
    Raw(u16),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct DdcSetOutcome {
    pub requested: u16,
    pub read_back: VcpValue,
}

/// Whether `path` names a directory tree that looks like sysfs (used by the
/// daemon's diagnostics; an absent `/sys` is a container, not a failure).
pub fn has_sysfs(roots: &Roots) -> bool {
    roots.sys_dir.join("class").is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (tempfile::TempDir, Roots) {
        let dir = tempfile::tempdir().expect("tempdir");
        let roots = Roots { dev_dir: dir.path().join("dev"), sys_dir: dir.path().join("sys") };
        std::fs::create_dir_all(&roots.dev_dir).expect("dev");
        std::fs::create_dir_all(roots.sys_dir.join("class/cec")).expect("cec");
        std::fs::create_dir_all(roots.sys_dir.join("class/drm")).expect("drm");
        std::fs::create_dir_all(roots.sys_dir.join("devices/i2c-7")).expect("i2c");
        (dir, roots)
    }

    fn connector(roots: &Roots, name: &str, status: &str, bus: Option<&str>) {
        let dir = roots.sys_dir.join("class/drm").join(name);
        std::fs::create_dir_all(&dir).expect("connector");
        std::fs::write(dir.join("status"), format!("{status}\n")).expect("status");
        if let Some(bus) = bus {
            std::os::unix::fs::symlink(roots.sys_dir.join("devices").join(bus), dir.join("ddc")).expect("ddc link");
        }
    }

    #[test]
    fn no_hardware_is_a_typed_unsupported_state() {
        let (_dir, roots) = tree();
        let hardware = DisplayHardware { roots, settings: Settings::default() };
        let probe = hardware.probe();
        assert_eq!(probe.cec.feature, Feature::new(CapabilityState::Unsupported, "cec_adapter_absent"));
        assert_eq!(probe.ddc.brightness, Feature::new(CapabilityState::Unsupported, "ddc_bus_absent"));
        assert!(matches!(hardware.cec_power(true), Err(OperationError::Unavailable(_))));
    }

    #[test]
    fn a_missing_sysfs_is_the_same_as_no_hardware() {
        let dir = tempfile::tempdir().expect("tempdir");
        let hardware = DisplayHardware {
            roots: Roots { dev_dir: dir.path().join("dev"), sys_dir: dir.path().join("none") },
            settings: Settings::default(),
        };
        assert_eq!(hardware.probe_cec().feature.reason, Some("cec_adapter_absent"));
        assert!(!has_sysfs(&hardware.roots));
    }

    #[test]
    fn adapters_without_nodes_or_permission_are_blocked() {
        let (_dir, roots) = tree();
        std::fs::create_dir(roots.sys_dir.join("class/cec/cec0")).expect("adapter");
        std::fs::create_dir(roots.sys_dir.join("class/cec/not-an-adapter")).expect("noise");
        let hardware = DisplayHardware { roots: roots.clone(), settings: Settings::default() };
        assert_eq!(cec_adapters(&roots), vec![0]);
        assert_eq!(hardware.probe_cec().feature, Feature::new(CapabilityState::Blocked, "cec_device_node_missing"));

        let disabled = DisplayHardware { roots, settings: Settings { cec_enabled: false, ..Settings::default() } };
        assert_eq!(disabled.probe_cec().feature.reason, Some("disabled_by_operator"));
    }

    #[test]
    fn ddc_uses_only_connected_connectors_and_the_bus_number_of_their_link() {
        let (_dir, roots) = tree();
        connector(&roots, "card0-HDMI-A-1", "disconnected", Some("i2c-7"));
        let hardware = DisplayHardware { roots: roots.clone(), settings: Settings::default() };
        assert_eq!(hardware.probe_ddc().brightness, Feature::new(CapabilityState::Supported, "display_disconnected"));

        connector(&roots, "card0-DP-1", "connected", Some("i2c-7"));
        connector(&roots, "card0-eDP-1", "connected", None);
        connector(&roots, "renderD128", "connected", None);
        let connectors = drm_connectors(&roots);
        assert_eq!(connectors.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["DP-1", "HDMI-A-1", "eDP-1"]);
        assert_eq!(connectors[0].ddc_bus, Some(7));
        // The bus exists in sysfs but i2c-dev did not create /dev/i2c-7.
        let status = hardware.probe_ddc();
        assert_eq!(status.connector.as_deref(), Some("DP-1"));
        assert_eq!(status.brightness, Feature::new(CapabilityState::Blocked, "i2c_dev_unavailable"));
    }

    #[test]
    fn names_from_sysfs_never_become_paths() {
        for bad in ["cec", "cec01234", "cec-1", "cec1a", "../cec1"] {
            assert_eq!(numbered(bad, "cec"), None, "{bad}");
        }
        assert_eq!(connector_name("card0-HDMI-A-1"), Some("HDMI-A-1"));
        for bad in ["card-HDMI", "cardX-HDMI", "card0-", "card0-HDMI/../x", "version"] {
            assert_eq!(connector_name(bad), None, "{bad}");
        }
    }
}
