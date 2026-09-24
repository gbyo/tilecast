---
title: Pair or replace a screen
description: Approve a Tilecast Player, repair its credential, or replace Player hardware while keeping the screen's assignments.
---

Pairing gives a Tilecast Player its own credential to connect to Tilecast Server. Use the same approval flow to enroll a new screen, repair a Player installation, or move an existing screen to replacement hardware.

## Before you start

- Sign in as an **Owner** or **Administrator**. Editors and Viewers can monitor screens, but can't approve or reject pairing requests.
- Connect Tilecast Player to the intended server. The Player must show its pairing code while you approve it.

## Approve a Player

1. On the display, open Tilecast Player and connect it to the Tilecast Server for this installation. Leave the pairing code visible.
2. In Studio, open **Screens** > **Fleet**, then select **Pair screen**.
3. Enter the six-character code in **Pairing code**, then select **Find player**. If the request is already listed under **Pending pairing requests**, select **Review** instead.
4. Check the Player's reported platform and device details on **Review this player**. Approve only a device you recognize.
5. Choose a **Pairing destination**:

   - **Create new screen** creates a new logical screen. Enter a **Screen name**; location, room, and description are optional.
   - **Repair existing credential** keeps the same Player installation on its existing screen. This option appears when the Player installation was paired before and has an active credential.
   - **Replace hardware for an existing screen** attaches different hardware to an existing logical screen. Select the screen being replaced.

6. Finish the selected path:

   - New screen: select **Approve and pair**.
   - Credential repair: select **Repair and replace credential**, review the confirmation, then select **Confirm pairing**.
   - Hardware replacement: select **Replace hardware**, review the confirmation, then select **Confirm pairing**.

7. Keep the Player connected until it completes enrollment.

The request expires after ten minutes. If the code expires before approval, create a new pairing request on the Player.

## Replace a broken Player

Choose **Replace hardware for an existing screen** when the old physical device is gone or unusable. Tilecast keeps the logical screen and its Display Group membership, content assignments, schedules, policies, and history. It retires the old device credential only after the new Player completes enrollment.

:::caution
Start from the pending request and select the existing screen in the replacement flow. Revoking or archiving the old screen first removes it from the active fleet and does not use the hardware-replacement flow.
:::

Choose **Repair existing credential** only when the same Player installation is still in use. A credential repair keeps that screen and its content assignments; the old credential is replaced after the Player enrolls again.

## Next steps

- [Manage Display Groups](../display-groups/) to put screens on shared content and schedules.
- [Set Player policies](../../administration/player-policies/) to configure inherited playback and device behavior.
