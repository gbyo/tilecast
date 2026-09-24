---
title: Send a Player command
description: Request a maintenance action from one or more paired Players.
---

An Owner or Administrator can send a fixed Tilecast command to a paired screen. Available controls depend on the Player's platform and reported capabilities.

## Send a command to one screen

1. Open **Screens** > **Fleet** and select the screen.
2. Open **Device** > **Maintenance**.
3. Choose an available action, such as **Sync now**, **Reload playback**, **Clear media cache**, or **Restart the Player**.
4. Check the command status in the screen's **Maintenance** section or in **Activity**.

Studio reports that a command was queued; this does not mean the Player completed it. The Player must collect the command and report its result. A command cannot be undone after the Player collects it, and commands may expire before a disconnected Player reconnects.

## Send the same command to several screens

1. Open **Screens** > **Fleet** and select **Bulk changes**.
2. Select the screens and the command.
3. Select **Preview the change** and review which screens will change, including screens added through a Display Group.
4. Apply the change and check the per-screen results.

The preview lists screens that cannot receive the command. Commands that a Player has already collected cannot be undone.
