# Engineering documentation

This directory contains Tilecast's versioned engineering contracts, operator-grade technical references, qualification evidence, and historical implementation plans. It is **not** the public user documentation site; that lives in [`apps/docs/src/content/docs`](../apps/docs/src/content/docs/).

## How to use these files

- **Current contract:** Use the source code plus the matching architecture/protocol document. A normative contract defines boundaries and invariants, not proof of device qualification.
- **Implementation/qualification record:** Read the recorded date, branch, release, target hardware, and test coverage. An older passing result never qualifies current `main` or a different device.
- **Historical plan or spike:** Keep it for decisions and traceability, but do not implement its proposed work or copy its former UI/components without checking the current contract.
- **Documentation conflict:** Check source and tests, reconcile the owning specification, and update both engineering and [public docs](../apps/docs/src/content/docs/) where users are affected. Preserve security and migration history.

Start with [`AGENTS.md`](../AGENTS.md) for repository rules, [architecture](architecture.md) for system boundaries, [development](development.md) for setup, and [testing](testing.md) for validation. Refer to [documentation style](documentation-style.md) for the engineering writing rules.

## Current contracts and references

- **API and authentication:** [API](api.md), [Player protocol](player-protocol.md), [device credentials](device-credential-security.md). See also [MFA and passkeys](multi-factor-authentication.md), [canonical OpenAPI](openapi.yaml).
- **Native Players:** [Player Core](player-core.md), [Player Runtime](player-runtime.md). See also [Presentation Model](presentation-model.md), [cross-player contracts](player-contracts.md).
- **Linux Edge:** [Edge architecture](tilecast-edge.md), [capability matrix](tilecast-edge-capabilities.md), [production readiness](tilecast-edge-readiness.md), [hardware qualification](tilecast-edge-qualification.md), and [decision checklist](tilecast-edge-readiness-checklist.md). See also [migration threat review](tilecast-edge-migration-threat-review.md), [update threat review](tilecast-edge-update-threat-review.md), [remote web threat review](tilecast-edge-remote-web-threat-review.md), and the dated [0.2.1 hardening record](records/edge/0.2.1-sandbox-review.md).
- **Other platforms:** [Android development](android-development.md), [Windows Player](tilecast-windows.md), [Browser Player](browser-player.md), [iOS/iPadOS Studio](ios-app.md). See also [Fire TV](fire-tv.md), [Google TV](google-tv.md), [Windows qualification](tilecast-windows-qualification.md).
- **Studio:** [Design system](design-system.md), [localization](localization.md). See also [widget authoring](widget-authoring.md), [Widgets V2](widgets-v2.md), [layouts](widgets-and-layouts.md).
- **Extensions:** [Plugin API v1](plugin-api.md), [external packages](packages.md), [Marketplace](marketplace.md). See also [data-source modules](data-source-modules.md), [Widget V2 catalog](widgets-v2-catalog.md), [content extension model](content-extension-model.md).
- **Playback and fleet:** [Activity](activity.md), [event contract](activity-event-contract.md), [reliability](reliability-and-power.md). See also [live previews](live-previews.md), [Watch Live](live-streaming.md), [Display Control](display-control.md), [Player updates](player-updates.md).
- **Operations:** [Deployment](deployment.md), [troubleshooting](troubleshooting.md), [demo mode](demo-mode.md). See also [notifications](notifications.md), [fleet operations](fleet-operations.md), [screen replacement](screen-replacement.md).
- **Authoring and content:** [Content review](content-review.md), [playback plan](playback-plan.md), [structured sources](structured-sources.md). See also [playlist history](playlist-history.md), [website content](website-content.md), [snapshot history](snapshots.md).

Read the platform's own README and any closer `AGENTS.md` before making changes. The list is navigational and does not override a deeper subsystem contract.

## Dated engineering records

Completed qualification reviews and implementation spikes that still matter for
traceability live under [`records/`](records/). They are evidence, not current
architecture instructions.

- [Native Player Core extraction/readiness](records/player-core-readiness.md)
- [External Widget sandbox spike](records/widget-sandbox-spike.md)
- [Tilecast Edge records](records/edge/), including the historical Edge 1
  milestone sequence, M9/M10/M11 implementation records, and the 0.2.1 field
  hardening review.

Abandoned implementation plans such as Rhea, the old Studio flow plan, the
Widgets V2 first-wave migration plan, the superseded design-system roadmap, and
dated CI timing snapshots are intentionally removed from the current tree. Git
history remains the archive for plans that no current contract or source code
needs.

Architecture decision records are in [`adr/`](adr/). Decisions remain useful
even when the implementation context that motivated them is historical.

## Updating documentation

Keep security invariants, SQL migration guarantees, release verification, and external compatibility precise. Do not change a protocol claim only because a historical date looks old. Verify it against the current implementation and corresponding tests. Mark time-sensitive assertions with the **as-of date and tested scope**. Do not silently promote preview releases, simulated tests, or plans into production compatibility claims.

Run `make docs-check` for engineering style and `npm run docs:build` for the public site when applicable.