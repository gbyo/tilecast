---
title: Start a Takeover
description: Temporarily replace scheduled and fallback content on selected screens.
---

A **Takeover** plays a ready playlist on selected screens or Display Groups until it expires or you end it. It overrides schedules and fallback content for those targets.

## Before you start

You need the **Owner** or **Administrator** role and a ready, non-empty playlist. A Player that is offline cannot show the Takeover until it reconnects.

## Start and end a Takeover

1. In Studio, open **Screens** > **Fleet** and select **Takeover**.
2. Enter a **Takeover name** and select the **Playlist**.
3. Choose an **Expires in** time.
4. Select **Target screens** or **Target Display Groups**. Selecting **All screens** targets the whole fleet.
5. Review the selected targets. Studio flags selected screens that are not online. Starting a new Takeover replaces any existing Takeover that overlaps the same screens.
6. For selected screens or groups, select **Activate takeover** and review the confirmation. For **All screens**, hold **Hold to activate takeover** for three seconds. If the installation requires it, enter your current password and select **Confirm takeover**.
7. To stop it early, open the active Takeover banner and select **End takeover**. Add a cancellation reason if useful.

When a Takeover ends or expires, Tilecast selects the schedule or fallback content that applies then. It does not restore a saved snapshot of what played before the Takeover.

:::caution
Check the selected screens before activation. A Takeover immediately replaces normal playback on every online target, and a new overlapping Takeover replaces the existing one.
:::
