//! The Linux kernel interfaces that display control needs, and the only
//! `unsafe` code in the Edge workspace.
//!
//! Two device families, each through its documented uapi:
//!
//! * the CEC framework (`/dev/cecN`, `include/uapi/linux/cec.h`): adapter
//!   capabilities, physical and logical addresses, and `CEC_TRANSMIT`;
//! * i2c-dev (`/dev/i2c-N`, `include/uapi/linux/i2c-dev.h`): `I2C_SLAVE`,
//!   then plain `read(2)` and `write(2)` for DDC/CI.
//!
//! Review rules for this file (docs/tilecast-edge.md §19, and the M9
//! decision recorded in docs/tilecast-edge-next.md):
//!
//! * every `ioctl` uses a fixed opcode built from the uapi `_IOC` components
//!   and a `#[repr(C)]` type whose size is asserted below against the kernel
//!   header;
//! * device paths are built here from a validated adapter number only, never
//!   from a string that came from sysfs, the server or IPC;
//! * a device is opened without following a final symbolic link, and the
//!   open file must be a character device;
//! * nothing here decides policy. [`super::cec`] and [`super::ddc`] do, on top
//!   of the small traits they define.
#![allow(unsafe_code)]

use std::fs::File;
use std::os::fd::AsFd;
use std::os::unix::fs::{FileTypeExt as _, OpenOptionsExt as _};
use std::path::{Path, PathBuf};

use rustix::fs::OFlags;
use rustix::ioctl::{Getter, IntegerSetter, Updater, ioctl, opcode};

pub const CEC_MAX_MSG_SIZE: usize = 16;
pub const CEC_MAX_LOG_ADDRS: usize = 4;

/// `struct cec_caps`.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CecCaps {
    pub driver: [u8; 32],
    pub name: [u8; 32],
    pub available_log_addrs: u32,
    pub capabilities: u32,
    pub version: u32,
}

/// `struct cec_log_addrs`.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CecLogAddrs {
    pub log_addr: [u8; CEC_MAX_LOG_ADDRS],
    pub log_addr_mask: u16,
    pub cec_version: u8,
    pub num_log_addrs: u8,
    pub vendor_id: u32,
    pub flags: u32,
    pub osd_name: [u8; 15],
    pub primary_device_type: [u8; CEC_MAX_LOG_ADDRS],
    pub log_addr_type: [u8; CEC_MAX_LOG_ADDRS],
    pub all_device_types: [u8; CEC_MAX_LOG_ADDRS],
    pub features: [[u8; 12]; CEC_MAX_LOG_ADDRS],
}

impl CecLogAddrs {
    pub fn empty() -> Self {
        Self {
            log_addr: [0; CEC_MAX_LOG_ADDRS],
            log_addr_mask: 0,
            cec_version: 0,
            num_log_addrs: 0,
            vendor_id: 0,
            flags: 0,
            osd_name: [0; 15],
            primary_device_type: [0; CEC_MAX_LOG_ADDRS],
            log_addr_type: [0; CEC_MAX_LOG_ADDRS],
            all_device_types: [0; CEC_MAX_LOG_ADDRS],
            features: [[0; 12]; CEC_MAX_LOG_ADDRS],
        }
    }
}

/// `struct cec_msg`.
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct CecMsg {
    pub tx_ts: u64,
    pub rx_ts: u64,
    pub len: u32,
    pub timeout: u32,
    pub sequence: u32,
    pub flags: u32,
    pub msg: [u8; CEC_MAX_MSG_SIZE],
    pub reply: u8,
    pub rx_status: u8,
    pub tx_status: u8,
    pub tx_arb_lost_cnt: u8,
    pub tx_nack_cnt: u8,
    pub tx_low_drive_cnt: u8,
    pub tx_error_cnt: u8,
}

impl CecMsg {
    /// A message from `initiator` to `destination` with `payload` after the
    /// header byte. Returns `None` when the payload does not fit.
    pub fn new(initiator: u8, destination: u8, payload: &[u8]) -> Option<Self> {
        if initiator > 15 || destination > 15 || payload.len() + 1 > CEC_MAX_MSG_SIZE {
            return None;
        }
        let mut msg = [0u8; CEC_MAX_MSG_SIZE];
        msg[0] = (initiator << 4) | destination;
        msg[1..=payload.len()].copy_from_slice(payload);
        Some(Self {
            tx_ts: 0,
            rx_ts: 0,
            len: (payload.len() + 1) as u32,
            timeout: 0,
            sequence: 0,
            flags: 0,
            msg,
            reply: 0,
            rx_status: 0,
            tx_status: 0,
            tx_arb_lost_cnt: 0,
            tx_nack_cnt: 0,
            tx_low_drive_cnt: 0,
            tx_error_cnt: 0,
        })
    }

    /// The received bytes, bounded by the message length.
    pub fn bytes(&self) -> &[u8] {
        &self.msg[..(self.len as usize).min(CEC_MAX_MSG_SIZE)]
    }
}

// Opcodes: include/uapi/linux/cec.h and i2c-dev.h.
const CEC_ADAP_G_CAPS: rustix::ioctl::Opcode = opcode::read_write::<CecCaps>(b'a', 0);
const CEC_ADAP_G_PHYS_ADDR: rustix::ioctl::Opcode = opcode::read::<u16>(b'a', 1);
const CEC_ADAP_G_LOG_ADDRS: rustix::ioctl::Opcode = opcode::read::<CecLogAddrs>(b'a', 3);
const CEC_ADAP_S_LOG_ADDRS: rustix::ioctl::Opcode = opcode::read_write::<CecLogAddrs>(b'a', 4);
const CEC_TRANSMIT: rustix::ioctl::Opcode = opcode::read_write::<CecMsg>(b'a', 5);
/// `I2C_SLAVE`: a plain number, not an `_IOC` value.
const I2C_SLAVE: rustix::ioctl::Opcode = 0x0703;

/// Opens a character device read-write, without following a final link and
/// without becoming its controlling terminal.
fn open_char_device(path: &Path) -> std::io::Result<File> {
    let flags = OFlags::NOFOLLOW | OFlags::NOCTTY | OFlags::CLOEXEC;
    let file = std::fs::OpenOptions::new().read(true).write(true).custom_flags(flags.bits() as i32).open(path)?;
    if !file.metadata()?.file_type().is_char_device() {
        return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "not a character device"));
    }
    Ok(file)
}

/// `/dev/cec<n>` or `/dev/i2c-<n>` under `dev_dir`, from a number only.
pub fn cec_node(dev_dir: &Path, adapter: u8) -> PathBuf {
    dev_dir.join(format!("cec{adapter}"))
}

pub fn i2c_node(dev_dir: &Path, bus: u16) -> PathBuf {
    dev_dir.join(format!("i2c-{bus}"))
}

/// An open CEC adapter.
#[derive(Debug)]
pub struct CecDevice {
    file: File,
}

impl CecDevice {
    pub fn open(dev_dir: &Path, adapter: u8) -> std::io::Result<Self> {
        Ok(Self { file: open_char_device(&cec_node(dev_dir, adapter))? })
    }

    pub fn caps(&self) -> std::io::Result<CecCaps> {
        // SAFETY: CEC_ADAP_G_CAPS is `_IOWR('a', 0, struct cec_caps)` and
        // `CecCaps` is `struct cec_caps` (size asserted in the tests). The
        // kernel only writes this structure.
        let getter = unsafe { Getter::<CEC_ADAP_G_CAPS, CecCaps>::new() };
        // SAFETY: the opcode/type pairing above; `self.file` is an open CEC
        // device.
        Ok(unsafe { ioctl(self.file.as_fd(), getter) }?)
    }

    pub fn phys_addr(&self) -> std::io::Result<u16> {
        // SAFETY: `_IOR('a', 1, __u16)` with a `u16` output.
        let getter = unsafe { Getter::<CEC_ADAP_G_PHYS_ADDR, u16>::new() };
        // SAFETY: as above.
        Ok(unsafe { ioctl(self.file.as_fd(), getter) }?)
    }

    pub fn log_addrs(&self) -> std::io::Result<CecLogAddrs> {
        // SAFETY: `_IOR('a', 3, struct cec_log_addrs)` with `CecLogAddrs`.
        let getter = unsafe { Getter::<CEC_ADAP_G_LOG_ADDRS, CecLogAddrs>::new() };
        // SAFETY: as above.
        Ok(unsafe { ioctl(self.file.as_fd(), getter) }?)
    }

    /// Claims logical addresses. The kernel updates `addrs` with the result.
    pub fn set_log_addrs(&self, addrs: &mut CecLogAddrs) -> std::io::Result<()> {
        // SAFETY: `_IOWR('a', 4, struct cec_log_addrs)`; the kernel reads and
        // writes exactly one `CecLogAddrs` through the exclusive reference.
        let updater = unsafe { Updater::<CEC_ADAP_S_LOG_ADDRS, CecLogAddrs>::new(addrs) };
        // SAFETY: as above.
        unsafe { ioctl(self.file.as_fd(), updater) }?;
        Ok(())
    }

    /// Transmits `msg`, waiting for its reply when `msg.reply` is set (the
    /// framework waits at most one second for a reply).
    pub fn transmit(&self, msg: &mut CecMsg) -> std::io::Result<()> {
        // SAFETY: `_IOWR('a', 5, struct cec_msg)`; one `CecMsg` in and out.
        let updater = unsafe { Updater::<CEC_TRANSMIT, CecMsg>::new(msg) };
        // SAFETY: as above.
        unsafe { ioctl(self.file.as_fd(), updater) }?;
        Ok(())
    }
}

/// An open i2c-dev bus bound to one slave address.
#[derive(Debug)]
pub struct I2cDevice {
    file: File,
}

impl I2cDevice {
    pub fn open(dev_dir: &Path, bus: u16, address: u8) -> std::io::Result<Self> {
        if address > 0x7f {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "7-bit I2C address"));
        }
        let file = open_char_device(&i2c_node(dev_dir, bus))?;
        // SAFETY: I2C_SLAVE takes an integer argument, the 7-bit address
        // checked above.
        let setter = unsafe { IntegerSetter::<I2C_SLAVE>::new_usize(usize::from(address)) };
        // SAFETY: as above; `file` is an open i2c-dev node.
        unsafe { ioctl(file.as_fd(), setter) }?;
        Ok(Self { file })
    }

    pub fn write(&self, bytes: &[u8]) -> std::io::Result<()> {
        let written = rustix::io::write(&self.file, bytes)?;
        if written != bytes.len() {
            return Err(std::io::Error::new(std::io::ErrorKind::WriteZero, "short I2C write"));
        }
        Ok(())
    }

    pub fn read(&self, buffer: &mut [u8]) -> std::io::Result<usize> {
        Ok(rustix::io::read(&self.file, buffer)?)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn structures_match_the_kernel_header() {
        assert_eq!(std::mem::size_of::<CecCaps>(), 76);
        assert_eq!(std::mem::size_of::<CecLogAddrs>(), 92);
        assert_eq!(std::mem::size_of::<CecMsg>(), 56);
        assert_eq!(std::mem::offset_of!(CecLogAddrs, vendor_id), 8);
        assert_eq!(std::mem::offset_of!(CecLogAddrs, osd_name), 16);
        assert_eq!(std::mem::offset_of!(CecLogAddrs, features), 43);
        assert_eq!(std::mem::offset_of!(CecMsg, msg), 32);
        assert_eq!(std::mem::offset_of!(CecMsg, reply), 48);
        assert_eq!(std::mem::offset_of!(CecMsg, tx_status), 50);
    }

    /// The values `_IOC` produces on the Edge targets (x86-64 and arm64).
    #[cfg(all(target_os = "linux", any(target_arch = "x86_64", target_arch = "aarch64")))]
    #[test]
    fn opcodes_match_the_kernel_header() {
        assert_eq!(CEC_ADAP_G_CAPS as u64, 0xC04C_6100);
        assert_eq!(CEC_ADAP_G_PHYS_ADDR as u64, 0x8002_6101);
        assert_eq!(CEC_ADAP_G_LOG_ADDRS as u64, 0x805C_6103);
        assert_eq!(CEC_ADAP_S_LOG_ADDRS as u64, 0xC05C_6104);
        assert_eq!(CEC_TRANSMIT as u64, 0xC038_6105);
    }

    #[test]
    fn messages_are_bounded() {
        let msg = CecMsg::new(4, 0, &[0x04]).expect("fits");
        assert_eq!(msg.bytes(), &[0x40, 0x04]);
        assert!(CecMsg::new(4, 0, &[0; 16]).is_none(), "header plus 16 bytes does not fit");
        assert!(CecMsg::new(16, 0, &[]).is_none());
    }

    #[test]
    fn only_character_devices_open() {
        let dir = tempfile::tempdir().expect("tempdir");
        std::fs::write(dir.path().join("cec0"), b"").expect("write");
        let error = CecDevice::open(dir.path(), 0).expect_err("a regular file is not a CEC adapter");
        assert_eq!(error.kind(), std::io::ErrorKind::InvalidInput);
        std::os::unix::fs::symlink("/dev/null", dir.path().join("cec1")).expect("symlink");
        assert!(CecDevice::open(dir.path(), 1).is_err(), "a final symbolic link is never followed");
        assert_eq!(
            CecDevice::open(dir.path(), 2).expect_err("missing").kind(),
            std::io::ErrorKind::NotFound,
            "a missing node is reported as missing"
        );
        assert_eq!(cec_node(Path::new("/dev"), 3), Path::new("/dev/cec3"));
        assert_eq!(i2c_node(Path::new("/dev"), 12), Path::new("/dev/i2c-12"));
    }
}
