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

Pinning image, media, and font sources to the exact granted URIs
through the iframe `csp` attribute is recorded future hardening; today
the scheme-wide source list relies on the grant list as the boundary.
A malicious Widget can still consume CPU and memory inside its frame
and can render misleading content inside its own tile; it cannot
exfiltrate data, reach credentials, touch other tiles, or navigate the
top page. Real-engine qualification (WPE, WebView, WebView2,
Chromium) is the gate for every advertised target: no target claims
`widget.external-runtime@2` on unit tests alone.
