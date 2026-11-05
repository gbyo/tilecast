# Phone setup

Phone setup lets a person give a new screen its Tilecast Server address with a
phone. The person does not type the address with a remote.

Status:

- The setup relay in `apps/setup-relay` is implemented and tested.
- The Edge, Windows, and Android Players show the setup QR code and accept an
  envelope. Player Core implements the Player requirements once for all three.
- The Studio route `/screens/setup` is not implemented. Until it is, no phone
  can complete a setup.
- The legacy Electron Linux Player does not implement phone setup. It gets the
  server address from [LAN discovery](mdns-discovery.md) or from manual entry.

## Why a relay

A new screen does not know the server address. The phone knows it, because
the person opens Tilecast Studio on the phone. The address must go from the
phone to the screen.

The only network operations that every Tilecast Player can do are:

- show a QR code;
- open outbound HTTPS and WebSocket connections.

Some Players cannot accept inbound connections. The Browser Player cannot
listen on a port. Windows asks for firewall approval when an application
listens. Guest Wi-Fi and AP isolation block traffic between a phone and a
screen. A phone on a cellular network cannot reach the screen.

Thus the phone and the screen meet at a fixed public address: the setup relay.
Both sides connect out to it. The relay carries one encrypted envelope from
Studio to the screen. The relay cannot read the envelope.

The Tilecast Server does not use the relay. Phone setup is an optional aid.
LAN discovery and manual entry stay available on every Player. If the relay is
not available, those methods continue to operate.

## Parts

| Part            | Responsibility                                                                                      |
| --------------- | --------------------------------------------------------------------------------------------------- |
| Player          | Makes a key pair and a setup code, shows the QR code, waits on the relay, opens the envelope.       |
| Setup page      | Static page on the relay. Asks for the Studio address and opens Studio. Sends nothing to the relay. |
| Studio          | Seals the server address for the Player key and delivers the envelope to the relay.                 |
| Relay           | Holds one envelope for one setup code. Gives it to the waiting Player one time.                     |
| Tilecast Server | Not changed. The Player pairs with the server through the [pairing protocol](player-protocol.md).   |

## Sequence

1. The Player makes a P-256 ECDH key pair and a setup code. The setup code is
   16 random bytes.
2. The Player opens a WebSocket to the relay with the setup code.
3. The Player shows a QR code with the setup page URL.
4. The person scans the QR code with the phone camera. The phone opens the
   setup page.
5. The person enters the Studio address. The setup page opens
   `/screens/setup` on that address and keeps the fragment.
6. Studio seals the server address and the installation ID for the Player key.
   Studio sends the envelope to the relay.
7. The relay sends the envelope to the Player and closes the WebSocket.
8. The Player opens the envelope. The Player then does the same steps as for a
   typed address: URL policy, identity read, installation ID check, and server
   confirmation.
9. The Player starts pairing. The person approves the screen in Studio on the
   phone.

## QR code

The QR code contains this URL:

```text
https://setup.tilecast.org/#v=1&r=<setup-code>&k=<player-key>
```

| Field | Value                                                                       |
| ----- | --------------------------------------------------------------------------- |
| `v`   | `1`                                                                         |
| `r`   | Setup code. 16 random bytes, base64url without padding, 22 characters.      |
| `k`   | Player public key. Uncompressed P-256 point, base64url, 87 characters (`B`) |

The values are in the fragment. A browser does not send the fragment to a
server. Thus the relay does not get the setup code or the key from the setup
page.

The setup page rejects a fragment that does not agree with this table. It
gives Studio the fields in the order `v`, `r`, `k` and removes other fields.

## Setup page

The setup page is static. It does not send a request to the relay.

- It applies the shared server address policy to the Studio address. The
  corpus in `packages/player-contracts/fixtures/server-url-policy.json` pins
  the page implementation.
- It keeps the last accepted address in the phone browser `localStorage`. The
  next setup shows this address.
- It opens `<address>/screens/setup#v=1&r=<setup-code>&k=<player-key>`.
- It shows English, Spanish, or Russian text, from the browser language.
- Its Content Security Policy permits only its own scripts and styles.
- It has the appearance of the Studio sign-in page. `scripts/build.mjs` takes
  the logo from `apps/dashboard/src/components/TilecastLogo.tsx` and the Geist
  font from the package that Studio uses. `setup.css` copies the Studio theme
  values from `apps/dashboard/src/styles.css`.

## Envelope

Studio seals the payload with ECIES on P-256:

1. Make an ephemeral P-256 ECDH key pair.
2. Derive 256 shared bits with ECDH from the ephemeral private key and the
   Player public key.
3. Derive an AES-256-GCM key with HKDF-SHA-256:
   - input key material: the shared bits;
   - salt: the raw ephemeral public key, then the raw Player public key
     (130 bytes);
   - info: the UTF-8 bytes of `tilecast-setup-v1`.
4. Encrypt the payload with a random 12-byte nonce. The additional data is the
   UTF-8 bytes of the setup code.

The envelope is a JSON object:

```json
{
  "v": 1,
  "epk": "<ephemeral public key, uncompressed, base64url>",
  "iv": "<nonce, base64url>",
  "ct": "<ciphertext and tag, base64url>"
}
```

The payload is a JSON object:

```json
{
  "serverUrl": "https://signage.example.org",
  "installationId": "0b0f4a52-9f1e-4f43-a0a4-6d3f7c1d2e11"
}
```

`apps/setup-relay/test/envelope.test.ts` is a reference implementation with
WebCrypto. The additional data binds the envelope to one setup code. The
Player must reject an envelope that does not open.

## Relay API

The relay has one endpoint, `/v1/rendezvous`. The setup code is in the
`Authorization` header as `Rendezvous <setup-code>`. The setup code is never in
a URL path or a query string.

### Player connection

The Player sends `GET /v1/rendezvous` with a WebSocket upgrade.

- The relay sends one text message: the envelope. Then it closes with code
  `1000`.
- The Player must send a WebSocket ping frame at intervals of 30 seconds or
  less. The runtime answers with a pong frame. It does not wake the Durable
  Object for a ping frame, and Cloudflare does not bill ping frames.
- The Player must not send data messages. The relay closes the socket with code
  `1003` when it gets a data message.
- A new connection for the same setup code replaces the old connection. The
  relay closes the old connection with code `4409`.
- The relay closes the socket with code `4408` when the setup code expires.

### Studio delivery

Studio sends `PUT /v1/rendezvous` with the envelope as the body. The relay
permits this request from all origins. The request carries no cookies.

| Status | Body or `error.code`           | Meaning                                                    |
| ------ | ------------------------------ | ---------------------------------------------------------- |
| `202`  | `{"data":{"delivered":true}}`  | The waiting Player received the envelope.                  |
| `202`  | `{"data":{"delivered":false}}` | The relay holds the envelope until the Player connects.    |
| `400`  | `invalid_envelope`             | The body does not agree with the envelope shape.           |
| `401`  | `invalid_rendezvous`           | The `Authorization` header has no valid setup code.        |
| `409`  | `rendezvous_occupied`          | The setup code already has an envelope.                    |
| `410`  | `rendezvous_closed`            | The setup code expired or the Player received an envelope. |
| `413`  | `envelope_too_large`           | The body is larger than 2048 bytes.                        |
| `429`  | `rate_limited`                 | Too many requests from this client address.                |

A Player connection also gets `410`, `401`, or `429` with the same codes.

### Slot lifetime

A setup code opens a slot when the relay first sees it. The slot accepts one
envelope. The slot closes when the Player receives the envelope. The relay
deletes the slot 60 minutes after it opens.

The slot is longer than the Player wait limit. Thus one slot covers a full
setup session. A long slot does not decrease security, because the screen
shows the setup code. Each new slot costs a request, an alarm, and row writes.

The relay keeps no other record. It does not record the setup code. It names
the slot with the SHA-256 hash of the setup code.

## Player requirements

- Show the setup QR code only when the Player has no server.
- Make a new key pair and a new setup code for each setup session, after code
  `4408`, and after each envelope.
- Stop the setup session 30 minutes after it starts if no envelope arrives.
  Close the relay connection. Replace the QR code with a prompt to press the
  remote select button. Start a new setup session when the person presses the
  button or when the Player starts again. A screen that stays on the setup
  screen for days thus does not use the relay.
- Keep the private key in memory only.
- Apply the server URL policy to `serverUrl`. Reject an address that the
  policy rejects.
- Read the server identity. If the installation ID is not `installationId`,
  reject the address.
- Start pairing with the address. The pairing screen shows the server
  organization, the server address, and the local-HTTP warning before a
  person approves the screen in Studio.
- Keep LAN discovery and manual entry on the same screen.
- Never send a device credential, a poll secret, or an enrollment token to the
  relay.

### Implementation

Player Core owns the setup session in
`crates/player-core/src/pairing/phone_setup.rs`. `player-client` owns the relay
connection and the envelope in `crates/player-client/src/phone_setup.rs`.

- A host turns phone setup on with `PairingCoordinator::with_phone_setup`.
  `PairingCoordinator::run` then runs the session beside the pairing loop.
- Core starts a session only when reconcile shows the setup surface for a
  Player without a server. A typed address, a reset, or enrollment stops the
  session.
- Core reports the session in `PairingStatus::Setup { phone }` as
  `PhoneSetupView::Ready`, `Paused`, or `Unavailable`. The host draws it.
- An unreachable relay shows `Unavailable` and retries after 15 seconds. The
  retry interval doubles to at most 5 minutes, inside the 30-minute session.
- `PairingCoordinator::resume_phone_setup` starts a new session after
  `Paused`. Core accepts the resume request while the host displays the
  paused state.
- `PairingStatus::Waiting` carries the session server address, so a host that
  did not start the session can show it.
- `packages/player-contracts/fixtures/phone-setup-envelope.json` pins the
  envelope. `player-client` opens it with the shared secret, and the relay
  tests open it with WebCrypto.

Each host draws the session and supplies the relay address:

| Host    | Surface                                                              | Relay setting                                                                          |
| ------- | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Edge    | Runtime setup surface through `phoneSetup` in the setup presentation | `[pairing] phone_setup` and `setup_relay_url` in `/etc/tilecast-edge/edge.toml`        |
| Windows | Runtime setup surface through `phoneSetup` in the setup presentation | `[pairing] phone_setup` and `setup_relay_url` in `tilecast-windows.toml`               |
| Android | Compose panel beside the search and manual entry screens             | Build property `TILECAST_PLAYER_SETUP_RELAY_URL`; an empty value turns phone setup off |

The Runtime shows the QR code when the setup presentation has
`phoneSetup.state` `ready`. It shows a "Show setup code" control for `paused`
when the host reports `capabilities.phoneSetup`. The control calls
`setup.resumePhoneSetup`. On Edge the renderer forwards it to `tilecastd` as
the IPC method `setup.resume_phone_setup`.

## Studio requirements

- `/screens/setup` requires a signed-in Owner or Administrator.
- Studio sends its own origin as `serverUrl`. The phone reached Studio at this
  address, so the screen can often reach it too.
- Studio sends its installation ID as `installationId`.
- Studio uses a fixed relay address. Studio does not get the relay address from
  the fragment.
- After delivery, Studio tells the person to look at the screen. The person
  approves the screen with the existing approval flow.
- The QR scanner in the Pair screen dialog accepts a setup QR code. Studio
  reads the fragment with the same rules as the setup page. Then it seals and
  delivers the envelope directly, without the setup page. The scanner must not
  load the scanned URL.

## Security

| Threat                                   | Result                                                                                                                                                            |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A person reads the QR code on the screen | The person can deliver a different address. The Player shows the server organization before pairing. Approval needs a Studio sign-in on that server.              |
| The relay or its operator is hostile     | The relay cannot open the envelope. It can drop or delay an envelope. It cannot make an envelope that the Player accepts without the Player key from the QR code. |
| A person repeats an old envelope         | The slot accepts one envelope. The additional data binds the envelope to one setup code. The Player makes a new key for each QR code.                             |
| A person guesses a setup code            | The setup code has 128 random bits.                                                                                                                               |
| A person sends too many requests         | The relay limits connections to 60 and deliveries to 20 each minute for each client address. An envelope is at most 2048 bytes.                                   |

The relay sees client IP addresses and the time of each setup. It does not see
the server address or the installation ID.

## Operation

The relay is a Cloudflare Worker with one SQLite Durable Object class. Static
assets serve the setup page. The relay does not need a database or secrets.

- The Player socket uses WebSocket hibernation. A waiting Player does not use
  Durable Object duration between pings.
- Static asset requests are free and have no limit. Only `/v1/rendezvous`
  requests use the Worker and Durable Object allowances.
- The rate limits use the Workers rate limiting binding.
- The production address is `setup.tilecast.org`. Add this custom domain to
  the Worker before the first Player release that shows the QR code.

### Usage and plan

| Activity                                  | Worker requests | Durable Object requests | Rows written |
| ----------------------------------------- | --------------- | ----------------------- | ------------ |
| One completed setup                       | 3               | 3                       | 8            |
| One setup session without an envelope     | 1               | 2                       | 3            |
| One rejected request (rate limit, format) | 1               | 0                       | 0            |

On the Workers Free plan, each of these three values has a limit of 100,000 a
day for the account. When a value reaches its limit, requests fail until
00:00 UTC. Phone setup then stops for all installations. Manual entry and LAN
discovery continue to operate.

A request that the rate limit rejects still counts as a Worker request. One
client at the per-address limit can thus use most of the Free plan allowance.

Before the first Player release that shows the QR code:

1. Move the account to Workers Paid. On this plan the allowances are monthly
   and an overage has a cost. An overage does not stop the relay.
2. Add a Cloudflare rate limiting rule for `/v1/rendezvous` on the relay
   hostname. A zone rule stops a request before the Worker runs, so the
   request does not count as a Worker request. This rule needs the domain DNS
   on Cloudflare.

To deploy, run `npm ci` and `npm run deploy` in `apps/setup-relay`. Wrangler
must be signed in to the Cloudflare account that owns the domain.

An operator can run a separate relay. Each Player and Studio must then use
that relay address. A new Player cannot learn a relay address before setup, so
an operator must configure it on each Player. Most installations use the
public relay.
