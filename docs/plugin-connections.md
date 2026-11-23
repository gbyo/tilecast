# Plugin connections

A Plugin Manifest API 3 plugin sends outbound requests only through host
connections. The plugin declares each connection in its manifest. An Owner or
Administrator creates connection records in Studio. Plugin code names a record
and calls `http.fetch@1`. The host decides the origin, the addresses, the
consents, and the limits. The decision record is
[ADR: Plugin Model V3](adr/plugin-model-v3.md), section 7.

This document is the contract for these items:

- the `connections` member of the manifest;
- connection records, consents, and references;
- the outbound engine (`apps/server/internal/outbound`);
- `http.fetch@1` and secret header references;
- OAuth 2.0 connections.

A bundled plugin is first-party code in the Server process. These rules
prevent mistakes. They do not contain a plugin that is compromised. See
[Trust](#trust).

## Declaration

```json
{
  "connections": [
    {
      "id": "calendar",
      "title": "Calendar service",
      "type": "http",
      "origins": ["https://api.example.com"]
    },
    {
      "id": "gateway",
      "title": "Meter gateway",
      "type": "http",
      "origins": "operator",
      "privateNetwork": "allowed",
      "plainHttp": "allowed",
      "allowPlaintextSecret": true,
      "maxResponseBytes": 4194304,
      "timeoutSeconds": 30
    }
  ]
}
```

| Member                 | Rule                                                                                                 |
| ---------------------- | ---------------------------------------------------------------------------------------------------- |
| `id`                   | `^[a-z][a-z0-9_]{0,39}$`. Unique in the plugin. It never changes.                                    |
| `title`, `description` | Display text. At most 80 and 280 characters.                                                         |
| `type`                 | `http` or `oauth2`. Later phases add other types.                                                    |
| `origins`              | 1 to 8 canonical `https` origins, or `operator`.                                                     |
| `privateNetwork`       | `refused` (default) or `allowed`.                                                                    |
| `plainHttp`            | `refused` (default) or `allowed`. Needs `origins: "operator"` and `privateNetwork: "allowed"`.       |
| `allowPlaintextSecret` | Optional. Needs `plainHttp: "allowed"`.                                                              |
| `maxResponseBytes`     | 1,024 to 16,777,216. The default is 1 MiB.                                                           |
| `timeoutSeconds`       | 1 to 60. The default is 10.                                                                          |
| `oauth`                | Required for `oauth2` and refused for `http`. See [OAuth 2.0 connections](#oauth-20-connections).   |

A plugin declares at most 8 connections. The Go SDK
(`packages/plugin-sdk/go/plugin/connections_v3.go`) and the Zod schema
(`packages/plugin-sdk/src/manifest.ts`) apply the same rules. The fixtures in
`packages/plugin-sdk/testdata/manifests` keep them in agreement.

### Why these bounds

- 8 connections: twice the number that the proof plugins use. Each connection
  is a separate item in the install review.
- 8 origins: enough for a provider with separate API, upload, and content
  hosts.
- 16 MiB and 60 seconds: the ADR limits for `http.fetch@1`. A larger download
  uses `blob.fetch@1` in a later phase.

### Origins

An origin is a scheme, a host, and an effective port. A path, a query, a
fragment, and user information are never part of an origin.

- A manifest origin must be canonical: lower case, no default port, and no
  trailing slash. `https://API.example.com:443` is refused. Write
  `https://api.example.com`.
- A fixed origin must use `https`. A plugin never declares a fixed `http`
  origin.
- `localhost` and names below `.localhost` are refused. They are always
  loopback addresses.
- A host is ASCII. Write an internationalized name in its `xn--` form.

`packages/plugin-sdk/testdata/origins.json` holds the shared cases for
`ParseOrigin` (Go) and `parseOrigin` (TypeScript).

## Connection records

An Owner or Administrator creates a record for one declaration. A record has:

- the plugin and the declaration;
- a name, 1 to 120 characters;
- the origin, for an `operator` declaration only;
- three consents;
- a revision.

A record never holds a credential. A plugin has at most 50 records.

The records are rows of `plugin_connections`. The security state is columns:
the origin, each consent with its time and its author, and the fingerprint
that the consents were given for.

### Consents

| Consent           | Available when                        | Needs             |
| ----------------- | ------------------------------------- | ----------------- |
| Private network   | `privateNetwork: "allowed"`           | Nothing           |
| Plain HTTP        | `plainHttp: "allowed"`                | Private network   |
| Plaintext secret  | `allowPlaintextSecret: true`          | Plain HTTP        |

- Consents change only through
  `PUT /api/v1/plugins/{pluginId}/connections/{connectionId}/consents`. The
  general save of a record never changes a consent.
- A consent that the declaration does not make possible is refused.
- The host records the fingerprint of the declaration's security members and
  of the origin with the consents. A changed origin clears every consent. A
  release that changes the declaration makes the stored consents stale. A
  stale consent applies to nothing. The next consent write clears it.
- Studio shows each consent as a separate control with its own explanation.
  Giving a consent asks for confirmation. Removing one does not.

### Status

Each record reports `ready` or the reasons that it cannot be used:

| Reason                             | Meaning                                              |
| ---------------------------------- | ---------------------------------------------------- |
| `origin_required`                  | An `operator` record has no origin.                  |
| `private_network_consent_required` | An `http` origin needs the private network consent.  |
| `plain_http_consent_required`      | An `http` origin needs the plain HTTP consent.       |
| `declaration_removed`              | The plugin no longer declares the connection.        |

Notices do not block use. `consents_need_confirmation` reports stale consents.
`private_addresses_need_consent` reports that private addresses are refused
until the private network consent is given.

### References

A `connection` field of a setting or an instance stores only the record ID.
See [configuration schema](config-schema.md#controls). On each write the host
checks that:

- the record exists and belongs to the same plugin;
- the field accepts the record's declaration;
- the writer holds `plugins.manage`, the capability that manages connections.

The host records each use in `plugin_connection_references`. It locks each
named record `FOR SHARE`, so a concurrent delete waits and then sees the
reference. A delete of a referenced record answers `409
plugin_connection_in_use` with the references. The foreign key also refuses
the delete.

Connection configuration stays on the Server. The host does not add a
connection ID, an origin, or a consent to Player state. A plugin projection
can convert a connection into display state only on purpose.

## Outbound engine

`apps/server/internal/outbound` is the one engine for outbound plugin
requests. `http.fetch@1`, OAuth token and revocation requests use it. Feed
image imports use it in a later change of phase 2.

### Addresses

For each new socket the engine:

1. resolves the host once;
2. converts IPv4-mapped IPv6 addresses to IPv4;
3. checks every returned address;
4. connects to one of the checked addresses;
5. verifies the TLS certificate against the original host name.

The HTTP transport never resolves a name itself. A resolver therefore cannot
answer one address for the check and another address for the connection. A
reused connection keeps its checked socket. A new socket repeats the
resolution and the check.

| Class     | Addresses                                                                                                      | Rule                                         |
| --------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| Forbidden | Loopback, link-local (with `169.254.169.254`), unspecified, multicast, broadcast, documentation, benchmarking, carrier-grade NAT, NAT64, 6to4, Teredo, IPv4-compatible | Always refused                               |
| Private   | `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `fc00::/7`                                                    | Only with the private network consent        |
| Public    | Other global unicast addresses                                                                                  | `https` only                                 |

An answer that holds one refused address fails as a whole. The engine never
selects a permitted address from an answer that also names a refused one.

### Plain HTTP

Plain HTTP is possible only when all of these are true:

- the origin is the `operator` origin of the record;
- the declaration allows the private network and plain HTTP;
- both consents are active;
- every resolved address is private.

### Proxies and headers

- The engine never uses a proxy from the environment.
- A response head is at most 64 KiB.
- The engine follows no redirect by itself. See [Redirects](#redirects).

### Redirects

The engine follows at most 5 redirects. It follows a redirect only to an
approved origin of the same record, and it checks the new addresses again.

| From              | To                       | Result                                                 |
| ----------------- | ------------------------ | ------------------------------------------------------ |
| `https`           | Approved `https`         | Followed                                               |
| Local `http`      | Approved `https`         | Followed                                               |
| `https`           | `http`                   | Refused                                                |
| Local `http`      | Approved local `http`    | Followed when the destination passes the plain HTTP rules |
| Any               | Not an approved origin   | Refused                                                |

At each change of origin the engine removes `Authorization` and every header
that came from a secret, also when both origins are approved. A `303`
changes the method to `GET`. A `301` or `302` changes `POST` to `GET`.

### Failure codes

Plugin code and diagnostics receive only these codes and fixed messages:

`request_invalid`, `origin_not_allowed`, `private_network_refused`,
`plain_http_refused`, `plaintext_secret_refused`, `dns_failed`,
`dns_address_refused`, `connect_failed`, `tls_failed`, `redirect_refused`,
`timeout`, `response_too_large`, `connection_unavailable`, `request_failed`,
and `secret_unavailable`.

A resolver, socket, or TLS error never reaches plugin code or a log, because
its text can name internal hosts.

### Diagnostics

The host writes one log line for each failed request, and one debug line for
each successful request. The line holds the plugin ID, the record ID, the
origin, the method, the status, the duration, and the failure code. It never
holds the path, the query, a header, a body, or a secret.

## `http.fetch@1`

`http.fetch@1/request` is a Server service for bundled Plugin Manifest API 3
plugins. Installed packages do not receive it before installed-plugin parity.
The old package `http_fetch` import keeps its own contract.

```go
response, err := services.Fetch(ctx, plugin.HTTPRequest{
    Connection: connectionID,
    Method:     http.MethodGet,
    URL:        "/calendar/v3/calendars/primary/events?maxResults=50",
    Headers: []plugin.HTTPHeader{
        {Name: "Accept", Value: "application/json"},
        {Name: "Authorization", Secret: &plugin.SecretHeader{
            Scope: plugin.ScopeOrganization, Key: "apiToken", Prefix: "Bearer "}},
    },
})
```

| Property         | Rule                                                                                       |
| ---------------- | ------------------------------------------------------------------------------------------ |
| Contexts         | `studio`, `background`, `system`                                                           |
| Connection       | A record of the calling plugin. Another plugin's record answers `connection_unavailable`. |
| URL              | Absolute, or a path and query when the record has exactly one origin.                      |
| Methods          | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`                                            |
| Request headers  | At most 32; a name at most 64 bytes; a value at most 4,096 bytes; at most 16 KiB in total.  |
| Refused headers  | `Host`, `Cookie`, `Connection`, `Proxy-Connection`, `Keep-Alive`, `TE`, `Trailer`, `Transfer-Encoding`, `Upgrade`, `Proxy-*`, `Content-Length`, `Expect`, `Forwarded`, `X-Forwarded-*`, `Via`, `Sec-*` |
| Request body     | At most 1 MiB, checked before the request starts.                                          |
| Response body    | The declared limit. The engine stops reading at the limit and answers `response_too_large`. |
| Time             | The declared limit covers resolution, connection, TLS, redirects, and the body.            |
| Response headers | Only `Content-Type`, `Content-Language`, `ETag`, `Last-Modified`, `Cache-Control`, `Expires`, `Date`, `Retry-After`, `Link`, `Location`, rate-limit headers, and `Square-Version`. Never `Set-Cookie`. |

The host keeps no cookie jar.

### Secret headers

A header can name one of the plugin's own `secret` fields instead of a value.
The host reads and decrypts the secret, sends `prefix + secret + suffix`, and
never returns the value to plugin code.

- The reference names the scope (`organization`, `instance`, or `screen`),
  the owner ID for an instance or a screen, and the key.
- The prefix and the suffix are at most 64 bytes each and cannot hold
  `{secret}`.
- A secret that is not set, cannot be decrypted, is not a `secret` field, or
  belongs to another plugin answers `secret_unavailable`.
- A secret header on an `http` request needs the declaration's
  `allowPlaintextSecret` and the plaintext secret consent. Otherwise the host
  answers `plaintext_secret_refused` before it reads the secret. Plain HTTP
  consent alone is not enough.
- A secret never enters a URL, a log, Activity, an audit event, an error, or a
  Studio read.

### Transport limits

The service registry gives each operation its own transport bounds. See
[External package service capabilities](package-services.md#transport). The
bounds of `http.fetch@1/request` hold the encoded domain limits:

| Bound  | Domain limit                       | Transport limit                                   |
| ------ | ---------------------------------- | ------------------------------------------------- |
| Input  | 1 MiB body, 16 KiB headers, 8 KiB URL | base64 of 1 MiB plus 64 KiB: 1,463,640 bytes   |
| Output | 16 MiB body                        | base64 of 16 MiB plus 64 KiB: 22,435,160 bytes    |

## OAuth 2.0 connections

An `oauth2` connection is an `http` connection with an OAuth 2.0 provider.
Tilecast is the OAuth client. The operator registers the client with the
provider. Tilecast ships no shared client and uses no relay. This model is
separate from `apps/server/internal/oauth`, where Tilecast is the
authorization server for its own CLI, iOS, and MCP clients.

### Declaration

```json
{
  "id": "google",
  "title": "Google Calendar",
  "type": "oauth2",
  "origins": ["https://www.googleapis.com"],
  "oauth": {
    "authorizationEndpoint": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenEndpoint": "https://oauth2.googleapis.com/token",
    "revocationEndpoint": "https://oauth2.googleapis.com/revoke",
    "scopes": ["https://www.googleapis.com/auth/calendar.readonly"],
    "tokenEndpointAuthMethod": "client_secret_post",
    "authorizationParameters": { "access_type": "offline", "prompt": "consent" }
  }
}
```

| Member                    | Rule                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------- |
| `authorizationEndpoint`   | Required. An `https` URL without a query, a fragment, or user information. At most 2,048 bytes.     |
| `tokenEndpoint`           | Required. The same rules.                                                                           |
| `revocationEndpoint`      | Optional. The same rules. An RFC 7009 endpoint.                                                     |
| `scopes`                  | 1 to 16 scopes. Each is 1 to 256 RFC 6749 scope characters. No repeated scope.                     |
| `tokenEndpointAuthMethod` | `client_secret_basic`, `client_secret_post`, or `none`. With `none` the operator enters no secret. |
| `tokenRequestFormat`      | `form` (default) or `json`. Some providers take token requests as JSON.                             |
| `authorizationParameters` | At most 8 fixed parameters, such as `access_type`. Keys `^[a-z][a-z0-9_]{0,39}$`; values 1 to 256 printable ASCII bytes. |

An `oauth2` connection has fixed `https` origins. It refuses `operator`
origins, the private network, plain HTTP, and `allowPlaintextSecret`. RFC 9700,
section 2.6, does not permit an authorization response on an unencrypted
connection. The host sets these parameters, and a declaration cannot set
them: `response_type`, `client_id`, `client_secret`, `redirect_uri`, `scope`,
`state`, `code`, `code_challenge`, `code_challenge_method`, `code_verifier`,
`grant_type`, `refresh_token`, and `nonce`.

The OAuth members are part of the declaration fingerprint. Tokens record the
fingerprint they were granted for. A release that changes an endpoint, a
scope, or a parameter puts the connection in `reconnect_required`.

### Setup

1. The Owner or Administrator creates a connection record.
2. Studio shows the exact redirect URI. The operator registers it with the
   provider:
   `<TILECAST_PUBLIC_URL>/api/v1/plugins/{pluginId}/connections/{connectionId}/callback`.
3. The operator enters the client ID, and the client secret when the
   declaration authenticates the client. The client secret is write-only.
4. The operator selects Connect.

The redirect URI comes only from `TILECAST_PUBLIC_URL`, never from a request.
Connect is available only when `TILECAST_PUBLIC_URL` is an `https` URL
without user information, a query, or a fragment. Otherwise the record shows
`connectUnavailableReason: public_url_https_required`, and Studio shows the
reason instead of the control. The other reasons are `client_id_required` and
`client_secret_required`.

### Authorization

The host runs the authorization code flow with PKCE S256 (RFC 7636).

1. `POST .../oauth/start` creates an attempt: a random state and a random PKCE
   verifier, 32 bytes each from the operating system's random source. The
   attempt row (`plugin_oauth_transactions`) holds the SHA-256 hash of the
   state, the plugin, the connection, the operator, and an expiry ten minutes
   later. The verifier is a connection secret. A new attempt replaces the
   earlier attempt of the connection. The answer is the provider URL with
   `response_type=code`, the client ID, the redirect URI, the scopes, the
   state, and the S256 challenge.
2. The provider sends the browser to the callback. The Studio session cookie
   is `SameSite=Strict`, so the browser does not send it on this cross-site
   navigation. The callback changes nothing. It redirects (303) to the fixed
   Studio page of the connection, with the state, the code, and a provider
   error code in the URL fragment. No request parameter chooses the
   destination. The response has `Referrer-Policy: no-referrer` and
   `Cache-Control: no-store`. A fragment never reaches a server log or a
   `Referer` header.
3. The Studio page posts the values to `POST .../oauth/complete` with the
   session and the CSRF token, and removes the fragment from the address. A
   bearer grant cannot complete an attempt.
4. The Server consumes the attempt with one `DELETE ... RETURNING` before it
   does anything else. The state is therefore single use across every Server
   process, and a failed completion cannot be replayed. The attempt must
   belong to the plugin, the connection, and the signed-in operator, and it
   must not have expired. A provider error answers `provider_denied`.
5. The Server exchanges the code with the verifier and the same redirect URI
   at the token endpoint, and stores the tokens.

The attempt is a database row, so the completion works on any Server
process and after a restart. The maintenance loop deletes expired attempts
and their verifiers every 30 seconds.

A failed completion answers `plugin_oauth_failed` with `error.details.reason`:
`invalid_state`, `provider_denied`, `invalid_response`, `connection_changed`,
`invalid_grant`, `token_rejected`, `token_endpoint_unavailable`,
`invalid_token_response`, or `client_secret_unavailable`. It never returns
provider text.

### Token requests

Token, refresh, and revocation requests use the outbound engine with the
endpoint's own origin only. The engine refuses private, loopback, and
link-local addresses and plain HTTP, and follows no redirect. A token response
is at most 64 KiB, and a request takes at most 20 seconds.

| Method                | Client authentication                                                                         |
| --------------------- | --------------------------------------------------------------------------------------------- |
| `client_secret_basic` | `Authorization: Basic`, with the ID and the secret each form-encoded first (RFC 6749, section 2.3.1). |
| `client_secret_post`  | `client_id` and `client_secret` in the body.                                                  |
| `none`                | `client_id` in the body.                                                                      |

The host accepts a token response only with an `access_token` of at most
4,096 bytes and a `token_type` of `bearer`, or no `token_type`. It reads
`expires_in` as a number or a string. A response classifies as follows:

| Response                                  | Class                        | Effect on a refresh                         |
| ----------------------------------------- | ---------------------------- | ------------------------------------------- |
| 4xx with `error: invalid_grant`           | `invalid_grant`              | Delete the tokens. `reconnect_required`.    |
| Any other 4xx, except 408 and 429         | `token_rejected`             | Keep the tokens. Record the code.           |
| 408, 429, 5xx, a redirect, or no answer   | `token_endpoint_unavailable` | Keep the tokens. Record the code.           |
| 2xx without a usable token                | `invalid_token_response`     | Keep the tokens. Record the code.           |

### Token storage

The client secret, the access token, the refresh token, and the PKCE verifier
are plugin secrets with the owner type `connection`
([Plugin secrets](plugin-secrets.md)). They are encrypted like every other
plugin secret, and deleting the connection deletes them. A connection row
holds the client ID, the status, the expiry, the fingerprint, and the last
refresh error code. No API response, audit row, log line, plugin hook, Player
manifest, or Player state holds a token or the client secret.

### Requests

`http.fetch@1` on an `oauth2` connection adds `Authorization: Bearer` with the
current access token. The header is a sensitive header: the engine removes it
when a redirect changes the origin. A plugin that sends its own
`Authorization` header on an `oauth2` connection gets
`oauth_authorization_header_refused`. Plugin code never receives a token.

| Failure code                         | Meaning                                                      |
| ------------------------------------ | ------------------------------------------------------------ |
| `oauth_not_connected`                | The connection has no tokens yet.                            |
| `oauth_reconnect_required`           | The provider refused the grant, or the declaration changed. |
| `oauth_refresh_failed`               | The token expired and a refresh failed for now.              |
| `oauth_authorization_header_refused` | The plugin sent its own `Authorization` header.              |

### Refresh

The host refreshes an access token 60 seconds before it expires.

- One process refreshes one connection at a time. The refresh holds the
  connection's row lock. A process that waited for the lock reads the token
  that the other process stored, and does not ask the provider again.
- The new access token and a rotated refresh token are written in one
  transaction. A provider that sends no new refresh token keeps the old one.
- `invalid_grant`, or a refresh token that is missing or cannot be
  decrypted, deletes the tokens and sets `reconnect_required`. The host never
  retries it. The audit log records `plugin.connection.oauth_reconnect_required`
  with the system surface.
- Any other failure keeps the tokens and records the failure code. The host
  waits 30 seconds before it asks the provider again. Until then, and while
  the access token has not expired, requests use the current token.
- A Server that stops after the provider answered and before the commit
  loses that answer. When the provider rotates refresh tokens, the stored
  refresh token can then be invalid. The next refresh gets `invalid_grant`,
  and the connection goes to `reconnect_required`. It does not loop.

The refresh reads the client secret in its own transaction, so it never needs
a second database connection while it holds the row lock.

### Disconnect and client changes

`POST .../oauth/disconnect` asks the provider to revoke the grant when the
declaration has a revocation endpoint (RFC 7009). It sends the refresh token,
or the access token when there is no refresh token, with the client
authentication of the declaration. Then it deletes the local tokens in every
case. Tilecast never keeps a token because a provider is unreachable.
`oauth.revocation` records the result:

| Value          | Meaning                                                                 |
| -------------- | ----------------------------------------------------------------------- |
| `confirmed`    | The provider answered 200, or Tilecast held no token.                   |
| `failed`       | The provider did not answer 200. The notice `oauth_revocation_failed`. |
| `not_declared` | The declaration has no revocation endpoint.                             |

A connected record cannot be deleted (`plugin_connection_connected`):
disconnect it first. A new client ID deletes the tokens and an attempt in
progress, because they belong to the old client. A new client secret keeps
the tokens.

### Record state

A record of an `oauth2` connection has an `oauth` member. Its `status` is
`not_connected`, `connected`, or `reconnect_required`. The record reasons
add `oauth_client_required`, `oauth_not_connected`, and
`oauth_reconnect_required`. The notices add `oauth_refresh_failing` and
`oauth_revocation_failed`. The install review shows the authorization, token,
and revocation endpoints and the scopes.

## Authorization

| Route                                                         | Capability       |
| ------------------------------------------------------------- | ---------------- |
| `GET /api/v1/plugins/{pluginId}/connections`                  | `plugins.use`    |
| `GET /api/v1/plugins/{pluginId}/connections/{connectionId}`   | `plugins.use`    |
| `POST`, `PUT`, `DELETE` of a record, and `PUT .../consents`   | `plugins.manage` |
| `POST .../oauth/start` and `POST .../oauth/disconnect`        | `plugins.manage` |
| `POST .../oauth/complete`                                     | `plugins.manage`, a Studio session |
| `GET .../callback`                                            | None. It changes nothing. |

Changes need CSRF for cookie requests and the `admin` scope for bearer
requests. The built-in roles that hold `plugins.manage` are Owner and
Administrator. A custom role with `plugins.manage` can give consents too.

## Trust

- For a bundled plugin, these rules prevent mistakes. A bundled plugin can
  open a socket without the host. `npm run plugins:check` refuses direct use
  of `net` and `net/http` clients in a Plugin Manifest API 3 plugin. The check
  finds mistakes. It is not a security control.
- For an installed plugin (a later phase), each declaration, origin, consent,
  and limit is a security control that the host enforces.

## Threat model

| Threat                                                   | Control                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------- |
| A plugin request reaches cloud metadata or a local admin service | Forbidden address classes; loopback and link-local are never reached.    |
| DNS rebinding between the check and the connection       | One resolution for each socket; the transport dials only checked addresses.      |
| A mixed DNS answer hides a local address                 | The whole answer fails.                                                          |
| A redirect leaves the approved origins                   | Redirects are followed step by step, only to approved origins, with new checks.  |
| A credential follows a redirect                          | Secret and `Authorization` headers are removed at each change of origin.         |
| A proxy carries a request past the checks                | Environment proxies are never used.                                              |
| A secret travels unencrypted                             | A separate declaration and consent; `plaintext_secret_refused` otherwise.        |
| A consent carries to a new destination                   | A changed origin clears consents; a fingerprint makes consents stale.            |
| A large response exhausts memory                         | A bounded head, a bounded stream, and per-operation transport bounds.            |
| Plugin code learns internal network detail               | Stable failure codes only.                                                       |
| An OAuth response arrives over plain HTTP                | Connect needs an `https` public URL; OAuth endpoints and origins are `https`.    |
| Login CSRF links a connection to an attacker's account   | The state is random, single use, and bound to the plugin, connection, and operator who started it. |
| A stolen code is exchanged                               | PKCE S256: the verifier never leaves the Server.                                 |
| The callback redirects to an attacker                    | The destination is fixed from the manifest; no parameter chooses it.            |
| A code or state leaks through logs or Referer            | The callback moves them to a URL fragment, with `no-referrer` and `no-store`.    |
| A token endpoint resolves to a local address             | The token request uses the engine's address rules.                              |
| Two processes refresh at once with a rotating token      | One refresh under the row lock; the rotated token is written atomically.        |
| A refused grant causes a retry loop                      | `invalid_grant` deletes the tokens and sets `reconnect_required`.               |
| A token reaches plugin code or a screen                  | Tokens are connection secrets; the host adds the bearer header itself.          |
