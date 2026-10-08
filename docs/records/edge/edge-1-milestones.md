# Historical Tilecast Edge 1 milestones

**Record date:** 2026-09-29

This file preserves the milestone sequence used to build Edge 1. It is not a
current readiness checklist. Use [Tilecast Edge architecture](../../tilecast-edge.md)
for current invariants and [Edge state and qualification](../../tilecast-edge-next.md)
for current release evidence.

By this checkpoint M1 through M10 were merged. The M11 remote-web
implementation was merged, while physical qualification and production rollout
were still incomplete.

| Milestone | Historical scope | Historical exit criterion |
| --- | --- | --- |
| M1 Foundation | Rust workspace, `tilecastd`, SQLite state, local IPC, WPE renderer, CAS, identity gate, credential handling, legacy import, capability registry | Linux image, headless, real-server import/identity/heartbeat/revocation checks |
| M2 Server presence | Player WebSocket, fallback heartbeat, server clock sampling | Online state, fallback heartbeat, reconnect after Server restart |
| M3 Manifests and content | Manifest validation, CAS preparation, activation, pinning, media capability channel, local schedule selection | Downloaded playback, offline restart, failed preparation keeps the previous manifest |
| M4 Configuration and commands | Configuration synchronization and durable idempotent commands | Commands do not execute twice across restart or redelivery |
| M5 Pairing | Pairing sessions, setup surface, manual URL, Avahi discovery | Clean machine pairs, is approved, and plays |
| M6 Offline resilience | Server/WAN outage, power-loss, and clock-change qualification | Crash-point and outage tests |
| M7 Migration installer | Preflight, cutover, settlement, rollback, acceptance | Migration and rollback qualification |
| M8 Proof of play and telemetry | Activity outbox and bounded telemetry | Activity parity with the previous Linux Player |
| M9 Hardware parity | CEC, DDC, Presentation Network, idle/session integration | Capability evidence on reference hardware |
| M10 Updates | Signed releases, verified download, root update helper, provisional confirmation, rollback | Real-systemd software qualification plus reference-hardware update/rollback |
| M11 WPE qualification | DRM/KMS, Wayland, remote-web isolation, physical media/output behavior | Physical-device qualification |
| M12 Production rollout | Pilot and staged Linux Legacy retirement | Pilot fleet stable for an agreed period |

Later records under this directory preserve specific implementation and field
evidence. The milestone number is historical context only.
