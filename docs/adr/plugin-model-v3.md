# ADR: Plugin Model V3

Status: proposed. This record does not change a contract yet. Each phase
below changes the related contracts in the same change as its
implementation. The current contracts are [Plugin API v1](../plugin-api.md),
[Plugin API v2](../plugin-api-v2.md), [Extension packages](../packages.md),
[External package service capabilities](../package-services.md), and
[External Player plugins](../external-player-plugins.md).

Companion records:

- [ADR: Takeover priority classes](takeover-priority.md). Phase 0 needs it.
- [ADR: Plugin capabilities and plugin sessions](plugin-access-and-sessions.md).
  Phase 4 needs it.

## Terminology

| Term                              | Meaning                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------- |
| Plugin API v1, Plugin API v2      | The current bundled plugin contracts.                                           |
| Plugin Manifest API 3             | The contract that this record proposes: `tilecast.plugin.json`, `apiVersion` 3. |
| Extension Package Manifest 1 to 4 | The distribution container: `tilecast.package.json`, `apiVersion` 1 to 4.       |
| Player frame ABI 2                | The current "External Plugin API 2". This record renames it.                    |
| Bundled plugin                    | A first-party plugin in `plugins/`, compiled into the release.                  |
| Installed plugin                  | A plugin in an extension package, run in the WebAssembly host.                  |
| Provider slot                     | A typed extension point of a core feature that a plugin fills.                  |

A Plugin Manifest API 3 plugin can travel in an Extension Package Manifest 4
package. The two numbers are independent.

## Context

### Method

The authors wrote 40 plugins that Tilecast users ask for, in four lists,
before they examined the code for each list. Then the authors tested each
plugin against `main`:

- the Go SDK in `packages/plugin-sdk/go/plugin`;
- the Studio kit in `apps/dashboard/src/plugin-host/kit.ts`;
- the Player Plugin Host in `packages/player-runtime/src/plugins`;
- the bundled plugins Countdown Bar, Emergency Alerts, and Forms;
- the package runtime in `apps/server/internal/extensions`;
- the Takeover service, the role model, the integration tokens, `notify`,
  `contenthealth`, `approvals`, and the Player manifest schema.

An external review of an earlier draft of this record also contributed.

### Result

Two of the first ten plugins are possible on `main` without core work, and
one of the two needs no plugin. The other lists have the same result.

| Plugin examples                                        | Blocking cause on `main`                                                                           |
| ------------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Room sign, Planning Center, POS menus, library catalog | No OAuth, no secret storage, no configuration model, and the package fetch is GET without headers. |
| Fundraising, POS menus, Planning Center                | No inbound webhook. SaaS providers sign the request body and cannot send a Tilecast token.         |
| Offline notifier, self-healing fleet                   | No subscription to core events. No plugin delivery channel in `notify`.                            |
| Queue, scorekeeping, council, visitor check-in         | No role-limited operator page, no kiosk, and no anonymous participant.                             |
| Queue, scorekeeping                                    | No compare-and-set for concurrent operators.                                                       |
| Visitor check-in, holds pickup, donors, patient boards | No personal-data declaration, retention, or erase. Player caches are not encrypted.                |
| Scoreboard gateway, touch booking                      | No path from a Player to the Server for plugin data.                                               |
| Scoreboard, show control                               | No native service on any Player. Edge allows only HDMI-CEC and I2C devices.                        |
| Transit, large catalogs                                | Package limits: 1 MiB fetch, 16 KiB call window, 30-second job, 1 MiB storage.                     |
| Sponsor slides, lockdown, paging                       | The Takeover service has no priority. See the companion record.                                    |

### Findings

**Too many extension systems.** An author must understand Plugin API v1 and
v2, External Plugin API 2, Extension Package Manifest 1 to 4, three service
vocabularies, Widgets V2, two kinds of Data Source, the Automation contract,
and the Store file. A bundled plugin and a package share no Server API, no
Studio model, and no Player API.

**Every plugin repeats the same host work.** Countdown Bar has 5,160 lines
without Store artwork. About 120 lines of its `write` function are the same
in each plugin: installation lock, target validation, authorization of the
stored and the new target, targets table, font usage, audit, and manifest
invalidation. It also has a 1,069-line Studio editor and a hand-written
OpenAPI fragment.

**The package service `plugin-runtime.state@1` already has an instance
model.** It stores configuration, enabled state, and targets with a
revision check, and it publishes expiring Player state. Bundled plugins have
no equivalent.

**The Player model has concepts without users.** Plugin events have no host
transport. No native contribution and no native service exist. No
presentation provider exists.

**The bundled `network` capability is advice only.** The parser validates
the host names. The Server does not enforce them. Emergency Alerts uses its
own `http.Client`.

**Recoverable secrets are plaintext.** TOTP secrets and the notification
webhook signing secret are stored in clear text.

**Plugins reimplement core features.** A lockdown plugin, an ad plugin, a
translation plugin, and an automation plugin each need their own
arbitration, scheduling, or localization. Their correct behavior depends on
semantics that only core can own.

## Decision

### 1. Plugin or core

A capability is a core feature, not a plugin, when it does one of these:

- changes which presentation a screen selects, or the priority between
  sources;
- adds a Player protocol or a Player presentation mechanism;
- adds a device class to a Player sandbox;
- adds Activity vocabulary;
- crosses installations;
- changes the content model, for example language variants.

A core feature can expose provider slots. A plugin then fills a slot and
does not reimplement the feature.

On this test, these are core features with separate records: the automation
and preemption engine, life-safety mode, interactive and touch Players,
multilingual content, device speech synthesis, advertising slots, federation,
live video ingest, and audience measurement. Interactive and touch Players
are deferred.

Audience measurement estimates who is in front of a screen. A count of
deliberate actions, such as scans of a public link (section 8a), is not
audience measurement. It is plugin data. It never becomes Activity
vocabulary.

### 2. One declarative model, two security boundaries

A plugin is one manifest with Plugin Manifest API 3. Both trust classes use
the same declarations and the same service semantics. They do not have the
same security boundary.

| Trust class | Code                                                                        | Security boundary                                                             |
| ----------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `bundled`   | Go in the Server process, React in Studio, TypeScript in the Shared Runtime | None. The code is trusted first-party code with the privileges of the Server. |
| `installed` | WebAssembly in `wazero`, a Studio sandbox frame, a Player sandbox frame     | The host. The code is untrusted. The host enforces every grant.               |

For a bundled plugin, the rules are architectural rules. They prevent
mistakes. They do not contain a compromised plugin:

- A bundled plugin has the raw database interface.
- A bundled plugin can open network connections without `http.fetch@1`.
  `pluginctl check` refuses direct use of `net` and `net/http` clients in a
  Plugin Manifest API 3 plugin. This check finds mistakes. It is not a
  security control.

For an installed plugin, each declaration, grant, limit, and origin is a
security control that the host enforces.

Native Player contributions stay bundled only. "External Plugin API 2" is
renamed "Player frame ABI 2".

### 3. One Server service registry

The package service registry in `internal/extensions/services` becomes the
one Server service vocabulary.

- An installed plugin calls services through `tilecast.call_v1`. Every new
  capability in this record is a service, so the guest ABI does not change.
- A bundled plugin calls the same services through a generated, typed Go
  client in the SDK. The call runs in process with the same contexts and the
  same `internal/authz` decisions as a package call.
- Calls have one of three contexts: `studio` (an operator, kiosk, or
  participant is the actor), `background` (a job or timer), and `system` (an
  event, a webhook, or a Player report). The registry already names
  `system` for this use.
- The `Host` struct fields stay for Plugin API v1 and v2 plugins.
- A bundled plugin keeps direct SQL on its own tables.

### 4. Configuration schema package

The field vocabulary of the Widget configuration schema moves to
`packages/config-schema`: field types, `control` values, `ui` hints, the Go
validator, and the TypeScript types.

- Widgets and plugins both consume it. The Studio inspector renders any
  schema from it.
- The controls `secret` and `connection` and the `personal` marker are
  available to plugin schemas only. A Widget schema refuses them.
- `packages/settings-schema` is the Player configuration schema. It does not
  change.

### 5. Settings and instances

#### `settings`

- Fields use `packages/config-schema`.
- A setting has the scope `organization`, `instance`, or `screen`. A
  `screen` setting holds a value for each screen, such as the switch port of
  that screen.
- An audit event names the changed keys. It never records a `secret` value.

#### `instances`

A plugin declares one or more instance kinds. A kind has a noun, a settings
schema, a targeting mode (`screens` or `none`), a schedule mode (`none`,
`window`, or `weekly`), and an optional priority. Phase 1 sets an upper bound
for the number of kinds from the generated Studio navigation and records the
reason.

The schedule mode controls when the host projects an instance. A domain
calendar, such as A and B days or a bell schedule with exceptions, is plugin
data. The plugin computes the current day type or period, puts it in state,
and sets timers for the next change. It does not need a host schedule mode.

The host owns:

- storage in `plugin_instances` and `plugin_instance_targets`;
- enable and disable;
- a revision on each instance. An update must name `expectedRevision`. A
  stale revision fails with `conflict`;
- authorization of the stored target and of the new target;
- audit events and manifest invalidation;
- font usage for `font` fields and media retention for `media_asset` fields;
- removal blockers and status counts;
- the Studio list and editor pages, the OpenAPI operations, and the
  automation mapping.

The plugin implements `validate(instance)` and `project(instance, screen)`.

`plugin-runtime.state@1` maps onto instances in phase 6. A plugin that needs
its own domain tables, such as Forms, keeps them.

### 6. Secrets

Phase 1 implements this design before any secret is stored.

**Envelope encryption.**

- A key encryption key (KEK) is a 256-bit key in a file. The Server reads it
  from `TILECAST_SECRETS_KEY_FILE`. At first start, the Server creates the
  file with a cryptographic random source and file mode `0600`. The default
  path is in the data directory, outside `TILECAST_PACKAGES_ROOT` and the
  media directories. An operator can supply the file as a container secret.
- Data encryption keys (DEKs) are stored in PostgreSQL. Each DEK is
  encrypted with the KEK and records the KEK ID.
- Each secret is encrypted with AES-256-GCM, a DEK, and a random 96-bit
  nonce. It records the DEK ID.
- The additional authenticated data is `tilecast-secret-v1`, the plugin
  identity, the owner (`organization`, an instance ID, or a screen ID), and
  the setting key. A ciphertext copied to another place fails to decrypt.

**Rotation.**

- `tilecast-server secrets rotate-kek` adds a KEK and encrypts each DEK again.
  The secrets do not change. Old KEKs stay for decryption until no DEK uses
  them.
- `tilecast-server secrets rotate-dek` creates a DEK for new writes. A
  background task encrypts old secrets again with it.

**Backup and restore.**

- An archive from `tilecast-server backup create` contains the encrypted
  DEKs and secrets. It never contains a KEK. This is the same rule as for
  `TILECAST_PRESENTATION_NETWORK_KEY`.
- The backup manifest records the KEK IDs that the archive needs.
- `tilecast-server secrets export-kek` writes the KEKs to a file that the
  operator stores apart from backups.
- Studio warns Owners until an Owner confirms the export. The warning returns
  after each KEK rotation.
- Before a restore changes anything, the restore check compares the KEK IDs
  in the archive with the available KEKs. It names each plugin and setting
  that becomes unreadable. The operator must confirm.
- An unreadable secret shows as "needs a new value" in Studio. The plugin
  receives `secret_unavailable`.

**Access.**

- Studio writes a secret and receives only a "set" or "not set" flag.
- Plugin code reads a secret through `secrets.read@1` in a `background`,
  `system`, or route context.
- `http.fetch@1` can insert a secret into a header by reference. The guest
  then never holds the value. Use this method when the plugin does not need
  the value for its own computation.
- A secret never enters a Player manifest, Player state, a log, an audit
  event, or a URL.

This record does not move the TOTP secrets or the notification signing
secret. A later change can use the same mechanism.

### 7. Outbound connections

#### Origins and addresses

- A connection declares a fixed list of origins, or `operator`. With
  `operator`, an Owner or Administrator enters one origin in Studio.
- The security boundary is an origin: scheme, host, and port.
- The private network rule is `refused` or `allowed`. With `allowed`, Studio
  shows a separate consent control. The Server refuses private, loopback,
  and link-local addresses until an Owner or Administrator gives consent.
- The Server resolves the host, checks every resolved address, and connects
  to a checked address.
- The Server follows a redirect only to an approved origin of the same
  connection, and it checks the new address again.

#### Plain HTTP on the local network

Many local devices and local systems have no TLS. Examples are solar
inverters, meter gateways, and library catalog servers. A connection can
declare the scheme `http` with these rules:

- The origin must be `operator`. A plugin cannot declare a fixed `http`
  origin.
- The connection must use the private network rule `allowed`. The Owner or
  Administrator gives the private network consent and a second consent for
  plain HTTP. Studio shows that the traffic is not encrypted.
- Every resolved address must be a private address: IPv4 `10.0.0.0/8`,
  `172.16.0.0/12`, `192.168.0.0/16`, or IPv6 `fc00::/7`. The Server refuses a
  public address, a loopback address, and a link-local address. The link-local
  rule also refuses cloud metadata addresses such as `169.254.169.254`.
- A secret reference in an `http` request needs a third declaration,
  `allowPlaintextSecret`, and its own consent in Studio. Without it, the host
  refuses the request with `plaintext_secret_refused`.
- The Server follows a redirect from `http` to an approved `https` origin. It
  never follows a redirect from `https` to `http`.
- OAuth connections, webhooks, and remote feed images never use `http`.

#### `http.fetch@1`

| Property         | Rule                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------- |
| Scheme           | `https`. `http` only under the local network rules above.                                         |
| Methods          | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`.                                                  |
| Request headers  | At most 32. The host refuses `Host`, `Cookie`, `Connection`, and other hop-by-hop headers.        |
| Secret reference | A header value can name a secret setting with a format, for example `Bearer {secret}`.            |
| Request body     | At most 1 MiB.                                                                                    |
| Response body    | 1 MiB by default. A connection can declare up to 16 MiB. The install review shows a larger limit. |
| Time             | 10 seconds by default. A connection can declare up to 60 seconds.                                 |

A large download, such as a weekly transit file, uses `blob.fetch@1`. It
writes the response to plugin blob storage, up to 256 MiB, and returns a blob
reference. Phase 6 adds it.

#### Other protocols

- Phase 6 adds `tcp` and `tls` origins for request and response protocols
  such as SIP2 and PJLink, with the same address rules.
- UDP and multicast, such as SNMP traps, sACN, and paging, are not Server
  protocols. They belong to native Player services on Edge. BACnet/IP is an
  example.
- A `tcp` origin follows the plain HTTP rules above: `operator` origin,
  private addresses only, and the same consents. A `tls` origin follows the
  address rules of `https`.
- Long-lived streams use stream connections. See below.

#### Stream connections

Some systems send live values on a connection that stays open. Examples are
an MQTT broker with door counters, and the WebSocket API of presentation
software in a worship hall. A plugin cannot hold such a connection, because
a hook runs for at most 30 seconds. The host holds it.

- A stream connection declares the scheme `wss`, `mqtts`, `ws`, or `mqtt`.
- `wss` and `mqtts` follow the address rules of `https`. `ws` and `mqtt`
  follow the plain HTTP rules above: `operator` origin, private addresses
  only, and the same consents.
- A WebSocket stream can send headers with secret references, as
  `http.fetch@1` does. An MQTT stream can take its user name and password
  from `secret` settings. MQTT 3.1.1 and MQTT 5 are in scope.
- An MQTT stream declares its topic filters. A filter is fixed in the
  manifest, or it is an operator setting below a fixed prefix. The host
  subscribes with QoS 0 or 1 and never publishes.
- A WebSocket stream can send a text message with `streams.send@1`. A message
  is at most 16 KiB, and the host allows 4 messages each second for each
  stream.
- The host keeps one connection for each stream and owner (`organization` or
  an instance). It reconnects with exponential backoff from 1 second to
  5 minutes.

**Delivery.** Stream messages are live values. They do not use the durable
delivery queue of section 9, because a busy broker would fill the database.

- An inbound message is at most 16 KiB. The host drops a larger message and
  counts it.
- Each message has a key: the MQTT topic, or a JSON Pointer into a WebSocket
  message that the stream declares.
- The host keeps only the latest message for each key in memory. It delivers
  keys to the stream hook in the order of their first arrival, with one call
  in progress for each stream. A bundled plugin implements
  `HandleStreamMessage(ctx, plugin.StreamMessage) error`. An installed
  plugin exports `handle_stream_message`. A message that arrives during a call
  replaces the waiting message of its key. A slow plugin therefore receives
  fewer messages, not older messages.
- A stream holds at most 256 keys. A message with a new key after that limit
  is dropped and counted.
- After a connection opens again, the plugin receives `stream.connected`. It
  must read the current values again, for example from MQTT retained
  messages or with `http.fetch@1`. Messages during an interruption are lost.
- The plugin status shows the connection state, the last message time, and
  the dropped message counts.
- A plugin that must keep a value writes it to state, storage, or a feed.

Stream connections run on the Server. UDP, multicast, and device buses stay
native Player services.

#### OAuth 2.0

- OAuth connections require `TILECAST_PUBLIC_URL` with the `https` scheme.
  RFC 9700, section 2.6, does not permit an authorization response on an
  unencrypted connection, except a loopback redirect for a native client.
  Without HTTPS, Studio hides the connect control and shows the reason.
- The host runs the authorization code flow with PKCE. RFC 9700 recommends
  PKCE for confidential clients.
- The redirect address is
  `<public URL>/api/v1/plugins/{pluginId}/connections/{connectionId}/callback`.
  Providers match it exactly, so Studio shows the exact string to register.
- The operator registers the OAuth client with the provider and enters the
  client ID, and the client secret when the provider requires one. Tilecast
  ships no shared client and uses no relay.
- The connection declares the endpoints, the scopes, the token endpoint
  authentication method (`client_secret_basic`, `client_secret_post`, or
  `none`), and additional authorization parameters from a bounded list.
- The host stores tokens as secrets. One process refreshes one connection at
  a time under a row lock. A new refresh token replaces the old one in the
  same transaction.
- A refresh that fails with `invalid_grant` sets `reconnect_required`.
- Disconnect calls the revocation endpoint when one exists, then deletes the
  tokens.

### 8. Inbound webhooks

A webhook declares one inbound endpoint at
`/api/v1/hooks/{pluginId}/{webhookId}`.

#### Authentication

| Mode         | Use                             | Rule                                                                                                                                                                                                                                                      |
| ------------ | ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `token`      | Fire panels, automation tools   | A webhook token in the `Authorization` header. A new table holds the public ID and the SHA-256 hash of the secret, in the shape of integration tokens. The prefix is `tch_`. Creating one needs `plugins.manage`. Integration tokens stay Owner-reserved. |
| `signature`  | SaaS providers                  | The host verifies an HMAC signature over the raw body with a `secret` setting. See below.                                                                                                                                                                 |
| `fetch-back` | SaaS providers without HMAC     | The host keeps only an event ID from the request. The plugin reads the event from the provider through an authenticated connection. See below.                                                                                                            |
| `public`     | Photo submissions, public forms | An Owner must enable it. Rate limits for each address and in total. Input must enter moderation (section 13a) before it can reach a screen.                                                                                                               |

The `signature` mode has presets and one custom form:

- `standard-webhooks`: headers `webhook-id`, `webhook-timestamp`, and
  `webhook-signature`; HMAC-SHA256 over `id.timestamp.body`; `v1,` and
  Base64; several signatures for key rotation.
- `hmac-sha256`: the connection declares these values:
  - the signature header;
  - the header format: `plain`, or `pairs` for comma-separated `key=value`
    pairs in one header. With `pairs`, the connection names the timestamp key
    and the signature key. The header can hold several signatures for key
    rotation. Stripe uses this format;
  - an optional timestamp header, for the format `plain`;
  - an optional prefix, such as `sha256=`;
  - the encoding, `hex` or `base64`;
  - the signed string: `body`, `timestamp.body`, or `url.body`. With
    `url.body`, the host signs the exact public endpoint address that Studio
    shows, then the body. Square uses this form.
- `verify` hook: for a provider that fits none of these forms, the plugin
  verifies the raw body. The host gives the hook 1 second and no network
  access.

For every signature mode:

- When the mode declares a timestamp, a timestamp older or newer than 5
  minutes fails.
- The comparison is constant time.
- The host drops a repeated delivery ID. The connection names the delivery
  ID: a header, or a JSON Pointer into the body. A mode without a delivery ID
  is refused at install.
- The host keeps delivery IDs for 24 hours when the mode declares a
  timestamp. Without a timestamp, it keeps them for 7 days. A captured request
  without a timestamp can be replayed after that window. The plugin treats a
  delivery as a reason to read the current state from the provider, not as
  the state itself. Mandatory polling, below, makes this complete.

The `fetch-back` mode serves providers that sign with certificates or that
verify with an API call, such as PayPal. The `verify` hook cannot call a
provider in 1 second without network access.

- The connection declares a JSON Pointer to the event ID and a pattern. The
  pattern is at most `^[A-Za-z0-9_.:-]{1,128}$`.
- The host extracts the event ID, drops the rest of the request, and answers
  `202`. A request without a valid event ID receives `400`.
- The host delivers only the event ID to `handle_webhook`. The plugin reads
  the event from the provider with `http.fetch@1` and an authenticated
  connection of the same plugin.
- The host applies a rate limit for each address and for each webhook. It
  combines repeated event IDs within 24 hours into one delivery.
- An attacker can only make the plugin read an event that the provider
  authenticates and owns.

#### Handshakes

Some providers verify an endpoint before they send events:

- `echo-query`: return a query parameter as `text/plain` with status 200. For
  example, Microsoft Graph sends `validationToken` and needs the answer
  within 10 seconds.
- `echo-json`: after a valid signature, return a field of the JSON body. For
  example, a chat platform sends a challenge value.

The host answers handshakes itself. Plugin code does not run.

#### Delivery

1. The host authenticates the request and checks the body limit. The upper
   limit is 64 KiB.
2. The host writes the request to the plugin inbox.
3. The host answers `202` at once. Microsoft Graph, for example, treats an
   answer after 3 seconds as a failure.
4. The host delivers the request to the plugin with the event delivery rules
   in section 9.

#### Reachability

A SaaS provider can reach only a public HTTPS address. Many installations
have none.

- Studio shows whether webhooks are available and why.
- A plugin that uses SaaS webhooks must also poll. Polling is the complete
  path. Webhooks only reduce delay.
- Subscriptions that expire, such as Microsoft Graph subscriptions with a
  lifetime of at most 10,080 minutes for calendar events, need a renewal
  job. The plugin owns it with a durable timer.

### 8a. Public links

A QR code on a screen often needs a short address that the Server counts and
then sends on, for example to a sign-up page. A webhook cannot do this,
because a webhook is a `POST` request that receives `202`. A participant
route needs a join code. The host owns public links.

**Declaration.** A plugin declares each link kind with:

- the target origins: a fixed list of `https` origins, or `operator`;
- the counting granularity: total, or by screen;
- a maximum lifetime, at most 400 days.

**Creation.**

- `links.create@1` takes a link kind, a target address, an optional instance,
  an optional screen, and an expiry. It returns a code and the complete
  public address.
- The target must be an `https` address on an approved origin of the link
  kind. The host stores the target with the code. A request cannot change it.
  This prevents an open redirect.
- The code is 10 random Base62 characters. A code is not a secret, because
  it is on a screen.
- The public address is `<public URL>/api/v1/links/{code}`. It holds no
  plugin identity, so the QR code stays small.
- A plugin shows one code for each screen when it projects the instance for
  that screen. `links.create@1` with the same kind, target, instance, and
  screen returns the same code.

**Request.**

- The host answers `GET` with `303` and the stored target. No plugin code
  runs, so a scan cannot cause plugin work.
- The host sets no cookie and adds `Referrer-Policy: no-referrer` and
  `Cache-Control: no-store`.
- An expired or deleted code receives a `404` page that names the
  installation and nothing else.
- The host applies a rate limit for each client address and for each code.

**Counts.**

- The host adds one to a counter for each code and hour.
- The host counts one request for each client address, code, and 10 minutes.
  It keeps the addresses for this rule in memory only.
- The host stores no client address, user agent, referrer, or other request
  data.
- `links.stats@1` returns the counters for a period. Studio labels them
  "scans". A scan is not a view, and Studio does not show a scan rate as a
  rate of viewers.
- The host deletes counters after 400 days. Removal keeps them, as for all
  plugin data. An explicit purge deletes them.
- A removed plugin's codes receive the `404` page.

**Reachability.** Phones off the local network can open a link only when the
installation has a public address. Studio shows the address that the QR code
will contain.

### 9. Events

A plugin subscribes to core events from a closed vocabulary:

- `screen.status.changed@1`
- `takeover.started@1`, `takeover.ended@1`, `takeover.suspended@1`
- `incident.opened@1`, `incident.recovered@1`
- `schedule.changed@1`
- `feed.stale@1` for the plugin's own feeds

**Plugin events.** A plugin can also publish events that other plugins
receive. For example, a bell schedule plugin publishes `period.started`,
and a hall display plugin changes its overlay. These are Server events. They
are not the Player plugin events of Plugin API v2.

- A plugin declares each event that it publishes with a name, a version, and
  a payload schema from `packages/config-schema`. The full name is
  `plugin.<identity>.<name>@<version>`.
- A payload is at most 4 KiB. It carries no `secret` field. A `personal`
  field is refused.
- `events.publish@1` writes the event in the publisher's transaction. The
  delivery rules below apply to each subscriber.
- A plugin subscribes by the full name. The install review shows each
  subscription and the plugin that publishes it.
- A subscription to an event of a plugin that is not installed is accepted
  and receives nothing. Studio shows it as inactive.
- The meaning of an event name never changes. A changed payload is a new
  version.
- Core code never names a plugin event. When the automation engine exists, a
  declared plugin event can also be a trigger in the `automation.triggers`
  slot.
- A plugin event cannot change which presentation a screen selects. That
  stays core (section 1).

**Hooks.** A bundled plugin implements `HandleEvent(ctx, plugin.Event)
error`. An installed plugin exports `handle_event`. The call runs in the
`system` context with the job time limit of 30 seconds.

**Delivery.** The same delivery engine serves events, webhook requests,
Player reports, and timers. It follows the outbox and backoff pattern of
`notify`.

- The producer writes the item in its own transaction.
- Delivery is at least once. Each item has a stable ID. A plugin treats a
  repeated ID as delivered.
- Delivery is in order for each plugin and subject. One item for each plugin
  and subject is in progress at a time. Different subjects run in parallel up
  to a bound for each plugin.
- A failure retries with exponential backoff from 5 seconds to 15 minutes.
- After 8 failed attempts, the host parks the item and runs the next item for
  the subject. The plugin status shows each parked item. An Owner can retry
  or discard it.
- The host deletes a delivered item, a parked item after 14 days, and an
  undelivered item after 7 days. The plugin status counts expired items.
- The host queues nothing for a plugin that is not installed. Removal deletes
  the queue of the plugin.
- A new event version is a new name. When a plugin stops subscribing to a
  name, the host deletes its queued items of that name at startup. This
  applies to core events and to plugin events.
- A payload is bounded and carries no secret.

### 10. Durable timers

`timers.schedule@1` schedules one callback for a plugin at a time, with a
key and a bounded payload. Scheduling the same key again replaces the timer.
`timers.cancel@1` removes it. The delivery engine delivers the callback.
Examples: release a room after a no-show, end a matching-gift window, renew a
provider subscription, and take the next step of a recovery sequence.

### 11. Storage

- `storage.kv@1` replaces the key read and key write imports for new
  plugins and adds `compareAndSet(key, expected, value)`. The current limits stay:
  128-byte keys, 64 KiB values, 1 MiB for each plugin.
- `storage.blob@1` stores large objects for a plugin with a quota that the
  install review shows. Phase 6 adds it.

### 12. Feeds

A feed is a dataset that a plugin publishes with `feeds.publish@1`. Feeds
are the preferred mechanism for records that Widgets show.
`DataSourceProvider` and `ManagedPresentations` stay until feeds represent
each current use.

| Subject       | Rule                                                                                                               |
| ------------- | ------------------------------------------------------------------------------------------------------------------ |
| Identity      | The feed definition `<feedId>` appears as Data Source provider `<plugin identity>.<feedId>`.                       |
| Datasets      | A feed has one dataset, or one dataset for each instance. A Widget binds to the dataset of one instance.           |
| Schema        | At most 16 fields. This is the limit of a Player Data Document dataset.                                            |
| Records       | At most 2,000 records, each with a stable ID of at most 80 characters. These are the Player dataset limits.        |
| Size          | At most 512 KiB of canonical JSON for one publication.                                                             |
| Schema change | A changed schema is a new feed version, `<feedId>@<n>`.                                                            |
| Publication   | A publication replaces the complete record set of one dataset. It names the revision that it replaces.             |
| Expiry        | A publication can set `validUntil`.                                                                                |
| Staleness     | A feed declares its expected refresh interval. A late feed becomes a `contenthealth` condition and `feed.stale@1`. |

**Local overrides.** An operator can edit a record field in Studio when the
feed allows it. The host stores the edit by dataset, record ID, and field.
The feed declares one rule for each field:

- `upstream`: the publication always wins. No edit is possible.
- `local`: the edit always wins.
- `local_until_changed`: the edit wins until a publication changes that
  field. Then the edit is removed and Studio records why.

The host applies overrides when it projects the dataset. A record that a
publication removes also removes its overrides.

**Remote images.**

- A record field can name a remote image through a connection.
- The host imports images after the publication commits. A failed import
  leaves the field empty and adds a status attention item.
- The import uses the media pipeline with generated paths and bounded decode
  dimensions.
- The host stores one copy of each image by SHA-256 as a private plugin
  asset, within a quota for each plugin.
- The host discards an image that no current record names after 24 hours.
- Images are in backups with other media variants. An explicit purge deletes
  them. Removal keeps plugin data, as for every plugin.

**Plugin assets.** A record field of type `plugin_asset` names a private
plugin asset by its ID. Plugin state can name one too.

- A remote image import (above) creates a plugin asset.
- An approved moderation item can create a plugin asset. See section 13a.
- A plugin asset is not in the Media library. The host grants it to a Player
  only while a current feed record or the plugin state for that screen names
  it.
- The 24-hour discard rule above applies to every plugin asset.

**Withdrawal.** Content from outside can be wrong, and an operator must be
able to remove it from every screen.

- A publication without a record, or plugin state without a value, removes
  it at the next plugin-only revision. An online Player stops showing it
  within normal delivery time.
- When no current record or state names a plugin asset, the host adds its
  SHA-256 digest to the purge list of each screen that received it. The
  manifest carries the purge list for 7 days. The list holds at most 256
  digests, newest first.
- A Player deletes each cached object on the purge list unless its current
  manifest names the same digest for another reason, for example as a Media
  library item. It never uses a purged object as an offline fallback.
- A feed or plugin state that can hold moderated input declares `untrusted`.
  The host then limits `validUntil` to 72 hours after the publication. The
  plugin publishes again to extend it. A Player that stays offline stops
  showing the data when it expires and shows the plugin fallback. Without
  this limit, an offline Player could show withdrawn content for weeks.

### 13. Personal data

- A setting, instance field, feed field, or participant field can be marked
  `personal`.
- A plugin declares a retention period for each personal field or record
  kind. The host purges what it stores when the period ends.
- A bundled plugin with its own tables implements `PurgeExpired(ctx,
before)`. The host calls it daily and records the result.
- An Owner can export or erase the personal data of one subject when the
  plugin declares a subject key.
- Masking happens before data enters Player state. For example, a holds
  display shows initials only.
- Player state that holds personal data is marked `sensitive`. A Player
  keeps sensitive state in memory only and does not write it to its cache.
  After a restart without the Server, the plugin shows its fallback.
  Screenshots, previews, thumbnails, and Watch Live frames hide the plugin's
  surfaces while sensitive state is shown.
- Backups keep personal data until the backup expires. The plugin
  documentation must say this.

### 13a. Moderation

Content Review and moderation review different things:

- Content Review (`internal/approvals`) reviews an immutable submission of a
  Playlist, a Layout, or a Campaign before publication. A change that a
  plugin makes with `content.write@1` goes through Content Review when the
  review policy requires it. The plugin does not build its own approval
  workflow.
- Moderation reviews untrusted input before a plugin uses it. Examples are a
  `public` webhook request, participant input, a post from a social network,
  and a message from a chat platform.

The host owns moderation. A plugin does not keep its own review state.

**Queues.** A plugin declares each moderation queue in its manifest with:

- a title;
- an item schema from `packages/config-schema`, with at most 16 fields;
- a reviewer capability, which must be a plugin capability of the same
  plugin. See the companion access record;
- a retention period for pending items, at most 30 days;
- the `personal` marker on each field that holds personal data;
- a limit of pending items, 1,000 by default.

**Items.**

- `moderation.submit@1` adds one item. An item has a stable ID from the
  plugin, the field values, an optional instance, an optional source label,
  and at most 4 media references.
- An item is at most 16 KiB without its media.
- The host imports item media through the media pipeline into private plugin
  storage. The media is not in the Media library. No Player receives it before
  approval.
- A repeated item ID changes nothing.
- A full queue refuses a new item with `queue_full`.
- The item states are `pending`, `approved`, `rejected`, `expired`,
  `withdrawn`, and `taken_down`. A `pending` item can change to `approved`,
  `rejected`, `expired`, or `withdrawn`. An `approved` item can change to
  `taken_down`. No other change is possible. The plugin can withdraw a
  pending item.

**Decisions.**

- Studio generates the queue page. A person with the reviewer capability
  approves or rejects an item, with an optional note. One request can decide
  at most 50 items.
- The host calls the moderation hook in the reviewer's `studio` request,
  with the reviewer as the actor and the time limit of `handle_ui_request`.
  A bundled plugin implements `HandleModeration(ctx, plugin.Decision)
error`. An installed plugin exports `handle_moderation`.
- The hook can call `content.write@1` and `media.ingest@1` as the reviewer.
- The host records the decision only when the hook succeeds. The hook must
  give the same result when it receives the same item ID again.
- The audit event records the reviewer, the queue, the item ID, and the
  decision. It never records a `personal` field value.
- In the hook, `moderation.promote@1` turns a media reference of the approved
  item into a plugin asset (section 12). Only an approved item can be
  promoted. A plugin asset records the item that it came from.

**Takedown.** A person with the reviewer capability can take down an
approved item.

- The item state becomes `taken_down`. Only an `approved` item can change to
  this state.
- The host calls the moderation hook with the decision `taken_down`. The
  plugin removes the item from its state, feeds, and content.
- The host revokes each plugin asset that came from the item. It stops the
  grant to Players even when a record or state still names the asset. It puts
  the digest on the purge list at once and does not wait for the 24-hour
  discard rule.
- The host records the takedown before it calls the hook, so a failed hook
  cannot keep a revoked asset on a screen. When the hook fails, the host
  retries it and shows the item in the plugin status until the hook
  succeeds.

**Retention.**

- A pending item expires at the end of the queue retention period.
- The host deletes the field values and the media of a decided or expired
  item after 7 days. It keeps the decision record without `personal` fields.
- An approved item gives the plugin its data in the hook. The plugin copies
  what it needs into its own state, a feed, or content.

### 14. Notifications and other provider slots

A provider slot is a typed interface of a core feature. Core owns the
semantics. The plugin supplies one function.

| Slot                     | Core feature               | The plugin supplies                          |
| ------------------------ | -------------------------- | -------------------------------------------- |
| `notifications.channels` | `notify`                   | Delivery of a rendered message to a channel. |
| `contenthealth.checks`   | `contenthealth`            | A check of one item that core passes in.     |
| `automation.triggers`    | Automation engine (future) | A trigger source with typed events.          |
| `automation.actions`     | Automation engine (future) | An action with typed input.                  |
| `takeovers`              | Takeovers                  | A request up to the declared maximum class.  |

**Content health checks.** A check declares the item kinds that it reads:
playlist, Layout, Widget instance, or media item. During its sweep,
`contenthealth` passes each changed item of those kinds to the check in the
`system` context. The item is a read-only API model, not a database row. The
check returns zero or more named conditions with a severity and a short
reason. A bundled plugin implements `CheckContent(ctx, plugin.ContentItem)
([]plugin.Condition, error)`. An installed plugin exports `check_content`. Core owns the incident and the Studio report. A check gets no other
read access to content, because a sweep has no operator and no content
access decision. A readability check, for example, compares text size and
contrast in the item that it receives.

`notify` keeps its incident rule: volume comes from incidents. A message to
one named person, such as a visitor's host, is not a notification channel.
It needs a separate decision before a plugin can send it.

Content approval goes through Content Review, and review of untrusted input
goes through moderation. See section 13a.

### 15. Player contribution

The Player model keeps `player.state`, surfaces, `player.clock@1`,
`player.fonts@1`, `player.media@1`, and `player.presentation.observe@1`.
Native services stay in the authoring guide. Plugin events and presentation
providers leave the authoring guide until a plugin uses them.

**Time.** A clock, such as a game clock, is state: the value, the moment it
started, and whether it runs. Players count with their corrected clock.
Clocks need no fast path.

**`player.report@1`.** The Runtime part of a plugin sends a bounded report
to the Server part of the same plugin. A native contribution can do the same.

- Player Core sends reports on the device credential to one endpoint.
- The Server accepts a report only for a plugin whose state the screen
  holds.
- A report is at most 2 KiB. A rate limit applies for each plugin and screen.
- The delivery engine delivers it to `HandlePlayerReport`.

**`player.audio.cue@1`.** The plugin plays a sequence of 1 to 16 declared
audio items once, at a declared volume. A chime is one item. "Now serving 42
at counter 3" is a sequence of recorded phrase items and number items.

- Each item is a plugin asset or the value of a `media_asset` setting.
- A Player accepts a cue only when it holds every item of the sequence in
  its cache. Otherwise it refuses the cue with `audio_item_missing`.
- A Player plays the items one after the other and adds no gap.
- One sequence plays at a time on a screen. The host holds at most 4 waiting
  sequences for each plugin and screen. When the limit is full, the host drops
  the oldest waiting sequence.
- The host refuses a cue while the screen is asleep.
- A plugin surface must show the same information as text while the cue
  plays. Audio is never the only signal.
- Device speech synthesis is not a plugin service. See section 1.

`player.audio-bed@1` follows the existing design.

**First native service.** `player.serial@1` on Edge reads and writes one
serial device that an Owner assigns to the screen. Edge adds a udev rule, a
group, and `DeviceAllow` entries for `ttyUSB` and `ttyACM`, with the same
pattern as HDMI-CEC and I2C. The capability matrix records it. Hardware
qualification is required.

**Printing.** A plugin prints in one of three ways. Use the first one that
works for the device:

1. A kiosk page or a staff page opens the browser print dialog of its own
   device. This method needs no host service.
2. The Server part of the plugin sends raw printer data, such as ZPL or
   ESC/POS, to a network printer through a `tcp` origin, usually port 9100.
   The local network rules of section 7 apply.
3. `player.printer@1` on Edge writes raw printer data to one USB printer
   device (`/dev/usb/lp*`, kernel driver `usblp`) that an Owner assigns to the
   screen. Edge adds a udev rule, a group, and a `DeviceAllow` entry, as for
   `player.serial@1`. Some printers do not accept raw data through `usblp`.
   The capability matrix lists each qualified model. No phase includes this
   service. It is added with the first plugin that needs it.

For the third method, a print job is plugin state with a job ID. A native
contribution prints each
job ID once and sends the result with `player.report@1`. A job with personal
data, such as a visitor badge, is `sensitive` state.

**Digital inputs.** `player.gpio@1` on Edge reads digital input lines, such
as a door counter, a beam sensor, or a push button.

- An Owner assigns lines of one GPIO chip to the screen in Studio. The
  plugin names a line by its setting, never by a chip path.
- Edge uses the Linux GPIO character device (`/dev/gpiochipN`) through the
  version 2 interface. It does not use the deprecated sysfs GPIO interface.
- Edge adds a udev rule, a group, and `DeviceAllow=char-gpiochip rw`, as for
  `player.serial@1`. Only `tilecast-edge.service` joins the group.
- The service reports edges with a debounce time from 1 to 1,000
  milliseconds, and it keeps a count of edges for each line. The plugin
  receives counts and the current level. It does not receive each edge.
- The service sets no output line. An output, such as a relay or a beacon,
  needs a separate decision, because it acts on the physical world.
- No phase includes this service. It is added with the first plugin that
  needs it. The capability matrix lists each qualified board.

**Gateway pattern.** One Player owns a device, such as a scoreboard console.
It sends decoded values with `player.report@1`. The Server part of the plugin
writes state, and other screens receive it.

**Fast path: measure first.** Plugin API v2 already sends plugin-only
revisions without a playback restart. Phase 5 measures that path with 100
screens at one change each second and at 10 changes each second: Server CPU,
database writes, bytes for each screen, and the 95th percentile time to the
screen. A fast path is added only when a measured case misses a 95th
percentile of one second at an acceptable cost.

If a fast path is needed:

- `live.publish@1` on the Server and `player.live@1` in the Runtime.
- A value that must survive a reconnect is written as durable state first.
- Each `plugin_state` entry carries a plugin generation. A value carries the
  generation and a sequence for its key. A Player drops older generations,
  applies the current generation in sequence order, and holds the latest
  value of a newer generation for up to 10 seconds.
- On reconnect, the Server sends the latest value of each key again from
  memory.
- Budgets: 2 KiB for each value, 8 keys and 4 values each second for each
  plugin and screen, 16 KiB each second for each screen, and a configured
  Server total. When a budget is full, the Server drops intermediate values.

### 16. Content and media from plugins

- `media.ingest@1` adds a file to the Media library through the media
  pipeline, as the acting operator.
- `content.write@1` creates and changes playlists, Widgets, and schedules
  through the canonical domain services, with the operator's authorization.
  Content Review applies when the review policy requires it.
- `content.read@1` reads playlists, Layouts, Widget instances, schedules, and
  media items as API models. It applies the operator's content access and
  screen scope, as the Studio API does.
- These three services run in the `studio` context only. A timer, a job, an
  event, a webhook, and a Player report have no operator. They cannot call
  these services.
- A plugin that acts on outside input, such as a chat message that asks for a
  publication, puts the input in moderation. The reviewer's decision runs in
  the `studio` context, so the hook can write content as the reviewer.
- A plugin that must stop showing something at a time uses an instance with a
  `window` schedule or a feed publication with `validUntil`. It does not
  change content from a timer.
- Studio editor action slots let a plugin propose a change to the open
  draft. The operator accepts or rejects the proposal. A proposal never saves
  by itself.

### 17. Studio

- The host generates the settings page, the instance pages, the connections
  page, the webhook page, the moderation queue pages, the public link page
  with its scan counts, the personal-data page, and the status page. The
  status page shows stream connections, parked deliveries, and inactive
  event subscriptions.
- A bundled plugin can add React pages. An installed plugin can add a
  sandbox frame page.
- Staff pages, kiosks, and participant pages follow the companion access
  record.

### 18. Installed plugin entry points

Each entry point is a WebAssembly export that the manifest declares and the
install review shows:

- `validate_instance` and `project_state`
- `handle_event`, `handle_webhook`, `verify_webhook`
- `handle_player_report`, `handle_timer`, `handle_moderation`
- `handle_stream_message` and `check_content`
- `run_job` and `handle_ui_request`, as today

### 19. Tooling

- `npm run plugins:new` takes a recipe: `overlay`, `integration`, `feed`,
  `operator`, or `automation`.
- A local development loop runs a plugin against a demo Server and reloads
  Studio and Runtime code.
- The public plugin guide uses plugins from this record as worked examples.

## Phases

Each phase delivers real plugins. A phase ends when those plugins pass their
checks and the contracts describe the new members.

| Phase | Scope                                                                                                                                              | Proof                                                                      |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 0     | Takeover priority classes. Terminology and the rename. One extension overview.                                                                     | Emergency Alerts survives an operator Takeover                             |
| 1     | `config-schema`, settings, secrets, instances, personal-data declarations, the registry Go client                                                  | Countdown Bar on Plugin Manifest API 3, with line counts                   |
| 2     | `http.fetch@1`, connections, local `http` origins, OAuth, feeds with overrides and images, `storage.kv@1`, timers                                  | Room sign display; POS menu board                                          |
| 3     | Core and plugin events, `token`, `signature`, and `fetch-back` webhooks, the delivery engine, notification channels, `contenthealth` checks        | Planning Center sync; offline notifier; bell schedule events               |
| 4     | Plugin capabilities, staff pages, kiosks, moderation with plugin assets and takedown, the purge list, `public` webhooks, public links              | "Now serving" keypad; scorekeeper page; community flyer wall with QR links |
| 5     | `player.report@1`, `player.audio.cue@1` with sequences, `player.serial@1` on Edge, the fast-path measurement                                       | Scoreboard gateway; spoken queue call                                      |
| 6     | Installed parity: every member for packages, `plugin-runtime.state@1` on instances, Player frame ABI 2 on services, blobs, TCP, stream connections | One plugin shipped as a package; transit arrivals; MQTT occupancy sign     |
| 7     | Participant sessions; content read, content write, and media services; editor action slots                                                         | Live poll; Slack publishing through moderation                             |

Emergency Alerts and Forms move to Plugin Manifest API 3 after phase 3.
Plugin API v1 is deleted after both move.

## Consequences

- A typical plugin declares settings and instances and writes two hooks.
- A first-party plugin and an installed plugin use one vocabulary. The
  security boundary changes when a plugin moves between trust classes.
- Plugin API v1, Plugin API v2, and Plugin Manifest API 3 exist together until
  the bundled plugins move.
- The Server gains tables for settings, instances, secrets, DEKs,
  connections, webhook tokens, the delivery queue, timers, feeds, overrides,
  moderation items, and capability definitions.
- The installation gains a KEK. An operator who loses the KEK and its export
  must enter each secret again.
- Operator-approved private origins let the Server reach the local network.
  For installed plugins, the consent control, the address check, and the
  redirect rule contain this risk.
- Local `http` and `tcp` origins send data without encryption on the local
  network. A separate consent is necessary before a secret travels this way.
- Public webhooks and participant sessions accept input from the internet.
  Rate limits and moderation contain abuse. They do not remove it.
- A `fetch-back` webhook accepts requests that it cannot authenticate. Each
  request can cause one read from the provider, within the rate limit.
- A provider that signs without a timestamp allows a replay after the 7-day
  delivery ID window. The plugin reads current provider state, so a replay
  does not change the result.
- OAuth connections need an HTTPS public URL and an OAuth client that the
  operator registers.
- `player.serial@1` widens the Edge device policy. It needs hardware
  qualification. `player.gpio@1` and `player.printer@1` do the same when a
  plugin first needs them.
- Stream connections keep sockets open from the Server to brokers and local
  systems. Messages during an interruption are lost, so a plugin must read
  current values again after each reconnect.
- Public links accept requests from the internet. They run no plugin code
  and store no request data, but a scan count can be inflated within the
  rate limits. Studio presents it as an indication, not a measurement.
- Manifests carry a bounded purge list, and every Player host must delete
  purged objects from its cache. An untrusted feed needs a publication at
  least every 72 hours.

## Rejected alternatives

- **Keep adding `Host` fields for each need.** Each plugin would still repeat
  host work, and installed plugins would never receive the fields.
- **Run every plugin in WebAssembly.** Studio would lose React pages for large
  plugins, and every bundled plugin would need a rewrite first.
- **Treat both trust classes as equal security boundaries.** It would give
  false assurance about bundled plugins.
- **Give installed plugins their own SQL schema.** It would break the one
  migration sequence that exact-version restore uses.
- **A shared OAuth client or an OAuth relay.** One registration cannot match
  every installation's redirect address. A relay adds a proprietary
  dependency.
- **Synchronous webhook handling.** Providers expect an answer within
  seconds. A slow plugin would lose events.
- **Webhooks without polling.** Many installations have no public address.
- **Add the fast path before a measurement.** Plugin-only revisions may be
  enough.
- **Plugins that own arbitration, approval, or localization.** These are core
  semantics. Plugins fill provider slots.
- **Secret tables in each plugin.** Each plugin would write its own
  cryptography.
- **Native Player code in installed plugins.** The Plugin Model V2 record
  rejects it.
- **A review state in each plugin.** Each plugin would build its own queue,
  retention, audit, and media quarantine for untrusted input.
- **Content Review for untrusted input.** Content Review reviews immutable
  submissions of Playlists, Layouts, and Campaigns. A social post or a poll
  answer is not such a submission.
- **`content.write@1` in a `background` or `system` context.** A timer or a
  webhook has no operator. A write would have no accountable actor and no
  content access decision.
- **A verification preset for each provider.** The `pairs` header format,
  the `url.body` signed string, the `verify` hook, and `fetch-back` cover the
  known forms without code for each provider.
- **Device speech synthesis as a plugin service.** It adds a Player
  presentation mechanism and language behavior. Section 1 makes it core.
- **Plain HTTP to any address.** It would expose public traffic and cloud
  metadata addresses to plugins.
- **Stream messages in the durable delivery queue.** A busy broker would
  write each message to the database. Live values need the latest value, not
  every value.
- **Stream connections held by plugin code.** A hook runs for at most 30
  seconds, and an installed plugin has no socket.
- **A plugin route that redirects.** Plugin code would run for each scan,
  and a plugin could build an open redirect.
- **Withdrawal through normal cache eviction.** A Player evicts an unpinned
  object only under storage pressure, so withdrawn content could stay on
  disk and return as an offline fallback.
- **Plugin events with free names.** A name without the publisher's identity
  could collide, and core would need to know plugin names.

## Open questions

- Which abuse controls must public webhooks, public links, and participant
  sessions have beyond rate limits? Tilecast must not require a proprietary service.
- How does a plugin send a message to one named person without breaking the
  incident rule of `notify`?
- How does a person link an external chat or calendar identity to a Tilecast
  account, so that a plugin can attribute an action to that person?
- Which Player hosts can keep sensitive state in memory only without a
  change to their cache design?
- Can each Player host delete one purged object at once? The Browser Player
  can delete from Cache Storage but not from the browser HTTP cache.
