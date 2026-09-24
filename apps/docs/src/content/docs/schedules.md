---
title: Create a recurring weekday schedule
description: Set a Playlist or published Layout to play on selected screens or Display Groups at weekday times.
---

Create a weekly schedule to show a Playlist or Layout at the same local time on selected days. For example, use one to play a lunch menu from Monday through Friday, 10:30 to 13:00.

## Before you start

- An **Owner** or **Administrator** account is needed to create or change schedules.
- Prepare a Playlist with content that is **Ready**, or publish the Layout you want to schedule. Tilecast won't save a schedule that references an empty Playlist, unready media, or an unpublished Layout.

## Create the schedule

1. Open **Operations** > **Schedules**, then select **Create schedule**.
2. Under **Content**, enter a **Schedule name** and select **Choose presentation**. Choose a Playlist or published Layout, then select **Use this presentation**.
3. Under **Timing**, choose **Weekly recurring**. Select Monday through Friday under **Active weekdays**, then enter the **Start time** and **End time**.
4. Choose the **Timezone** for the schedule. Search by city or region and select the matching IANA timezone, such as `America/Chicago`.
5. Under **Targets**, choose **Screens** or **Display Groups**, then search for and select one or more targets.
6. Under **Advanced options**, leave **Enabled** on. Choose **Normal** priority unless another schedule for the same targets should take precedence.
7. Review the **Schedule summary** and **Conflict preview**, then select **Save schedule**.

Add a **Date range** if the weekday rule should start or stop on specific dates. Without one, the rule repeats every selected weekday.

## Check overlaps and targets

The higher-priority schedule wins when active schedules overlap for a screen. Use **Important** or **Special event** when that schedule should take precedence; **Custom** lets you enter a value from -999 to 999. When priorities are equal, the conflict preview explains whether a more specific target or a later start wins.

The **Conflict preview** checks one screen at an upcoming occurrence: the first selected screen, or the first screen in the first selected Display Group. A **No conflicts** result doesn't check every target. Review other screens separately if they have different schedules.

In the **Screens** picker, a screen that belongs to a Display Group is offered as that group. Selecting the group schedules all its members together. Outside an active schedule window, the screen's assigned fallback content continues to play.

## Time and playback behavior

Weekly times use the selected timezone, including daylight-saving changes. If the **End time** is earlier than the **Start time**, playback ends the following day. Equal start and end times make a 24-hour window.

Players evaluate timing locally from the last schedule manifest they received. During a server or network outage, they can continue switching at schedule boundaries already in that manifest, but they can't receive schedule or content changes until they reconnect. Playback during an outage still depends on the needed content being available on the Player; content set to stream or not yet downloaded needs a network connection.

Turning **Enabled** off keeps the schedule saved but stops it from affecting playback. Outside active windows, fallback content resumes.

## Next steps

- Prepare a [Playlist](../playlists/) or [Layout](../layouts/) for the schedule.
- Coordinate several content blocks and destinations with a [Campaign](../campaigns/).
