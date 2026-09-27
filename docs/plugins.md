# Installable built-in plugins

Tilecast plugins are release-owned optional capabilities. A Tilecast release defines which plugins are available; an organization explicitly installs the ones it uses. Installing does not download executable code.

Plugins add bounded workflows or affect Player behavior outside normal playlist items and Layout zones. Their implementation is compiled into the server and Players. Player-facing plugins are projected into each targeted screen's authenticated manifest; workflow plugins need not add manifest entries of their own. Tilecast does not load third-party code, download plugins, accept arbitrary plugin manifests, or update a plugin separately from Tilecast itself: updating Tilecast updates its plugins.

## Catalog, installation, and removal

Each plugin is a directory below `plugins/` with a `tilecast.plugin.json` manifest; [plugin-api.md](plugin-api.md) is the contract. The server registry is generated from those directories and compiled into the binary. Each definition carries a stable identifier, a definition version, name, description, category (Display, Automation, Workflow, or Hardware), a bounded icon identifier, the Studio route that manages it, instance nouns, and declarative requirements and capabilities. Requirements are advice shown before installation; they are never evaluated, and a plugin may be installed before any compatible Player is paired. The catalog lists plugins by name.

Installation state is one row per plugin in `plugin_installations`. The row records only that the organization installed the plugin, who installed it, and when. Each plugin keeps its real configuration in its own tables — Countdown Bar in `countdown_bar_instances`, Emergency Alerts in `alert_monitor` and `alert_rules`, and so on. There is deliberately no generic configuration column and no separate enabled flag: installed is the lifecycle, and enabling or disabling individual instances stays inside each plugin.

The catalog reports three separate questions for every plugin:

| Plugin                | Configured                         | Active                        | Instances   |
| --------------------- | ---------------------------------- | ----------------------------- | ----------- |
| Countdown Bar         | at least one instance              | at least one enabled instance | instances   |
| Brand Bug / Watermark | at least one mark                  | at least one enabled mark     | marks       |
| Noise Meter           | at least one meter                 | at least one enabled meter    | meters      |
| Forms                 | at least one form                  | at least one form             | forms       |
| Emergency Alerts      | areas or zones chosen, or any rule | monitoring switched on        | alert rules |

An installed Emergency Alerts plugin with monitoring off is a valid state. `attention` carries bounded advisory notes, such as a Noise Meter installed before any Linux Player is paired, monitoring switched on with no alert rule, or a failing NWS poll. Feature data that exists without an installation — after a restore or a manual database edit — is reported as `data_without_installation` and has no runtime effect.

**Install** (`POST /api/v1/plugins/{pluginId}/install`) requires Owner or Administrator and the session CSRF token. It answers `201 Created` the first time and `200 OK` with the same representation when repeated, records a `plugin.installed` audit event with the definition version, and revises every screen manifest for a Player-facing plugin. An identifier the release does not know answers `404 plugin_not_found`.

**Remove** (`DELETE /api/v1/plugins/{pluginId}/installation`) has the same authorization and is idempotent. It never deletes plugin data. While plugin-owned resources remain it answers `409 plugin_in_use` with the resources in `error.details`. Each resource has a `resolution`: `delete` (delete it through the plugin's page), `disable` (switch it off), or `wait` (it clears by itself when the others are gone). Studio explains the next step from the resolution:

| Plugin                | Removal is blocked while                                                        |
| --------------------- | ------------------------------------------------------------------------------- |
| Countdown Bar         | any instance exists                                                             |
| Brand Bug / Watermark | any mark exists                                                                 |
| Noise Meter           | any meter exists (history belongs to its meters and does not block on its own)  |
| Forms                 | any form that has not been deleted exists                                       |
| Emergency Alerts      | monitoring is on, any alert rule exists, or an alert activation has not cleared |

To remove Emergency Alerts, switch monitoring off and delete the rules through its page; deleting a rule already clears its live activations. A successful removal records `plugin.removed` and revises every screen manifest for a Player-facing plugin.

Configuration routes refuse a plugin that is not installed with `409 plugin_not_installed` rather than installing it implicitly. That covers creating or updating Countdown Bar, Brand Bug, and Noise Meter instances, creating a form, changing the NWS monitor, saving an alert rule, and polling NWS by hand. Deleting leftover instances stays possible so inconsistent data can be cleaned up.

### Runtime gating

Installation is the top-level runtime gate: a plugin must be known to the running release **and** installed.

- **Manifests.** An uninstalled plugin contributes no manifest entries, whatever its own tables contain. Install and remove use the existing manifest revision and Player notification path; no parallel revision system exists.
- **Emergency Alerts.** The NWS poller makes no upstream request while the plugin is uninstalled, even if the monitor row says monitoring is on.
- **Noise Meter.** Heartbeat noise history for an uninstalled Noise Meter is consumed and dropped, not rejected, so a Player never retries the same batch forever.
- **Forms.** The time-window worker skips forms while Forms is uninstalled. Normal operation cannot reach that state because removal is refused while forms exist; the check protects restored or edited databases.

A Player or Tilecast Edge node that already holds a valid cached manifest keeps honoring it offline under the ordinary manifest rules, exactly as for any other server configuration change. Players and Edge nodes never install plugins, never receive plugin code, and never decide whether a plugin exists; the Edge daemon-to-renderer `plugin.state` message is runtime state, not installation state.

### Existing installations and fresh installs

Migration `00102_plugin_installations.sql` installs a plugin on an existing installation only when its data shows the plugin in use: any Countdown Bar, Brand Bug, or Noise Meter instance (enabled or not), any form that has not been deleted, or Emergency Alerts monitoring switched on or any alert rule. The disabled NWS monitor row the earlier migration seeds is not evidence of use. A fresh installation starts with no plugins installed.

### Unknown installations and downgrades

A database restored from a newer release may name a plugin this release does not know. Startup succeeds, the row is kept, nothing runs or is projected for it, and the catalog lists it under `unsupportedInstallations`. An administrator may remove such a row explicitly through the same Remove endpoint; that deletes the installation row only and never touches tables this release cannot reason about.

### Backups

`plugin_installations` is an ordinary table, and full backups dump every table in the public schema, so installation state is backed up and restored with everything else. There is no plugin-specific archive component.

### Studio

**Plugins** lists installed plugins only, each with its instance count and one status — Needs setup, Configured, Active, or Attention. **Add plugin** opens a searchable catalog filtered by category; installed plugins are left out of the default list and reappear, marked, when a search matches them. Choosing a plugin shows its requirements and what it uses before **Install**, and a successful install opens the plugin's page. Remove plugin sits in the overflow menu on each plugin's page and explains what still uses the plugin when removal is blocked.

Studio discovers each plugin's routes and icon from `plugins/<name>/studio/index.tsx` when the bundle is built, so the routes stay registered whether or not the plugin is installed. Opening an uninstalled plugin's page shows how to install it — with an Install button for Owners and Administrators — and never installs it by opening the link. Global search offers installed plugins as ordinary destinations and uninstalled ones as "Not installed", opening Add plugin on that plugin. Studio renders a registry entry it does not recognize with a generic icon rather than dropping it.

## Forms

Forms collects submissions, applies review and approval workflows, and exposes approved records to Widgets and Layout bindings. Once Forms is installed, operators create and manage forms at **Plugins → Forms**. Submitters continue to use **My Forms**, and reviewers may use the central Approvals inbox.

Forms remains a typed Data Source provider in the internal content contract because its approved records are reusable signage data. That implementation detail does not make a form an external data connection: Studio omits Forms from the Data Sources library and creation gallery, and legacy `/data-sources/...` form links redirect to the canonical `/plugins/forms/...` routes.

Forms does not add a Player plugin manifest entry. Its published views flow through the ordinary authenticated Data Source projection used by Widgets and Layout bindings.

## Dependency Explorer is a system tool

Dependency Explorer is not a plugin: it has no installation and no instances, and projects nothing to Players. It lives at **Settings → System tools → Dependency Explorer** (`/settings/dependency-graph`); the old `/plugins/dependency-graph` address redirects there. Its API remains at `GET /api/v1/plugins/dependency-graph` for now. Because it is a spatial tool, Settings gives it the full content width and moves the section list into a **Settings sections** Sheet; every other section keeps the permanent section column.

It maps Data Sources, media, Widgets, Layouts, playlists, Campaigns, schedules, sync groups, and screens. Edges point from a dependency to its consumer. Following them forward answers where a change can appear; following them backward answers what feeds a presentation or screen. Every resource links to its canonical Studio surface.

The explorer uses progressive disclosure so it stays readable with hundreds or thousands of resources:

- **Overview.** With nothing selected it draws one node per resource type, with its count, in three labelled stages — Sources (Data Sources, Widgets, media), Presentations (Layouts, playlists, Campaigns), and Delivery (schedules, Display Groups, screens) — and one edge per type pair. Selecting a type highlights its edges with their relationship counts and lists its resources in the inspector without adding them to the graph.
- **Search is navigation.** The resource search groups matches by type. Choosing one makes it the root.
- **Focus.** The root sits in the centre column; direct dependencies are one column to its left, their dependencies two, and consumers likewise to the right. Direction (Dependencies, Both, Consumers) and depth (1, 2, or 3 hops, or All) re-derive and re-lay out the visible graph; the defaults are Both and 2 hops. Zoom and Fit act on the visible graph only.
- **Large fan-out.** When one visible node connects to eight or more leaf resources of one type — screens that consume nothing further, or media that depend on nothing — and nothing else visible connects to them, they appear as one node such as “30 screens”. Selecting it lists them in the inspector, where **Show on graph** expands them. Resources that lead further, or that another visible node also reaches, are never grouped.
- **Inspector.** On desktop it is a resizable pane beside the graph; on narrow screens it opens in a Sheet. It shows the selected resource's type, an Open resource link, total dependency and consumer counts, and its direct dependencies and consumers with their relationships. Selecting a row makes that resource the root.

The query string carries the view, so a focused view can be shared and browser Back and Forward move between views: `?node=<type>:<id>` selects the root, `direction` and `depth` appear only when they differ from the defaults, and `?type=<type>` browses a type from the overview. A missing or unknown node falls back to the overview.

The graph uses the same stored dependency records and assignment tables as playback and the existing “Used by” panels. Deleted content, deleted groups and schedules, and archived screens are excluded. A screen-scoped account sees only the screen nodes and screen-targeting edges allowed by the same scope used for the Screens list; the shared content library remains organization-wide.

## Countdown Bar

Countdown Bar was the first built-in plugin. An installation can create multiple instances, each with its own name, message, schedule, lead time, optional completion text and confetti, display mode, height, horizontal padding, text size, background countdown, urgency stages, enabled state, priority, and targets.

Weekly instances use an IANA timezone, a wall-clock target time, and one or more days where Sunday is `0` and Saturday is `6`. One-time instances use an absolute RFC 3339 target. A bar is active from its configured lead time until the target. When completion text is configured, it replaces the countdown message and value for one minute after the target; otherwise the bar hides at zero. Optional confetti falls from the top for several seconds when the selected countdown reaches zero, independently of whether completion text keeps the bar visible. Reduced-motion settings suppress the effect where the platform exposes that preference. If active instances overlap, the Player shows the highest priority instance, then the earliest target, then the stable instance ID.

Targets are one of:

- all active screens;
- one or more individual screens;
- one or more sync groups; or
- one or more locations.

### Background countdown

`progressFill` controls the bar's background. `none` leaves it plain. `drain` tints the whole bar when the lead window opens and retreats the tint leftward as the target approaches, so the bar holds only its background colour at zero — the elapsed share of the lead window, read as a shrinking block rather than a number. While completion text shows, the fill stays empty.

The fill is a share of the configured lead time, not of a fixed span: a fifteen-minute lead empties over fifteen minutes and a two-minute lead over two. Players animate between the once-a-second steps, which smooths the sweep without implying a finer clock than the Player has, and honour a reduced-motion preference where the platform exposes one.

`progressFill` is optional on the wire. An omitted value is stored as `none`, and a Player released before the field existed ignores the key and draws the bar exactly as before.

### Text fit

`contentPadding` is the percentage of the bar width reserved on both the left and right. It defaults to `4`; lowering it toward `0` lets text use more of the bar. `textScale` multiplies the height-derived type size and defaults to `100`. Studio accepts padding from 0–40 percent and text size from 25–500 percent. Players clamp both values defensively, and older manifests that omit them retain the original appearance.

### Urgency stages

Urgency stages are opt-in per instance. For the default fifteen-minute lead window, they enter **Starting soon** five minutes before the target with an orange bar, enter **Urgent** at 60 seconds with a red bar, and pulse in the final ten seconds. Untouched thresholds follow changes to the lead window at those same proportions; once an operator edits a threshold, that value stays fixed while the other untouched defaults continue to follow the lead window. Studio requires the resulting thresholds to remain ordered. During the pulse stage, the bar height and text grow by 25 percent. At zero the bar returns to its configured height and text size while completion text is visible, or disappears immediately when no completion text is configured. Players suppress the pulse animation when the platform exposes a reduced-motion preference.

Changing an instance increments the manifest revision for every screen. The next authenticated manifest contains only enabled instances that apply to that screen.

## Emergency Alerts

Emergency Alerts watches official National Weather Service alerts and takes matching screens over automatically while one is active. It is a plugin rather than an organization default: an installation opts into monitoring, and the alert rules are its instances. Settings keeps only the defaults for a Takeover a person starts by hand and for player commands.

The catalog reports the plugin as active when monitoring is on — a monitor switched on with no rule yet is a half-finished setup, and the catalog flags it — and its instance count is the number of alert rules.

### Response mode

A rule answers a matching alert in one of two ways, chosen per rule as `responseMode`.

`takeover` raises an ordinary Takeover through the existing bounded playback-override machinery, so Player behavior is exactly Takeover behavior. It shows either Tilecast's live fullscreen alert or a custom playlist, and normal playback is restored when the alert clears.

`ticker` leaves playback running and delivers the alert as a bar along the bottom of the screen, through the same manifest `plugins` channel and the same `overlay`/`push` geometry as Countdown Bar. It raises no Takeover, owns no managed Data Source, Widget, or playlist, and has nothing to restore: the bar is gone once the screens hold a manifest without it. `tickerDisplayMode`, `tickerHeightPx`, and `tickerSpeed` (`slow`, `medium`, or `fast`) give the bar its shape. A ticker always shows the live alert; asking for a ticker and a custom playlist together is rejected rather than resolved in one direction, because a playlist is fullscreen content by nature.

Both responses use the same matching, the same `maximumDurationMinutes` ceiling, and the same targets. Changing a rule's response mode clears its live activations so the next poll answers the same alert in the new form.

Its configuration endpoints predate the plugin catalog and are unchanged, under `/api/v1/alerts/nws/`. See [takeover-and-operations.md](takeover-and-operations.md) for the monitor, rule matching, and poll health.

## Brand Bug / Watermark

Brand Bug places a persistent mark — a logo, sponsor mark, legal notice, campaign badge, or location label — in one corner over all normal content. An installation can create multiple instances, each with its own name, corner, optional logo image, optional text, size, opacity, margin, text color, backing, optional date window, enabled state, priority, and targets.

An instance needs a logo, text, or both; a mark with neither would hold a corner invisibly and is rejected. The optional logo comes from the Media library and, when configured, must be a ready image; it is projected into the manifest as an ordinary asset, so the Player verifies, caches, and redraws it exactly like playlist media.

Sizes are expressed against the screen rather than in pixels, so one instance reads the same on a 1080p panel and a 4K one:

- logo width is 2–40 percent of screen width;
- text size is 1–12 percent of screen height;
- the corner margin is 0–20 percent of the screen's shorter edge;
- opacity is 10–100 percent.

`startsAt` and `endsAt` are both optional. An unset bound is open-ended, so a permanent logo carries neither and a campaign badge carries one or both. The window is evaluated locally against the corrected clock, the same way Countdown Bar evaluates recurrence.

At most one mark occupies a corner: the highest priority wins, then the stable instance ID. Marks in different corners appear together, so a logo can hold the top right while a legal notice holds the bottom left. Targets use the same four scopes as Countdown Bar.

## Noise Meter

Noise Meter watches how loud the room in front of a screen is and shows a bottom bar only while it stays too loud. It is measured on the player itself: an ordinary USB microphone plugged into the mini PC, read through the player's own audio stack. An installation can create multiple instances, each with its own name, message, warning level, too loud level, sensitivity, show delay, hide delay, display mode, height, optional display window, enabled state, and targets. Targets use the same four scopes as Countdown Bar.

Noise Meter currently runs on **Linux Player only**. Android Player ignores the plugin type, so a configured meter is inert there rather than an error.

### What stays on the player

Nothing about the audio leaves the device. The player opens its default microphone, reads a running window of the waveform, reduces it to one number, and overwrites the window. It creates no recording, keeps no audio, sends no samples to the Tilecast server, and never plays the microphone back through the display's speakers. The only thing that travels out of the renderer is a diagnostic line when the microphone cannot be opened.

Microphone access is granted by the Linux player's main process to exactly one surface — the trusted player renderer — and only for audio. Website items, which render in `<webview>` under their own partitioned sessions, are refused capture outright.

### The scale is relative

The displayed value is a **Noise Level** from 0 to 100, relative to whatever microphone happens to be plugged into that player. It is not dB, dBA, SPL, or any other calibrated physical measurement, and Studio, the manifest, and the bar all avoid presenting it as one: a generic USB microphone has no known gain or sensitivity to calibrate against. Internally the player computes an RMS level, expresses it in dBFS against a fixed floor, and maps that onto 0-100. Sensitivity is a percentage applied before normalization, for a microphone that reads quiet or hot; it is not a calibration step.

### Showing and hiding

Two thresholds and two delays, so the bar cannot flap:

1. Below the too loud level, the bar is hidden.
2. A brief spike does nothing. The level has to stay at or above the too loud level for the configured show delay.
3. Once it does, the bar slides up from the bottom and the meter keeps moving in real time.
4. When the level falls below the warning level, the hide timer starts.
5. The bar hides only after the level has stayed below that level for the configured hide delay.
6. A room that gets loud again during that wait cancels the timer and the bar stays up.

Studio requires the warning level to be below the too loud level, and both the server and the player enforce it: one threshold used for both directions is exactly what makes a bar blink on and off while a room hovers around it.

If there is no microphone, permission is refused, the input disappears, or the audio context fails, the meter fails open — the bar hides, signage continues untouched, the failure is logged, and the player retries about every ten seconds while an applicable instance remains enabled. It also listens for device changes, so a microphone plugged back in recovers in seconds. Unplugging one takes the bar down rather than freezing it at the last level.

Because a screen has one microphone, only one meter can run on it. When more than one enabled instance applies, the server projects the lowest stable instance ID and the player picks the same one, rather than exposing another priority for operators to tune.

### When the bar can show

By default a too-loud room may raise the bar at any time. An instance can instead name a window: days of the week, a start, an end, and an IANA timezone. Outside the window the room is still measured and history still accumulates — the bar stays down and nothing else changes.

The window is half-open, so a start of `08:00` is inside it and an end of `15:30` is not, and two adjacent windows cannot both claim the same minute. An end at or before the start is an overnight window belonging to the start day, the same daily-window semantics active hours and content schedules use. Studio requires a window that is switched on to name at least one day and two different times; one that could never open would hide the bar permanently.

The Player evaluates the window locally against its own corrected clock, so a temporary server outage cannot leave the bar showing outside its window. A window that cannot be read — an unknown timezone, an unparseable time — is treated as no window at all: a room that is too loud is the condition this plugin exists to report, and a bad setting must not be what silences it. When nothing else wants the microphone, a closed window also stops capture rather than measuring for a bar that cannot appear.

Emergency alerts are unaffected: an alert ticker outranks the Noise Meter whether or not its window is open.

### Noise history

History is on by default and stores derived measurements so the plugin can draw graphs, report statistics, and export CSV. It changes nothing about what is measured: the live analysis stays on the player, and no audio, waveform, or sample is recorded, kept, or uploaded.

The player aggregates its live readings into fixed ten-second buckets while history is enabled. Each completed bucket carries the average and peak relative level, how much of the bucket the microphone actually covered, how long it spent in the warning and too-loud bands, and how many times the meter tripped. Durations are accumulated as they happen rather than inferred afterwards from an average — an average of 70 cannot say whether a room spent ten seconds there or five seconds at 40 and five at 100. Bucket boundaries are a fixed grid rather than "ten seconds after the last one", so a restart, a reconnect, or a retry produces the same slots instead of overlapping windows. Ten seconds is the internal resolution and is not configurable.

Completed buckets are handed to the player's trusted core, which owns a durable local queue. The queue survives renderer reloads, player restarts, network outages, and server downtime, and it is bounded: records past the configured retention window are dropped, and a hard ceiling of about a week of continuous monitoring keeps a permanently offline player from filling a disk.

### Delivery on the ordinary heartbeat

History travels on the standard authenticated Player heartbeat. There is no upload interval, no second heartbeat, no websocket stream, and no request per bucket — microphone processing runs fifteen to twenty times a second and none of that rate reaches the network.

Each heartbeat carries at most 120 buckets, twenty minutes of history. A longer backlog stays queued and drains over subsequent ordinary heartbeats; the cadence is never shortened to catch up. A batch leaves the local queue only after the server's heartbeat response says how many records it has taken responsibility for, so a timeout, a 5xx, or a lost response retains the exact batch for the next attempt. Storage is keyed on screen plus bucket start, so a retry after the server had already stored the records is harmless.

The screen a record belongs to comes from the authenticated device credential. A player cannot submit history for another screen, and records stay attributed to the right screen when one Noise Meter instance targets many. A malformed history section is dropped and named in `data.ignoredFields` rather than costing the heartbeat's liveness and playback state; the player retries that batch on the next heartbeat.

Records that cannot be believed — a NaN level, a timestamp from next year, durations longer than the bucket that holds them — are refused by the player before they are stored and again by the server on arrival. The server counts them as consumed so a player cannot loop forever on a bucket it can never get accepted.

### Active hours and retention

`Collect only during active hours` is on by default. Outside the player's configured active hours the screen is resting, so nothing wants the microphone: the player stops capture entirely, stops the MediaStream tracks, closes the AudioContext, and creates no buckets. It stops listening rather than measuring and discarding.

Retention is 1, 3, 7, 14, or 30 days, defaulting to 7. It governs the server's stored records and the player's own unsent queue, so both ends expire the same window. Expired records are removed automatically by the same bounded maintenance pass that expires Activity data; no administrator has to delete anything, and shortening the window expires the now-old records without touching anything newer.

### History in Studio

**Plugins → Noise Meter → History** shows Today, Yesterday, 7 days, or 30 days. Above the graph: average noise level, peak noise level, time too loud, and warning events, with time in the normal and warning bands, their share of monitored time, the longest continuous too-loud event, the loudest fifteen minutes, and total monitored time beside them. Warning events are the count the player recorded when its state machine entered the loud state, not an estimate from how many buckets look red.

The timeline graph draws average and peak against the instance's own two thresholds. The server aggregates to the resolution the range needs — one minute for a day, fifteen minutes for a week, an hour for a month — so a browser never downloads a month of ten-second records; the stored records themselves are untouched until they expire. Periods with no monitoring are left blank rather than drawn as silence. Multi-day ranges add a daily comparison by average level, time too loud, or warning events, and a day with no data is omitted rather than shown as zero.

Because one instance can target several screens, History names the screen it is showing, and offers a selector plus a combined view when more than one screen has measurements. A combined view says so: levels are relative to each player's own microphone, so comparing rooms is a comparison of different instruments as much as of different rooms.

CSV export covers the selected range and screen at ten-second, one-minute, or daily granularity. It is generated server-side and streamed, honours the same retention and authorization, and never materializes an unbounded dataset in the browser.

### Bar height and geometry

Noise Meter supports `overlay` and `push` exactly like Countdown Bar, and its default height is 96 pixels. The bar shows a fixed three-zone scale — green normal, yellow getting loud, red too loud — with a marker at the current level, `NOISE LEVEL` on the left, and the configured message (or `TOO LOUD`) on the right. The warning label is emphasised briefly as the bar arrives and then stays still; reduced-motion settings suppress the entrance emphasis and the marker's transition where the platform exposes that preference.

## Player behavior

The manifest carries a discriminated `plugins` array. Countdown Bar uses `type: "countdown_bar"`, an Emergency Alerts ticker uses `type: "alert_ticker"`, Brand Bug uses `type: "brand_bug"`, and Noise Meter uses `type: "noise_meter"`, all at `version: 1`; a Player ignores a type it does not implement. The complete timing rule is cached in `manifest-active.json`; recurrence and date windows are evaluated locally with the configured timezone, so a temporary server outage does not stop future show or hide transitions.

Both the Linux and Android players render the bar, and both resolve the schedule from the cached manifest with the same weekly, one-time, daylight-saving, completion, priority, and fill rules. The two implementations are covered by matching test cases so a divergence surfaces as a failure rather than as a difference between screens.

### One bar slot

Three plugins share one bar slot, in a fixed order: an emergency alert ticker, then Noise Meter, then Countdown Bar. An active alert ticker takes the strip from either of the others — a bar counting down to lunch, or one reporting a loud cafeteria, must never be what a screen is showing instead of a tornado warning. A room that is too loud takes it from a countdown, which is the one of the three that can wait.

Nothing is destroyed by losing the strip. Each surface keeps resolving itself while another owns it, so an emergency that clears over a still-loud room shows the Noise Meter again immediately, and a room that settles returns an active Countdown Bar — without touching playback in any direction. A visible Brand Bug in a bottom corner is lifted by whichever bar currently holds the strip.

An alert ticker carries the alert text and an `expiresAt` rather than a schedule. The server publishes the ticker only while it is answering an alert and withdraws it by revising the manifest, but a Player on a cached manifest has no poller to hear from: it takes the bar down itself at the expiry, using its own corrected clock. An unreadable or passed expiry hides the bar, so the surface fails toward showing nothing rather than toward presenting a stale alert as current. Because the message is longer than a bar is wide, it scrolls at the configured speed while the severity stays fixed at the leading edge; where the platform exposes a reduced-motion preference, the message is clipped instead of scrolled.

Plugin projection and presentation use a dedicated renderer channel. It does not replace the active presentation, change playlist selection, increment the renderer generation, remount media, touch synchronized-playback anchors, or open and close proof-of-play sessions. On Android the bar composes around a single playback call site for the same reason: appearing, changing mode, and hiding must not restart the media item.

Overlay mode positions the bar above the current content at the bottom of the screen. Push mode changes only the content stage's bottom inset. Existing image, video, website, Widget, and Layout nodes remain mounted and are resized inside the remaining stage, preserving their normal fit or aspect-ratio behavior.

Brand Bug always overlays and never reflows the content stage. Its corner elements are created once and updated in place, so a mark does not re-decode its logo on the one-second plugin tick. When a Countdown Bar is visible, bottom-corner marks are lifted by the bar's height rather than being covered by it. When a logo is configured and resolved, it is a required download: the manifest does not activate until the image is verified, so the mark keeps drawing while the network is gone. Text-only marks have no image download requirement.

A logo that becomes unavailable between saving an instance and building a manifest degrades to that instance's text; if the instance had no text, the mark is omitted from the manifest instead of publishing an empty corner. Neither case fails the manifest.

Brand Bug is drawn by Linux Player only. Android Player ignores plugin types it does not implement, so a configured mark is inert there rather than an error; drawing it on Android is outstanding work. Noise Meter is Linux Player only for the same reason and additionally by design: Android microphone capture is out of scope.

The Player estimates server clock offset when a manifest is received. The cached offset is reconstructed from the manifest's `serverTime` and local `storedAt`, so offline restarts retain the last known correction instead of treating the old server timestamp as the current time.

## API

Dashboard reads require a valid Tilecast session. Mutations additionally require Owner or Administrator, the session CSRF token, strict JSON, and normal request-size limits. Instance mutations answer `409 plugin_not_installed` while their plugin is not installed.

- `GET /api/v1/plugins` — the catalog: every plugin this release offers with installation and status, plus `unsupportedInstallations`
- `POST /api/v1/plugins/{pluginId}/install` — install; `201` first time, `200` when already installed
- `DELETE /api/v1/plugins/{pluginId}/installation` — remove; `204`, or `409 plugin_in_use` with blocking resources
- `GET /api/v1/plugins/dependency-graph` — typed nodes and directed dependency-to-consumer edges (a system tool, not a plugin)
- `GET /api/v1/plugins/countdown-bar/instances`
- `GET /api/v1/plugins/countdown-bar/instances/{id}`
- `POST /api/v1/plugins/countdown-bar/instances`
- `PUT /api/v1/plugins/countdown-bar/instances/{id}`
- `DELETE /api/v1/plugins/countdown-bar/instances/{id}`
- `GET /api/v1/plugins/brand-bug/instances`
- `GET /api/v1/plugins/brand-bug/instances/{id}`
- `POST /api/v1/plugins/brand-bug/instances`
- `PUT /api/v1/plugins/brand-bug/instances/{id}`
- `DELETE /api/v1/plugins/brand-bug/instances/{id}`
- `GET /api/v1/plugins/noise-meter/instances`
- `GET /api/v1/plugins/noise-meter/instances/{id}`
- `POST /api/v1/plugins/noise-meter/instances`
- `PUT /api/v1/plugins/noise-meter/instances/{id}`
- `DELETE /api/v1/plugins/noise-meter/instances/{id}`
- `GET /api/v1/plugins/noise-meter/instances/{id}/history/summary`
- `GET /api/v1/plugins/noise-meter/instances/{id}/history/series`
- `GET /api/v1/plugins/noise-meter/instances/{id}/history/daily`
- `GET /api/v1/plugins/noise-meter/instances/{id}/history/screens`
- `GET /api/v1/plugins/noise-meter/instances/{id}/history/export.csv`

All successful JSON responses use the standard `{ "data": ... }` envelope.
