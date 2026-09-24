---
title: Operations
description: Keep displays running, respond to problems, and override content when you need to.
---

Operations is the day-to-day work after your displays are set up: knowing which screens are healthy, fixing the ones that aren't, and changing what plays in a hurry.

## Screen status

Studio shows a status for every screen. The server works it out from the Player's connection, so a Player can't report itself as online.

| Status              | Meaning                                                                  |
| ------------------- | ------------------------------------------------------------------------ |
| **Online**          | The Player has a live connection to the server right now.                |
| **Recently online** | No live connection, but the Player made contact in the last two minutes. |
| **Stale**           | The last contact was between two and fifteen minutes ago.                |
| **Offline**         | No contact for more than fifteen minutes, or never.                      |
| **Disabled**        | An Owner or Administrator disabled the screen in Studio.                 |
| **Pairing revoked** | The screen's credential was revoked. Pair the Player again to use it.    |

A screen that's offline keeps playing the content it already downloaded. It picks up changes when it reconnects.

## Override content with a takeover

A takeover replaces scheduled and fallback content on the screens and Display Groups you choose, until it expires or you end it. Use it for an emergency or any other urgent message. You need a ready playlist, the targets, and an expiry time.

When a takeover ends, each screen goes back to whatever its schedule or fallback content says now. It doesn't go back to what it showed before the takeover started.

:::caution
A Player that's offline when you start a takeover can't show it until it reconnects. Studio lists the offline targets before you confirm.
:::

## Send a command to a Player

Owners and Administrators can send a Player a command from a fixed list, such as **Sync now**, **Reload playback**, **Clear media cache**, or **Restart the Player**. The server holds the command until the Player collects it, so a Player that's briefly offline still gets it. A command can't be undone after the Player collects it.

To make the same change on many screens, use **Bulk changes** on the **Screens** page. It shows a preview of every screen the change affects before anything is applied.

## Watch for problems

**Activity** in Studio shows:

- What each Player confirms it actually displayed, and for how long.
- Open incidents, such as a screen that stopped reporting or content that failed to play.
- An audit log of who changed what.

Tilecast can also send notifications by email or webhook when an incident opens and when it recovers. Set them up in **Settings** > **Notifications**.

## Go further

- [Activity](https://github.com/gbyo/tilecast/blob/main/docs/activity.md) defines each metric Studio reports.
- [Reliability and Kiosk](https://github.com/gbyo/tilecast/blob/main/wiki/Reliability-and-Kiosk.md) covers startup, recovery, and kiosk lockdown on each platform.
- [Troubleshooting](https://github.com/gbyo/tilecast/blob/main/wiki/Troubleshooting.md) lists common problems and fixes.
