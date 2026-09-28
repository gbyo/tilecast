//! HDMI-CEC display control through the kernel CEC framework.
//!
//! Tilecast Edge acts as one playback device on the CEC bus and sends only
//! the fixed messages the shared Display Control contract needs
//! (`docs/display-control.md`):
//!
//! | operation  | message                                   | readback                     |
//! | ---------- | ----------------------------------------- | ---------------------------- |
//! | power on   | Image View On (0x04) to the TV            | Give Device Power Status     |
//! | power off  | Standby (0x36) to the TV                  | Give Device Power Status     |
//! | set input  | Active Source (0x82), broadcast           | none: CEC reports no input   |
//! | probe      | Give Device Power Status (0x8f) to the TV | Report Power Status (0x90)   |
//!
//! A message the TV acknowledged is "sent". A state is "confirmed" only when
//! the TV itself reported it afterwards. Nothing here claims that a display
//! changed state because a transmit returned.

use std::time::Duration;

use super::kernel::{CecDevice, CecLogAddrs, CecMsg};

const LOG_ADDR_TV: u8 = 0;
const LOG_ADDR_BROADCAST: u8 = 15;
const LOG_ADDR_INVALID: u8 = 0xff;
pub const PHYS_ADDR_INVALID: u16 = 0xffff;

const MSG_IMAGE_VIEW_ON: u8 = 0x04;
const MSG_STANDBY: u8 = 0x36;
const MSG_ACTIVE_SOURCE: u8 = 0x82;
const MSG_GIVE_DEVICE_POWER_STATUS: u8 = 0x8f;
const MSG_REPORT_POWER_STATUS: u8 = 0x90;

const CAP_LOG_ADDRS: u32 = 1 << 1;
const CAP_TRANSMIT: u32 = 1 << 2;

const TX_STATUS_OK: u8 = 1 << 0;
const TX_STATUS_NACK: u8 = 1 << 2;
const RX_STATUS_OK: u8 = 1 << 0;
const RX_STATUS_FEATURE_ABORT: u8 = 1 << 2;

const LOG_ADDR_TYPE_PLAYBACK: u8 = 3;
const PRIM_DEVTYPE_PLAYBACK: u8 = 4;
const ALL_DEVTYPE_PLAYBACK: u8 = 0x10;
const CEC_VERSION_1_4: u8 = 5;
const VENDOR_ID_NONE: u32 = 0xffff_ffff;
const OSD_NAME: &[u8] = b"Tilecast";

/// What the TV reported in Report Power Status.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PowerStatus {
    On,
    Standby,
    TransitioningToOn,
    TransitioningToStandby,
}

impl PowerStatus {
    fn from_operand(value: u8) -> Option<Self> {
        Some(match value {
            0 => Self::On,
            1 => Self::Standby,
            2 => Self::TransitioningToOn,
            3 => Self::TransitioningToStandby,
            _ => return None,
        })
    }
}

/// The adapter facts the controller needs.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AdapterInfo {
    pub can_transmit: bool,
    /// Userspace configures logical addresses (`CEC_CAP_LOG_ADDRS`).
    pub configurable_log_addrs: bool,
}

/// One transmit's outcome, as the framework reports it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Transmit {
    /// Acknowledged. `reply` holds the awaited reply's bytes when one came.
    Acked { reply: Option<Vec<u8>>, feature_abort: bool },
    /// Nobody acknowledged a directly addressed message.
    NotAcknowledged,
    /// Arbitration loss, low drive, bus error or retries exhausted.
    BusError,
}

/// The minimal adapter surface, implemented by the kernel device and by test
/// fakes.
pub trait CecAdapter {
    fn info(&self) -> std::io::Result<AdapterInfo>;
    fn physical_address(&self) -> std::io::Result<u16>;
    /// The first claimed logical address, if any.
    fn logical_address(&self) -> std::io::Result<Option<u8>>;
    /// Claims one playback logical address and returns it (blocking).
    fn claim_playback(&self) -> std::io::Result<Option<u8>>;
    fn transmit(&self, initiator: u8, destination: u8, payload: &[u8], reply: Option<u8>) -> std::io::Result<Transmit>;
}

impl CecAdapter for CecDevice {
    fn info(&self) -> std::io::Result<AdapterInfo> {
        let caps = self.caps()?;
        Ok(AdapterInfo {
            can_transmit: caps.capabilities & CAP_TRANSMIT != 0,
            configurable_log_addrs: caps.capabilities & CAP_LOG_ADDRS != 0,
        })
    }

    fn physical_address(&self) -> std::io::Result<u16> {
        self.phys_addr()
    }

    fn logical_address(&self) -> std::io::Result<Option<u8>> {
        let addrs = self.log_addrs()?;
        Ok((addrs.num_log_addrs > 0 && addrs.log_addr[0] != LOG_ADDR_INVALID).then_some(addrs.log_addr[0]))
    }

    fn claim_playback(&self) -> std::io::Result<Option<u8>> {
        let mut addrs = CecLogAddrs::empty();
        addrs.num_log_addrs = 1;
        addrs.cec_version = CEC_VERSION_1_4;
        addrs.vendor_id = VENDOR_ID_NONE;
        addrs.log_addr_type[0] = LOG_ADDR_TYPE_PLAYBACK;
        addrs.primary_device_type[0] = PRIM_DEVTYPE_PLAYBACK;
        addrs.all_device_types[0] = ALL_DEVTYPE_PLAYBACK;
        addrs.osd_name[..OSD_NAME.len()].copy_from_slice(OSD_NAME);
        self.set_log_addrs(&mut addrs)?;
        Ok((addrs.num_log_addrs > 0 && addrs.log_addr[0] != LOG_ADDR_INVALID).then_some(addrs.log_addr[0]))
    }

    fn transmit(&self, initiator: u8, destination: u8, payload: &[u8], reply: Option<u8>) -> std::io::Result<Transmit> {
        let mut msg = CecMsg::new(initiator, destination, payload)
            .ok_or_else(|| std::io::Error::new(std::io::ErrorKind::InvalidInput, "CEC message too long"))?;
        msg.reply = reply.unwrap_or(0);
        CecDevice::transmit(self, &mut msg)?;
        if msg.tx_status & TX_STATUS_OK == 0 {
            return Ok(if msg.tx_status & TX_STATUS_NACK != 0 {
                Transmit::NotAcknowledged
            } else {
                Transmit::BusError
            });
        }
        let feature_abort = msg.rx_status & RX_STATUS_FEATURE_ABORT != 0;
        let replied = reply.is_some() && msg.reply != 0 && msg.rx_status & RX_STATUS_OK != 0 && !feature_abort;
        Ok(Transmit::Acked { reply: replied.then(|| msg.bytes().to_vec()), feature_abort })
    }
}

/// Why CEC cannot be used right now. Each maps to a capability reason code.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum CecError {
    #[error("the CEC adapter cannot transmit")]
    TransmitUnsupported,
    #[error("no display is connected to the CEC adapter")]
    DisplayDisconnected,
    #[error("no CEC logical address could be claimed")]
    NoLogicalAddress,
    #[error("the TV did not acknowledge the CEC message")]
    DisplayNotResponding,
    #[error("the CEC bus reported an error")]
    BusError,
    #[error("the CEC device failed")]
    Device,
}

impl CecError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::TransmitUnsupported => "cec_transmit_unsupported",
            Self::DisplayDisconnected => "display_disconnected",
            Self::NoLogicalAddress => "cec_logical_address_unavailable",
            Self::DisplayNotResponding => "cec_display_not_responding",
            Self::BusError => "cec_bus_error",
            Self::Device => "cec_device_error",
        }
    }

    fn from_io(error: &std::io::Error) -> Self {
        // ENONET: the adapter is unconfigured; ENODEV: it went away.
        #[cfg(target_os = "linux")]
        if error.raw_os_error() == Some(rustix::io::Errno::NONET.raw_os_error()) {
            return Self::NoLogicalAddress;
        }
        let _ = error;
        Self::Device
    }
}

/// What a probe learned.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CecProbe {
    pub physical_address: u16,
    pub logical_address: u8,
    /// `None` when the TV acknowledged but did not report its power status.
    pub power: Option<PowerStatus>,
}

/// Timing of the readback after a power request. TVs take seconds to wake;
/// the controller asks again at each delay and stops at the first final
/// state.
#[derive(Debug, Clone)]
pub struct Readback {
    pub delays: Vec<Duration>,
}

impl Default for Readback {
    fn default() -> Self {
        Self { delays: vec![Duration::from_millis(500), Duration::from_secs(2), Duration::from_secs(4)] }
    }
}

/// The result of a power request.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PowerOutcome {
    /// The last state the TV reported, if it reported one.
    pub observed: Option<PowerStatus>,
}

pub struct CecController<'a, A: CecAdapter + ?Sized> {
    adapter: &'a A,
}

impl<A: CecAdapter + ?Sized> std::fmt::Debug for CecController<'_, A> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CecController").finish_non_exhaustive()
    }
}

impl<'a, A: CecAdapter + ?Sized> CecController<'a, A> {
    pub fn new(adapter: &'a A) -> Self {
        Self { adapter }
    }

    /// The logical address to send from, claiming a playback address when
    /// the adapter has none and userspace may configure one.
    fn ensure_logical_address(&self) -> Result<u8, CecError> {
        let info = self.adapter.info().map_err(|e| CecError::from_io(&e))?;
        if !info.can_transmit {
            return Err(CecError::TransmitUnsupported);
        }
        if let Some(address) = self.adapter.logical_address().map_err(|e| CecError::from_io(&e))? {
            return Ok(address);
        }
        if !info.configurable_log_addrs {
            return Err(CecError::NoLogicalAddress);
        }
        self.adapter.claim_playback().map_err(|e| CecError::from_io(&e))?.ok_or(CecError::NoLogicalAddress)
    }

    fn connected_address(&self) -> Result<u16, CecError> {
        let physical = self.adapter.physical_address().map_err(|e| CecError::from_io(&e))?;
        if physical == PHYS_ADDR_INVALID {
            return Err(CecError::DisplayDisconnected);
        }
        Ok(physical)
    }

    fn send_to_tv(&self, from: u8, payload: &[u8], reply: Option<u8>) -> Result<Option<Vec<u8>>, CecError> {
        match self.adapter.transmit(from, LOG_ADDR_TV, payload, reply).map_err(|e| CecError::from_io(&e))? {
            Transmit::Acked { reply, .. } => Ok(reply),
            Transmit::NotAcknowledged => Err(CecError::DisplayNotResponding),
            Transmit::BusError => Err(CecError::BusError),
        }
    }

    fn query_power(&self, from: u8) -> Result<Option<PowerStatus>, CecError> {
        let reply = self.send_to_tv(from, &[MSG_GIVE_DEVICE_POWER_STATUS], Some(MSG_REPORT_POWER_STATUS))?;
        Ok(reply.and_then(|bytes| match bytes.as_slice() {
            [header, MSG_REPORT_POWER_STATUS, status, ..] if header >> 4 == LOG_ADDR_TV => {
                PowerStatus::from_operand(*status)
            }
            _ => None,
        }))
    }

    /// Checks the adapter, the connection and the TV, and reads its power
    /// status.
    pub fn probe(&self) -> Result<CecProbe, CecError> {
        let physical_address = self.connected_address()?;
        let logical_address = self.ensure_logical_address()?;
        let power = self.query_power(logical_address)?;
        Ok(CecProbe { physical_address, logical_address, power })
    }

    pub fn power_status(&self) -> Result<Option<PowerStatus>, CecError> {
        self.connected_address()?;
        let from = self.ensure_logical_address()?;
        self.query_power(from)
    }

    /// Asks the TV to turn on (`on`) or go to standby, then reads back its
    /// power status until it reports the requested state or the readback
    /// schedule ends.
    pub fn set_power(&self, on: bool, readback: &Readback) -> Result<PowerOutcome, CecError> {
        self.connected_address()?;
        let from = self.ensure_logical_address()?;
        self.send_to_tv(from, &[if on { MSG_IMAGE_VIEW_ON } else { MSG_STANDBY }], None)?;
        let wanted = if on { PowerStatus::On } else { PowerStatus::Standby };
        let mut observed = None;
        for delay in &readback.delays {
            std::thread::sleep(*delay);
            // A TV that stops answering while it changes state is not an
            // error: the request was acknowledged.
            match self.query_power(from) {
                Ok(Some(status)) => {
                    observed = Some(status);
                    if status == wanted {
                        break;
                    }
                }
                Ok(None) => {}
                Err(CecError::DisplayNotResponding) => {}
                Err(error) => return Err(error),
            }
        }
        Ok(PowerOutcome { observed })
    }

    /// Makes `physical_address` the active source (the TV input that shows
    /// it). CEC offers no readback of the selected input.
    pub fn set_active_source(&self, physical_address: u16) -> Result<(), CecError> {
        self.connected_address()?;
        let from = self.ensure_logical_address()?;
        let payload = [MSG_ACTIVE_SOURCE, (physical_address >> 8) as u8, physical_address as u8];
        match self.adapter.transmit(from, LOG_ADDR_BROADCAST, &payload, None).map_err(|e| CecError::from_io(&e))? {
            // A broadcast is never acknowledged by one follower; the
            // framework reports it sent.
            Transmit::Acked { .. } | Transmit::NotAcknowledged => Ok(()),
            Transmit::BusError => Err(CecError::BusError),
        }
    }
}

/// Parses a CEC physical address such as `1.0.0.0`. Four hexadecimal
/// nibbles; the invalid address `f.f.f.f` is refused.
pub fn parse_physical_address(text: &str) -> Option<u16> {
    let parts: Vec<&str> = text.split('.').collect();
    if parts.len() != 4 {
        return None;
    }
    let mut value = 0u16;
    for part in parts {
        if part.len() != 1 {
            return None;
        }
        value = (value << 4) | u16::from_str_radix(part, 16).ok()?;
    }
    (value != PHYS_ADDR_INVALID).then_some(value)
}

pub fn format_physical_address(value: u16) -> String {
    format!("{:x}.{:x}.{:x}.{:x}", value >> 12, (value >> 8) & 0xf, (value >> 4) & 0xf, value & 0xf)
}

#[cfg(test)]
pub(crate) mod fake {
    use std::cell::RefCell;
    use std::collections::VecDeque;

    use super::*;

    /// A scripted adapter and TV. Power status answers come from `power`,
    /// which the TV changes when it receives Image View On or Standby after
    /// `wake_steps` further queries.
    #[derive(Debug)]
    pub struct FakeTv {
        pub info: AdapterInfo,
        pub physical: u16,
        pub claimed: RefCell<Option<u8>>,
        pub claimable: bool,
        pub tv_present: bool,
        pub answers_power: bool,
        pub power: RefCell<PowerStatus>,
        pub pending: RefCell<VecDeque<PowerStatus>>,
        pub sent: RefCell<Vec<(u8, u8, Vec<u8>)>>,
        pub fail_io: Option<i32>,
    }

    impl Default for FakeTv {
        fn default() -> Self {
            Self {
                info: AdapterInfo { can_transmit: true, configurable_log_addrs: true },
                physical: 0x1000,
                claimed: RefCell::new(None),
                claimable: true,
                tv_present: true,
                answers_power: true,
                power: RefCell::new(PowerStatus::Standby),
                pending: RefCell::new(VecDeque::new()),
                sent: RefCell::new(Vec::new()),
                fail_io: None,
            }
        }
    }

    impl CecAdapter for FakeTv {
        fn info(&self) -> std::io::Result<AdapterInfo> {
            match self.fail_io {
                Some(code) => Err(std::io::Error::from_raw_os_error(code)),
                None => Ok(self.info.clone()),
            }
        }
        fn physical_address(&self) -> std::io::Result<u16> {
            Ok(self.physical)
        }
        fn logical_address(&self) -> std::io::Result<Option<u8>> {
            Ok(*self.claimed.borrow())
        }
        fn claim_playback(&self) -> std::io::Result<Option<u8>> {
            let claimed = self.claimable.then_some(4);
            *self.claimed.borrow_mut() = claimed;
            Ok(claimed)
        }
        fn transmit(
            &self,
            initiator: u8,
            destination: u8,
            payload: &[u8],
            reply: Option<u8>,
        ) -> std::io::Result<Transmit> {
            self.sent.borrow_mut().push((initiator, destination, payload.to_vec()));
            if destination == LOG_ADDR_BROADCAST {
                return Ok(Transmit::Acked { reply: None, feature_abort: false });
            }
            if !self.tv_present {
                return Ok(Transmit::NotAcknowledged);
            }
            match payload.first() {
                Some(&MSG_IMAGE_VIEW_ON) => {
                    self.pending.borrow_mut().extend([PowerStatus::TransitioningToOn, PowerStatus::On]);
                }
                Some(&MSG_STANDBY) => {
                    self.pending.borrow_mut().extend([PowerStatus::Standby]);
                }
                Some(&MSG_GIVE_DEVICE_POWER_STATUS) => {
                    if let Some(next) = self.pending.borrow_mut().pop_front() {
                        *self.power.borrow_mut() = next;
                    }
                    if !self.answers_power || reply.is_none() {
                        return Ok(Transmit::Acked { reply: None, feature_abort: !self.answers_power });
                    }
                    let status = match *self.power.borrow() {
                        PowerStatus::On => 0,
                        PowerStatus::Standby => 1,
                        PowerStatus::TransitioningToOn => 2,
                        PowerStatus::TransitioningToStandby => 3,
                    };
                    return Ok(Transmit::Acked {
                        reply: Some(vec![(LOG_ADDR_TV << 4) | initiator, MSG_REPORT_POWER_STATUS, status]),
                        feature_abort: false,
                    });
                }
                _ => {}
            }
            Ok(Transmit::Acked { reply: None, feature_abort: false })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeTv;
    use super::*;

    fn instant() -> Readback {
        Readback { delays: vec![Duration::ZERO; 3] }
    }

    #[test]
    fn a_probe_claims_one_playback_address_and_reads_the_power_status() {
        let tv = FakeTv::default();
        let probe = CecController::new(&tv).probe().expect("probe");
        assert_eq!(probe, CecProbe { physical_address: 0x1000, logical_address: 4, power: Some(PowerStatus::Standby) });
        // The claimed address is reused, never claimed twice.
        CecController::new(&tv).probe().expect("again");
        assert_eq!(tv.sent.borrow().iter().filter(|(from, _, _)| *from == 4).count(), 2);
    }

    #[test]
    fn power_on_is_confirmed_only_by_the_tv_reporting_on() {
        let tv = FakeTv::default();
        let outcome = CecController::new(&tv).set_power(true, &instant()).expect("sent");
        assert_eq!(outcome.observed, Some(PowerStatus::On));
        let sent = tv.sent.borrow();
        assert_eq!(sent[0], (4, 0, vec![MSG_IMAGE_VIEW_ON]), "Image View On to the TV");
        assert!(sent[1..].iter().all(|(_, _, payload)| payload == &[MSG_GIVE_DEVICE_POWER_STATUS]));
    }

    #[test]
    fn a_tv_that_is_still_waking_is_not_reported_as_on() {
        let tv = FakeTv::default();
        let outcome =
            CecController::new(&tv).set_power(true, &Readback { delays: vec![Duration::ZERO] }).expect("sent");
        assert_eq!(outcome.observed, Some(PowerStatus::TransitioningToOn));
    }

    #[test]
    fn a_tv_without_power_status_leaves_the_state_unobserved() {
        let tv = FakeTv { answers_power: false, ..FakeTv::default() };
        let outcome = CecController::new(&tv).set_power(false, &instant()).expect("sent");
        assert_eq!(outcome.observed, None, "sent, never confirmed");
    }

    #[test]
    fn absent_tv_disconnected_display_and_unusable_adapters_are_typed() {
        let absent = FakeTv { tv_present: false, ..FakeTv::default() };
        assert_eq!(CecController::new(&absent).set_power(true, &instant()), Err(CecError::DisplayNotResponding));
        let unplugged = FakeTv { physical: PHYS_ADDR_INVALID, ..FakeTv::default() };
        assert_eq!(CecController::new(&unplugged).probe(), Err(CecError::DisplayDisconnected));
        assert!(unplugged.sent.borrow().is_empty(), "nothing is sent without a display");
        let receive_only =
            FakeTv { info: AdapterInfo { can_transmit: false, configurable_log_addrs: true }, ..FakeTv::default() };
        assert_eq!(CecController::new(&receive_only).probe(), Err(CecError::TransmitUnsupported));
        let unclaimable = FakeTv { claimable: false, ..FakeTv::default() };
        assert_eq!(CecController::new(&unclaimable).probe(), Err(CecError::NoLogicalAddress));
        let failing = FakeTv { fail_io: Some(19), ..FakeTv::default() };
        assert_eq!(CecController::new(&failing).probe(), Err(CecError::Device));
    }

    #[test]
    fn active_source_is_a_broadcast_of_the_physical_address() {
        let tv = FakeTv::default();
        CecController::new(&tv).set_active_source(0x2100).expect("sent");
        assert_eq!(tv.sent.borrow()[0], (4, 15, vec![MSG_ACTIVE_SOURCE, 0x21, 0x00]));
    }

    #[test]
    fn physical_addresses_are_four_nibbles() {
        assert_eq!(parse_physical_address("1.0.0.0"), Some(0x1000));
        assert_eq!(parse_physical_address("2.1.a.F"), Some(0x21af));
        for bad in ["f.f.f.f", "1.0.0", "1.0.0.0.0", "10.0.0.0", "hdmi1", "", "1..0.0", "g.0.0.0"] {
            assert_eq!(parse_physical_address(bad), None, "{bad}");
        }
        assert_eq!(format_physical_address(0x21af), "2.1.a.f");
    }
}
