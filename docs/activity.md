# Activity

Tilecast Activity is divided into four reporting domains. They intentionally use separate storage and APIs so an assigned schedule is never mistaken for proof that content actually appeared on a screen.

| Domain        | Question answered                                                       | Source                                                            |
| ------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Overview      | What needs attention across this installation?                          | Derived from the other Activity domains                           |
| Proof of Play | What did a Player confirm was displayed, where, when, and for how long? | `playback_sessions` derived from Player events                    |
| Screen Events | What did a Player or the server do?                                     | Append-only `player_activity_events` and `screen_state_intervals` |
| Audit Log     | What did an authenticated user or administrator change?                 | `audit_logs`                                                      |

## Player event ingestion

Paired Players upload bounded batches to `POST /api/v1/player/activity-events` with their existing device credential. The server always obtains the screen identity from that credential and ignores any screen identity supplied by a client payload.

Every Player event has a UUID and a per-screen sequence. UUID and sequence constraints make retries idempotent. The Player persists its queue in app-private storage, increments the sequence across process restarts, retries in batches of at most 100 with bounded exponential backoff, and removes events only after the server acknowledges their IDs. Queue writes and uploads run off the playback thread. When the local cap is reached, the oldest low-priority routine events are removed before failures, recovery events, or presentation boundaries.

`occurredAt` is the Player wall-clock timestamp. `receivedAt` is assigned by the server. Durations are measured with Android elapsed realtime so wall-clock changes cannot create negative or inflated playback intervals.

Heartbeat and WebSocket status transitions are serialized per screen in one database transaction. The screen-state timeline has at most one open interval per screen; a concurrent heartbeat cannot create a second connected/healthy interval or duplicate the connection transition. The liveness-only heartbeat endpoint updates contact time without replacing the foreground playback snapshot.

## Incidents

Activity used to treat the latest bad event on a screen as an unresolved issue. A screen that dropped out five times showed five problems, a screen that had recovered still showed its last failure, and nothing could be acknowledged or closed. Incidents replace that with a record of the underlying condition.

An incident opens once, absorbs repeats into `last_seen_at` and an occurrence count, and recovers when the evidence says the condition ended. Statuses are `open`, `acknowledged`, `recovered`, `resolved`, and `ignored`. **Recovered** and **resolved** are deliberately different: recovered means the condition ended on its own, resolved means a person closed the matter. That distinction is what makes the automatic-versus-manual recovery breakdown meaningful.

**A recovered incident is logged, not queued.** The condition ended without anyone doing anything, so it is a record of an outage rather than work waiting on an operator: it leaves the active list, is not counted as an active incident, and nobody is asked to acknowledge or close it. It stays readable on the Incidents tab under `status=recovered` or `status=all`, keeps its recovery timestamp and mode, counts toward time-to-recover, and can be reopened if the record turns out to be wrong.

| Incident     | Opened by                                                                             | Recovered by                                                |
| ------------ | ------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| Connectivity | Heartbeat gap, confirmed connection loss, or a screen past the heartbeat grace period | Connection restored, or a heartbeat inside the grace period |
| Playback     | Renderer failure, decoder failure, or foreground playback lost                        | Renderer recovery, or a healthy root presentation starting  |
| Storage      | Cache use crossing the configured pressure threshold                                  | A `storage.recovered` report                                |
| Safe mode    | Safe-mode entry                                                                       | Safe-mode exit                                              |
| Update       | A failed installation                                                                 | A completed installation                                    |

A screen that stops reporting sends nothing, so connectivity incidents are also swept from current state whenever the incident list or analytics are read. The sweep is idempotent — the partial unique index on `dedupe_key` means one open incident per screen per condition — and it opens the incident at the moment the grace period lapsed rather than when the sweep noticed, so time-to-recover measures the outage and not the poll interval.

A condition that returns after recovering opens a _new_ incident rather than reviving the old one. Two outages must not be measured as one.

**Probable cause is only stated when the evidence establishes it.** A heartbeat gap proves reporting stopped; it proves nothing about why, so the incident carries no cause and Studio shows "Unknown cause". A renderer failure reported by the Player is evidence, and is stated.

Owners and Administrators can acknowledge, assign, note, resolve, ignore, and reopen an incident. Acknowledging applies only while the condition is live (`open` or `acknowledged`); a recovered incident can only be reopened. Every applied action is appended to the incident timeline with its actor and written to the audit log; an action that does not apply to the current status returns 409 and records nothing.

## Proof-of-play derivation

Sessions carry a `session_type`: `presentation` for the root interval, and `content`, `layout_placement`, or `playlist_item` for what plays inside it. This distinction is load-bearing. **Confirmed screen playback** is the union of root presentation intervals per screen, clipped to the range — real wall-clock time on the display. **Content exposure** is the sum of child intervals, and legitimately exceeds wall clock when several layout zones play at once. The two are never added together; doing so counted one second of screen time once per zone.

The proof-of-play summary reports a **session completion rate**, not coverage. It is the share of sessions that completed or ran partially. Nothing in Tilecast yet compares actual playback against what was scheduled to play, so calling it coverage would claim a measurement that does not exist.

Every ended session records a `terminal_reason` (see [the event contract](activity-event-contract.md)). **Interrupted plays** counts only sessions whose reason was unexpected. A schedule transition, a Takeover, and a normal item boundary all end playback early and are exactly what was asked for. `unknown` is excluded too: absence of evidence is not evidence of an interruption, which also means records predating the contract are not retroactively counted as faults.

The server derives `playback_sessions` from matching start and terminal events. A session is not considered completed until the Player reports a completion. Missing terminal events become:

- `partial` when a new incompatible root presentation or replacement item starts;
- `unknown` after the bounded open-session timeout, Player restart, or reporting gap;
- `failed` only when the Player reports a failure;
- `recovered` only when the Player reports successful recovery.

Layouts have a root activation interval. Meaningful child sessions are recorded for media, Widgets, and playlist-zone items. Static primitives such as shapes, lines, and background colors do not create events. Persistent Widgets create one activation interval rather than periodic update events.

Date-aware Widgets report the selected cached record by Source ID, placement or Widget ID, selected record ID, selection date, cached-at timestamp or Source revision, and snapshot hash. Raw field values and private CSV payloads are not copied into Activity.

## Fleet health

The Activity Overview reports fleet health as of now, not over the selected date range, because it answers what is on screen at this moment. It covers enabled, non-archived, non-deleted screens holding an unrevoked device credential; uptime has its own historical population and gap rules. A screen taken out of service deliberately never reads as a fleet-health fault.

The same enabled, non-archived, non-deleted screen scope is applied to fleet, overview, uptime, proof, and activity aggregations. Archiving a screen therefore removes it consistently from active-fleet counts and historical uptime calculations without deleting its retained audit or playback records.

A recent heartbeat is reachability, not health, and is reported separately as **Online**. Every measured screen also lands in exactly one of four states, so the four counts sum to the measured fleet:

- **healthy**: reporting, and confirmed playing what it should be — no safe mode, no active playback error, in the foreground where applicable, no storage pressure, and no synchronization error;
- **impaired**: still reporting, but currently in safe mode, showing a playback or renderer error, running in the background, under storage pressure, failing to synchronize, or not playing when content is expected;
- **offline**: enabled, paired, expected to participate, and past the heartbeat grace period;
- **unmeasured**: paired and enabled but without enough trustworthy evidence — it has never reported, has posted no player status yet, or is correctly showing nothing because playback is off hours, administratively stopped, or unassigned.

The two players spell the same conditions differently — `safe_mode` against `safe-mode`, `off_hours` against `sleep` — so reported playback state is normalized before it is classified. The same situation must not be counted differently by platform.

## Expected versus actual playback

Compliance cannot be computed from current schedules and assignments: both change after the fact, so reconstructing last month's expectation from today's configuration would report against a plan that never existed at the time. Expected playback windows are therefore **materialized when a selection becomes effective** and are immutable once written — a change supersedes a window rather than editing it.

Windows are superseded when the assignment changes, a schedule begins or ends, the manifest revision changes, a Takeover begins or ends, the screen is disabled, active hours change, or a deployment intentionally prevents playback. The reason is recorded, because it is what decides whether the unplayed time was a miss.

Root playback sessions are then matched against each closed window. An open window is never judged: it has not finished, and judging it early would report playback that is still running as missed. Match statuses are `confirmed`, `started_late`, `ended_early`, `partial`, `failed`, `never_started`, `screen_offline`, `overridden_by_takeover`, `cancelled`, and `not_measurable`. A ninety-second grace applies at each edge so compliance does not become a measure of clock skew.

**Playback compliance = confirmed expected screen-time ÷ measurable expected screen-time.** Takeover-overridden and intentionally cancelled time is excluded from the denominator — neither is playback that went missing — and both are reported separately so the exclusion is visible rather than silently improving the percentage. When nothing measurable was expected the percentage is null, not zero: zero would claim every expected play was missed.

The report shows expected, confirmed and missed screen-minutes, the compliance percentage, late starts, early endings, never-started windows, offline-caused misses and Takeover-overridden time, with drill-downs by screen, location, group, presentation, schedule, date, and failure reason.

## Per-screen timeline

`GET /api/v1/activity/screens/{id}/timeline` merges one screen's whole history into a single ordered stream: state intervals, playback sessions, reported events, incident lifecycle, and administrative changes. It is filterable by domain and carries a current-status header — presentation, item, incident, last healthy playback, last manifest activation, last heartbeat, Player version, and the same four-state health classification the fleet-health section uses, so the two pages cannot disagree about one screen.

## Player telemetry

Telemetry is bounded in three ways, because the failure mode of fleet telemetry is unbounded growth.

**A snapshot of latest values.** One row per screen, updated in place — current item, item start, last meaningful progress, stall duration and reason, renderer state, round-trip time, download queue, bytes remaining, cache use and limit, free storage, process and device uptime, sync drift, frame fingerprint, average luminance, and thermal and memory-pressure state. Keeping a history here is exactly what turns telemetry into an unbounded table, so it does not. An out-of-order sample never overwrites newer state.

**Events only on meaningful transitions.** Each condition has a two-level threshold and a cooldown. The level that _enters_ a condition is worse than the level that _leaves_ it — storage pressure enters at 90% of the cache limit and only clears at 80% — so a value hovering on the boundary cannot produce an endless enter/recover stream. On top of that, a condition that has just changed cannot change again until its cooldown elapses, which rate-limits even a value swinging across the whole band. Cooldowns run on the sample's own clock, not on arrival time, so a player uploading a buffered backlog after an outage does not have every transition in it suppressed.

A measurement the player did not report is absent, not zero. A player that cannot measure luminance must not read as a black screen, and a frozen visual output is only evaluated where motion was expected — a still image showing identical frames is doing its job.

**Five-minute rollups.** Average and maximum round-trip time, connected and disconnected seconds, healthy and stalled playback seconds, black-output seconds, dropped frames, frame changes, downloaded bytes, cache hits and misses, average and peak memory, average CPU, thermal distribution, and sync drift at p50, p95 and maximum. Averages are running means weighted by sample count, so every sample in a bucket counts equally. Rollups are the only telemetry that accumulates and have their own retention bound (`telemetryRollupDays`, 7–400 days) enforced by the existing cleanup worker. Raw high-frequency samples are never uploaded and never stored.

### Diagnostic measurements

The measurements above answer "is this screen playing". These answer "why is it not", which otherwise needs physical access to the device.

**Network path.** Round-trip time alone cannot tell a weak radio from a slow resolver from a failing server. Gauges: link type (ethernet, wifi, cellular, other, unknown), Wi-Fi signal in dBm and link speed in Mbit/s, gateway reachability, a captive-portal verdict, and the category of the last disconnect. Counters: total requests, failures, 4xx and 5xx separately, retries, socket reconnects, interface changes, time-to-first-byte at p95, and average throughput.

Deliberately absent: SSID, hostname, IP address, and URL. The columns cannot hold them — every state field is an allowlist and the resolution fields accept only `<digits>x<digits>` — so a player sending one has it dropped rather than stored. A disconnect or shutdown _reason_ is likewise a category and never the error text, which stays in the player's own log.

**Display and power.** A dark panel in front of a healthy player is the case where every other measurement reads normal. Gauges: display connected, negotiated resolution and refresh rate, display power state, last shutdown reason, power source, battery percent. Counters: unexpected reboots, display sleeps and wakes. The negotiated resolution is not the window size the renderer was given; the two disagreeing is itself the signal.

**Clock.** Offline scheduling is evaluated on the device clock, so drift presents only as content playing at the wrong time. Reported as a signed offset in seconds — behind and ahead are different faults — plus the time-sync state.

**Startup timing.** One set per boot: total, config load, manifest load, asset verification, and time to first frame. This is what makes "the screen took four minutes to come back after the power cut" attributable to a phase.

**Render and decode.** Frame time at p95 and p99, jank frames, renderer crashes, surface losses, decoder init failures, and the decode path actually used. Silent hardware-to-software fallback is the usual explanation for one device playing a video badly while an identical one plays it fine.

**Cache churn.** Distinct from cache hits and misses, which only say whether content was local: evictions and evicted bytes, integrity failures, download resumes, and download failures.

Six further conditions come from these: weak Wi-Fi signal, clock drift, request failure rate, display disconnected, captive portal suspected, and software decode fallback. Each obeys the same hysteresis and cooldown rules as the original conditions, and each is only evaluated on evidence — a wired screen reporting a meaningless signal figure does not raise a weak-signal condition, and the failure _rate_ is not computed at all below ten requests in the window, because one failed request in an idle window is not a failing screen.

Two sanitization rules apply, and they differ on purpose. An implausible **gauge** is dropped, because absent is honest and a luminance of 4 recorded as darkness is not. An implausible **counter** is clamped, because its column is `NOT NULL` and accumulates, so one bad delta would otherwise fail the whole request for a screen that is reporting fine.

Coverage is not yet equal across platforms. Tilecast Player for Linux reports the network, clock, power, display, startup, cache, and request measurements; frame timing, decode path, and cache eviction await renderer and cache-manager instrumentation, and are omitted rather than sent as zero. Tilecast Player for Android does not yet post telemetry samples at all — its heartbeat is unaffected, but the telemetry conditions are dark for Android screens until it does.

## Meaningful render progress

Three things are routinely confused, and conflating them is what lets a player report itself healthy over a blank screen: the process is alive, the renderer object is alive, and playback is actually progressing. Only the third is health.

Progress is tracked from real signals — video position advancing, item transitions, an image successfully displayed, a website's first meaningful render, a layout child rendering, and a frame fingerprint changing _where change was expected_. Renderer liveness probes are recorded but are not progress, except for indefinite content where they are the only available evidence.

Expectations are content-aware, because silence means different things:

| Content     | Progress is                             | Silence is                                    |
| ----------- | --------------------------------------- | --------------------------------------------- |
| Still image | Displayed successfully                  | Correct, until it outstays its duration       |
| Video       | The position advancing                  | A stall within about twenty seconds           |
| Website     | A first meaningful render               | Correct once rendered; frame changes optional |
| Layout      | Each zone rendering                     | A stall once a zone stays silent              |
| Indefinite  | A periodic renderer health confirmation | A stall once the probe lapses                 |

Layouts are evaluated per zone. A whole-layout signal can hide a failed zone
when other zones continue to render. Every zone must produce a first render. A
rotating playlist zone must also produce continuing evidence. A static Widget or
image zone renders once and holds. A single-item zone loops in place and does
not advance, so it does not require a continuing cadence.

A valid long-lived still image is never called frozen for having identical pixels, and a fingerprint change on a still image is treated as noise rather than evidence. The player reports `lastMeaningfulProgressAt`, `stallStartedAt`, `stallDurationMs`, `stallReason`, `expectedMotion` and `rendererResponding` on every heartbeat, and the recovery supervisor is fed from the assessment rather than from raw signals. The stall is measured from when progress was last seen, not from when it was noticed, so the duration reflects how long the screen has actually been wrong.

## Uptime derivation

The System overview uptime graphs read `screen_state_intervals`; the schema keeps no heartbeat history, so uptime is measured from recorded state transitions only. Uptime covers the same population the Screens list shows — enabled, non-deleted screens that still hold an unrevoked device credential — because downtime on a disabled or revoked screen is administrative rather than a fault. The fixed windows are 24 one-hour buckets, 28 six-hour buckets, or 30 daily buckets aligned to the bucket size, so the newest bucket is the partial one.

Players do not share one activity event vocabulary: the Linux player reports `content.*` and `connection.lost`/`connection.recovered`, while the interval derivation recognises the Android player's `presentation.*` and `manifest.activated`. The heartbeat is the one signal every player sends, so authenticated HTTP heartbeats and WebSocket `player.status` messages both anchor an up-state interval when none is open. Valid status metadata replaces a stale impaired interval once it confirms the player is playing with no playback error, no safe mode, no lost foreground, and no cache pressure. If optional socket metadata is malformed, the server still records authenticated contact and an `online` interval while rejecting the metadata and logging safe field-level diagnostics. Heartbeat-anchored intervals record `{"source":"heartbeat"}` and stay bounded at one row per continuous up-stretch. Without this, a player that never emits a recognised event would never be measured, and a single renderer failure would leave a screen impaired indefinitely.

Each measured second falls into one class:

- **up**: `online` or `healthy`;
- **impaired**: `safe_mode`, or `degraded` for a reason other than a heartbeat gap, such as a renderer failure or cache pressure;
- **down**: `offline`, `unknown`, or `degraded` because of a detected heartbeat gap.

Players do not report a disconnect, so an open up-state interval is clipped to the last heartbeat plus the three-minute gap grace period that the gap detector uses, and the remainder of the window counts as down. Time before a screen's first recorded interval is reported as unmeasured and excluded from the percentage rather than counted as downtime, so a newly paired fleet shows no percentage instead of a false one.

## Audit safety

Audit metadata is allowlisted for presentation. Keys associated with passwords, sessions, OAuth tokens, Player credentials, authorization headers, private CSV payloads, and full configuration documents are discarded. IP addresses, request IDs, raw failure messages, and detailed diagnostics are returned only to Owners and Administrators.

The Activity API resolves resource names for historical audit records where possible. New authentication and Activity-setting records include result, request ID, summary, and safe metadata.

## Metric definitions

Every number Studio shows, stated exactly. Where a metric can be null, null means "no data" and is never rendered as zero — zero is a measurement, and claiming one you do not have is the failure mode this whole area exists to avoid.

### Fleet health (measured now, not over the range)

| Metric         | Exact definition                                                                                                                                                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Measured fleet | Screens where `enabled` and `deleted_at IS NULL` and `archived_at IS NULL` and at least one `device_credentials` row has `revoked_at IS NULL`.                                                                                             |
| Online         | Measured screens whose `last_heartbeat_at` is within the heartbeat grace period (15 minutes, `devices.OfflineThreshold`). Reachability only. Deliberately overlaps the four states below.                                                  |
| Healthy        | Reporting, has posted a player status, not in safe mode, no `last_playback_error`, `foreground_state` empty or `foreground`, cache use below 90% of its limit, no `last_sync_error`, playback expected, and `playback_state` is `playing`. |
| Impaired       | Reporting and has a status, but one of: safe mode, an active playback error, not in the foreground, storage pressure, a synchronization error, or playback expected but `playback_state` is not `playing`.                                 |
| Offline        | `last_heartbeat_at` is non-null and older than the grace period.                                                                                                                                                                           |
| Unmeasured     | Never reported, or no player status yet, or playback is not expected (off hours, playback disabled, no assigned manifest).                                                                                                                 |

Healthy + impaired + offline + unmeasured = measured fleet, exactly. Online is separate and overlaps them.

### Playback (measured over the selected range)

| Metric                      | Exact definition                                                                                                                                                                                                                                                         |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Confirmed screen playback   | The **union** of `playback_sessions` rows with `session_type='presentation'` and `result IN (playing, completed, recovered, partial)`, per screen, clipped to the range, summed across screens. Overlapping root sessions merge, so this is wall-clock screen time.      |
| Content exposure            | The **sum** of `session_type <> 'presentation'` rows with the same result filter, clipped to the range. Not a union: two layout zones playing simultaneously contribute twice, which is correct for exposure and wrong for screen time. Never added to the figure above. |
| Playback failures           | Count of sessions with `result='failed'` starting in the range.                                                                                                                                                                                                          |
| Interrupted plays           | Count of sessions whose `terminal_reason` is in the unexpected set — `player_restart`, `process_exit`, `heartbeat_gap`, `renderer_failure`, `decoder_failure`, `recovery_action`, `bounded_timeout`. Excludes every expected reason and excludes `unknown`.              |
| Session completion rate     | `(completed + partial) ÷ total sessions`, averaged across the grouping. **Not** coverage: nothing here compares playback against what was scheduled.                                                                                                                     |
| Screens with reporting gaps | Distinct screens with a `screen_state_intervals` row overlapping the range in state `offline` or `unknown`, or `degraded` with `reason_code='heartbeat_gap'`.                                                                                                            |

### Playback compliance

| Metric                      | Exact definition                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Expected screen-minutes     | Sum of expected-window duration clipped to the range, for windows whose `match_status` is **not** `cancelled`, `overridden_by_takeover` or `not_measurable`. |
| Confirmed screen-minutes    | Sum of `confirmed_duration_ms` across those windows — root presentation time actually observed inside each window.                                           |
| Missed screen-minutes       | `max(0, expected − confirmed)`.                                                                                                                              |
| Playback compliance         | `confirmed ÷ expected`, capped at 100%. **Null** when expected is zero.                                                                                      |
| Late starts / early endings | Count of windows with `match_status` `started_late` / `ended_early`. The grace at each edge is 90 seconds.                                                   |
| Never started               | Windows with no root playback at all where the screen was reachable.                                                                                         |
| Offline-caused misses       | Windows with no playback where the screen was offline or unknown for at least half the window.                                                               |
| Takeover-overridden time    | Expected duration of windows a Takeover replaced. Excluded from the denominator and reported separately.                                                     |

### Incidents

| Metric                       | Exact definition                                                                                                                                                                    |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Active incidents             | Incidents in status `open` or `acknowledged`. Measured now, not over the range. Recovered ones are excluded: the condition has ended.                                               |
| Opened / resolved            | Incidents whose `opened_at` / `resolved_at` falls in the range.                                                                                                                     |
| Time to recover              | `LEAST(recovered_at, resolved_at) − opened_at`, for incidents that ended in the range and are not `ignored`. Reported as mean, median and maximum. **Null** when nothing recovered. |
| Automatic vs manual recovery | `recovery_mode='automatic'` means the condition ended on its own; `manual` means a person closed it.                                                                                |
| Recurring                    | A screen and incident type with more than one incident, or more than two total occurrences, in the range. Incidents and occurrences are counted separately.                         |

### Uptime

Uptime is derived from `screen_state_intervals`, not from these metrics, and uses its own fixed windows (24 hours, 7 days, or 30 days) rather than the selected range. Each measured second is up (`online`/`healthy`), impaired (`safe_mode`, or `degraded` for a reason other than a heartbeat gap), or down (`offline`, `unknown`, or `degraded` from a heartbeat gap). Time before a screen's first recorded interval is unmeasured and excluded from the percentage.

## Glossary

**Online** — a screen has reported within the heartbeat grace period. Reachability, nothing more. A screen can be online and showing a black screen.

**Healthy** — a screen is online _and_ confirmed to be playing what it should be, with no current fault. This is the only state that asserts the screen is doing its job.

**Impaired** — a screen is still reporting but something is currently wrong: safe mode, a playback error, running in the background, storage pressure, a synchronization error, or not playing when content is expected.

**Offline** — a screen that is enabled, paired and expected to participate has not reported within the grace period. Disabled, archived, deleted and revoked screens are never offline; they are out of the operational fleet entirely.

**Unmeasured** — a screen is paired and enabled but there is not enough trustworthy evidence to classify it: it has never reported, has posted no player status, or is correctly showing nothing because playback is not expected right now.

**Proof of Play** — a record that a Player confirmed content was displayed, derived from matched start and end events. An assignment or a schedule is not proof of play; only the Player's own report is.

**Screen playback time** — wall-clock time content was on a display, computed as the union of root presentation intervals per screen. Two layout zones playing at once are still one second of screen time.

**Content exposure time** — the total time individual pieces of content were displayed, computed as the sum of child sessions. Legitimately exceeds screen playback time when a layout shows several things at once. It answers "how much was this asset seen", not "how long was the screen working".

**Session completion rate** — the share of playback sessions that completed or ran partially. A session outcome rate. It is _not_ coverage, and it does not tell you whether the right content played at the right time.

**Playback compliance** — confirmed screen-time divided by measurable expected screen-time, measured against expectations recorded when each selection became effective. This is the metric that answers "did the right content play when it was supposed to". Time an operator deliberately stopped, and time a Takeover replaced normal playback, are excluded from the denominator.

**Incident** — a persistent record of one operational condition, opened once and updated on repeat. Five renderer failures on one screen are one incident with five occurrences, not five problems.

**Recovery** — the condition behind an incident ending. _Automatic_ recovery means the evidence showed it ended by itself; _manual_ means a person closed the matter. Recovered is not resolved: a recovered incident stays visible until someone closes it.

**Uptime** — the share of measured time a screen was up, from the recorded state timeline. Distinct from compliance: a screen can be up for 100% of a day and still have played nothing.

## Known limitations

These are real and worth knowing before trusting a number.

**Compliance depends on expectations having been recorded.** Expected windows are materialized going forward from the moment a selection becomes effective. There are no expected windows for playback that happened before this feature existed, so compliance over a historical range will report less expected time than actually occurred — or none at all. It is honest about that (null rather than 0%), but it is not retroactive.

**Expected windows are anchored to heartbeats.** A screen that is offline when its schedule changes does not get a new expected window until it reports again. Its outage is captured as `screen_offline`, but the window boundary may be later than the schedule's real boundary.

**`unknown` terminal reasons under-report interruptions.** Sessions recorded before contract v2, and sessions from a v1 player, usually have no terminal reason. They are excluded from interrupted plays rather than guessed at, so that count is a floor, not a total.

**Percentiles cannot be merged across samples.** A five-minute rollup receiving several samples keeps the worst reported sync-drift percentile rather than recomputing across the underlying values, which the server never sees. p50 and p95 in a multi-sample bucket are therefore upper bounds.

**Frame fingerprints and luminance are best-effort and platform-dependent.** A
Player that cannot measure them reports nothing. The black-output and
frozen-output conditions do not run for that Player. The absence of those events
does not prove that the screen is operating correctly.

**Layout zone evidence depends on the renderer reporting it.** Zones are judged individually on the Linux player. A zone that the renderer cannot identify is excluded rather than held to an expectation it could never meet.

**Health is a point-in-time classification.** Fleet health reflects the last heartbeat and status, so a screen that failed seconds ago still reads healthy until its next report. The uptime and incident timelines are the historical record; fleet health is not.

**Probable cause is frequently unknown, and says so.** The server knows reporting stopped; it does not know whether that was the network, the power, or the device. Incidents show "Unknown cause" rather than a plausible guess.

**Telemetry samples are dropped, not buffered.** A player that cannot reach the server loses that minute of telemetry detail. Proof of play and activity events _are_ buffered and retried; telemetry deliberately is not, because buffering it would trade a minute of detail for unbounded memory on a player offline for hours.

**Counts are bounded for display.** Incident lists, timelines, breakdowns and rollup reads have row limits. Where a limit truncates, the report shows the top of the ordering rather than a complete set.

## Permissions

| Capability                                                            | Owner | Administrator |                      Editor                      | Viewer |
| --------------------------------------------------------------------- | :---: | :-----------: | :----------------------------------------------: | :----: |
| Overview, fleet health, compliance                                    |   ✓   |       ✓       |                        ✓                         |   ✓    |
| Proof of Play                                                         |   ✓   |       ✓       |                        ✓                         |   ✓    |
| Incidents (read)                                                      |   ✓   |       ✓       |                        ✓                         |   ✓    |
| Incident actions — acknowledge, assign, note, resolve, ignore, reopen |   ✓   |       ✓       |                        —                         |   —    |
| Screen Events (the raw diagnostic stream)                             |   ✓   |       ✓       |                        —                         |   —    |
| Player telemetry snapshots and rollups                                |   ✓   |       ✓       |                        —                         |   —    |
| Audit Log                                                             |   ✓   |       ✓       | content, Playlist, Layout and Schedule work only |   —    |
| Sensitive detail — IP addresses, request IDs, raw failure messages    |   ✓   |       ✓       |                        —                         |   —    |
| CSV exports                                                           |   ✓   |       ✓       |                        —                         |   —    |
| Retention settings                                                    |   ✓   |       ✓       |                        —                         |   —    |

Incidents are the grouped operational view and are readable by every role, because knowing a screen is broken is not privileged. Screen Events remains the raw diagnostic stream behind them and keeps its existing restriction, as does telemetry: both carry failure messages and device detail.

Incident actions change operational state, so they require Owner or Administrator **and** pass CSRF protection, and every applied action is written to the audit log. An action that does not apply to the incident's current status returns 409 and records nothing.

The per-screen timeline redacts by role rather than being withheld: an unprivileged reader sees the shape of the history without the diagnostic text.

The API applies permissions independently of the Studio UI so future department-scoped access can add a scope predicate without changing the event model.

## Retention

Defaults and deployment hard limits:

| Data                         |  Default |   Hard limits |
| ---------------------------- | -------: | ------------: |
| Raw Player events            |  60 days |    7–365 days |
| Proof-of-play sessions       | 365 days | 30–2,555 days |
| Screen-state intervals       | 365 days | 30–2,555 days |
| Audit logs                   | 730 days | 90–3,650 days |
| Detailed diagnostic metadata |  30 days |    7–180 days |
| Telemetry rollups            |  30 days |    7–400 days |

Two telemetry datasets deliberately do **not** appear in that table, because neither grows: the snapshot is one row per screen updated in place, and raw high-frequency samples are never stored at all. Rollups are the only telemetry that accumulates, which is why they are the only telemetry with a retention bound.

Cleanup runs periodically and after Activity ingestion, changing at most 500 rows per dataset per invocation in short statements. It never deletes open playback sessions or open screen-state intervals, restores the default singleton safely if it is missing, and logs only safe row counts and errors. Derived sessions retain the evidence needed for reporting after their source raw events age out.

## API summary

See [`activity-api.yaml`](activity-api.yaml) for request and response shapes.

Player ingest:

- `POST /api/v1/player/activity-events`
- `POST /api/v1/player/telemetry`

Reporting:

- `GET /api/v1/activity/overview`
- `GET /api/v1/activity/uptime`
- `GET /api/v1/activity/compliance`
- `GET /api/v1/activity/proof-of-play`
- `GET /api/v1/activity/proof-of-play/summary`
- `GET /api/v1/activity/proof-of-play/export.csv`
- `GET /api/v1/activity/screen-events`
- `GET /api/v1/activity/audit`
- `GET /api/v1/activity/audit/export.csv`

Incidents:

- `GET /api/v1/activity/incidents`
- `GET /api/v1/activity/incidents/analytics`
- `GET /api/v1/activity/incidents/{incidentId}`
- `PATCH /api/v1/activity/incidents/{incidentId}`

Per screen:

- `GET /api/v1/activity/screens/{screenId}`
- `GET /api/v1/activity/screens/{screenId}/timeline`
- `GET /api/v1/activity/screens/{screenId}/telemetry`

Settings:

- `GET|PATCH /api/v1/activity/retention`

Large event lists use a stable `(timestamp, UUID)` cursor. CSV exports are bounded and require Owner or Administrator access.
