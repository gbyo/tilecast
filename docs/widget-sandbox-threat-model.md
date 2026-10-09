# External Widget sandbox threat model

External Widget JavaScript is untrusted third-party code. It executes
only inside the sandboxed frame: an opaque-origin `allow-scripts`
document with no credentials, no network voice, and no host handle.
This document names the threats, the controls that answer them, and
the residual risks an operator accepts.

## Assets

The frame must never reach Tilecast credentials, cookies, database
handles, filesystem paths, the Player host object, server auth tokens,
package-management APIs, other Widgets' data, or the top-level page.
The bridge carries only the Widget contract: bounded config, prepared
data documents, host-authorized media URIs, and a serializable context
snapshot. Frames report only lifecycle states through bounded codes.

## Controls

Isolation starts with the document. The response policy sandboxes the
frame to an opaque origin with `allow-scripts` only: no
`allow-same-origin`, no forms, no popups, no top navigation, no
downloads, no modals. `connect-src`, `worker-src`, `object-src`,
`base-uri`, and `form-action` are all `none`. The iframe element
repeats the sandbox flags as defense in depth. Image, media, and font
loads stay possible only through host-authorized URIs granted over
the bridge; the grant list is the real boundary because an opaque
origin cannot use `self`.

Attachment binds the frame to its placement. The parent mints a
cryptographically random per-attach hello token and appends it to the
frame URL as a fragment, outside the resource request and the cached
frame identity. The bootstrap echoes the token in `frame-hello`. The
parent accepts the hello only from the placement's own frame window,
from the opaque origin `null`, with the exact protocol version and
token, once per attach. It then transfers a fresh `MessagePort`;
every later message uses only that port plus the per-attach nonce.
Reload or navigation kills the connection permanently and never
receives a new port. Blob and srcdoc embedding exist only as negative
fixtures proving why they are unsuitable; production code cannot reach
them.

Input revisions stop stale reports. Every input carries a revision;
the frame drops element events from older revisions and echoes the
current one on every report, and the parent drops reports for a
superseded revision. A slow Widget can never settle a previous input
after an update. Message sizes stay strictly bounded on both sides.

Verification precedes execution. Players verify the assembled frame
against the package digest and cache only verified bytes. A Player
that cannot fully isolate, verify, cache, and execute an external
Widget must not advertise external Widget runtime support, and server
compatibility projection stays authoritative. Manifest v18 keeps its
meaning: verified raw bundle retrieval that explicitly does not
execute those bytes. Only manifest v19 marks executable Widgets.

Media stays authorized. Frame media requests carry opaque
per-activation tokens from an authorized table, never digests or
paths. Tokens are single-claim: a second claim with the same token
fails. Whole documents only: range requests are refused.

## Residual risks

### Passive-resource exfiltration

`connect-src 'none'` blocks `fetch`, XHR, and WebSocket, but not passive
loads. A Widget that is allowed to load any `https:` or `http:` image,
media, or font could encode its declared configuration or prepared data
into an attacker-owned URL. The frame document's own `<meta>` policy cannot
prevent this: the untrusted bytes choose it, and it must stay broad enough
for every host's media route, which only the serving host can name.

Each Player host therefore serves frame bytes with a response policy built
from the shared contract (`packages/player-contracts/fixtures/widget-frames.json`).
Content-Security-Policies intersect, so the header narrows the meta policy:

| Host                         | Passive sources (`img-src`, `media-src`, `font-src`) | Enforcement                                     |
| ---------------------------- | ---------------------------------------------------- | ----------------------------------------------- |
| Browser Player               | `data:` and `<origin>/player/media/`                 | Service-worker response header                  |
| Android                      | `data:` and `tcmedia:`                               | `TcWidgetBridge` response header                |
| Windows                      | `data:` and `tcmedia:`                               | `tcwidget` scheme response header               |
| Edge (WPE)                   | `data:` and `http://127.0.0.1:*/media/`              | `tcwidget` scheme response header               |
| Server player frame endpoint | `data:` and `tcmedia:`                               | Response header (hosts re-serve with their own) |

Every other fetch directive stays `'none'`, including `connect-src`,
`worker-src`, `object-src`, `frame-src` (through `default-src`), `base-uri`,
and `form-action`. Unit tests pin each header to the contract, and a
fixture check rejects any passive source outside the allowed set.

Evidence by engine:

- **Chromium (Browser Player): proven.** The Browser frame e2e loads the
  production service worker and runs a hostile Widget that aims 14 passive
  vectors at an attacker host (image, `srcset`, video, audio, poster, CSS
  background, `@font-face`, stylesheet, preload, prefetch, object, embed,
  iframe, and plain `http:`). Each must raise a policy violation, and the
  harness must see no request leave the frame. A control run with
  `https:`/`http:` restored to the header leaks the requests, so the test
  detects the weakness.
- **Android WebView, WebView2, and WPE: header pinned, engine run
  outstanding.** Their headers equal the contract and are unit tested, but
  no run has yet shown that the engine enforces the header inside an
  opaque-origin frame loaded from a custom scheme. WPE needs particular
  care because it rejects custom-scheme loads inside opaque-origin frames;
  the loopback route is the only passive source it allows.

Remaining limits:

- **Studio preview** serves the frame with the broader meta-equivalent
  policy (`https:` and `http:` passive sources) because its media grants are
  same-origin server URLs. A previewed malicious package could exfiltrate
  the preview's data. Preview runs only for a signed-in administrator, but
  do not preview untrusted packages with real data until preview pins its
  media path.
- **DNS prefetch** and similar resolver hints are not governed by CSP. A
  Widget could leak a few bits through name lookups. Hosts do not block
  them.
- **Edge loopback** allows any local port under `127.0.0.1`. Only a process
  on the device itself could receive a request, but the policy does not pin
  the daemon's port.

**Release gate for untrusted external packages:** run the passive-vector
Widget on Android WebView, WebView2, and WPE, with each engine showing a
policy violation and no outbound request. Until then,
`widget.external-runtime@2` is not security-qualified for general
third-party execution on those hosts, regardless of unit-test success.
A malicious Widget may also consume CPU/memory or render misleading content
inside its own tile. Physical DRM/KMS, WebView and WebView2 qualification
remain separate gates.
