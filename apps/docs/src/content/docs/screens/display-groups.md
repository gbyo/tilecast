---
title: Manage Display Groups
description: Group screens that should share fallback content, schedules, and synchronized playback.
---

A Display Group is a set of screens that share fallback content, schedules, and playback position. Use one for displays that should stay synchronized, such as several screens in a lobby.

## Create a group and add screens

1. In Studio, open **Screens** > **Display Groups** and select **Create Display Group**.
2. Enter a group name and optional description, then create the group.
3. Open the group and add screens under **Screens**. Search by screen name or location, choose an available screen, and add it.

Only screens that aren't already assigned to another Display Group appear as available. A screen can belong to one Display Group at a time. To move a screen, remove it from its current group before adding it to another.

## Choose fallback content

Under **Fallback content**, select a Playlist or a published Layout, then select **Apply to Display Group**. Choose **No fallback presentation** if the group should have no fallback. The fallback plays whenever no higher-priority schedule or Takeover is active. Schedules can target the group so its member screens follow the same schedule.

**Mirror** is the default mode. It preserves synchronized group playback: members use the same fallback and schedule and keep the same playback position.

## Make a video wall

Set **Wall mode** to **Span** when the screens form one logical canvas. In **Span wall editor**, set the canvas size, arrange each screen's panel, then select **Save wall**. Presets provide 2 × 1, 1 × 2, and 2 × 2 starting arrangements. Select **Return to Mirror** to restore mirrored playback.

For Span video playback, Tilecast Server prepares a normal-resolution H.264 panel file for each screen. Check **Panel preparation** in the editor; wait for required panels to show **ready** before expecting the video wall to play.

## Change or delete a group

Owners and Administrators can edit a group's name, description, membership, fallback, and Player policy. Removing a screen leaves the screen itself in Tilecast. Deleting a Display Group also leaves its screens intact, but removes the group that schedules and policies may target.

See [Set Player policies](../../administration/player-policies/) to understand how group settings combine with screen and organization defaults.
