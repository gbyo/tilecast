---
title: Privacy
description: What tilecast.org and the Tilecast software collect, and what they don't.
lastUpdated: true
---

This page covers two things: the Tilecast documentation site at tilecast.org, and the Tilecast software you install yourself.

## This website

tilecast.org is a static site hosted on GitHub Pages. It doesn't have accounts, forms, comments, or advertising.

- **No analytics.** The site doesn't load Google Analytics or any other tracking or measurement script, and the project doesn't count visitors.
- **No cookies.** The site doesn't set cookies.
- **Stored in your browser.** If you change the theme with the picker in the page header, your browser keeps that choice in local storage so the next page loads in the same theme. It stays on your device and is never sent anywhere.
- **Search runs in your browser.** The search index is downloaded with the page assets, and queries are matched on your device. They aren't sent to a server.
- **No third-party assets.** Pages don't load fonts, scripts, or images from other companies.

GitHub serves the site, so GitHub receives your IP address and browser details when you load a page, and it may keep server logs. The Tilecast project doesn't get access to those logs. GitHub describes its own practices in the [GitHub privacy statement](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement).

Links to github.com, including the repository and its releases, take you to GitHub, which applies its own policies.

## The Tilecast software

Tilecast is self-hosted. Tilecast Server, Studio, and Players run on hardware you control, and their data stays there: accounts, media, screens, schedules, and activity records are stored in your installation's PostgreSQL database and media volume. The Tilecast project doesn't operate a cloud service, and the software doesn't send usage data, crash reports, or analytics to the project.

Your organization decides who can see that data and how long it's kept. If you run Tilecast for other people, such as students, patrons, or staff, you are responsible for telling them what your installation records. See [Activity](../operations/activity/) and the retention settings in Studio for what is kept and for how long.

Two features connect to outside services, and only when an administrator uses them:

- **Player updates.** **Sync from GitHub** in **Settings** > **Player updates** makes your server contact github.com to list and download signed Player releases. GitHub sees your server's IP address, as it would for any download. You can upload releases by hand instead. See [Update Tilecast Player](../administration/player-updates/).
- **Content you add.** Websites, data sources, and streams you configure are fetched from the addresses you give. Those services see requests from your server or displays and apply their own policies.

If you put Tilecast behind a service such as Cloudflare Tunnel, that service handles your traffic under its own terms.

## Contact and changes

Questions about this page can go to the project's [GitHub issues](https://github.com/gbyo/tilecast/issues). To report a security problem, follow [SECURITY.md](https://github.com/gbyo/tilecast/blob/main/SECURITY.md) instead of opening a public issue.

If this page changes, the change appears in the repository history and the "Last updated" date above.
