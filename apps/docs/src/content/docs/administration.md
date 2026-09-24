---
title: Administration
description: Manage accounts, sign-in security, settings, backups, and Player releases for a Tilecast installation.
---

Administration covers the parts of Tilecast that keep an installation secure and recoverable. Most of it lives under **Settings** in Studio, and most of it needs the **Owner** or **Administrator** role.

## Accounts and sign-in

Each person signs in to Studio with their own local account. Tilecast doesn't use a shared login or an outside identity service.

Anyone can protect their own account with a second factor from **My Account** > **Sign-in security**:

- An authenticator app, which works on every installation.
- A passkey, which needs HTTPS and a hostname. Browsers don't allow passkeys on plain HTTP or when Studio is opened by IP address.
- Recovery codes, which let someone sign in if they lose their other factor.

To require a second factor, an Owner or Administrator sets **Settings** > **Sign-in security** > **Require multi-factor authentication** for administrators only or for every account. Someone who hasn't enrolled yet can still sign in, but Studio only lets them set up a factor until they finish. That way a policy change can't lock the installation out.

## Settings and Player policies

Organization settings include your organization's name, branding, locale, time zone, and date and time formats.

Player policies control how Players behave, such as playback, caching, and reliability options. When the same policy is set in more than one place, the most specific value wins:

1. A value set on the screen itself.
2. The screen's Display Group policy.
3. The organization default.
4. Tilecast's built-in default.

Studio shows the effective value for each screen and where it came from.

## Backups

In Studio, **Settings** > **Backup and restore** can create, verify, download, schedule, and restore full installation backups.

:::caution
A backup contains every account's authenticator app secret. Anyone who can read a backup can generate sign-in codes for those accounts. Store backups where only trusted administrators can reach them.
:::

If you use Presentation Networks, `TILECAST_PRESENTATION_NETWORK_KEY` isn't included in backups. Keep a copy of it with your other deployment secrets.

## Player releases

Tilecast Server can update Players with signed releases from the [Tilecast GitHub releases](https://github.com/gbyo/tilecast/releases). An Owner adds a release to the installation. An Owner or an Administrator then deploys it to chosen screens or Display Groups, so you can update a few displays first.

On Android, the Player needs a one-time local permission to install app updates. The Player's setup steps ask for it. On Linux, the Player replaces its own AppImage.

## Go further

- [Settings and player policies](https://github.com/gbyo/tilecast/blob/main/docs/settings.md)
- [Multi-factor authentication and passkeys](https://github.com/gbyo/tilecast/blob/main/docs/multi-factor-authentication.md)
- [Player updates](https://github.com/gbyo/tilecast/blob/main/docs/player-updates.md)
