# Plugin storage and timers

A bundled Plugin Manifest API 3 plugin keeps small values with
`storage.kv@1` and schedules callbacks with `timers.schedule@1` and
`timers.cancel@1`. This document is the contract for these services. The
decision record is [ADR: Plugin Model V3](adr/plugin-model-v3.md), sections 10
and 11.

The three services are for bundled plugins only. A package grant for one of
them fails closed. The package KV imports of WebAssembly packages keep their
own contract ([Package services](package-services.md)) and the same bounds.

## `storage.kv@1`

### Namespace

Each plugin has one namespace. The host binds the plugin identity into the
call. No input names a namespace or another plugin, and the dispatcher refuses
an input with an unknown member.

### Operations

| Operation                     | Input                         | Answer                          |
| ----------------------------- | ----------------------------- | ------------------------------- |
| `storage.kv@1/get`            | `key`                         | `value`, or `not_found`         |
| `storage.kv@1/set`            | `key`, `value`                | `stored: true`                  |
| `storage.kv@1/compareAndSet`  | `key`, `expected`, `value`    | `swapped: true` or `false`      |
| `storage.kv@1/delete`         | `key`                         | `deleted: true` or `false`      |

A value is bytes. JSON carries it in base64. An empty value is a value, and
it is different from a missing key.

`compareAndSet` writes `value` only when the current value is equal to
`expected` byte for byte. `expected: null` means that the key must not exist.
A failed comparison changes nothing and answers `swapped: false`. The
comparison, the quota check, and the write are one transaction. They are not a
read and a later write.

The ADR names `get`, `set`, and `compareAndSet`. `delete` is added so that a
plugin can free its quota and clear a cursor, for example a sync token that
the provider no longer accepts.

### Bounds

| Bound                        | Value     |
| ---------------------------- | --------- |
| Key                          | 1 to 128 bytes |
| Value                        | at most 64 KiB |
| Live values of one plugin    | at most 1 MiB  |

These are the bounds of the package KV. One package,
`apps/server/internal/extensions/kvstore`, holds the bounds, the validation,
the write lock, and the quota arithmetic for both stores, so the two cannot
drift apart. A write takes a transaction-scoped advisory lock on the plugin's
namespace before it sums the other keys. Two concurrent writers therefore
cannot each see room and together pass 1 MiB. A replaced value counts once.

A write over the quota answers `quota_exceeded`. A key or a value out of bounds
answers `invalid_input`.

### Transport limits

A 64 KiB value in base64 is 87,384 bytes. `set` takes that plus 4 KiB for the
key and the JSON, and `get` answers the same size. `compareAndSet` takes two
values plus 4 KiB: 178,864 bytes. `delete` uses the default bounds. The global
32 KiB and 64 KiB defaults do not change.

### Lifecycle

The rows are in `plugin_kv`. They stay when the plugin is removed, like the
plugin's settings and instances, and a reinstall reads them again. Phase 2
has no purge action for bundled plugin data.

## Durable timers

### Operations

| Operation                    | Input                       | Answer               |
| ---------------------------- | --------------------------- | -------------------- |
| `timers.schedule@1/schedule` | `key`, `at`, `payload`      | `id`, `dueAt`        |
| `timers.cancel@1/cancel`     | `key`                       | `cancelled`          |

| Bound                     | Value                                         |
| ------------------------- | --------------------------------------------- |
| Key                       | 1 to 128 bytes of UTF-8, no control characters |
| Payload                   | at most 4 KiB of bytes                        |
| Time                      | at most 400 days ahead; a past time is due now |
| Pending timers of a plugin| at most 1,000                                 |

4 KiB holds an identifier, a cursor, or a short JSON document. A plugin that
needs more keeps it in `storage.kv@1` and puts the key in the payload.

Scheduling a key again replaces its pending timer. Cancelling removes it.
Both also apply to a timer whose callback is running now: the callback
finishes, and its completion changes nothing.

### Hook

A plugin that declares `timers.schedule@1` implements
`HandleTimer(ctx, plugin.Timer) error`. The host calls it in the `system`
context with no operator, for at most 30 seconds. A `plugin.Timer` has the
generation ID, the key, the payload, the due time, and the attempt number.

Delivery is at least once. A callback can run again for the same timer after
a crash, a timeout, or an error. A handler must be idempotent: for example,
it compares a cursor in `storage.kv@1` with `compareAndSet` before it acts.

### Generations

A timer row is one generation with its own ID. Scheduling a key deletes the
old row and inserts a new row with a new ID. Completion and retry name the row
ID and the claim token, never the plugin and the key. A callback of generation
A that finishes after the plugin scheduled generation B of the same key
therefore cannot delete or move B.

### Claims and leases

`apps/server/internal/durable` is the claim and lease mechanism. Phase 3 can
use it for other durable work.

1. A worker claims due rows with `FOR UPDATE SKIP LOCKED`. A claim sets a
   random claim token, a lease of 2 minutes, and adds one to `attempts`. Two
   workers never claim the same row while a lease holds.
2. The worker runs the callback outside the claiming transaction.
3. Success deletes the row with the same ID and token.
4. A failure sets the next due time with the same ID and token. The delay is
   5 seconds after the first failure and doubles to at most 1 hour. After 10
   attempts the host deletes the timer and logs it.
5. A worker that stops leaves the claim. When the lease ends, another worker
   claims the row again and the attempt number goes up. A late completion of
   the old claim changes nothing.

Failure codes on the row are `handler_error`, `handler_timeout`, and
`handler_panic`. A callback never sees another plugin's timers.

The Server maintenance loop runs due timers every 5 seconds. Tests call
`RunDueTimers` with a stepped clock.

### Removal and reinstall

- A removed plugin gets no callbacks. Its timers stay and are inert.
- After a reinstall, the timers fire at their times. A timer that became due
  while the plugin was removed fires once, soon after the reinstall.
- Each timer records the manifest `definitionVersion` when it is scheduled. A
  timer fires only under the same definition version. The host deletes a
  timer of another definition version and logs it, so an old definition can
  never fire in a new one. A release that changes `definitionVersion` must
  schedule again the timers that it needs.

## Threat model

| Threat                                                   | Control                                                                 |
| -------------------------------------------------------- | ----------------------------------------------------------------------- |
| A plugin reads or writes another plugin's values         | The host binds the namespace; no input names one.                      |
| Concurrent writers pass the quota together               | One advisory lock for each namespace before the quota sum.             |
| A compare-and-set races another write                    | The comparison and the write are one transaction under the same lock.  |
| A late callback deletes a newer timer                    | Completion names the generation ID and the claim token.                |
| Two Server processes run one timer at the same time      | `FOR UPDATE SKIP LOCKED` and a lease.                                   |
| A failing callback spins                                 | Bounded exponential backoff and at most 10 attempts.                   |
| A removed plugin runs code                               | Timers of a plugin that is not installed are not claimed.              |
| An old definition fires in a new one                     | Each timer carries its `definitionVersion`.                            |
| A callback acts as an operator                           | The `system` context, with no actor.                                    |
