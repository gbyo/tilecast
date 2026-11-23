# Plugin webhooks

A Plugin Manifest API 3 plugin can declare inbound webhooks. Another system
sends a request to an address that the host owns. The host authenticates the
request, keeps it, and gives it to the plugin later. This document is the
contract. The [ADR](adr/plugin-model-v3.md), section 8, records the decision.
The [delivery queue](plugin-delivery.md) delivers each request.

In phase 3, webhooks are for bundled plugins only. The hooks are the Go
methods `HandleWebhook` and `VerifyWebhook`. The `handle_webhook` and
`verify_webhook` exports of an installed WebAssembly plugin are phase 6. The
`public` mode is phase 4, because public input must go through moderation
first. The host refuses a manifest that declares it.

## Endpoint

Each webhook has one endpoint:

```text
POST /api/v1/hooks/{pluginId}/{webhookId}
```

The host owns the route. A plugin cannot add a public HTTP route of its own.
The route takes no Studio session and no CSRF token. The webhook's declared
mode authenticates each request.

The host answers `404` when the plugin is not installed or does not declare
the webhook. It answers `405` for a method other than `POST`. Every answer has
`Cache-Control: no-store`.

## Manifest

```json
{
  "settings": {
    "organization": [
      { "key": "webhookSecret", "label": "Webhook secret", "control": "secret" }
    ]
  },
  "webhooks": [
    {
      "id": "plan_changes",
      "title": "Plan changes",
      "authentication": "signature",
      "ackStatus": 200,
      "signature": {
        "scheme": "hmac-sha256",
        "secret": "webhookSecret",
        "header": "X-PCO-Webhooks-Authenticity",
        "format": "plain",
        "encoding": "hex",
        "signedPayload": "body"
      },
      "deliveryId": { "pointer": "/data/0/id" },
      "forwardHeaders": ["X-PCO-Webhooks-Event"]
    }
  ]
}
```

| Member           | Rule                                                                           |
| ---------------- | ------------------------------------------------------------------------------ |
| `id`             | 1 to 40 characters: `[a-z][a-z0-9_]*`. It is the last segment of the endpoint. |
| `title`          | 1 to 80 bytes. `description` is at most 280 bytes.                             |
| `authentication` | `token`, `signature`, or `fetch-back`. The host refuses `public`.              |
| `ackStatus`      | `200` or `202`. The default is `202`.                                          |
| `handshake`      | Optional: `echo-query` or `echo-json`. See [Handshakes](#handshakes).          |
| `signature`      | Required for `signature`. Not permitted for the other modes.                   |
| `deliveryId`     | A `header` or a JSON `pointer`. Rules for each mode are below.                 |
| `fetchBack`      | Required for `fetch-back`. Not permitted for the other modes.                  |
| `forwardHeaders` | At most 8 headers that the plugin receives. The host keeps no other header.    |
| Webhooks         | At most 8 for each plugin.                                                     |

A plugin has at most 8 webhooks. Each webhook is an endpoint that anyone can
reach, a separate item in the install review, and a separate card on the
Webhooks page. A provider integration needs one or two. Eight is the same as
the connection limit.

A plugin that declares webhooks must implement `WebhookHandler`. A plugin
with a `verify` signature must implement `WebhookVerifier`. The SDK refuses
a plugin that does not.

The host never forwards these headers: `Authorization`, `Proxy-Authorization`,
`Cookie`, `Set-Cookie`, hop-by-hop headers, `Host`, `Content-Length`,
`Forwarded`, `Via`, `X-Forwarded-*`, `Proxy-*`, and client address headers.
A webhook cannot forward its signature header.

## Request bounds

| Bound                                 | Value                     |
| ------------------------------------- | ------------------------- |
| Raw body                              | 64 KiB                    |
| Forwarded header value                | 512 bytes                 |
| Signature header                      | 2,048 bytes, 8 signatures |
| External delivery ID                  | 1 to 200 visible ASCII    |
| Fetch-back event ID                   | 1 to 128 characters       |
| Handshake value                       | 512 bytes                 |
| JSON Pointer in a declaration         | 128 bytes                 |
| Undelivered requests for each webhook | 500                       |
| Requests from one address (all hooks) | 600 in one minute         |
| Fetch-back requests from one address  | 60 in one minute          |

The host refuses a declared `Content-Length` above 64 KiB before it reads the
body. Otherwise it reads at most 64 KiB and one byte, and it refuses the
request at the extra byte. It never allocates more than the limit.

The address limits are in the memory of each Server process. They use the
address of the direct connection. The host does not read a proxy header for
them, and it stores no address.

## Authentication

Every authentication failure answers `401` with the code `unauthenticated`.
The answer does not tell the sender which check failed. The plugin's status
records a stable refusal code. See [Status](#status).

### Token

A token webhook takes a webhook token in the `Authorization` header:

```text
Authorization: Bearer tch_<public id>.<secret>
```

- The public ID is 12 random bytes in hex. The secret is 32 random bytes in
  unpadded base64url.
- The Server stores the SHA-256 digest of the secret. It compares the digest
  in constant time.
- Studio shows the token one time, when it is created. No route reads it
  again.
- A token authenticates one webhook of one plugin. It does not authenticate
  another webhook of the same plugin.
- Revocation is permanent. A webhook has at most 10 active tokens.
- Creating or revoking a token needs `plugins.manage`. The audit records the
  token's name and public ID, never the secret.
- Removing the plugin deletes its tokens.

Webhook tokens are not integration tokens. They have no scopes, no acting
user, and their own table. The two share only the credential format code in
`internal/credential`.

A token webhook may declare a `deliveryId`. Then the host drops a repeated
delivery ID for 7 days, and a request without the ID receives `400`.

### Signature

The host verifies the signature. The plugin never receives the signing
secret.

`signature.secret` names an organization setting of the same plugin with the
`secret` control. The host reads it from the encrypted secret store. When the
secret is not set, was cleared, or cannot be read (for example after a
restore without the key file), the host refuses the request with `503` and
`Retry-After`. The provider retries until an operator enters the secret.
Studio shows the state of the secret: set, not set, or needs a new value.
Studio never shows the value.

A signature webhook needs a stable delivery ID. `standard-webhooks` uses the
`webhook-id` header. The other schemes must declare `deliveryId`.

#### `standard-webhooks`

The [Standard Webhooks](https://www.standardwebhooks.com/) symmetric form:

- Headers `webhook-id`, `webhook-timestamp` (Unix seconds), and
  `webhook-signature`.
- The signed string is `<webhook-id>.<webhook-timestamp>.<raw body>`.
- The secret is `whsec_` and base64 key material. The host removes the
  prefix and decodes the base64. The HMAC key is the decoded bytes, not the
  text of the secret. A secret without the prefix is decoded the same way. A
  secret that is not base64 refuses the request with `503`.
- `webhook-signature` holds one or more space-separated `v1,<base64>`
  entries, for key rotation. The host ignores entries of other versions. This
  release does not verify the asymmetric `v1a` form.
- The timestamp must be at most 5 minutes from the host clock, in the past or
  in the future.

The declaration names only the secret:

```json
{ "scheme": "standard-webhooks", "secret": "webhookSecret" }
```

#### `hmac-sha256`

A generic HMAC-SHA256 signature:

| Member            | Rule                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------- |
| `header`          | The signature header.                                                                     |
| `format`          | `plain`: the header holds signatures. `pairs`: comma-separated `key=value` pairs.         |
| `signatureKey`    | `pairs` only: the key of each signature.                                                  |
| `timestampKey`    | `pairs` only: the key of the timestamp, exactly when `signedPayload` is `timestamp.body`. |
| `timestampHeader` | `plain` only: the timestamp header, exactly when `signedPayload` is `timestamp.body`.     |
| `prefix`          | Optional, such as `sha256=`. A candidate without the prefix is ignored.                   |
| `encoding`        | `hex` or `base64`: the encoding of the signature.                                         |
| `signedPayload`   | `body`, `timestamp.body`, or `url.body`.                                                  |

The signed string is:

- `body`: the raw body.
- `timestamp.body`: the timestamp text, `.`, and the raw body. The timestamp
  must be at most 5 minutes from the host clock.
- `url.body`: the exact endpoint address, then the raw body, with nothing
  between them.

The HMAC key is the text of the secret. The host never decodes a secret
because it looks like hex or base64. `encoding` is the encoding of the
signature, not of the secret.

In the `plain` format, a header can hold several signatures separated by
commas or spaces. In the `pairs` format, several pairs can have the signature
key. The host tries at most 8 candidates and accepts the request when one
matches.

Examples:

| Provider style  | Declaration                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------ |
| Planning Center | `header` `X-PCO-Webhooks-Authenticity`, `plain`, `hex`, `body`                                         |
| Square          | `header` `x-square-hmacsha256-signature`, `plain`, `base64`, `url.body`                                |
| Stripe          | `header` `Stripe-Signature`, `pairs`, `timestampKey` `t`, `signatureKey` `v1`, `hex`, `timestamp.body` |

#### URL-bound signatures

The endpoint address is `TILECAST_PUBLIC_URL` and
`/api/v1/hooks/{pluginId}/{webhookId}`, with no trailing slash on the base.
Studio shows the same address. The host never builds it from `Host`,
`Forwarded`, `X-Forwarded-Host`, or `X-Forwarded-Proto`. A request through a
reverse proxy verifies against the address the operator registered with the
provider.

#### `verify` hook

For a provider that fits neither form, the plugin verifies the request:

```go
func (p *Plugin) VerifyWebhook(ctx context.Context, request plugin.WebhookVerification) error
```

- The input is the webhook ID, the exact raw body, the headers that
  `signature.headers` names (at most 8), and the endpoint address.
- The host gives the call 1 second. An error, a panic, or the end of the
  time limit refuses the request.
- The call runs in a restricted `system` invocation. The service registry
  refuses every operation that reaches the network, such as `http.fetch@1`.
  The registry marks each such operation, so a later network operation is
  refused in the same way.
- The host gives the hook no signing secret.

A bundled plugin is trusted Server code. The architecture check refuses a
direct `net` or `net/http` import in a Plugin Manifest API 3 plugin. This is
a correctness boundary, not a sandbox.

### Fetch-back

For a provider whose request cannot carry trusted data, the host keeps only an
event ID. The plugin then reads the event from the provider through an
authenticated connection.

```json
{
  "authentication": "fetch-back",
  "fetchBack": { "eventId": "/value/0/id", "pattern": "^[A-Za-z0-9-]{1,64}$" }
}
```

1. The host reads at most 64 KiB.
2. It reads the string or integer at `eventId`.
3. The ID must match `^[A-Za-z0-9_.:-]{1,128}$` and the declared pattern. A
   pattern is anchored and at most 200 bytes. The host applies both, so a
   pattern can only make the rule narrower.
4. The host drops the rest of the request, its headers included.
5. A request without a valid event ID receives `400`.
6. The host drops a repeated event ID for 24 hours.
7. The host queues only the event ID.

The plugin receives `Webhook.EventID` and no body. An attacker can only make
the plugin read an event that the provider authenticates.

## Replay protection

The host keeps a receipt for each accepted external delivery ID: the
provider's delivery ID or a fetch-back event ID. The receipt key is the
plugin, the webhook, and the ID.

| Webhook                                      | Receipt kept |
| -------------------------------------------- | ------------ |
| Signature with a signed timestamp            | 24 hours     |
| Signature without a timestamp, token webhook | 7 days       |
| Fetch-back                                   | 24 hours     |

A request with a signed timestamp older than 5 minutes fails, so 24 hours is
more than enough. Without a timestamp, a captured request can be replayed
after 7 days. The plugin treats a delivery as a reason to read current state
from the provider, not as the state itself. Polling makes the result
complete.

The receipt insert and the queue insert are in one transaction. Two copies of
one delivery that arrive at the same time never both queue: the second waits
for the first and finds its receipt. The queue's own UUID is the Tilecast
delivery ID. The provider's ID is kept apart as `Webhook.ExternalID`. A
receipt whose time ended counts as absent, and the maintenance sweep deletes
it.

## Acknowledgement

`ackStatus` is `200` or `202`. Providers do not agree: Planning Center
retries every answer except `200`, and Microsoft Graph asks for `202` after
validation and durable queueing. Both values have the same safety rules:

1. Validate the request and its bounds.
2. Authenticate the request.
3. Check the receipt.
4. Queue the delivery.
5. Commit the transaction.
6. Answer the declared status with no body.

The host never acknowledges a request that it did not store. When the
transaction fails, the answer is `503` and the provider retries. A repeated
delivery ID answers the declared status and queues nothing.

When a webhook already has 500 undelivered requests, the host answers `503`
with `Retry-After`. An advisory lock for each webhook makes this bound hold
across Server processes.

## Handshakes

The host answers a handshake itself. Plugin code does not run, and nothing is
queued. A handshake answer has status `200`, `Content-Type: text/plain;
charset=utf-8`, `Cache-Control: no-store`, and
`X-Content-Type-Options: nosniff`. The body is only the value.

| Type         | When the host answers it                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| `echo-query` | The request has the declared query parameter. The host returns its decoded value. No authentication runs. |
| `echo-json`  | After a valid signature, when the body has a string at the declared pointer. Only for signature webhooks. |

For example, Microsoft Graph sends `validationToken` and needs the answer
within 10 seconds. A value that is empty or longer than 512 bytes receives
`400`.

A handshake never chooses a status, a header, or a body shape. A webhook is
not a general anonymous HTTP endpoint.

## Delivery

The webhook request is an item of kind `webhook` on the shared delivery
queue. Its source and its subject are the webhook ID. So the requests of one
webhook are delivered in order, and different webhooks of one plugin run in
parallel. A plugin cannot choose another subject. The delivery rules of the
[delivery queue](plugin-delivery.md) apply: at least once, a stable delivery
ID, a 30-second time limit, retries from 5 seconds to 15 minutes, and a
parked item after 8 failures.

```go
func (p *Plugin) HandleWebhook(ctx context.Context, webhook plugin.Webhook) error
```

| Field        | Value                                                      |
| ------------ | ---------------------------------------------------------- |
| `DeliveryID` | The Tilecast delivery ID. It is the same on every attempt. |
| `WebhookID`  | The declaration's ID.                                      |
| `ReceivedAt` | When the host accepted the request.                        |
| `ExternalID` | The provider's delivery ID, when the webhook declares one. |
| `Body`       | The exact raw body of a token or signature webhook.        |
| `Headers`    | The declared `forwardHeaders` the request carried.         |
| `EventID`    | The event ID of a fetch-back request.                      |
| `Attempt`    | 1 for the first attempt.                                   |

The hook runs in the `system` context with no operator. The queue keeps the
raw body as the payload, and the receive time, the external ID, the event ID,
and the forwarded headers as metadata. It never keeps a credential, a
signature, a cookie, or an address.

## Reachability

A SaaS provider can reach only a public HTTPS address. Many installations
have none. Studio shows one of these states for each webhook:

| State                   | Meaning                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------- |
| `available`             | `TILECAST_PUBLIC_URL` is HTTPS. The Server cannot prove that the provider can reach it.   |
| `public_https_required` | A signature or fetch-back webhook, and `TILECAST_PUBLIC_URL` is plain HTTP.               |
| `local_network`         | A token webhook on a plain HTTP address. A system that can reach that address can use it. |
| `public_url_missing`    | `TILECAST_PUBLIC_URL` is not a usable address. The webhook has no endpoint.               |

A plugin that uses SaaS webhooks must also poll. Polling is the complete
path. Webhooks only make an update arrive sooner.

## Status

The Webhooks page shows each webhook's endpoint, its authentication, its
acknowledgement, its handshake, the state of its signing secret, its
reachability, the counts of accepted and repeated requests, the requests
that wait, and the time and code of the latest refusal. For a token webhook,
it lists the tokens and creates and revokes them. The Status page shows a
short summary.

The refusal codes are `token_invalid`, `signing_secret_unavailable`,
`signing_secret_unusable`, `signature_missing`, `signature_invalid`,
`timestamp_missing`, `timestamp_out_of_range`, `delivery_id_missing`,
`verify_failed`, `verify_timeout`, `verify_panic`, `event_id_invalid`,
`rate_limited`, `queue_full`, `header_too_large`, `body_too_large`, and
`handshake_value_too_large`.

The host writes a refusal at most one time each minute for each code, so
anonymous requests do not cause a database write each. It logs the same
event with the plugin, the webhook, and the code. It never logs a body, a
header, a token, a signature, a secret, or an address.

The install review shows each webhook: its path, its authentication, whether
it needs a public HTTPS address, its handshake, its acknowledgement, and
whether the operator enters a signing secret.

## Routes

| Route                                                                     | Access                 |
| ------------------------------------------------------------------------- | ---------------------- |
| `POST /api/v1/hooks/{pluginId}/{webhookId}`                               | The webhook's own mode |
| `GET /api/v1/plugins/{pluginId}/webhooks`                                 | `plugins.use`          |
| `POST /api/v1/plugins/{pluginId}/webhooks/{webhookId}/tokens`             | `plugins.manage`, CSRF |
| `DELETE /api/v1/plugins/{pluginId}/webhooks/{webhookId}/tokens/{tokenId}` | `plugins.manage`, CSRF |

## Lifecycle

- Removing the plugin deletes its tokens, receipts, webhook status, and
  queued requests in the removal transaction.
- A reinstall starts with no tokens and no receipts. Work of the previous
  installation never runs: each queued item records its installation.
- A definition upgrade that removes a webhook makes its queued requests
  undeliverable. The engine deletes them. The maintenance sweep deletes the
  tokens, receipts, and status of a webhook that no plugin declares.
- Signing secrets are organization plugin secrets. A backup includes them
  encrypted, with the rest of the plugin secrets. Token digests and receipts
  are ordinary rows of the backup.

## Storage

Migration `00146_plugin_webhooks.sql` adds:

- `plugin_webhook_tokens`: token metadata and the SHA-256 digest.
- `plugin_webhook_receipts`: one row for each accepted external delivery ID.
- `plugin_webhook_status`: counts, times, and the latest refusal code.

The request itself is a row of `plugin_deliveries`.

## Tests

`apps/server/internal/webhookauth` holds conformance vectors that an
independent HMAC implementation computed: the Standard Webhooks reference
vector, a Square-style `url.body` vector, a Planning Center-style `body`
vector, and a `pairs` vector. `apps/server/pluginharness/webhooks_test.go`
runs a test plugin with one webhook of each mode against the real host. It
covers the body bound, methods, each scheme, the configured address behind
proxy headers, a missing and an unreadable secret, a concurrent replay race,
receipt retention, the token lifecycle, the verify hook (failure, panic,
time limit, refused network service), fetch-back, handshakes, the pending
bound, a rolled-back enqueue, retries, cleanup, and secrets in logs, status,
and audit.
