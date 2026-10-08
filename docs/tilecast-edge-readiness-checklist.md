# Tilecast Edge: production-readiness decision checklist

Each item carries evidence from exactly one level. A higher level never
implies a lower one was skipped.

- Software implemented: the code exists on main.
- Automated tests passed: the named suite ran green.
- Release artifact validated: a signed release installed and ran.
- Physical hardware validated: the qualification procedure ran on
  reference hardware.
- Field deployment validated: production screens ran the release.

## Update and rollback safety

| Item                                          | Evidence                                                                     |
| --------------------------------------------- | ---------------------------------------------------------------------------- |
| Verified pre-update checkpoint                | Software implemented, tests passed (`tilecastd` checkpoint + updates suites) |
| Schema-advancing rollback restores playback   | Tests passed (harness); hardware and field pending                           |
| Ordinary rollback without onsite recovery     | Tests passed; hardware pending                                               |
| Signed release install and update on hardware | Not run                                                                      |

## Remote operations

| Item                                | Evidence                                         |
| ----------------------------------- | ------------------------------------------------ |
| Preview transport hardening (#1376) | Implemented, CI green; hardware fidelity pending |
| Command delivery hardening (#1377)  | Implemented, CI green                            |
| Watch Live stall recovery (#1378)   | Implemented, CI green; encoder load pending      |

## Recovery

| Item                                   | Evidence                                      |
| -------------------------------------- | --------------------------------------------- |
| Supervisor persistence across restarts | Implemented, tests passed                     |
| No systemd latch into failed state     | Implemented, tests passed                     |
| Renderer crash matrix                  | Tests passed (Linux suites); hardware pending |

## Hardware qualification

All items in [`tilecast-edge-qualification.md`](tilecast-edge-qualification.md)
are pending: display output, media, remote-web helper, display control,
network, groups, power/update on hardware, and the 24-72 h soak.

## Diagnostics (no-SSH review)

Studio already surfaces: screen status, version, preview images with
failure states, Watch Live state, command results, display output
status, update states, and migration status. Gaps recorded as
follow-ups, not implemented here: a distinct renderer-unhealthy versus
offline indicator, the last preview failure reason on the screen page,
the last restart/recovery reason, and the last rollback reason with its
restore outcome. Any addition must reuse existing screens and follow
current UI conventions.

## Migration and installation

Verified against the existing migrate suites (16 tests) and systemd
migration tests: preflight, identity and binding preservation, verified
media import, offline compatibility, error descriptions, single-player
ownership, service transitions, reboot behavior, settlement rollback,
and recovery instructions. Physical kiosk migration and rollback are
pending. The default install path must prefer Edge only after
qualification. Legacy binaries, instructions, and compatibility code
stay.

## Requirements for Edge as the default Linux target

1. All automated suites green on the release commit.
2. Signed release artifacts validated on reference hardware.
3. Qualification sections 1-7 passed and recorded.
4. One 24-72 h soak passed and recorded.
5. No open known defect in the readiness record.

## Requirements for discontinuing Linux Legacy

All of the above, plus:

1. Field deployment validation across a full release cycle.
2. Migration and settlement rollback proven on kiosk hardware.
3. AirPlay-dependent screens have a documented path. AirPlay remains
   unsupported by Edge. It is out of scope and must not be presented as
   implemented.

## Current blockers

- To Edge default: hardware qualification (all sections) and the soak.
- To Legacy retirement: field validation, kiosk migration proof, and the
  AirPlay-dependent screen path.
