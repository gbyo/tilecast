---
title: Operations
description: Check playback health, respond to incidents, and make temporary changes on screens.
---

Use this section to monitor screens after setup and handle problems without losing track of what each Player actually displayed.

## Find the right task

- [Read Activity reports](./activity/) to check Player-confirmed playback, compliance, and incidents.
- [Understand a screen's status](./screen-status/) when a display appears offline or needs attention.
- [View a live preview or stream](./live-preview/) to check what a connected Player is showing.
- [Show content now](./quick-present/) for a temporary presentation without editing its schedule.
- [Present with AirPlay](./airplay-present/) from a supported Linux Player.
- [Start a Takeover](./takeover/) to replace normal playback for a limited time.
- [Use Display Control](../screens/display-control/) to request a power, input, volume, or brightness action.
- [Send a Player command](./player-commands/) to request a sync, playback reload, cache clear, or restart.
- [Install a built-in plugin](./plugins/) for an optional Tilecast capability.
- [Review Snapshot history](./snapshot-history/) when you need to look back at earlier screen captures instead of only the current preview.
- [Set data retention](./data-retention/) for Activity, audit, diagnostics, and telemetry history.

For timed playback, see [Schedules](../schedules/). To send notifications to people or another system, see [Integrations](../integrations/). For a symptom-first path when something is wrong, start with [Troubleshooting](../troubleshooting/).

## What plays first

Tilecast selects the highest-priority presentation that is active for a screen:

1. An active Takeover.
2. On Linux, an active AirPlay session.
3. A Quick Present session.
4. The highest-priority active schedule.
5. The screen's assigned content or its Display Group fallback.

Android Players do not support AirPlay. Quick Present, AirPlay, and Takeover can continue outside normal active hours or while ordinary playback is disabled. Safe mode has separate platform behavior: Linux safe mode blocks Quick Present, while an active AirPlay session remains visible; Android can show Quick Present. A fullscreen Emergency Alerts presentation uses a Takeover. An Emergency Alerts ticker is an overlay and does not replace the current presentation. When a temporary session ends, Tilecast evaluates the schedule and fallback again instead of restoring an old playback snapshot.
