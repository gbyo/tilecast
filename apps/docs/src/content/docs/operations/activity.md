---
title: Read Activity reports
description: Use Activity to review Player-confirmed playback, screen health, incidents, and administrative history.
---

Open **Activity** in Studio to see what Tilecast can confirm about the fleet and what changed over time. Choose a date range for historical reports; the current fleet and active incident counts describe the present, regardless of that range.

## Choose a report

| Tab                | Use it to                                                                                                               |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------- |
| **Overview**       | See current fleet health, active incidents, and summaries for the selected period.                                      |
| **Proof of Play**  | See sessions the Player reported as displayed, and how each session ended.                                              |
| **Incidents**      | Follow a continuing screen or content problem through recovery or manual resolution.                                    |
| **Content Health** | Find Data Sources that stopped refreshing and assigned playlists with nothing available to play.                        |
| **Screen Events**  | Inspect the technical events reported by Players. This tab is available to Owners and Administrators.                   |
| **Audit Log**      | See changes made by Studio users. Editors see content-related activity; Owners and Administrators can see the full log. |

Owners and Administrators can inspect **Screen Events** and diagnostic telemetry, export Proof of Play or Audit Log reports to CSV, and change Activity retention under **Settings** > **Data retention**. Editors can read content-related Audit Log entries. Overview, Proof of Play, Incidents, and Content Health reports are available to signed-in Studio users.

## Interpret playback numbers

**Proof of Play** comes from reports sent by Tilecast Player. An assignment or schedule says what Tilecast expected to play; it does not prove that the Player displayed it. A playback record confirms the Player reported that presentation or content as playing. It cannot tell you whether anyone in the room saw or read the display.

For a screen using a multi-zone Layout, **confirmed screen playback** counts wall-clock screen time once even when several zones play at the same time. **Content exposure** adds the time of each zone's content, so it can exceed the time the screen was on. These answer different questions and should not be added together.

**Session completion rate** describes how playback sessions ended. It is not a measure of whether scheduled content played. For that, use **Playback compliance**, which compares Player-confirmed screen time with expected windows Tilecast recorded when a selection became effective. Takeover time and intentionally cancelled windows are reported separately and excluded from the percentage. If there is no measurable expected time, Studio shows **No data**, not `0%`.

Expected windows are not reconstructed from today's schedules. Compliance has no historical expectation for periods before Tilecast began recording those windows.

## Follow an incident

An incident represents a continuing condition, not every repeated error. Tilecast updates the same incident while the condition continues. When the condition ends on its own, it is marked recovered and remains in the report as history; it does not stay in the active list. A person can resolve an active incident, which is recorded separately from automatic recovery.

Owners and Administrators can acknowledge, assign, add a note, resolve, ignore, and reopen incidents. Other roles can read incidents. Use [Understand a screen's status](../screen-status/) to separate connectivity from playback health.

For exact metric and event definitions, see the repository's [Activity definitions](https://github.com/gbyo/tilecast/blob/main/docs/activity.md) and [Activity event contract](https://github.com/gbyo/tilecast/blob/main/docs/activity-event-contract.md).
