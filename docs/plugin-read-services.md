# Plugin read services

This document specifies the shared read services of the Server service
registry: `content.read@2` and `activity.read@1`. It also specifies the one
rule that decides who a service call acts for. The rule applies to every
Server service, for external packages and for bundled Plugin Manifest API 3
plugins.

Related contracts:

- [External package service capabilities](package-services.md) owns the
  registry, the package grant, and the Wasm transport.
- [Plugin Manifest API 3](plugin-api-v3.md) owns the bundled `services`
  declaration and the generated Go client.
- [Activity](activity.md) owns the meaning of every Activity metric.
- [Screen access](screen-scopes.md) owns the screen-access rules.

## One rule for unattended calls

Every service call has one invocation context: `studio`, `background`, or
`system`.

- A `studio` call acts for the signed-in person. The dispatcher refuses a
  `studio` call without an actor. The call takes the live core capability and
  the live object, content, and screen decision of the equivalent dashboard
  route.
- A `background` call or a `system` call is unattended. It carries no actor.
  The dispatcher refuses an unattended call that carries an actor.
- The dispatcher refuses every other context.

An unattended call runs only when all of these conditions are true:

1. The registry lists that context for the operation.
2. The caller holds the exact capability identity and version: an
   install-time grant for a package, or a manifest declaration for a bundled
   plugin.
3. The installation of the caller is active. For a package, the dispatcher
   checks the activation epoch. For a bundled plugin, the plugin host invokes
   only an installed plugin.
4. The resource rules of the operation permit the request.

An unattended call sees the installation-wide view that the operation
defines. It never acts as a person. It does not take the access of the person
who installed or configured the plugin. There is no system user.

Unattended access is not administrative access. The grant names one versioned
service. An unattended read of `content.read@2` cannot write content and
cannot read Activity. An unattended read of `activity.read@1` cannot read the
audit log.

The registry names the contexts of each operation. No read service is
available in every context by default. The invocation restriction of a call,
such as the network refusal of a webhook verify hook, is a separate check.
Both checks must pass.

## Caller classes

| Capability        | Package | Bundled plugin | Contexts                         |
| ----------------- | ------- | -------------- | -------------------------------- |
| `content.read@1`  | Yes     | No             | `studio`, `background`           |
| `content.read@2`  | Yes     | Yes            | `studio`, `background`, `system` |
| `activity.read@1` | Yes     | Yes            | `studio`, `background`, `system` |

A caller must declare the exact version. A `content.read@1` grant does not
reach a `content.read@2` operation. A `content.read@2` grant does not reach a
`content.read@1` operation. A call without the grant fails with the
`missing_grant` denial. A grant for an unknown version fails installation.

## `content.read@1` compatibility

`content.read@1` is frozen. It keeps its identity, its operations, its
`page` and `pageSize` pagination, its answers, its callers, and its contexts.
It covers playlists, Layouts, Data Sources, schedules, and screen groups. It
does not cover Widgets or media. A package that holds it behaves the same
after this change.

A package that moves from `content.read@1` to `content.read@2` requests a
different service. The install review and the update review show the change
as a removed grant and an added grant.

## `content.read@2`

`content.read@2` reads the content library. It has these operations:

| Operation                         | Answer                         |
| --------------------------------- | ------------------------------ |
| `content.read@2/playlists.list`   | Playlist summaries             |
| `content.read@2/playlists.get`    | One playlist with its items    |
| `content.read@2/layouts.list`     | Layout summaries               |
| `content.read@2/layouts.get`      | One Layout with its references |
| `content.read@2/widgets.list`     | Widget summaries               |
| `content.read@2/widgets.get`      | One Widget with configuration  |
| `content.read@2/media.list`       | Image and video summaries      |
| `content.read@2/media.get`        | One image or video             |
| `content.read@2/dataSources.list` | Data Source summaries          |
| `content.read@2/dataSources.get`  | One Data Source with fields    |
| `content.read@2/schedules.list`   | Schedule summaries             |
| `content.read@2/schedules.get`    | One schedule with its targets  |
| `content.read@2/groups.list`      | Screen group summaries         |
| `content.read@2/groups.get`       | One screen group with members  |

Every `get` takes `{"id": "<uuid>"}`. A missing record answers `not_found`.

### Models

The answers are explicit models that the service owns. They are not database
rows and not domain structs. A new member of a domain record does not reach a
plugin until the service model adds it. A test pins every member.

- A playlist has `id`, `name`, `description`, `sourceType`,
  `publishedRevision`, `draftRevision`, `hasUnpublishedChanges`, `itemCount`,
  `createdAt`, and `updatedAt`. The detail adds `items`, `itemsComplete`,
  `dataSourceIds`, and `tagRule`. The detail describes the authoring draft,
  as Studio does.
- A Layout has `id`, `name`, `description`, `orientation`, `canvasWidth`,
  `canvasHeight`, `draftRevision`, `publishedRevision`, `publishedAt`,
  `hasUnpublishedChanges`, `createdAt`, and `updatedAt`. The detail adds
  `placementCount`, `dependencies`, and `dependenciesComplete`.
- A Widget has `id`, `name`, `description`, `provider`, `configVersion`,
  `createdAt`, `updatedAt`, `availableFrom`, and `expiresAt`. The detail adds
  `folderId` and `configuration`.
- A media item has `id`, `name`, `description`, `type`, `mimeType`,
  `sizeBytes`, `width`, `height`, `durationSeconds`, `processingStatus`,
  `createdAt`, `updatedAt`, `availableFrom`, and `expiresAt`. The detail adds
  `folderId` and `tagIds`.
- A Data Source has `id`, `name`, `description`, `provider`, `configVersion`,
  `status`, `cachedRecordCount`, `createdAt`, and `updatedAt`. The detail
  adds `fields`, `fieldsComplete`, `usingCachedData`,
  `lastSuccessfulRefreshAt`, `lastAttemptedRefreshAt`, `cacheUpdatedAt`, and
  `cacheExpiresAt`.
- A schedule has `id`, `name`, `description`, `type`, `enabled`, `priority`,
  `timezone`, `presentationType`, `playlistId`, `layoutId`, the date and time
  members of its rule, `daysOfWeek`, `createdAt`, and `updatedAt`. The detail
  adds `targets` and `targetsComplete`.
- A screen group has `id`, `name`, `description`, `displayMode`,
  `presentationType`, `playlistId`, `layoutId`, `screenCount`, `createdAt`,
  and `updatedAt`. The detail adds `screenIds` and `screensComplete`.

A relationship list in a detail is bounded so that the answer fits the
transport bound. The `*Complete` member is `false` when the list holds fewer
entries than the record has: 100 playlist items, 200 Layout dependencies,
250 schedule targets, 500 group screens, and 200 Data Source fields.

### Widgets and media

Media stores Widgets, but the service shows them as different resources.

- `widgets.list` and `widgets.get` read Widgets only.
- `media.list` and `media.get` read images and videos only. A Widget ID
  answers `not_found` from `media.get`, and an image ID answers `not_found`
  from `widgets.get`.
- No operation reads a private plugin asset, such as a Form attachment or a
  feed image. Such an ID answers `not_found`.
- Lists read the live library: archived, expired, and plugin-managed records
  are not listed, as in the Studio library.

### Excluded data

No `content.read@2` answer contains:

- file paths, storage keys, file names, variants, thumbnail URLs, or signed
  URLs;
- private attachment bytes or processing payloads, errors, and metadata;
- credentials, tokens, secret headers, or connection secrets;
- a Data Source configuration, cached records, or uploaded CSV data.

A Widget configuration is authored content. The service returns it without
every member whose name contains a secret word, such as `token`, `secret`,
`password`, `credential`, `authorization`, `cookie`, or `apiKey`, at any
depth. A configuration larger than 32 KiB is omitted, and
`configurationOmitted` is `true`.

Record-level Data Source access is not part of this service. A later design
must add it as a separate decision.

### Authorization

A `studio` call takes the decision of the equivalent dashboard route:

| Resource     | Studio decision                                  |
| ------------ | ------------------------------------------------ |
| Playlist     | `playlist.read`                                  |
| Layout       | `layout.read`                                    |
| Widget       | `widget.read` and the operator's content access  |
| Media        | `media.read` and the operator's content access   |
| Data Source  | `datasource.read`                                |
| Schedule     | `schedule.read` and the operator's screen access |
| Screen group | `screen.read` and the operator's screen access   |

A missing capability answers `forbidden`. A record outside the operator's
content access or screen access answers `not_found`, as the dashboard does.
The service uses `internal/authz` and `media.AssetInScopeSQL`. It has no
access rule of its own.

An unattended call reads the whole installation under the grant.

## `activity.read@1`

`activity.read@1` reads measured operational evidence. It is separate from
`content.read@2` because it shows a different class of data. Content says
what exists. Activity says what played and how screens behave.

| Operation                            | Answer                                     |
| ------------------------------------ | ------------------------------------------ |
| `activity.read@1/proof.list`         | Proof-of-play sessions                     |
| `activity.read@1/proof.summary`      | Proof-of-play metrics by one dimension     |
| `activity.read@1/compliance.summary` | Expected against confirmed playback        |
| `activity.read@1/screens.current`    | Health and current playback of each screen |

### One definition

The Studio Activity routes and the service both read
`internal/activityreport`. The package owns the range rules, the proof
filters and their SQL, the summary and compliance calculations, the
expected-window judgement, and the fleet classification. Parity tests run
both consumers on the same rows.

### Range and filters

- `from` and `to` are RFC 3339 timestamps. A missing value defaults to the
  last 24 hours. `from` must be earlier than `to`. A range may not exceed five
  years. A range error answers `invalid_input`.
- `proof.list` and `proof.summary` accept `screen`, `group`, `result`,
  `sessionType`, `terminalReason`, `content`, `presentation`, `schedule`,
  `takeover`, and `search`.
- `screen` and `group` must be UUIDs. `result` and `sessionType` must be
  values of the Activity contract. `terminalReason` must be a terminal reason
  or `unexpected`, which selects the reasons that the Interrupted plays metric
  counts. `presentation` selects a presentation of any type.
- `content`, `presentation`, `schedule`, and `takeover` hold at most 128
  bytes. `search` holds at most 200 bytes.
- A filter error answers `invalid_input`.

### Proof records

`proof.list` returns sessions newest first. The ID breaks a tie. A record has
these members, when the session has a value:

`id`, `startedAt`, `endedAt`, `screenId`, `screenName`, `groupId`,
`groupName`, `sessionType`, `presentationType`, `presentationId`,
`presentationRevision`, `presentationName`, `contentType`, `contentId`,
`contentName`, `playlistItemId`, `layoutPlacementId`, `actualDurationMs`,
`expectedDurationMs`, `result`, `terminalReason`, `trigger`, `scheduleId`,
`takeoverId`, `manifestVersion`, `failureCode`, `sourceId`,
`selectedRecordId`, `selectionDate`, `sourceCachedAt`, `sourceRevision`, and
`snapshotHash`.

A record never contains the stored `metadata`, the Studio `details`, a raw
failure payload, an IP address, a request identifier, a credential, a token,
a cookie, an authorization header, a source payload, or diagnostic data. The
safe view applies to every caller. A Studio operator who holds
`activity.manage` receives the same record. A plugin that needs privileged
diagnostic Activity must use a separate capability. `activity.read@1` does
not grow to cover it.

### Summaries

`proof.summary` takes `dimension`: `screen`, `content`, `presentation`, or
`schedule`. The default is `screen`. Each group has `key`, `label`,
`confirmedScreenPlaybackMs`, `contentExposureMs`, `records`, `completed`,
`failures`, `partial`, `unknown`, `interrupted`, and
`sessionCompletionPercent`. The meanings are those of
[Activity](activity.md).

`compliance.summary` takes `screen`, `schedule`, and `dimension`: `screen`,
`location`, `group`, `presentation`, `schedule`, `date`, or `reason`. The
answer has `totals` and one page of groups. The totals have
`measurableExpectedMs`, `confirmedMs`, `missedMs`, `compliancePercent`,
`takeoverOverriddenMs`, `cancelledMs`, `notMeasurableMs`, `windows`,
`lateStarts`, `earlyEndings`, `neverStarted`, `offlineMisses`,
`failedWindows`, and `partialWindows`. A group has `key`, `label`,
`measurableExpectedMs`, `confirmedMs`, `missedMs`, `compliancePercent`,
`windows`, `lateStarts`, `earlyEndings`, `neverStarted`, `offlineMisses`,
and `topFailureReason`. The report reads the materialized expected windows.
It does not compute past expectations from current schedules. Like the
Studio route, the service first judges every finished window.

### Current screens

`screens.current` answers what each measured screen does now. It does not
replace `screens.read@1`, which owns the static facts and the Player
capabilities of a screen. A screen has `screenId`, `screenName`, `health`,
`healthReason`, `online`, `lastContactAt`, `currentPresentation`,
`currentContent`, `lastHealthyPlaybackAt`, and
`lastSuccessfulManifestActivationAt`.

- `health` is `healthy`, `impaired`, `offline`, or `unmeasured`.
  `healthReason` names the reason, as the Activity overview does.
- `online` is reachability alone.
- `currentPresentation` is the newest open root presentation session.
  `currentContent` is the newest open session inside it.
- The population is the measured fleet: enabled, not archived, not deleted,
  and with a live device credential.

The answer contains no telemetry, IP address, diagnostic payload, or screen
event. The Studio per-screen route derives a current issue from recent
screen events, which only `activity.manage` reads. The service does not
return that issue. `healthReason` is the safe summary.

### Authorization

A `studio` call needs `activity.read`. Historical proof and compliance cover
the whole installation, as the Studio routes do. `screens.current` is
narrowed to the operator's screen access, as the fleet health card and the
per-screen routes are. See [Screen access](screen-scopes.md).

An unattended call reads the whole installation under the grant.

## Pagination

Every `*.list` operation of `content.read@2` and `activity.read@1`, and every
grouped answer of `proof.summary`, `compliance.summary`, and
`screens.current`, uses one cursor contract:

```json
{ "limit": 50, "cursor": "opaque-token" }
```

```json
{ "items": [], "nextCursor": "opaque-token" }
```

- `limit` defaults to 50. The maximum is 250. A limit outside 1 to 250
  answers `invalid_input`.
- A page holds at most `limit` items. It holds fewer when the items do not
  fit the 64 KiB transport bound of the operation. `nextCursor` then
  continues the list.
- An answer without `nextCursor` is the last page.
- Content lists order by creation time, oldest first. Proof lists order by
  start time, newest first. The record ID breaks every tie. Summaries order by
  their largest measure, then label and key.
- A caller must treat the cursor as opaque. Its encoding is not a contract.
- A cursor belongs to one operation and one set of filters. A cursor with
  another operation or other filters answers `invalid_input`. Start again
  without a cursor.
- An Activity cursor keeps the range of its first page, so a default range
  does not move between pages.
- A cursor grants nothing. The dispatcher decides authorization again for
  every page.

## Install review

The review payload of a grant carries `contexts`, and each operation carries
its own `contexts`. A bundled plugin's catalog entry carries the same
`services` review. Studio uses the contexts to say whether a grant works
while the plugin runs automatically. Studio never calls unattended access
administrative access.
