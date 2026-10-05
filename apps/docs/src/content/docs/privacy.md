---
title: Privacy
description: What tilecast.org and the Tilecast software collect, and what they don't.
lastUpdated: true
---

This page covers two things: the Tilecast documentation site at tilecast.org, and the Tilecast software you install yourself.

## This website

tilecast.org is a static site hosted on GitHub Pages. It doesn't have accounts, forms, comments, or advertising.

- **Website analytics.** tilecast.org uses [Microsoft Clarity](https://clarity.microsoft.com/) to understand how people use the site, including page visits, clicks or taps, scrolling, device and browser information, and session replays. Tilecast uses this information to improve the website and documentation, not for advertising.
- **Cookies and browser storage.** Microsoft Clarity may use cookies and similar browser technologies to measure visits and sessions. Separately, if you change the theme with the picker in the page header, your browser keeps that choice in local storage so the next page loads in the same theme.
- **Search runs in your browser.** The search index is downloaded with the page assets, and queries are matched on your device. They aren't sent to a server.
- **Third-party service.** The site loads the Clarity script from Microsoft and sends analytics data to Microsoft. Other site assets such as fonts and documentation images are served with the site rather than loaded from third-party asset hosts. Microsoft describes its data practices in the [Microsoft Privacy Statement](https://privacy.microsoft.com/en-us/privacystatement).

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
