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

The current frame CSP allows `https:` and `http:` passive image,
media, and font requests so that host-served media works in opaque-origin
frames. This is **not an exfiltration barrier**: a malicious Widget could
encode its declared configuration or prepared data into an attacker-owned
image URL, even while `connect-src 'none'` blocks `fetch`. Opaque origin
isolation still prevents access to host credentials, top-level DOM, and
other Widgets, but it does not make granted Widget data impossible to
exfiltrate. The existing hostile fixture's `fetch` canary only tests
active network calls; passing it must not be interpreted as proving
passive resource isolation.

**Release blocker for untrusted external packages:** each supported host
must constrain image, media, and font requests to specific host-authorized
media endpoints (or an equivalently restrictive native request policy),
and a real-engine test must prove that an attacker-specified image URL
cannot receive a request. A response-level or per-frame CSP is suitable
only when verified for that engine, including WPE opaque-origin frames.
Until this is enforced and tested, `widget.external-runtime@2` is not
security-qualified for general third-party execution, regardless of
unit-test or headless fixture success. A malicious Widget may also
consume CPU/memory or render misleading content inside its own tile.
Physical DRM/KMS, WebView and WebView2 qualification remain separate gates.
