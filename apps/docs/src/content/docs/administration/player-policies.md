---
title: Set Player policies
description: Choose organization defaults and override them for a Display Group or an individual screen.
---

Player policies control playback and device behavior such as caching, synchronization, website handling, reliability, power, accessibility, and updates. Set organization defaults in **Settings**. Use a Display Group or screen override when some Players need different behavior.

## Where to change a policy

- Set organization defaults in the relevant section under **Settings**, such as **Playback**, **Websites**, **Reliability and kiosk**, or **Active hours and power**.
- Set a Display Group policy on the group's page.
- Set a screen policy under **Screens** > **Fleet**, open the screen, then open **Settings**.

Only Owners and Administrators can change Player policies. The editor groups settings under **Playback**, **Storage and downloads**, **Synchronization**, **Websites**, **Reliability and kiosk**, **Active hours and power**, **Accessibility control**, and **Player updates**. Search by setting name or use **Overridden only** to find values already set for that group or screen.

## Understand which value a screen uses

Tilecast applies the most specific value that is set:

1. A screen override.
2. Its Display Group policy.
3. The organization default.
4. Tilecast's built-in default.

The screen's effective policy shows the value and its source. Select **Revert** to remove one override and inherit the next value. **Reset all overrides** clears every override for that screen or group.

## Check platform requirements

Some settings apply only to Android or Linux Players, or require a capability that must be enabled on the device. For example, Android **Managed Kiosk** depends on device-policy capability, and **Accessibility Control Assist** needs deliberate local enablement on Android. Read each setting's description before applying it to a group or fleet.

See [Manage Display Groups](../../screens/display-groups/) to create a group and choose its members.
