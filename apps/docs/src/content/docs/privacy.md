---
title: Privacy
description: What data Tilecast stores, where it stays, and which outside services it contacts.
lastUpdated: true
---

Tilecast is software you run yourself. This page describes what Tilecast Server, Studio, and Tilecast Player record, where that data lives, and what leaves your installation. The last section covers the tilecast.org website.

## Who holds your data

The organization that runs the installation holds all of its data. The Tilecast project doesn't host installations, doesn't receive copies of them, and can't see them. Tilecast has no telemetry, crash reporting, or analytics that sends anything to the project.

That makes your organization responsible for the data in your installation. If people outside your team appear in it, such as students, patrons, or members, tell them what you record and how long you keep it.

## What an installation stores

Everything below lives in your installation's PostgreSQL database or media volume.

| Data                | What is recorded                                                                                                              | Who can see it                                                |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Accounts            | Name, username, role, password hash (Argon2id), sign-in time, and any second factor you enable                                | Owners and Administrators manage accounts                     |
| Sessions            | A hash of the session token, expiry, and last-seen time. The token itself is never stored                                     | Server only                                                   |
| Audit log           | Who changed what and when, plus the IP address of the request. Passwords, tokens, and credentials are never written to it     | Owners and Administrators see IP addresses. Other roles don't |
| Screens and Players | Screen name and location, Player platform, version, and hardware details, and a hash of each Player's credential              | Signed-in users, by role                                      |
| Playback records    | What a Player confirmed it displayed, on which screen, and for how long                                                       | Signed-in users, by role                                      |
| Player health       | Latest status per screen and five-minute summaries: connection quality, memory, CPU, storage, dropped frames, display state   | Signed-in users, by role                                      |
| Content             | Media files, playlists, layouts, schedules, and Data Source settings. Uploaded file names are stored as descriptive text only | Signed-in users, by role                                      |
| Backups             | A copy of the database and media                                                                                              | Whoever can reach the backup storage                          |

Playback records and health data describe screens, not the people who watch them. Player health data is limited to a fixed set of measurements. It doesn't include Wi-Fi network names, hostnames, IP addresses, or web addresses. Tilecast Player for Android TV doesn't request camera, microphone, or location permissions.

Passwords are stored only as Argon2id hashes. If you enable authenticator-app sign-in, the server keeps that app's secret so it can check codes. Treat backups as sensitive for that reason. See [Sign-in security](../administration/sign-in-security/).

## How long data is kept

Activity data is deleted automatically after a retention period. Owners can change these periods under the Activity settings, within the limits shown.

| Data                         |  Default | Allowed range |
| ---------------------------- | -------: | ------------: |
| Raw Player events            |  60 days |    7–365 days |
| Playback sessions            | 365 days | 30–2,555 days |
| Screen-state history         | 365 days | 30–2,555 days |
| Audit logs                   | 730 days | 90–3,650 days |
| Detailed diagnostic metadata |  30 days |    7–180 days |
| Health summaries             |  30 days |    7–400 days |

Accounts, content, and screens stay until someone removes them. Backups keep what they contained when they were made. Delete old backups if you need the data gone from them too. See [Activity](../operations/activity/) and [Backups](../administration/backups/).

## Connections to outside services

The server makes an outside request only when a feature that needs one is in use. The service on the other end sees your server's IP address and applies its own privacy policy.

- **Player updates.** **Sync from GitHub** in **Player updates** contacts github.com to list and download signed Player releases. You can upload releases by hand instead. See [Update Tilecast Player](../administration/player-updates/).
- **Weather Data Sources.** The server requests forecasts from MET Norway for the locations you configure. Coordinates and contact details stay on the server and don't go to Players.
- **Emergency Alerts.** If you turn on monitoring, the server requests alerts from `api.weather.gov`.
- **Websites, Data Sources, and streams.** Anything you point a Widget or Player at is fetched from the address you enter.
- **Email and webhooks.** Notifications go to the SMTP relay and webhook addresses you configure, and they contain the incident details.
- **Tunnels and proxies.** If you publish Tilecast through a service such as Cloudflare Tunnel, that service can see the traffic and handles it under its own terms.

Discovery on the local network uses multicast DNS and stays on that network.

## Tilecast on iPhone and iPad

The iOS app is a host for Studio. It stores the list of servers you added in its own storage on the device, without passwords, and keeps each server's sign-in session in a separate browser store that it deletes when you remove the server. It doesn't include analytics or advertising code.

## This website

tilecast.org is a static site on GitHub Pages. It has no accounts, forms, or advertising, and it loads no analytics, tracking scripts, or third-party fonts and images.

- The site sets no cookies. If you change the theme, your browser keeps that choice in local storage on your device.
- Search runs in your browser and sends nothing to a server.
- GitHub serves the pages, so GitHub receives your IP address and browser details and may keep logs. The Tilecast project can't see them. See the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).
- Links to github.com go to GitHub, which applies its own policies.

## Questions and changes

Ask questions in [GitHub issues](https://github.com/gbyo/tilecast/issues). To report a security problem, follow [SECURITY.md](https://github.com/gbyo/tilecast/blob/main/SECURITY.md) and don't open a public issue.

Changes to this page appear in the repository history and in the "Last updated" date above.
