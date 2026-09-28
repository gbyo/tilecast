# Display Control

Display Control is an optional, capability-driven way to operate a physical
display attached to Tilecast Player. It is separate from Player connectivity:
an online Player can report that a display is powered off by policy, and a
command being accepted means that the provider call was attempted, not that
the panel confirmed a state change.

## Providers and capabilities

The protocol keeps providers independent so one display can expose a mixed
set of controls:

| Capability         | Initial Linux provider                                                 |
| ------------------ | ---------------------------------------------------------------------- |
| Power, input       | HDMI-CEC                                                               |
| Brightness, volume | DDC/CI                                                                 |
| Mute               | Provider-specific; not claimed by the initial Linux DDC implementation |
| Probe              | HDMI-CEC or DDC/CI                                                     |

The registry also reserves Network and RS-232 providers for later display
integrations. Android players and older Players report no Display Control
capabilities and continue normal playback.

Linux detection is best effort and bounded. The Electron Linux Player probes
`/dev/cec0` with `cec-ctl` and connected monitors with `ddcutil detect --brief`.
Tilecast Edge uses the kernel interfaces directly (see "Tilecast Edge" below). Install the
matching Linux packages and grant the Player service access to the CEC device
and the display's I²C device. A missing binary, permission failure, or absent
device produces an unsupported capability report; it does not stop playback.

Display commands are fixed typed commands:

```text
display_power_on
display_power_off
display_set_input
display_set_volume
display_mute
display_unmute
display_set_brightness
display_probe
```

Inputs use a bounded identifier format. Volume and brightness are integers
from 0 through 100. The Linux implementation invokes `cec-ctl` and `ddcutil`
without a shell, with fixed executable arguments, a five-second timeout, and a
64 KiB output limit. No command can provide a path, URL, executable, or shell
fragment.

## Scheduled actions

Display actions use the normal Tilecast schedule rows, time zones, priorities,
targets, manifest revisioning, and offline transition resolver. A schedule
contains exactly one of a playlist, Layout, or `displayAction`; content
schedules remain unchanged. A power-off action marks the Player status as
**Display: Powered off by policy** while the Player itself remains online.

Studio only renders controls reported by the Player. The status panel keeps
these facts distinct:

- command state: queued, acknowledged, succeeded, or failed;
- provider result: the bounded command was sent or failed locally;
- display state: a later heartbeat or provider confirmation observed `on`,
  `off`, or `transitioning`.

The initial Linux providers report a successful send as unconfirmed. This is
intentional: CEC and DDC/CI do not provide a uniformly reliable panel-state
query across hardware.

## Tilecast Edge

Tilecast Edge implements the same commands, payload validation, scheduled
actions and heartbeat fields. It adds a readback after each change and reports
what the display said:

| Result code               | Meaning                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `display_state_confirmed` | The display reported the requested state afterwards: CEC Report Power Status, or a DDC/CI Get VCP of the same feature.                                                         |
| `display_command_sent`    | The display acknowledged the request, but reported no state that confirms it: CEC input selection, a TV that does not answer power queries, a TV that is still changing state. |
| `display_state_mismatch`  | The display reported a different state afterwards. The command failed although the request was delivered.                                                                      |
| `display_unsupported`     | No usable provider. The message names the capability reason, for example `cec_adapter_absent`.                                                                                 |
| `display_invalid_payload` | The payload broke the contract. Nothing was sent.                                                                                                                              |

`displayPowerStateConfirmed` is true only for a power state that the TV
reported. `tilecastd` starts no processes: it opens `/dev/cecN` and
`/dev/i2c-N` through the kernel CEC and i2c-dev interfaces. The device nodes
belong to the `tilecast-display` group, which only the daemon's service
joins. The DDC/CI retry, null-reply and timing behavior follows ddcutil. The
operator can turn either provider off in `/etc/tilecast-edge/edge.toml`
(`[display] cec_enabled`, `ddc_enabled`, `cec_adapter`).

## Display Group actions

Studio can preview and send **Power on all**, **Power off all**, **Mute all**,
and **Unmute all** for a Display Group. The preview is based on each current
Player heartbeat and reports the selected count, capability-supported count,
unsupported displays, and displays that cannot currently receive a command.
Only supported displays receive a persistent Player command; unsupported or
disabled members are skipped and named in the result. The preview fingerprint
is checked at apply time so a replacement Player or a new capability report
cannot be silently acted on using stale information.

## AirPlay and presentation priority

Display Control does not change AirPlay. AirPlay remains an external runtime
presentation path and is handled by its existing command and conflict logic.
Scheduled Display Control actions operate the physical display only; they do
not silently interrupt AirPlay or take over playback.

## Replacement and older hardware

When hardware is replaced, the logical screen's Display Control policy and
group membership remain attached to the screen, but capability detection starts
from the replacement Player's own probe. Previous hardware capability claims
are never copied. Old Linux computers decode their ordinary playback assets as
before; Display Control adds only short bounded provider commands and performs
no video processing on the Player.
