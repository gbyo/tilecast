# Plugin events

A Plugin Manifest API 3 plugin can receive Server events and publish its own
Server events. This document is the contract for both. The
[ADR](adr/plugin-model-v3.md), section 9, records the decision. The
[delivery queue](plugin-delivery.md) delivers each event.

These are Server events. They are not the Player plugin events of
[Plugin API v2](plugin-api-v2.md).

In phase 3, events are for bundled plugins only. `events.publish@1` accepts
only bundled callers, and the hook is the Go method `HandleEvent`. The
`handle_event` export of an installed WebAssembly plugin is phase 6.

## Manifest

A manifest declares events in the `events` member:

```json
{
  "services": ["events.publish@1"],
  "events": {
    "publishes": [
      {
        "name": "period_started",
        "version": 1,
        "title": "Period started",
        "description": "A class period started.",
        "fields": [
          {
            "key": "period",
            "label": "Period",
            "control": "text",
            "required": true,
            "maxLength": 40
          },
          {
            "key": "minutes",
            "label": "Minutes",
            "control": "integer",
            "minimum": 1,
            "maximum": 240
          }
        ]
      }
    ],
    "subscribes": [
      "takeover.started@1",
      "plugin.bell_schedule.period_started@1"
    ]
  }
}
```

| Rule               | Value                                                          |
| ------------------ | -------------------------------------------------------------- |
| Published events   | At most 16                                                     |
| Subscriptions      | At most 32. A name occurs one time.                            |
| Event name         | 1 to 40 characters: `[a-z][a-z0-9_]*`                          |
| Version            | 1 to 999. A name and version occur one time.                   |
| Title              | Required, at most 80 bytes                                     |
| Description        | At most 200 bytes                                              |
| Payload fields     | 1 to 16, from the `event` profile of the configuration schema  |
| `events.publish@1` | Required when `publishes` is not empty, and refused when it is |

The `event` profile of [the configuration schema](config-schema.md) accepts
only scalar controls: `text`, `multiline_text`, `number`, `integer`,
`boolean`, `select`, `color`, `date`, `datetime`, `local_datetime`, `time`,
`timezone`, `currency_code`, `url`, `string_list`, and `weekdays`. It refuses
a `secret`, a `connection`, a `personal` marker, a media or font reference, a
Data Source binding, and a repeating group.

A plugin that subscribes implements `plugin.EventHandler`. The host queues
nothing for a plugin that does not implement it.

## Event names

A core event has a name from the closed core vocabulary, for example
`takeover.started@1`.

A plugin event has a full name: `plugin.<plugin id>.<name>@<version>`. The
publisher declares only `<name>` and `<version>`. The host adds the plugin ID
of the caller. A plugin cannot publish an event in the name of another
plugin.

A subscriber names the full name. The meaning of a name never changes.

## Core events

The core vocabulary is closed. A manifest cannot name another core event.
Each core event comes from the domain service that owns the change, in the
transaction of the change. An HTTP handler emits a core event only when the
handler transaction is the only writer of that state.

| Event                     | Producer                                                                                                 | Subject             |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------- |
| `screen.status.changed@1` | `internal/connectivity` sweep                                                                            | `screen:<id>`       |
| `takeover.started@1`      | `takeovers.Service` activation                                                                           | `takeover:<id>`     |
| `takeover.ended@1`        | `takeovers.Service` cancellation and expiry                                                              | `takeover:<id>`     |
| `takeover.suspended@1`    | `takeovers.Service` activation                                                                           | `takeover:<id>`     |
| `incident.opened@1`       | Incident derivation, the connectivity sweep, Content Health, and the operator reopen action              | `incident:<id>`     |
| `incident.recovered@1`    | Incident derivation, the connectivity sweep, Content Health, and the operator resolve and ignore actions | `incident:<id>`     |
| `schedule.changed@1`      | `scheduling.Service`, Campaigns, sync group membership, and screen archive                               | `schedule:<id>`     |
| `feed.stale@1`            | Content Health feed sweep                                                                                | `feed:<dataset id>` |

The payload of each core event is a Go type in
`apps/server/internal/coreevents`. `TestCorePayloadsAreFrozen` compares each
type with `testdata/payloads.json`. A changed payload is a new version.

### Screen connectivity

`screen.status.changed@1` reports a persisted transition, not a heartbeat.
The table `screen_connectivity` holds one state for each screen:

- `reachable`: the Server received a heartbeat within the offline threshold
  of `internal/devices` (15 minutes). The display status is then `online`,
  `recent`, or `stale`.
- `offline`: no heartbeat for longer than the threshold.

The notify worker runs the sweep every 30 seconds. The incident list also
runs it before it reads. A transaction advisory lock serializes sweeps of
several Server processes. One outage is one change to `offline` and one
change to `reachable`. The connectivity incident opens and recovers in the
same transaction as the change.

- A screen that the sweep sees for the first time gets a state and no event.
- The sweep reads only enabled screens that are not archived or deleted and
  that have a live device credential.

Payload: `screenId`, `status`, `previousStatus`, `lastContactAt`, and
`changedAt`.

### Takeovers

`takeovers.Service` is the only writer of the Takeover lifecycle.

- An activation emits one `takeover.started@1`, also when a stronger
  Takeover hides the new one on every screen.
- An activation emits `takeover.suspended@1` for each other active Takeover
  that showed on at least one screen before the activation and on no screen
  after it. `suspendedBy` names the new Takeover.
- A cancellation emits `takeover.ended@1` with the reason `cancelled`.
- An expiry emits `takeover.ended@1` with the reason `expired`. `at` is the
  `expiresAt` of the Takeover.

One transaction expires a Takeover as a whole:

1. It locks the due Takeovers in ID order.
2. It changes each Takeover from `active` to `expired`.
3. It expires each screen state that is not ended.
4. It increments the manifest version of each affected screen one time.
5. It emits one `takeover.ended@1` for each Takeover.

The notify worker runs this transition every 30 seconds. A manifest build
also runs it for the Takeovers of its own screen, through
`playlists.TakeoverExpirer`, before it reads the manifest version. The other
screens of the Takeover end in the same transaction. A concurrent expiry
waits for the lock, then reads the status again and finds nothing to do. Thus
each Takeover emits one `takeover.ended@1`. Player notifications go out after
the commit.

Payload: `takeoverId`, `class`, `screenCount` (the screens it targets),
`effectiveScreenCount` (the screens that show it under the precedence rule),
`activatedAt`, `expiresAt`, `reason`, `suspendedBy`, and `at`.

### Incidents

- `incident.opened@1` has the reason `detected` when a condition opens a new
  incident, and `reopened` when an operator reopens a closed incident.
- `incident.recovered@1` has the reason `automatic` when the condition ends,
  and `resolved` or `ignored` when an operator closes an open or acknowledged
  incident.
- A recurrence of an open incident is not an event. Acknowledge, assign, and
  note are not events.

Incident derivation runs in the Player activity ingest transaction. The
operator actions run in the transaction of
`PATCH /api/v1/activity/incidents/{id}`. No other code changes the incident
lifecycle.

Payload: `incidentId`, `type`, `severity`, `failureCode`, `screenId`,
`relatedType`, `relatedId`, `reason`, and `at`. The payload never holds the
title or the description.

### Schedules

`schedule.changed@1` has one change: `created`, `updated`, `enabled`,
`disabled`, or `deleted`.

- A save that changes nothing is not an event.
- A save that changes only the enabled switch is `enabled` or `disabled`.
- `targetsChanged` is true when the screens or groups that the schedule
  targets changed.
- A Campaign publication deletes and creates its schedules. A Campaign
  archive deletes them.
- The deletion of a group disables the schedules that targeted it.
- A screen that joins a sync group moves its screen targets to the group. A
  screen that leaves moves them back. Each move is `updated` with
  `targetsChanged`.
- A screen archive removes the screen from schedule targets. This is
  `updated` with `targetsChanged`.

Payload: `scheduleId`, `change`, `enabled`, `targetsChanged`, and `at`.

### Feed staleness

`feed.stale@1` reports that a plugin feed dataset is stale: no publication
for twice its expected refresh interval, while a Widget uses it. The Content
Health sweep opens the incident and emits `incident.opened@1` and
`feed.stale@1` in one transaction.

`feed.stale@1` reaches only the plugin that owns the feed. A subscription of
a plugin without feeds is inactive.

Payload: `datasetId`, `feed`, `instanceId`, `publishedAt`,
`expectedRefreshSeconds`, and `staleSince`.

## Publish an event

A plugin publishes with `events.publish@1`:

```go
occurrence, err := p.services.PublishEvent(ctx, "period_started@1", "room-12",
	map[string]any{"period": "3", "minutes": 50})
```

| Input     | Rule                                                       |
| --------- | ---------------------------------------------------------- |
| `event`   | `<name>@<version>` of a declared event of the caller       |
| `subject` | 1 to 128 bytes of UTF-8, without control characters        |
| `payload` | A JSON object. Encoded after normalization, at most 4 KiB. |

The host:

1. Refuses an undeclared name or version.
2. Normalizes the payload with the declared fields. It refuses an unknown
   key, a value of the wrong type, a value outside a bound, and a missing
   required value. It applies a declared default to an omitted value.
3. Begins a transaction.
4. Refuses the call when the plugin is not installed.
5. Records the schema fingerprint of the version the first time. It refuses
   the call when the recorded fingerprint differs.
6. Queues one delivery for each installed subscriber.
7. Commits.

The answer holds the occurrence ID and the number of deliveries.

| Failure                    | Code                   |
| -------------------------- | ---------------------- |
| Undeclared event           | `not_found`            |
| Invalid subject or payload | `invalid_input`        |
| Changed payload schema     | `event_schema_changed` |
| Plugin not installed       | `not_found`            |

### Transaction semantics

The host queues the deliveries of one occurrence in one transaction. All
subscribers receive the occurrence, or none does. A successful answer means
the deliveries committed.

`events.publish@1` opens its own host transaction. It does not share a
transaction with other service calls of the plugin, for example
`storage.kv@1` or `feeds.publish@1`. Thus:

- A plugin must write its own state first and publish after that write
  succeeds.
- A publication can fail after the state write. A plugin that must publish
  for each state change does the work in a timer or an event hook, which the
  host retries.
- A subscriber can receive an event before the publisher's later writes are
  visible.

A core producer emits in the transaction of its change. A core event exists
when the change commits, and a rolled-back change emits nothing. A core event
with no subscriber causes no database write.

## Subjects and order

The subject names the object whose events must stay in order. It never names
the event.

- Delivery is in order for each subscriber and subject. One delivery of a
  subject runs at a time.
- The host stores the subject of a plugin event as
  `plugin.<publisher>:<subject>`. Two publishers never share an order. The
  hook receives the subject that the publisher named.
- The delivery queue adds the kind: `event:<subject>`. A timer key and an
  event subject with the same text never share an order.

## Payload contract and versions

A payload contract never changes under a version. A changed payload is a new
version, which is a new name. A subscriber subscribes to each version it
reads.

### Schema fingerprint

The host records a fingerprint of each published version in
`plugin_event_schemas` on the first publication. The row stays after a
removal, so a reinstall of the same version keeps the same contract.

The fingerprint is the SHA-256 of a canonical JSON form. The form holds only
the properties that change which payloads the host accepts or what a
subscriber receives:

- `key`, `control`, and `required`
- `default`, because it fills an omitted value
- `minimum` and `maximum`
- `minLength` and `maxLength`
- the values of `options`
- `maximumItems`
- `itemFields`, with the same rules

The form sorts fields by key and option values by value. A payload is a JSON
object and a select value is checked by membership, so a change of order is
not a schema change.

The form does not hold `label`, `labelKey`, `description`,
`descriptionKey`, option labels, or `ui`. A plugin can change these under the
same version.

The form starts with a format number. A change to the form is a new format.
A test pins the hash of a sample schema, and a test fails when
`configschema.Field` gets a property that the form does not classify.

When the declared schema differs from the recorded fingerprint, the host
refuses the publication with `event_schema_changed`. The Status page of the
publisher shows the version as changed.

## Receive an event

A bundled plugin implements:

```go
func (p *Plugin) HandleEvent(ctx context.Context, event plugin.Event) error
```

| Field          | Content                                                 |
| -------------- | ------------------------------------------------------- |
| `DeliveryID`   | Stable for each attempt of this delivery to this plugin |
| `OccurrenceID` | The same for each subscriber of one occurrence          |
| `Name`         | The full event name                                     |
| `Subject`      | The subject                                             |
| `OccurredAt`   | The time of the change, or the time of the publication  |
| `Payload`      | The JSON payload. `Decode` copies it into a struct.     |
| `Attempt`      | 1 for the first attempt                                 |

The host calls `HandleEvent` in the `system` context, with no operator, for
at most 30 seconds.

Delivery is at least once. The same `DeliveryID` can arrive again after a
crash, a timeout, or an error, also after the hook completed its work. A hook
must give the same result for the same delivery ID. A subscriber that must
act one time for each occurrence across several deliveries keys its work on
`OccurrenceID`.

A returned error retries the delivery. The retry, parking, Owner retry and
discard, and retention rules are the rules of
[the delivery queue](plugin-delivery.md): a retry after 5 seconds, then
doubled to at most 15 minutes, and parking after 8 failed attempts.

## Inactive subscriptions

An install of a subscriber does not need the publisher. A subscription that
cannot receive anything is inactive. The plugin status gives the reason:

| Reason                    | Cause                                                               |
| ------------------------- | ------------------------------------------------------------------- |
| `publisher_unknown`       | This release does not include the publishing plugin on API 3.       |
| `publisher_not_installed` | The publishing plugin is not installed.                             |
| `event_not_declared`      | The publisher does not declare this name and version.               |
| `no_own_feeds`            | `feed.stale@1` reaches only own feeds, and the plugin has no feeds. |

A subscription becomes active when its cause ends. The host does not deliver
earlier occurrences.

The delivery sweep deletes queued deliveries of a name that the plugin no
longer subscribes to. Removal deletes the queue of the plugin.

## Studio

`GET /api/v1/plugins/{pluginId}/status` adds:

- `subscriptions`: each event the plugin receives, its state, the reason of
  an inactive state, the publisher (`core` or a plugin ID), and the name of a
  publishing plugin that this release includes;
- `publishedEvents`: each event the plugin publishes, its title, the number
  of installed subscribers, and `schemaChanged`.

Studio generates a **Status** page for a plugin that schedules timers,
publishes events, or subscribes to events. The page shows the subscriptions
and the published events in separate sections.

The catalog entry of a plugin holds `events`: the events it publishes, with
the full name, the title, and the number of fields, and the events it
receives, with the publisher. The Store detail shows them in an **Events**
section. A core event shows as a Tilecast event. A plugin event names the
publishing plugin. The section is information for the operator. It grants
nothing.

## Storage

| Table                  | Content                                                                                   |
| ---------------------- | ----------------------------------------------------------------------------------------- |
| `screen_connectivity`  | One row for each screen: `reachable` or `offline`, and the time of the change             |
| `plugin_event_schemas` | One row for each published plugin, event name, and version: the fingerprint and first use |
| `plugin_deliveries`    | Queued event deliveries. See [plugin delivery](plugin-delivery.md).                       |

The tables are in backups.

## Tests

- `apps/server/pluginharness/events_test.go` runs conformance with a test
  publisher, a test subscriber, and the real core producers on a stepped
  clock: publication rules, subscriptions that follow the publisher, order,
  retry, rollback, removal, the core payloads, and the owner rule of
  `feed.stale@1`.
- `apps/server/internal/takeovers/expiry_test.go` tests the expiry of a
  Takeover on several screens: a manifest request on one screen, the sweep
  first, a concurrent expiry that waits, and racing sweeps and manifest
  builds.
- `apps/server/internal/plugins/v3_event_fingerprint_test.go` tests which
  schema changes change the fingerprint.
