# Tilecast Player for Windows

This document specifies the Windows-owned platform services of the
Tilecast Player for Windows. It covers the release family `windows` on
Windows 10 and Windows 11, x64 and ARM64.

Player Core owns pairing, the server link, configuration, manifests,
selection, scheduling, offline activation, commands, Activity, and
telemetry policy. The Player Runtime owns presentation. This document
covers only the behavior that must touch Windows.

For physical proof, see `tilecast-windows-qualification.md`. For the
release contract, see `player-updates.md`. For the pairing and device
protocol, see `player-protocol.md`.

## Single instance

The Player runs one copy per login session. The first copy claims the
session mutex `Local\TilecastPlayerSingleInstance` before it touches
any state. A second copy prints a message and exits with status 1.

A commanded restart drops the guard after a clean shutdown and starts
one fresh copy. Either the fresh copy or a racing third copy holds the
mutex after the handoff. Exactly one Player runs.

## Kiosk window

The production window covers its monitor with a borderless frame. The
Player enters fullscreen after it creates the window and before it
wires the WebView2 controller. The controller therefore receives the
fullscreen client size.

The Player re-covers the monitor on every display change. Resolution,
scale, and monitor moves keep the signage surface fullscreen. The
conformance runner keeps its exact fixture size and never enters
fullscreen.

The Player hides the cursor while signage runs and restores it at
shutdown. The hide and show helpers normalize the process-global
`ShowCursor` counter. A previous crash cannot stack hidden states.

## WebView2 renderer

The Player renders with the Evergreen WebView2 Runtime. The package
never bundles a fixed runtime. When WebView2 is absent, install
Microsoft's Evergreen Bootstrapper on a connected machine or the
matching Standalone installer on a prepared offline machine. The
Player reads the installed engine version and reports it in renderer
status. A future fixed-runtime option needs a demonstrated
air-gapped or compliance requirement.

One COM STA UI thread owns every window and WebView2 object. The
trusted environment serves the exact Player Runtime artifact over
`tilecast://runtime/` and verified media through opaque
`tcmedia://cap/` grants. The Runtime talks to the host only through
the typed `TilecastRuntimeHostV1` bridge over JSON web messaging.
Remote Websites and YouTube show in child views of a separate remote
environment with bounded profiles. Remote views register no
`tilecast` or `tcmedia` scheme, no bridge, and no host objects. They
block popups, downloads, and external protocols. They
deny device permissions. TLS errors fail closed. Top-level navigation
follows the exact allowlist. WebView2 exposes no file-chooser event,
so the Player cannot cancel a file dialog from a remote page: do not
assign pages with file inputs to Windows screens. See
`website-content.md` for the cross-engine browsing-data contract.

The WebView2 conformance engine runs the shared Runtime fixture
corpus through this exact production path and compares it with the
Electron reference. See `player-runtime.md`.

## Sleep inhibition

The Player holds display and system sleep off while it presents. It
calls `SetThreadExecutionState` with continuous, system-required, and
display-required execution state at startup. It restores the default
state at shutdown. Process exit restores the default state in every
case.

The Player does not control display power. It answers the
`power_assist_sleep` and `power_assist_wake` commands with
`unsupported_command`.

## Startup behavior

The Player starts without interaction. Pairing arrives through the
`run --pair` flag or through the setup surface in the Runtime. No
first-run dialog blocks a headless start.

Start the Player at user logon with a Startup folder shortcut or with
a scheduled task. The single-instance guard makes a double start safe.
The MSIX package declares the `TilecastPlayerAutostart` startup task.
The packaged install starts at logon. The user can disable the task in
Task Manager.

## Crash and relaunch behavior

The Player does not retry superstitiously after a crash. It registers
for restart with `RegisterApplicationRestart` and flags 0. Windows
restarts the same command line after a crash, a hang, an update, or a
reboot.

A `restart_player_process` command shuts the Player down cleanly and
starts one fresh copy of the same executable with the same arguments,
except `--pair`. A relaunch resumes running. It never re-pairs.

The next start detects an unclean previous shutdown. It runs an
integrity check on the state database and marks stored content
suspect before it presents anything. Recovery mode keeps private-file
cleanup working when state cannot open.

## Installation and updates

The Player ships as a signed MSIX package, one per architecture. The
package identity Name is `Tilecast.TilecastPlayer` and never changes.
The Publisher is the Windows signing identity. The package version is
a version quad mapped from the release version name and channel: `0.2.0`
stable maps to `0.2.0.2`, `0.2.0` beta maps to `0.2.0.1`. The revision
is 1 for a beta release and 2 for a stable release. The mapping is
monotonic: a beta release precedes the stable release of the same
version, and a newer version always maps higher. The
`tilecast-msix-version` helper is the single implementation. The
release build fails when the version name or channel is invalid.

Two trusts stay separate. Windows verifies the package signature
against the Publisher certificate and refuses an untrusted package.
The Tilecast signed update envelope binds the version name, the
version code, the channel, the architecture, and the package SHA-256.
The server verifies the envelope before it caches the release. The
Player verifies the envelope fields and the package identity before it
installs. Neither trust substitutes for the other.

Installing the signed package needs no special tooling when the
Publisher certificate is trusted. Double-click the MSIX package, or
install it with App Installer. In an enterprise deployment, provision
the Publisher certificate before you install the package.

A Player update arrives as an `install_player_update` command from the
paired server. The Player downloads the package from that server only.
It never contacts GitHub. It verifies the SHA-256, the envelope, and
the package identity. It waits for the maintenance window of a
scheduled deployment. It stages the package and deploys it with the
Windows package manager. Deployment uses no force flag. The restart
command then relaunches the new build. The new build reports its
version code on the heartbeat. Heartbeat settlement completes the
deployment (see `player-updates.md`). The update job is durable: a
restart resumes it, and a stale command for an older version is
refused.

## Device facts

The Player reports manufacturer, model, OS release, architecture,
locale, time zone, and display size. It reads the manufacturer and
model from the system firmware registry keys. It reads the OS product
name and build number from the registry because the version APIs
report compatibility values without an embedded manifest. It reports
the primary monitor size because the production window covers that
monitor. Each fact degrades to a documented fallback. Pairing works on
any Windows 10 or Windows 11 machine.

## Server discovery

The setup surface lists advertised Tilecast Servers. The Player
browses `_tilecast._tcp.local.` for three seconds with a pure-Rust
mDNS client. It needs no Bonjour installation.

The Player accepts only advertisements whose `base-url` TXT record is
an absolute lowercase HTTP or HTTPS URL without user information. It
returns at most 32 servers. An empty list means no server answered or
multicast does not work on the network. Manual server entry always
works.

## Final-output capture

Studio preview and Watch Live use Player Core capture policy. Core
owns the lease, the protection states, and the cadence. The Windows
host owns the pixels.

The host captures its own top-level window with Windows Graphics
Capture. The capture shows the final composed frame: the trusted
Runtime view plus every remote Website and YouTube host layer.
Capturing the own window needs no picker and shows no consent UI and
no border.

Each capture initializes a multithreaded COM apartment on a blocking
thread, builds a throwaway D3D11 device, waits for one frame, and
reads the pixels back through a staging texture. The host converts
the BGRA frame to RGB, scales it into the requested bounds without
upscaling, and encodes the smallest JPEG that fits the byte budget.
The quality ladder runs first. Smaller dimensions run second. A frame
that cannot fit fails as invalid.

One capture runs at a time across preview and Watch Live. Protected
states produce no image. Setup, pairing, safe mode, and an empty
stage stay protected. A failed Watch Live capture drops its frame. It
never suspends anything. Repeated preview failures suspend previews
under Core health policy while Studio sees `unavailable`.

Physical proof that host layers appear in captures is qualification
item 15. If child views do not appear correctly, that evidence moves
the renderer adapter to the composition-controller path. The host
never ships an incomplete screenshot path.

## Capability reporting

The Player reports what it implements. The heartbeat advertises the
shared declarative presentation capabilities and the Widget
components. It advertises no CEC control, no DDC control, and no
Presentation Network. Commands outside the Windows feature set settle
as `unsupported_command` with a reason that names the gap.
