---
title: Update Tilecast Player
description: Add a verified Android or Linux Player release and deploy it to selected screens.
---

Use **Settings** > **Player updates** to deploy signed Tilecast Player releases. This updates Player apps; it does not update Tilecast Server, containers, or the host operating system. Owners manage releases. Owners and Administrators can create deployments.

## Add a release

1. Choose **Android** or **Linux** under **Player platform**.
2. Select **Sync from GitHub** to import releases from [Tilecast releases](https://github.com/gbyo/tilecast/releases), or select **Upload release** to add signed files directly.
3. For a direct upload, choose all three files from the same signed release:

   | Platform | Player file                | Manifest                            | Signature                               |
   | -------- | -------------------------- | ----------------------------------- | --------------------------------------- |
   | Android  | `tilecast-player.apk`      | `tilecast-player-update.json`       | `tilecast-player-update.json.sig`       |
   | Linux    | `tilecast-player.AppImage` | `tilecast-player-update-linux.json` | `tilecast-player-update-linux.json.sig` |

   Select **Upload and verify**. Tilecast verifies the files before adding the release to its update cache.

GitHub releases show verification and cache status. If a release is verified but not cached, select **Download** to cache it. A release must be verified and cached before you can deploy it.

## Deploy a release

1. Select **Deploy update**.
2. Choose a **Verified release** and select screen and/or Display Group targets for the selected platform.
3. Choose **Download only**, **Download and request installation**, or **Maintenance window**. For a maintenance window, choose the local time at which each Player may install.
4. Set **Canary screens** if you want the remaining targets to wait until every canary reconnects. Use `0` to deploy to all selected targets at once.
5. Review the confirmation, then select **Deploy update**.

Offline Players begin after they reconnect. Canceling a deployment stops screens that haven't finished; screens already updated stay on the new release.

## Platform limits

- **Android:** the operating system may require local installation permission or approval on each TV. Plan for someone to handle the prompt at the display.
- **Linux:** this update path applies to Players running as a managed AppImage. Each Linux Player restarts into the new version.
