# Installable built-in plugins

Tilecast plugins are release-owned optional capabilities. Installing one activates code that ships with the Tilecast release; it does not download executable code. This release offers Countdown Bar, Emergency Alerts, and Forms.

## Catalog, installation, and removal

The catalog at `GET /api/v1/plugins` lists the plugins available in this release. Each definition has a stable ID, a version, requirements, and capabilities. Installation state is stored in `plugin_installations`; configuration stays in the plugin's own tables. Installation is the runtime gate: uninstalled plugins contribute no manifest entries or background work.

| Plugin           | Configured                         | Active                        | Instances   |
| ---------------- | ---------------------------------- | ----------------------------- | ----------- |
| Countdown Bar    | At least one instance              | At least one enabled instance | Bars        |
| Forms            | At least one form                  | At least one form             | Forms       |
| Emergency Alerts | Areas or zones chosen, or any rule | Monitoring switched on        | Alert rules |

Owners and Administrators install with `POST /api/v1/plugins/{pluginId}/install` and remove with `DELETE /api/v1/plugins/{pluginId}/installation`, using a session and CSRF token. Installation returns `201` initially and `200` when repeated. Removal is idempotent and never deletes plugin data. Active resources may block removal with `409 plugin_in_use` and a resolution in `error.details`: delete, disable, or wait. Countdown Bar is blocked while instances exist; Forms while undeleted forms exist; Emergency Alerts while monitoring, rules, or activations remain. Configuration mutations require installation and otherwise return `409 plugin_not_installed`.

Studio lists installed plugins and offers the current catalog under **Add plugin**. Opening an uninstalled supported plugin page shows its installation gate. A retired installation is labeled **Plugins removed from Tilecast** and is removable without deleting its old data.

### Retired installations and compatibility

Brand Bug / Watermark (`brand_bug`) and Noise Meter (`noise_meter`) are retired. Neither can be installed, configured, rendered by the shared Player runtime, or projected into new manifests. Older `plugin_installations` rows remain inert and distinct from unknown plugins that might come from a newer Tilecast release. Removing a retired row preserves its historical tables and data. Shipped migration `00102_plugin_installations.sql` remains unchanged; its old backfill rule is historical, not current plugin availability.

Already-deployed Players may retain cached manifests with `brand_bug` or `noise_meter` entries. The runtime ignores those entries without disturbing supported plugins. Older Linux and Edge Players may still send a `noiseMeter` heartbeat field; the server accepts and ignores it, without storing history or changing status. Edge's native microphone code remains in place but has no active plugin consumer.

### Unknown installations and backups

A database restored from a newer release may name a plugin this release does not know. Startup succeeds; the row is kept and listed under `unsupportedInstallations`, and no code runs for it. An administrator can remove that row without deleting unknown plugin data. Full backups include installation rows and old plugin tables.

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

## Player behavior

The manifest's optional `plugins` array can contain `countdown_bar@1` and `alert_ticker@1`. Players cache the timing rules and evaluate them locally while offline. A Player safely ignores an unimplemented or retired entry in an older cached manifest.

Emergency Alerts takes the strip ahead of Countdown Bar. An alert ticker expires at its `expiresAt` even when the Player is offline. Plugin presentation uses a separate renderer channel and does not restart the underlying playlist item or proof-of-play session. Overlay mode places a bar over content; push mode insets the content stage while leaving its media mounted.

## API

Dashboard reads require a valid session. Mutations require Owner or Administrator, CSRF, strict JSON, and normal request-size limits.

- `GET /api/v1/plugins` — current catalog plus unsupported or retired installations
- `POST /api/v1/plugins/{pluginId}/install` — install a supported plugin
- `DELETE /api/v1/plugins/{pluginId}/installation` — remove an installation row
- `GET /api/v1/plugins/dependency-graph` — Dependency Explorer system tool
- `GET /api/v1/plugins/countdown-bar/instances` and matching instance create, read, update, and delete routes

All successful JSON responses use the standard `{ "data": ... }` envelope. The retired Brand Bug and Noise Meter configuration and history endpoints are no longer offered.
