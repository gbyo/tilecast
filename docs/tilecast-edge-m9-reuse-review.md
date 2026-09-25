# Tilecast Edge M9: reuse review

**Date:** 2026-09-25
**Scope:** M9 hardware parity (`docs/tilecast-edge.md` §18.1). This record compares each M9 subsystem with the mature Linux facility that can do the same work. It states what Tilecast keeps, what Tilecast replaces, and why.

The rule for M9: Tilecast writes only the adapter between a system facility and the Tilecast contract. Tilecast does not own protocol behavior, device quirks or session policy that a maintained system component already owns.

## 1. Summary

| Area                 | Decision                                                                                                                                                                             | Tilecast code                                                       |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------- |
| HDMI-CEC             | Keep the kernel CEC provider (`/dev/cecN`, CEC UAPI). Use v4l-utils (`cec-follower`, `cec-ctl`, `cec-compliance`) as the test endpoint and the reference.                            | `edge-platform::display::{kernel,cec}` (about 840 lines with tests) |
| DDC/CI               | Keep the narrow provider. Do not link libddcutil into `tilecastd` (§3). Adopt the ddcutil timing, retry, null-reply and udev behavior. Use `ddcutil` as the qualification reference. | `edge-platform::display::ddc` (about 400 lines with tests)          |
| Noise Meter capture  | `tilecast-session-bridge` runs `pipewiresrc ! audioconvert ! level`. The GStreamer `level` element computes RMS. Tilecast has no DSP code.                                           | Bridge message handling only                                        |
| Audio inventory      | libwireplumber in the bridge: nodes, default source and default sink, node state. No `wpctl` output parsing. No GstDeviceMonitor.                                                    | A WirePlumber object manager and a count                            |
| Presentation Network | Reuse the root helper `tilecast-networkd` and its socket protocol without changes. Edge adds a typed client only.                                                                    | Client, parser and reconciliation (about 500 lines)                 |
| Display sleep        | A systemd-logind `idle` inhibitor lock over D-Bus.                                                                                                                                   | About 120 lines                                                     |
| Device access        | udev rules, a sysusers group, `modules-load.d`, systemd `DevicePolicy=closed`.                                                                                                       | Packaging files                                                     |
| M10 updates          | Prototype `systemd-sysupdate` before any custom updater code.                                                                                                                        | None in M9                                                          |

## 2. HDMI-CEC

The kernel CEC framework is the Linux interface for HDMI-CEC. The provider uses the official UAPI (`linux/cec.h`) through `rustix` ioctls. The kernel owns logical address allocation, message retransmission and the follower messages that the CEC core answers.

libCEC is not added. libCEC is useful for USB CEC adapters (Pulse-Eight) that do not register a kernel CEC device. M11 physical testing can show a need for such an adapter. Only then add libCEC as a separate optional provider.

v4l-utils supplies the test endpoint and the reference:

- `cec-follower` emulates the TV on the `vivid` virtual HDMI adapter. The CI test runs the Tilecast provider against the real kernel UAPI and this follower. Tilecast has no CEC simulator of its own.
- `cec-ctl` sends the same messages as a reference. The CI test compares the power state that `cec-ctl` reads with the power state that Tilecast reads.
- `cec-compliance` tests a remote CEC device. Tilecast is an initiator, so `cec-compliance` does not test Tilecast code. Use it in M11 qualification to record the CEC behavior of each reference TV.

## 3. DDC/CI

### 3.1 libddcutil

ddcutil 3.0.2 (2026-09-23) is the current release. Its library, libddcutil, has a public C API (`ddca_*`). It handles display discovery, VCP access, retry and sleep tuning, capability strings, USB monitors and connection events.

License: the source files carry `SPDX-License-Identifier: GPL-2.0-or-later`. Tilecast is `AGPL-3.0-only`. GPL-2.0-or-later code can be used under GPLv3, and GPLv3 §13 permits combination with AGPLv3 code. The license does not prevent linking.

The architecture prevents linking into `tilecastd`. libddcutil starts shell processes during normal library use:

- `src/ddc/ddc_common_init.c` runs `uname -m` through `popen` during library initialization;
- `src/i2c/i2c_bus_sysfs.c` runs `ls -d /sys/class/drm/...` through a shell during bus detection;
- `src/base/flock.c` runs shell pipelines for lock diagnostics.

`docs/tilecast-edge.md` §19 rule 2 states that `tilecastd` starts no processes. The daemon unit can also refuse such calls. The library also reads a configuration file and writes cache files below `$XDG_CACHE_HOME/ddcutil`, which the daemon sandbox makes read-only.

A separate DDC helper process that links libddcutil would satisfy rule 2. It adds a process, a second IPC contract, a unit and a runtime package dependency (`libddcutil5`). The Tilecast DDC scope is three VCP features (0x10, 0x62, 0x8D) on a directly connected display. That scope does not justify the extra process in Edge 1.

Decision: keep the narrow provider. Record the libddcutil helper as an option in `docs/tilecast-edge-future.md` if M11 hardware shows displays that the narrow provider cannot drive (USB MCCS monitors, DisplayLink, displays that need capability-string negotiation).

### 3.2 Behavior taken from ddcutil

The narrow provider adopts the ddcutil 3.0.2 defaults (`src/base/parms.h`, `src/ddc/ddc_packet_io.c`):

| Behavior                                     | ddcutil                               | Tilecast before             | Tilecast after                        |
| -------------------------------------------- | ------------------------------------- | --------------------------- | ------------------------------------- |
| Delay between Get VCP request and reply read | 40 ms                                 | 40 ms                       | 40 ms                                 |
| Delay after Set VCP                          | 50 ms                                 | 50 ms                       | 50 ms                                 |
| Write-read attempts                          | 10                                    | 3                           | 10                                    |
| Write-only attempts                          | 4                                     | 3                           | 4                                     |
| Null reply                                   | retry with 50 ms more delay each time | retry, no extra delay       | retry with 50 ms more delay each time |
| All replies null                             | `DDCRC_ALL_RESPONSES_NULL`            | `ddc_ci_invalid_reply`      | `ddc_ci_all_responses_null`           |
| All reads zero                               | `DDCRC_ALL_TRIES_ZERO`                | `ddc_ci_invalid_reply`      | `ddc_ci_all_responses_zero`           |
| Set VCP verification                         | one Get VCP after the write           | one Get VCP after the write | unchanged                             |
| I/O method                                   | file I/O after `I2C_SLAVE` (default)  | file I/O after `I2C_SLAVE`  | unchanged                             |

### 3.3 Packaging taken from ddcutil

ddcutil installs `modules-load.d/ddcutil.conf` with `i2c-dev`. Tilecast installs the same module line.

ddcutil matches display adapters with `ATTRS{class}=="0x03*"`. That pattern also matches a 3D controller (`0x030200`), which hybrid-graphics machines use. Tilecast now uses the same class pattern.

ddcutil gives access with `TAG+="uaccess"`, which is for the logged-in desktop user. Tilecast does not copy that. Tilecast gives the nodes to the `tilecast-display` group. Only `tilecast-edge.service` gets the group (`SupplementaryGroups=`), and `DevicePolicy=closed` limits the unit to `char-cec` and `char-i2c` devices.

ddcutil also ships an NVIDIA proprietary driver option (`RMUseSwI2c`). Tilecast does not ship it. The M11 runbook records it as a known quirk.

### 3.4 Reference comparison

No kernel module emulates a DDC/CI display, so CI cannot compare Tilecast with ddcutil. The M11 qualification script compares them on each reference display: for each feature, it reads the value with `ddcutil --terse getvcp`, reads it with Tilecast, sets it with Tilecast and reads it again with ddcutil. `--terse` is the ddcutil output format for scripts. Production code never runs or parses ddcutil.

## 4. Noise Meter and audio inventory

The Noise Meter integration is paused (2026-09-25). The design below stays the plan; the plugin is not advertised until it is qualified.

`tilecast-session-bridge` runs in the tilecast account's user session because PipeWire is a per-user service.

- Capture: `pipewiresrc ! audioconvert ! level interval=60000000 ! fakesink`. The bridge reads the `rms` field of each `level` element message (decibels per channel) and converts it to one linear value. No sample leaves the GStreamer pipeline.
- Inventory: libwireplumber (`WpObjectManager` for `Audio/Source` and `Audio/Sink` nodes, the `default-nodes-api` plugin for the default nodes). WirePlumber owns the session policy and the object graph. The bridge sends counts and two flags. PipeWire and WirePlumber object IDs stay in the bridge.
- IPC to `tilecastd`: `audio.inventory` (`pipewire`, `sources`, `sinks`, `defaultSource`, `defaultSink`) and `audio.level` (`rms`, `state`). Strict decoding refuses any other field.

## 5. Presentation Network

The root helper `tilecast-networkd` (`apps/server/internal/httpapi/install/tilecast-networkd`) owns every NetworkManager operation, the profile namespace `tilecast-presentation-<uuid>`, credential storage, the radio-state rule and the default-route check. Edge uses it without changes and adds no privileged code.

The Edge client is a port of the typed client layer only (`apps/player-linux/src/core/presentation-network.ts` and the reconciliation in `src/main/presentation-network.ts`). The Electron code is TypeScript and the Edge code is Rust, so the two cannot share a module. The helper's own test suite (`apps/player-linux/helper/test_tilecast_networkd.py`) and the Edge integration test run against the same helper script.

## 6. Display sleep

`linuxKiosk.preventDisplaySleep` takes a systemd-logind `idle` inhibitor lock (`org.freedesktop.login1.Manager.Inhibit`, mode `block`) and holds its file descriptor. Clearing the setting closes the descriptor. The default polkit policy lets any process take an `idle` lock. A `sleep` lock needs `org.freedesktop.login1.inhibit-block-sleep`, which is not granted to a system service without a session, so Tilecast does not request one.

Tilecast adds no `xset` call, no input simulation and no idle timer. The capability `system.idle_inhibit` reports `available`, or `blocked` with `logind_unavailable` or `inhibit_denied`.

## 7. Dependencies

| Component                               | Package (Debian 13)                                                           | License                               | Used by                       |
| --------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------- | ----------------------------- |
| GStreamer core, `level`, `audioconvert` | `libgstreamer1.0-0`, `gstreamer1.0-plugins-base`, `gstreamer1.0-plugins-good` | LGPL-2.1-or-later                     | bridge                        |
| `pipewiresrc`                           | `gstreamer1.0-pipewire`                                                       | MIT                                   | bridge                        |
| libwireplumber 0.5                      | `libwireplumber-0.5-0`                                                        | MIT                                   | bridge                        |
| json-glib, GIO                          | `libjson-glib-1.0-0`, `libglib2.0-0`                                          | LGPL-2.1-or-later                     | bridge, renderer              |
| v4l-utils                               | `v4l-utils`                                                                   | GPL-2.0 (tools), LGPL-2.1 (libraries) | CI and M11 qualification only |
| ddcutil                                 | `ddcutil`                                                                     | GPL-2.0-or-later                      | M11 qualification only        |

`tilecastd` gets no new crate. The bridge links only LGPL and MIT libraries.

## 8. Architecture amendments

- `docs/tilecast-edge.md` §4: the session bridge is a third Edge process (§4.4).
- `docs/tilecast-edge.md` §15: M10 prototypes `systemd-sysupdate` (transfer definitions, verified downloads, A/B versions under `/opt/tilecast-edge/<version>/`) before any custom update code. Mender is not a candidate.
- `docs/tilecast-edge-future.md`: an optional libddcutil helper process and an optional libCEC provider, each only after M11 hardware evidence.
