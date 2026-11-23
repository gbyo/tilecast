# Plugin provider slots

A provider slot is a typed interface of a core feature. Core owns the
semantics. A Plugin Manifest API 3 plugin supplies one function. This
document is the contract of the phase 3 slots. The
[ADR](adr/plugin-model-v3.md), section 14, records the decision.

| Slot                     | Core feature    | The plugin supplies                         |
| ------------------------ | --------------- | ------------------------------------------- |
| `notifications.channels` | `notify`        | Delivery of a rendered message to a channel |
| `contenthealth.checks`   | `contenthealth` | A check of one item that core passes in     |

In phase 3, provider slots are for bundled plugins only. The installed
`check_content` export and installed notification providers are phase 6.
Later slots, such as `automation.triggers`, are not part of this release.

## Manifest

```json
{
  "providers": {
    "notifications": {
      "channels": [
        {
          "id": "push",
          "title": "ntfy",
          "description": "Sends to an ntfy topic."
        }
      ]
    },
    "contentHealth": {
      "checks": [
        {
          "id": "readability",
          "title": "Readability",
          "kinds": ["playlist", "layout"]
        }
      ]
    }
  }
}
```

| Rule       | Value                                                                      |
| ---------- | -------------------------------------------------------------------------- |
| Channels   | 1 to 2 for each plugin                                                     |
| Checks     | 1 to 4 for each plugin                                                     |
| ID         | 1 to 40 characters: `[a-z][a-z0-9_]*`. An ID occurs one time in its slot.  |
| Title      | 1 to 80 bytes. `description` is at most 280 bytes.                         |
| Item kinds | 1 to 4 of `playlist`, `layout`, `widget_instance`, `media_item`, each once |

API 1 and API 2 refuse `providers`. A plugin that declares channels must
implement `NotificationChannelProvider`. A plugin that declares checks must
implement `ContentChecker`. The SDK refuses a hook without its declaration.

## Notification channels

A channel delivers a notification that Tilecast already decided to send. It
does not create notifications. There is no `notifications.send` service. A
plugin cannot choose recipients, users, addresses, volume, category,
severity policy, quiet hours, or digests.

The notification path does not change:

1. An incident changes state.
2. `notify.ScanIncidents` turns the transition into one event.
3. The notification policy decides: notifications on, and the minimum
   severity. A recovery is tested at the severity of the condition it ends.
4. `Enqueue` writes one row in `notification_deliveries` for each target:
   each subscribed person's email, each notification webhook, and each ready
   plugin channel.
5. `DeliverDue` sends each row.

A plugin channel row has channel `plugin` and target
`<plugin id>:<channel id>`. Like a notification webhook, a channel is a
machine receiver, so quiet hours and digests do not apply. The outbox keeps
its idempotency key (`event_key`, channel, target), its lease, its backoff,
and its attempt limit. Plugin channels do not use the plugin delivery queue.

### Hooks

```go
func (p *Plugin) DeliverNotification(ctx context.Context, n plugin.Notification) error

// Optional.
func (p *Plugin) NotificationChannelReady(ctx context.Context, channel string) (bool, error)
```

`plugin.Notification` holds only what delivery needs: the channel ID, the
event key, the category, the severity, the subject, the body, the time, and
the Studio address when the Server has a public address. The host renders
the subject and the body. The hook runs in the `system` context with a
30-second time limit. A channel may use its own declared `http.fetch@1`
connection.

`NotificationChannelReady` runs when notify queues a notification, with a
2-second time limit. A channel that answers false gets no row, so an
intentionally disabled or unconfigured channel leaves no failed delivery. A
hook that fails or runs out of time counts as ready. Without the hook, a
declared channel of an installed plugin is ready.

### Outcomes

Core decides from typed values, never from an error text:

| Hook result                             | Delivery                                     |
| --------------------------------------- | -------------------------------------------- |
| `nil`                                   | `sent`                                       |
| `plugin.ErrChannelUnavailable`          | `cancelled`: the channel was turned off      |
| wraps `plugin.ErrNotificationPermanent` | `failed` at once                             |
| any other error, a panic, a time-out    | retried on the outbox backoff, then `failed` |
| the plugin or channel is gone           | `cancelled`                                  |

The delivery log stores a fixed message for each outcome. It never stores
the plugin's error text.

A removed plugin, or a channel that a definition upgrade removed, receives
no new rows. A pending row of it is cancelled when it comes due.

## Content Health checks

A check reads one content item that Content Health passes in and returns
named conditions. Core owns the incidents.

```go
func (p *Plugin) CheckContent(ctx context.Context, item plugin.ContentItem) ([]plugin.Condition, error)
```

The hook runs in the `system` context with a 10-second time limit for each
item. The check gets no other read access to content: no `content.read`
service, and no list of the library. A sweep has no operator and no content
access decision.

### Content model

`plugin.ContentItem` is a versioned, read-only model. Version 1 has the
check ID, the kind, the item ID, the name, the description, and one of:

| Kind              | Model                                                                                |
| ----------------- | ------------------------------------------------------------------------------------ |
| `playlist`        | Source type, and the items in play order with asset names, types, status, and timing |
| `layout`          | Orientation, canvas size, and the working document                                   |
| `widget_instance` | Provider, configuration version, and configuration                                   |
| `media_item`      | Type, MIME type, size, duration, processing status, and availability window          |

The host builds the model from the public API model of the domain service,
never from a database row. It leaves out users, the usage of an item by
other content, screens, or schedules, preview addresses, and credentials. A
playlist has at most 500 items, and a document or configuration is at most
64 KiB. A larger item fails with `item_too_large`.

The items are the library's: not deleted, not archived, and not
system-managed. `media_item` excludes Widgets and websites.

### Changed items

Core does not trust `updated_at` columns to detect a change. For each item,
it builds the model, encodes it as canonical JSON (sorted object keys, also
inside an embedded document), and takes the SHA-256. It keeps the
fingerprint of the last completed check for each plugin, check, kind, and
item.

Core runs the check when the item is new, when the fingerprint changed, or
when the last check of the item failed. Each sweep reads at most 200 items
of each kind for each check: items never checked first, then the items
checked longest ago.

When the check completes, core in one transaction:

1. stores the new fingerprint;
2. opens an incident for each new condition, or keeps the open one;
3. recovers the item's earlier conditions that the check no longer returns;
4. emits `incident.opened@1` and `incident.recovered@1`.

When the check fails, core keeps the old fingerprint and the old
conditions, and records a failure code: `check_failed`, `check_timeout`,
`check_panic`, `invalid_result`, or `item_too_large`. A failing check never
means that everything recovered. The item is checked again on a later sweep.

When the item disappears, core recovers its conditions and deletes its state.

### Conditions

| Rule       | Value                                                          |
| ---------- | -------------------------------------------------------------- |
| Conditions | At most 16 for one item                                        |
| Name       | 1 to 40 characters: `[a-z][a-z0-9_]*`. A name occurs one time. |
| Severity   | `info`, `warning`, `error`, or `critical`                      |
| Reason     | 1 to 280 bytes                                                 |

A result that breaks a rule is the failure `invalid_result`.

Each condition is an incident of type `content` with the failure code
`plugin_check`. Its dedupe key is
`plugin_check:<plugin>:<check>:<kind>:<item>:<condition>`. The plugin cannot
choose it. The title is the check title and the item name; the description
is the reason. Core owns the incident ID, its opening, its deduplication, its
recovery, Activity, and its notifications: a condition reaches the
notification outbox like every content incident, in the `content_health`
category.

The built-in checks do not change: stale Data Sources, stale plugin feeds,
empty assigned playlists, and the media report. The empty-playlist recovery
does not touch a plugin check's incident.

## Status and install review

The Status page has a section for the plugin's provider slots:

- each channel: ready or off, and how many deliveries were sent, wait, or
  failed;
- each check: the item kinds, the items checked, the items whose last check
  failed with the latest failure code, and the open conditions.

The install review lists each channel and each check with the kinds it reads.

## Lifecycle

- Removing the plugin recovers the open conditions of its checks, emits
  `incident.recovered@1`, and deletes its check state, in the removal
  transaction. New notifications skip its channels, and its pending
  notification rows are cancelled.
- A check or kind that a definition upgrade removes is retired on the next
  sweep: its conditions recover and its state is deleted.
- Removing a plugin never deletes content.

## Storage

Migration `00147_plugin_providers.sql`:

- allows the channel `plugin` in `notification_deliveries`;
- adds `plugin_content_check_state`: the fingerprint, the times of the last
  check, success, and failure, and the failure code of each plugin, check,
  kind, and item.

## Tests

`apps/server/pluginharness/providers_test.go` runs a test channel and a test
checker against the real host, the real notification outbox, and the real
Content Health sweep. It covers the notification policy, quiet hours for a
machine channel, one delivery for one transition, recovery notifications,
each delivery outcome, a removed channel, unchanged email and webhook
targets, the absence of a send service, declared kinds only, the content
model, fingerprints, dedupe, recovery, failed checks, invalid results, item
deletion, plugin removal, and the notification of a check's incident.
