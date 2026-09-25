//! DDC/CI (VESA MCCS) over i2c-dev, for brightness, volume and mute.
//!
//! The display answers at I²C address 0x37. A request is
//! `0x51, 0x80 | length, payload…, checksum`, where the checksum XORs the
//! display's write address 0x6E with every byte. A Get VCP reply is 11 bytes:
//! `0x6E, 0x88, 0x02, result, code, type, max hi, max lo, value hi,
//! value lo, checksum`, with the checksum seeded by the host's virtual
//! address 0x50. A display that is busy answers with a null message
//! (`0x6E, 0x80, …`).
//!
//! Every Set VCP is followed by a Get VCP of the same code: the value the
//! display reports afterwards, not the write, is what may be called
//! confirmed.

use std::time::Duration;

use super::kernel::I2cDevice;

pub const DDC_ADDRESS: u8 = 0x37;
const HOST_ADDRESS: u8 = 0x51;
const DISPLAY_WRITE_ADDRESS: u8 = 0x6e;
const REPLY_CHECKSUM_SEED: u8 = 0x50;
const GET_VCP: u8 = 0x01;
const GET_VCP_REPLY: u8 = 0x02;
const SET_VCP: u8 = 0x03;
const GET_VCP_REPLY_LEN: usize = 11;

/// MCCS feature codes Tilecast uses.
pub const VCP_BRIGHTNESS: u8 = 0x10;
pub const VCP_AUDIO_VOLUME: u8 = 0x62;
pub const VCP_AUDIO_MUTE: u8 = 0x8d;
/// Values of `VCP_AUDIO_MUTE`.
pub const MUTE_ON: u16 = 1;
pub const MUTE_OFF: u16 = 2;

/// The bus surface DDC/CI needs, implemented by i2c-dev and by test fakes.
pub trait I2cBus {
    fn write(&self, bytes: &[u8]) -> std::io::Result<()>;
    fn read(&self, buffer: &mut [u8]) -> std::io::Result<usize>;
}

impl I2cBus for I2cDevice {
    fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        I2cDevice::write(self, bytes)
    }
    fn read(&self, buffer: &mut [u8]) -> std::io::Result<usize> {
        I2cDevice::read(self, buffer)
    }
}

/// DDC/CI timing (MCCS 2.2a): wait after a Get VCP request before reading
/// the reply, and after any write before the next request.
#[derive(Debug, Clone)]
pub struct Timing {
    pub reply_delay: Duration,
    pub write_delay: Duration,
    pub attempts: u32,
}

impl Default for Timing {
    fn default() -> Self {
        Self { reply_delay: Duration::from_millis(40), write_delay: Duration::from_millis(50), attempts: 3 }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum DdcError {
    /// No device acknowledged address 0x37: the monitor has no DDC/CI or it
    /// is turned off in the monitor's menu.
    #[error("the display does not answer DDC/CI")]
    NotResponding,
    /// The display answered that it does not implement this feature.
    #[error("the display does not support this DDC/CI feature")]
    Unsupported,
    /// Replies arrived but were never valid (checksum, length or opcode).
    #[error("the display's DDC/CI replies are invalid")]
    BadReply,
    #[error("the I2C bus failed")]
    Bus,
}

impl DdcError {
    pub fn reason_code(&self) -> &'static str {
        match self {
            Self::NotResponding => "ddc_ci_not_responding",
            Self::Unsupported => "vcp_feature_unsupported",
            Self::BadReply => "ddc_ci_invalid_reply",
            Self::Bus => "i2c_bus_error",
        }
    }

    fn from_io(error: &std::io::Error) -> Self {
        // ENXIO and EREMOTEIO are a NACK on the address; EIO is what several
        // drivers return for the same thing.
        let Some(code) = error.raw_os_error() else { return Self::Bus };
        #[cfg(target_os = "linux")]
        if code == rustix::io::Errno::REMOTEIO.raw_os_error() {
            return Self::NotResponding;
        }
        if code == rustix::io::Errno::NXIO.raw_os_error() || code == rustix::io::Errno::IO.raw_os_error() {
            Self::NotResponding
        } else {
            Self::Bus
        }
    }
}

/// A feature's current and maximum value.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct VcpValue {
    pub current: u16,
    pub maximum: u16,
}

fn checksum(seed: u8, bytes: &[u8]) -> u8 {
    bytes.iter().fold(seed, |acc, byte| acc ^ byte)
}

fn request(payload: &[u8]) -> Vec<u8> {
    let mut packet = Vec::with_capacity(payload.len() + 3);
    packet.push(HOST_ADDRESS);
    packet.push(0x80 | payload.len() as u8);
    packet.extend_from_slice(payload);
    packet.push(checksum(DISPLAY_WRITE_ADDRESS, &packet));
    packet
}

/// A Get VCP reply, or why it is not one.
enum Reply {
    Value { code: u8, unsupported: bool, value: VcpValue },
    Null,
    Invalid,
}

fn parse_reply(bytes: &[u8]) -> Reply {
    if bytes.len() < 3 || bytes[0] != DISPLAY_WRITE_ADDRESS || bytes[1] & 0x80 == 0 {
        return Reply::Invalid;
    }
    let length = usize::from(bytes[1] & 0x7f);
    if length == 0 {
        return Reply::Null;
    }
    if length != 8 || bytes.len() < GET_VCP_REPLY_LEN {
        return Reply::Invalid;
    }
    if checksum(REPLY_CHECKSUM_SEED, &bytes[..10]) != bytes[10] || bytes[2] != GET_VCP_REPLY {
        return Reply::Invalid;
    }
    Reply::Value {
        code: bytes[4],
        unsupported: bytes[3] != 0,
        value: VcpValue {
            maximum: u16::from_be_bytes([bytes[6], bytes[7]]),
            current: u16::from_be_bytes([bytes[8], bytes[9]]),
        },
    }
}

pub struct DdcController<'a, B: I2cBus + ?Sized> {
    bus: &'a B,
    timing: Timing,
}

impl<B: I2cBus + ?Sized> std::fmt::Debug for DdcController<'_, B> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("DdcController").finish_non_exhaustive()
    }
}

impl<'a, B: I2cBus + ?Sized> DdcController<'a, B> {
    pub fn new(bus: &'a B, timing: Timing) -> Self {
        Self { bus, timing }
    }

    pub fn get(&self, code: u8) -> Result<VcpValue, DdcError> {
        let packet = request(&[GET_VCP, code]);
        let mut last = DdcError::BadReply;
        for _ in 0..self.timing.attempts.max(1) {
            if let Err(error) = self.bus.write(&packet) {
                last = DdcError::from_io(&error);
                std::thread::sleep(self.timing.write_delay);
                continue;
            }
            std::thread::sleep(self.timing.reply_delay);
            let mut buffer = [0u8; GET_VCP_REPLY_LEN];
            match self.bus.read(&mut buffer) {
                Ok(count) => match parse_reply(&buffer[..count]) {
                    Reply::Value { code: answered, unsupported, value } if answered == code => {
                        return if unsupported { Err(DdcError::Unsupported) } else { Ok(value) };
                    }
                    Reply::Value { .. } | Reply::Invalid => last = DdcError::BadReply,
                    // Busy: ask again after the write delay.
                    Reply::Null => last = DdcError::BadReply,
                },
                Err(error) => last = DdcError::from_io(&error),
            }
            std::thread::sleep(self.timing.write_delay);
        }
        Err(last)
    }

    /// Writes `value` and reads the feature back. Returns what the display
    /// reports afterwards; the caller compares it with what it asked for.
    pub fn set(&self, code: u8, value: u16) -> Result<VcpValue, DdcError> {
        let [high, low] = value.to_be_bytes();
        let packet = request(&[SET_VCP, code, high, low]);
        let mut written = Err(DdcError::NotResponding);
        for _ in 0..self.timing.attempts.max(1) {
            written = self.bus.write(&packet).map_err(|e| DdcError::from_io(&e));
            std::thread::sleep(self.timing.write_delay);
            if written.is_ok() {
                break;
            }
        }
        written?;
        self.get(code)
    }
}

/// Maps Tilecast's 0–100 scale onto a feature's own maximum, and back.
pub fn scale_to_display(percent: u8, maximum: u16) -> u16 {
    let percent = u32::from(percent.min(100));
    ((percent * u32::from(maximum) + 50) / 100) as u16
}

pub fn scale_from_display(value: u16, maximum: u16) -> u8 {
    if maximum == 0 {
        return 0;
    }
    ((u32::from(value.min(maximum)) * 100 + u32::from(maximum) / 2) / u32::from(maximum)) as u8
}

#[cfg(test)]
pub(crate) mod fake {
    use std::cell::RefCell;
    use std::collections::BTreeMap;

    use super::*;

    /// A monitor's DDC/CI responder: it checks request checksums as a real
    /// display does and answers Get VCP with the stored value.
    #[derive(Debug, Default)]
    pub struct FakeMonitor {
        pub features: RefCell<BTreeMap<u8, VcpValue>>,
        pub absent: bool,
        /// Values the display clamps to on write, as some panels do.
        pub clamp: Option<u16>,
        /// Answer this many requests with a null message first.
        pub busy: RefCell<u32>,
        /// Corrupt every reply's checksum.
        pub corrupt: bool,
        pub pending: RefCell<Option<Vec<u8>>>,
        pub writes: RefCell<Vec<Vec<u8>>>,
    }

    impl FakeMonitor {
        pub fn with(features: &[(u8, u16, u16)]) -> Self {
            let monitor = Self::default();
            for (code, current, maximum) in features {
                monitor.features.borrow_mut().insert(*code, VcpValue { current: *current, maximum: *maximum });
            }
            monitor
        }
    }

    impl I2cBus for FakeMonitor {
        fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
            if self.absent {
                return Err(std::io::Error::from_raw_os_error(rustix::io::Errno::NXIO.raw_os_error()));
            }
            self.writes.borrow_mut().push(bytes.to_vec());
            let valid = bytes.len() >= 3
                && bytes[0] == HOST_ADDRESS
                && checksum(DISPLAY_WRITE_ADDRESS, &bytes[..bytes.len() - 1]) == bytes[bytes.len() - 1];
            if !valid {
                *self.pending.borrow_mut() = None;
                return Ok(());
            }
            match &bytes[2..bytes.len() - 1] {
                [GET_VCP, code] => {
                    let feature = self.features.borrow().get(code).copied();
                    let (result, value) = match feature {
                        Some(value) => (0, value),
                        None => (1, VcpValue { current: 0, maximum: 0 }),
                    };
                    let mut reply = vec![DISPLAY_WRITE_ADDRESS, 0x88, GET_VCP_REPLY, result, *code, 0];
                    reply.extend(value.maximum.to_be_bytes());
                    reply.extend(value.current.to_be_bytes());
                    let mut sum = checksum(REPLY_CHECKSUM_SEED, &reply);
                    if self.corrupt {
                        sum ^= 0xff;
                    }
                    reply.push(sum);
                    *self.pending.borrow_mut() = Some(reply);
                }
                [SET_VCP, code, high, low] => {
                    let mut value = u16::from_be_bytes([*high, *low]);
                    if let Some(limit) = self.clamp {
                        value = value.min(limit);
                    }
                    if let Some(feature) = self.features.borrow_mut().get_mut(code) {
                        feature.current = value;
                    }
                    *self.pending.borrow_mut() = None;
                }
                _ => *self.pending.borrow_mut() = None,
            }
            Ok(())
        }

        fn read(&self, buffer: &mut [u8]) -> std::io::Result<usize> {
            if self.absent {
                return Err(std::io::Error::from_raw_os_error(rustix::io::Errno::NXIO.raw_os_error()));
            }
            let mut busy = self.busy.borrow_mut();
            let reply = if *busy > 0 {
                *busy -= 1;
                vec![DISPLAY_WRITE_ADDRESS, 0x80, checksum(REPLY_CHECKSUM_SEED, &[DISPLAY_WRITE_ADDRESS, 0x80])]
            } else {
                self.pending.borrow_mut().take().unwrap_or_else(|| vec![0xff; GET_VCP_REPLY_LEN])
            };
            let count = reply.len().min(buffer.len());
            buffer[..count].copy_from_slice(&reply[..count]);
            Ok(count)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::fake::FakeMonitor;
    use super::*;

    fn instant() -> Timing {
        Timing { reply_delay: Duration::ZERO, write_delay: Duration::ZERO, attempts: 3 }
    }

    #[test]
    fn requests_carry_the_mccs_checksum() {
        // Get VCP brightness, as every DDC/CI reference shows it.
        assert_eq!(request(&[GET_VCP, VCP_BRIGHTNESS]), vec![0x51, 0x82, 0x01, 0x10, 0xac]);
    }

    #[test]
    fn set_is_read_back_and_scaled_to_the_feature_maximum() {
        let monitor = FakeMonitor::with(&[(VCP_BRIGHTNESS, 30, 100), (VCP_AUDIO_VOLUME, 10, 50)]);
        let ddc = DdcController::new(&monitor, instant());
        assert_eq!(ddc.get(VCP_BRIGHTNESS), Ok(VcpValue { current: 30, maximum: 100 }));
        let volume = ddc.get(VCP_AUDIO_VOLUME).expect("volume");
        let target = scale_to_display(60, volume.maximum);
        assert_eq!(target, 30);
        assert_eq!(ddc.set(VCP_AUDIO_VOLUME, target), Ok(VcpValue { current: 30, maximum: 50 }));
        assert_eq!(scale_from_display(30, 50), 60);
    }

    #[test]
    fn a_clamping_display_reports_what_it_really_set() {
        let monitor = FakeMonitor { clamp: Some(80), ..FakeMonitor::with(&[(VCP_BRIGHTNESS, 30, 100)]) };
        let read_back = DdcController::new(&monitor, instant()).set(VCP_BRIGHTNESS, 100).expect("written");
        assert_eq!(read_back.current, 80, "the readback, not the request, is the result");
    }

    #[test]
    fn unsupported_features_absent_displays_and_bad_replies_are_typed() {
        let monitor = FakeMonitor::with(&[(VCP_BRIGHTNESS, 30, 100)]);
        let ddc = DdcController::new(&monitor, instant());
        assert_eq!(ddc.get(VCP_AUDIO_MUTE), Err(DdcError::Unsupported));
        let absent = FakeMonitor { absent: true, ..FakeMonitor::default() };
        assert_eq!(DdcController::new(&absent, instant()).get(VCP_BRIGHTNESS), Err(DdcError::NotResponding));
        let corrupt = FakeMonitor { corrupt: true, ..FakeMonitor::with(&[(VCP_BRIGHTNESS, 30, 100)]) };
        assert_eq!(DdcController::new(&corrupt, instant()).get(VCP_BRIGHTNESS), Err(DdcError::BadReply));
    }

    #[test]
    fn a_busy_display_is_asked_again() {
        let monitor = FakeMonitor::with(&[(VCP_BRIGHTNESS, 42, 100)]);
        *monitor.busy.borrow_mut() = 2;
        assert_eq!(DdcController::new(&monitor, instant()).get(VCP_BRIGHTNESS).map(|v| v.current), Ok(42));
        *monitor.busy.borrow_mut() = 5;
        assert_eq!(DdcController::new(&monitor, instant()).get(VCP_BRIGHTNESS), Err(DdcError::BadReply));
    }

    #[test]
    fn scaling_is_bounded() {
        assert_eq!(scale_to_display(100, 100), 100);
        assert_eq!(scale_to_display(0, 255), 0);
        assert_eq!(scale_to_display(50, 255), 128);
        assert_eq!(scale_from_display(128, 255), 50);
        assert_eq!(scale_from_display(10, 0), 0);
        assert_eq!(scale_from_display(300, 255), 100);
    }
}
