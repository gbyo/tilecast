//! systemd socket activation (`sd_listen_fds(3)`) for `tilecast-edge-update`.
//!
//! This is the second audited `unsafe` module of the workspace
//! (`display/kernel.rs` is the first). It holds one `unsafe` block: taking
//! ownership of descriptor 3, which systemd passes to a socket-activated
//! service. Everything else checks that the descriptor really is that.

#![allow(unsafe_code)]

use std::os::fd::{FromRawFd as _, OwnedFd};
use std::sync::atomic::{AtomicBool, Ordering};

/// `SD_LISTEN_FDS_START`.
const LISTEN_FDS_START: i32 = 3;

static TAKEN: AtomicBool = AtomicBool::new(false);

#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ActivationError {
    #[error("the process was not started by socket activation")]
    NotActivated,
    #[error("socket activation passed {0} descriptors; exactly one is expected")]
    WrongCount(i32),
    #[error("the activation descriptor was already taken")]
    AlreadyTaken,
    #[error("descriptor 3 is not a socket")]
    NotASocket,
}

/// Takes the one listening socket systemd passed to this process.
///
/// Requires `LISTEN_PID` to name this process and `LISTEN_FDS` to be 1, as
/// `sd_listen_fds(3)` does, and may succeed only once per process.
pub fn take_listen_socket() -> Result<OwnedFd, ActivationError> {
    let pid = std::env::var("LISTEN_PID").ok().and_then(|value| value.parse::<i32>().ok());
    if pid != Some(rustix::process::getpid().as_raw_nonzero().get()) {
        return Err(ActivationError::NotActivated);
    }
    let count = std::env::var("LISTEN_FDS").ok().and_then(|value| value.parse::<i32>().ok()).unwrap_or(0);
    if count != 1 {
        return Err(ActivationError::WrongCount(count));
    }
    if TAKEN.swap(true, Ordering::AcqRel) {
        return Err(ActivationError::AlreadyTaken);
    }
    // SAFETY: systemd opened descriptor 3 for this process (LISTEN_PID is our
    // PID and LISTEN_FDS is 1), nothing in this process closes or owns it
    // before this call, and TAKEN makes this the only ownership transfer.
    let fd = unsafe { OwnedFd::from_raw_fd(LISTEN_FDS_START) };
    let stat = rustix::fs::fstat(&fd).map_err(|_| ActivationError::NotASocket)?;
    if rustix::fs::FileType::from_raw_mode(stat.st_mode) != rustix::fs::FileType::Socket {
        // Hand the descriptor back unowned: it is not ours to close.
        std::mem::forget(fd);
        return Err(ActivationError::NotASocket);
    }
    let _ = rustix::io::fcntl_setfd(&fd, rustix::io::FdFlags::CLOEXEC);
    Ok(fd)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_process_without_activation_variables_gets_nothing() {
        // The test runner is not socket-activated.
        assert_eq!(take_listen_socket().unwrap_err(), ActivationError::NotActivated);
    }
}
