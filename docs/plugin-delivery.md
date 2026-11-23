# Plugin delivery

The plugin delivery queue runs every host callback of a bundled Plugin
Manifest API 3 plugin: durable timers, events, and inbound webhook requests.
This document is the contract for the queue. The
[ADR](adr/plugin-model-v3.md), section 9, records the decision.

The queue is in `apps/server/internal/plugindelivery`. The package knows no
plugin and no HTTP handler. A producer adds an item in its own transaction.
An engine claims due items and gives each item to the plugin.

## Kinds

| Kind      | Producer                      | Source              | Subject                | Hook            |
| --------- | ----------------------------- | ------------------- | ---------------------- | --------------- |
| `timer`   | `timers.schedule@1`           | the timer key       | the timer key          | `HandleTimer`   |
| `event`   | an event (phase 3B)           | the full event name | see the event contract | `HandleEvent`   |
| `webhook` | an inbound request (phase 3C) | the webhook ID      | the webhook ID         | `HandleWebhook` |

A later kind, for example a Player report, is a new kind value. It is not a
new queue.

The queue stores a subject as `<kind>:<subject>`. Thus a timer key and an
event subject with the same text never share an order.

## Semantics

| Rule              | Value                                                              |
| ----------------- | ------------------------------------------------------------------ |
| Delivery          | At least once                                                      |
| Delivery ID       | Stable. The plugin receives the same ID on each attempt.           |
| Order             | Sequence order for one plugin and subject                          |
| Items in progress | One for each plugin and subject                                    |
| Parallel subjects | At most 4 for each plugin, across all Server processes             |
| Job time limit    | 30 seconds, in the `system` context                                |
| Lease             | 2 minutes                                                          |
| Retry             | 5 seconds after the first failure, then double, at most 15 minutes |
| Parking           | After 8 failed attempts                                            |
| Pending retention | 7 days after the item became due                                   |
| Parked retention  | 14 days after the item was parked                                  |
| Success           | The host deletes the item.                                         |

The bound of 4 keeps one plugin from holding many database connections and
provider requests. Other subjects of the plugin still move while one subject
waits.

### Order

The head of a subject is its pending item with the lowest sequence. Only the
head can run. A later item never runs before the head, also when the head
waits for a retry or is due in the future. A parked item leaves the order, so
the next item of its subject runs.

Two transactions can add items to one subject at the same time. The order of
such items is the order of their sequence values. A producer that needs a
strict order for one subject adds its items from one transaction or from one
callback.

### Claims

1. A worker begins a transaction and takes the advisory lock
   `plugin_deliveries:<plugin>`.
2. It reads the installation of the plugin. A plugin that is not installed
   gets no claim.
3. It deletes the items that never run: items of an earlier installation,
   cancelled items whose claim ended, and items of another
   `definitionVersion`.
4. It parks an item whose eighth claim ended without a result, with the code
   `lease_expired`.
5. It counts the live claims of the plugin. Live claims of other processes
   count.
6. It claims the head of each free subject, up to the bound. A claim sets a
   random claim token, a lease, and adds one to `attempts`.

The worker runs each callback outside the claiming transaction. Success,
retry, and parking name the item ID and the claim token. A worker whose lease
ended, or whose item was cancelled, changes nothing but its own cancelled
item.

The advisory lock makes the subject rule and the bound hold across Server
processes. A process-local lock does not.

### Failures

A failure is one of these stable codes:

| Code              | Cause                                                               |
| ----------------- | ------------------------------------------------------------------- |
| `handler_error`   | The hook returned an error.                                         |
| `handler_timeout` | The hook returned after the job time limit.                         |
| `handler_panic`   | The hook panicked. The Server recovers and continues.               |
| `lease_expired`   | The eighth claim ended without a result, for example after crashes. |

The queue stores no error text and no payload in a status field or a log
field. A hook that ignores its context keeps its claim until it returns. The
lease of 2 minutes lets another process claim the item after a crash.

A Server shutdown cancels running hooks. The host then releases the claim,
and the attempt does not count.

### Cancellation

A producer can cancel the items of one source, for example when a plugin
schedules a timer key again. An item that waits is deleted. An item whose
hook runs now becomes `cancelled`:

- It keeps its subject until its claim ends. A replacement of the same
  subject waits for it.
- Its result changes nothing. Success, failure, and the end of the lease
  delete only the cancelled item.
- The host never runs it again.

## At least once

The host can deliver one item more than once. For example:

1. The hook writes to a provider.
2. The Server stops before it records the success.
3. After the lease, another process delivers the item again, with the same
   delivery ID and the next attempt number.

A hook must give the same result for the same delivery ID. Examples:

- Keep the last processed ID or boundary in `storage.kv@1` and compare it
  with `compareAndSet`.
- Read the current state from the provider and write a complete result, such
  as a feed publication, instead of an increment.

## Reconciliation

The engine runs a sweep at startup and every minute:

- It expires pending items 7 days after they became due, and parked items 14
  days after they were parked. The status of the plugin adds the count and
  the time.
- It deletes the items of a plugin that is not installed.
- It deletes the items that the plugin no longer accepts: a plugin that stops
  handling timers, stops subscribing to an event name, or removes a webhook.

The queue holds nothing for a plugin that is not installed:

- `Enqueue` writes nothing when the plugin is not installed.
- Each item records the `installed_at` of the installation it was queued
  for. An item runs only while that installation exists. An item that a
  removal raced with belongs to the earlier installation: it never runs, also
  after a reinstall, and the sweep deletes it.
- `Enqueue` takes no lock on the installation. A removal locks the
  installation and then changes screens, as many producers do. A lock would
  let a producer and a removal wait for each other.
- Removal deletes the queue and the status of the plugin in the removal
  transaction.

## Status and Owner actions

`GET /api/v1/plugins/{pluginId}/status` needs `plugins.use`. It returns:

- the number of pending items, and of running items;
- the parked items, at most 50, newest first, with the kind, the source, the
  subject, the attempts, the last failure code, and the expiry time;
- the expired count and the time of the last expiry;
- the last failure code, its kind, and its time.

The status never holds a payload, a metadata value, a secret, or an error
text.

An Owner retries or discards a parked item:

| Operation                                               | Effect                                                                                         |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `POST /api/v1/plugins/{pluginId}/deliveries/{id}/retry` | The item returns to the end of its subject's queue with the same ID. Its attempts start again. |
| `DELETE /api/v1/plugins/{pluginId}/deliveries/{id}`     | The host deletes the item. The plugin never receives it.                                       |

Both need the Owner-reserved capability `plugins.deliveries.manage`, CSRF for
a cookie session, and the `admin` scope. See
[access control](access-control.md). The audit event
`plugin.delivery.retried` or `plugin.delivery.discarded` records the plugin,
the delivery ID, the kind, and the subject. It never records the payload.

Studio generates a **Status** page for a plugin with queued work. An Owner
sees **Retry** and **Discard**. Other accounts see the parked items without
the actions.

## Storage

| Table                    | Content                                                                                                                                                                                                                                 |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `plugin_deliveries`      | One row for each item: ID, plugin, definition version, kind, source, subject, payload (at most 64 KiB), metadata (at most 16 KiB of JSON), sequence, due time, next attempt time, attempts, state, claim, last failure code, and times. |
| `plugin_delivery_status` | One row for each plugin: expired count, last expiry, last failure code, kind, and time.                                                                                                                                                 |

The tables are in backups. A restore keeps pending and parked items. A claim
in a backup ends with its lease.

## Tests

`apps/server/internal/plugindelivery` tests the engine with a fake plugin and
a stepped clock: order, the bound across two engines, one subject across two
engines, lease expiry and redelivery with the same ID, timeout, panic,
backoff, parking, retry, discard, retention from the due time, expiry counts,
removal, definition versions, reconciliation, and cancellation of a running
item. No test waits for a retry or a lease on the wall clock.
