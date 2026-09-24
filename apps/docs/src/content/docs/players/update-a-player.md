---
title: Update a Player
description: Cache a verified release and deploy it to selected Android or Linux screens.
---

Use **Settings** > **Player updates** to choose and deploy a verified Android or Linux release. Updating a release does not update Tilecast Server, Docker, or the host operating system.

## Prepare the release

1. Open **Settings** > **Player updates** in Studio.
2. Select **Android** or **Linux**.
3. If you need a GitHub release that is not listed yet, select **Sync from GitHub**. Only an Owner can synchronize releases.
4. Select **Download** beside the release. Wait until its status is **Ready to deploy**. Only a cached and verified release can be deployed.

## Deploy to screens

1. Under **New deployment**, choose the verified release.
2. Choose **Download only** to stage the release without installing it, **Download and request installation** to ask the Player to install it as soon as it can, or **Maintenance window** to install it at or after the selected local time on each screen.
3. Select the target screens or Display Groups. The targets must use the same Player platform as the release.
4. If you choose a canary rollout, select the canary count. Set **Canary screens** to `0` to send the update to all selected targets at once.
5. Select **Deploy update** and confirm the deployment.

An offline screen receives the update after it reconnects. Use **Deployment history** to check each screen. Cancelling a deployment stops screens that have not finished; it does not roll back screens that already updated.

## What to expect on each platform

- **Android:** The Player downloads and verifies the APK. Android may require the install permission on the Player and may show a local install confirmation. The first-time checklist includes **Allow signed Player updates**.
- **Linux:** The managed AppImage downloads and verifies the release, replaces the running file, and restarts. The AppImage and its parent directory must be writable by the kiosk account. Use the [server-provided Linux installation](../install-linux/) to create the supported managed setup.

If an Android TV is waiting for someone to approve the install, complete the prompt on that TV. If a Linux update fails, confirm that Tilecast Player is running from the installed AppImage and that the kiosk account can write to its file and directory.
