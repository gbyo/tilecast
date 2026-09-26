//! The CEC provider against the real kernel CEC framework: the `vivid`
//! driver's HDMI output adapter as the player, and `cec-follower` (v4l-utils)
//! emulating the TV on vivid's HDMI input adapter. No Tilecast simulator is
//! involved; every message crosses the kernel UAPI.
//!
//! CI (`.github/workflows/ci-edge.yml`) loads vivid, starts cec-follower and
//! runs this test with `TILECAST_CEC_TEST_ADAPTER` set to the playback
//! adapter's number. It is ignored otherwise, and it fails, never skips, when
//! it is run without that adapter.
#![cfg(target_os = "linux")]
#![allow(clippy::unwrap_used)]

use std::time::{Duration, Instant};

use edge_platform::display::{DisplayHardware, PowerStatus, Settings};

fn hardware() -> DisplayHardware {
    let adapter: u8 = std::env::var("TILECAST_CEC_TEST_ADAPTER")
        .expect("TILECAST_CEC_TEST_ADAPTER names the vivid playback adapter (cecN)")
        .parse()
        .expect("an adapter number");
    DisplayHardware {
        settings: Settings { cec_adapter: Some(adapter), ddc_enabled: false, ..Settings::default() },
        ..DisplayHardware::default()
    }
}

/// Polls the TV's own report until it says `wanted`. cec-follower passes
/// through a transition state first, as a real TV does.
fn wait_for_power(hardware: &DisplayHardware, wanted: PowerStatus) -> Vec<Option<PowerStatus>> {
    let deadline = Instant::now() + Duration::from_secs(30);
    let mut seen = Vec::new();
    while Instant::now() < deadline {
        let status = hardware.cec_power_status().expect("the TV answers Give Device Power Status");
        seen.push(status);
        if status == Some(wanted) {
            return seen;
        }
        std::thread::sleep(Duration::from_millis(500));
    }
    panic!("the TV never reported {wanted:?}; reports: {seen:?}");
}

#[test]
#[ignore = "needs the vivid kernel driver and cec-follower (CI)"]
fn the_playback_adapter_turns_the_tv_off_and_on_and_reads_it_back() {
    let hardware = hardware();
    let probe = hardware.probe_cec();
    assert!(probe.feature.is_usable(), "probe: {probe:?}");
    assert!(probe.power.is_some(), "the emulated TV reports its power status: {probe:?}");
    println!(
        "probe: adapter cec{:?}, physical address {:?}, power {:?}",
        probe.adapter, probe.physical_address, probe.power
    );

    let off = hardware.cec_power(false).expect("Standby is acknowledged");
    println!("standby sent; the TV reported {:?}", off.observed);
    let reports = wait_for_power(&hardware, PowerStatus::Standby);
    println!("standby confirmed after {reports:?}");

    let on = hardware.cec_power(true).expect("Image View On is acknowledged");
    println!("image view on sent; the TV reported {:?}", on.observed);
    let reports = wait_for_power(&hardware, PowerStatus::On);
    println!("on confirmed after {reports:?}");
}
