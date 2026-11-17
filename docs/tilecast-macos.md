# Tilecast Player for macOS

**Status:** In development. The host composes Player Core, pairs,
reconciles with a Server, and presents the shared Player Runtime in a
`WKWebView`. It is not released. Tracking issue: gbyo/tilecast#1922.

The macOS Player (`apps/player-macos`, package `tilecast-macos`) is the
third native host of the shared Player crates, after Edge and Windows. It
uses the same Player Core, Player Runtime, and Presentation Model as the
other hosts. It does not contain a second implementation of pairing,
reconciliation, manifests, CAS, Activity, or recovery.

## Host decisions

| Decision             | Choice                                    | Reason                                                                                                                                                                                                                                                     |
| -------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Host language        | Rust with `objc2`, in the Cargo workspace | A spike drove a real `WKWebView` from Rust: a custom URL scheme handler, a script message handler, a navigation delegate, and `evaluateJavaScript` with a completion block. No Swift shell is necessary. The host links `plugin-native-registry` directly. |
| Minimum macOS        | 14.0 (Sonoma)                             | `WKWebsiteDataStore dataStoreForIdentifier:` needs macOS 14. Isolated Website and YouTube views need it (gbyo/tilecast#1927). Constructed stylesheets need 13.3. Login items through `SMAppService` need 13.                                               |
| Release family       | `macos`                                   | The Server reaches only screens that report this family.                                                                                                                                                                                                   |
| Renderer engine name | `wkwebview`                               | Host diagnostics report this name.                                                                                                                                                                                                                         |

## Shared WebView host

The Windows and macOS Players share one composition crate,
`crates/webview-host` (package `webview-host`). It contains:

- the daemon context and its supervised task set;
- the Core host ports for pairing, the server link, configuration,
  manifest preparation, offline activation, commands, Activity, preview,
  Watch Live, and telemetry;
- the Runtime projection, the presentation engine, and its `RendererPort`
  (`WebViewPort`);
- verified media grants, the `tilecast://` and `tcmedia://` scheme contract,
  range parsing, and the scheme responses (`webview_host::serve`);
- the `TilecastRuntimeHostV1` bootstrap (`runtime_host.js`) with one
  transport for each WebView engine;
- remote web surfaces and the capture broker;
- the sealed credential and pairing-session stores;
- the release version rule (`release_version`), which runs the shared
  corpus in `packages/player-contracts/fixtures/release-versions.json`.

The crate calls no OS API and does not branch on a platform name. A
platform supplies its answers through the narrow seams in
`webview_host::host`. `RendererHost::features` states which optional
renderer features the platform implements. The host capabilities, the
packaged renderer profile, and the heartbeat follow that answer:

| Seam            | Windows                           | macOS                                   |
| --------------- | --------------------------------- | --------------------------------------- |
| `HostIdentity`  | `tilecast-windows`, `webview2`    | `tilecast-macos`, `wkwebview`           |
| `DeviceFacts`   | Registry, monitor, and tick count | `sysctl`, `NSLocale`, and Core Graphics |
| `RendererHost`  | WebView2 on its STA thread        | `WKWebView` on the AppKit main thread   |
| `WindowCapture` | Windows Graphics Capture          | Not available yet (gbyo/tilecast#1928)  |
| `UpdateHost`    | Signed MSIX updates               | Not available yet (gbyo/tilecast#1933)  |
| `Sealer`        | User-scoped DPAPI                 | AES-256-GCM key in the login Keychain   |
| `SpaceProbe`    | `GetDiskFreeSpaceExW`             | `statfs`                                |
| `SecureOpener`  | Reparse-point refusal             | `O_NOFOLLOW` and opened-file checks     |

The architecture gate (`scripts/ci/check-player-architecture.py`) enforces
the dependency direction:

- `webview-host` depends only on the five shared Player crates and the
  native plugin registry. It has no OS-specific dependency.
- No shared Player crate depends on `webview-host`.
- `tilecast-windows` and `tilecast-macos` do not depend on each other, on
  Edge, on Android, or on the Electron Player.

## Local state

| Path                                                      | Content                                                                             |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `~/Library/Application Support/Tilecast/Tilecast Player/` | State root: `state.db`, `identity/`, `cas/`, `partial/`, `updates/`, `diagnostics/` |
| `~/Library/Caches/Tilecast/Tilecast Player/`              | Scratch files                                                                       |
| `tilecast-macos.toml` in the state root                   | Optional operator configuration                                                     |

`TILECAST_MACOS_STATE_DIR` and `TILECAST_MACOS_RUNTIME_DIR` override the
roots. An override must be absolute. The host finds the home directory with
`NSHomeDirectory`, not `$HOME`.

The `identity/` directory is owner-only (`0700`). The device credential and
the pairing session are sealed files with mode `0600`. The sealing key is a
random 256-bit key in the login Keychain (service `org.tilecast.player`,
account `state-sealing-key`). The host creates the key only when the item
does not exist. A locked or denied Keychain is an error. It never causes a
new key. The data protection Keychain needs a signed app with a
keychain-access-groups entitlement. That decision belongs to
gbyo/tilecast#1929 and gbyo/tilecast#1933.

One `tilecast-macos run` process holds an exclusive lock on
`.instance.lock` in the state root. A second copy exits before it reads or
writes state.

## Renderer

The renderer is `apps/player-macos/src/webkit`. It supplies the WebKit
transport for the shared contracts. It does not contain a presentation
engine, a projection, a recovery policy, or a copy of the scheme policy.

### Process and threads

`tilecast-macos run` gives the main thread to AppKit. The Player daemon runs
on a Tokio runtime on other threads. `run --headless` runs without AppKit
and without a renderer.

- Every AppKit and WebKit object lives on the main thread.
- The Player sends `UiCommand` values on a bounded channel. A wake puts one
  drain block on the main dispatch queue. Only one drain block is waiting
  at a time.
- WebKit callbacks send `UiEvent` values on a bounded channel.
- No Player task waits synchronously for a WebKit callback.

The window is a minimal host window. It covers the visible frame of the
main screen and has no close button. Kiosk presentation belongs to
gbyo/tilecast#1930.

### Trusted Runtime origin

The renderer loads `tilecast://runtime/index.html`. The `tilecast` and
`tcmedia` schemes have a `WKURLSchemeHandler`. Each request goes to
`webview_host::serve`, the same policy that the Windows Player uses:

- `tilecast://runtime/` serves only files in the Runtime manifest, at their
  manifested sizes. All other paths get `404`.
- `tcmedia://` serves only a grant for the current renderer session. The
  host opens only verified CAS objects and checks the granted size.
- A single `Range` gets `206`. A range that cannot be satisfied gets `416`.
  `HEAD` gets headers without a body.
- Media responses allow CORS reads only from `tilecast://runtime`, so fonts
  load in CORS mode.
- An invalid, expired, retired, or wrong-session grant gets the same `404`.
- Media is served only while the top-level document of the web view is the
  Runtime document.

A worker on the Player runtime streams a file body in chunks of 512 KiB. One
chunk is in flight for each task. The main thread gives each chunk to
WebKit only while WebKit still owns the task. A stopped task stops the
read.

The navigation delegate lets the top frame load only the Runtime document.
It refuses every other navigation and every subframe navigation. The web
view uses a non-persistent website data store.

### Remote Website and YouTube views

Website and YouTube content render in separate `WKWebView`s. The Runtime
keeps `remoteWeb: "host-view"` ownership of timing, fallback, and
lifecycle. The host owns the views and the platform security policy. The
shared contract is in `webview_host::remote_web` (validated specs, the
bounded surface tracker, navigation rules, the YouTube wrapper, and the
failure vocabulary). `webview_host::remote_layer` holds the rest of the
engine-neutral behavior, which Windows also uses:

- the data policy of each surface (`RemoteDataPolicy`);
- the lifecycle state of each surface and the events it produces;
- top-level and subframe navigation decisions;
- the mapping of engine load results to failure codes;
- what a destroy releases and what a clear-data request must reach;
- the bounded surface map in stacking order.

`apps/player-macos/src/webkit/remote.rs` is the WebKit glue. `policy.rs`
holds the macOS decisions that need no WebKit process.

**Layering.** The window content is a flipped layer view. The Runtime web
view is the bottom subview and fills the view. Each remote surface is a
backdrop view, with the configured background color, that holds one
`WKWebView`. A later surface sits above an earlier one. The frame of a
surface is the validated device-pixel viewport divided by the window
backing scale, so it follows the Runtime's own coordinates when the window
resizes or moves between displays. Hiding a surface hides its backdrop. A
destroy removes both views and clears their delegates. The host keeps at
most four surfaces.

**Isolation.** `policy::remote_view_plan` is the whole configuration of a
remote view. It has no `tilecast` or `tcmedia` scheme handler, no script
message handler, and no user script, so a remote page has no
`tilecastRuntimeHost` and no bridge. The view never uses the Runtime's
data store. The Web Inspector is off. A remote view has no access to
Player Core, credentials, or CAS paths.

**Navigation.** The navigation delegate sends each top-level navigation to
`LayerState::top_level_navigation` and each subframe navigation to
`LayerState::subframe_navigation`. The rules are the shared Website
rules: the configured scheme, no credentials, default ports only, and the
exact allowed hosts. A refused top-level navigation is cancelled and
reported as `navigation-blocked`. It is never given to `NSWorkspace`, so
`mailto:`, `tel:`, `file:`, `javascript:`, `data:`, App Store, and custom
schemes cannot open another application. A navigation without a target
frame (a popup) is cancelled. Third-party subresources load, as on the
other Players: the allowlist applies to top-level navigation.

**Permissions.** The UI delegate creates no window, answers JavaScript
alert, confirm, and prompt dialogs without showing them, selects no files,
and denies camera, microphone, and motion permissions. A download, or a
response that WebKit cannot show, is cancelled. Website credentials and
client certificates are cancelled without a prompt.

**TLS.** A server-trust challenge gets the system's default evaluation,
and deprecated TLS is refused. A self-signed, expired, wrong-host, or
untrusted certificate fails the load, and the surface reports
`tls_failure`. There is no path that ignores a certificate error.

**Website data.** `RemoteDataPolicy` chooses the store:

| Policy                | Selected by                                        | Store                                    | When the surface ends                   |
| --------------------- | -------------------------------------------------- | ---------------------------------------- | --------------------------------------- |
| `EphemeralSurface`    | cookies `disabled`                                 | New non-persistent store for the surface | The store is cleared and released       |
| `IsolatedNoDomStorage`| cookies allowed, `domStorageEnabled: false`        | New non-persistent store for the surface | The store is cleared and released       |
| `PersistentFirstParty`| `first_party` with DOM storage                     | Persistent store `…A101`                 | Cookies outside the allowed hosts of every open first-party surface are deleted |
| `PersistentAll`       | `first_and_third_party` with DOM storage           | Persistent store `…A102`                 | Kept                                    |
| `YouTube`             | YouTube content                                    | Persistent store `…A103`                 | Kept                                    |

The persistent stores come from `WKWebsiteDataStore dataStoreForIdentifier:`
(macOS 14) with three fixed identifiers, so the number of stores does not
grow. A `first_party` strip lists every cookie of the store, so a cookie
that a third-party subresource set is found without a navigation to its
host.

**Clear data.** The clear-website-data command removes every WebKit data
type (cookies, HTTP cache, DOM and local storage, IndexedDB, service
workers, and temporary data) from every live private store and from all
three persistent stores, whether or not a surface uses them. The command
answers `true` only when every store completed. It does not touch the
Runtime view, the pairing credential, the CAS, or the Player state. Live
pages keep running, and their next load starts from the cleared store.

**YouTube.** The surface loads the shared Tilecast wrapper
(`remote_web::youtube_wrapper`) from memory with the base URL
`https://org.tilecast.player/<surface>.html`, the fixed origin that the
YouTube iframe API requires. The origin serves nothing, because the host
has no scheme handler for it. The wrapper has no message handler. The
host polls its state token every 500 ms in the client content world and
reports `loaded`, `stream-ready`, `media-ended`, and `failed` with
`youtube_error`. The wrapper starts paused. Visibility plays or pauses it.

**Mute.** WebKit has no public page mute on macOS. The host uses the
`_setPageMuted:` selector that Safari uses. If a WebKit does not have it,
the surface fails with `unsupported_content` and does not play unmuted.

**Recovery.** A remote surface has its own web content process. When it
ends, only that surface reports `renderer_crash`, and the Runtime's
failure policy decides what replaces it. The Runtime view and the other
surfaces continue. This path is separate from the Runtime's
`webViewWebContentProcessDidTerminate`. A `RemoteRecovered` command
announces that remote web serves. A Runtime restart removes all remote
layers, and the new Runtime creates the surfaces it still shows.

### Runtime bridge

The bootstrap is the shared `runtime_host.js` with the WebKit transport
(`runtime_host_webkit.js`). It is a document-start user script for the main
frame only. It defines `globalThis.tilecastRuntimeHost` before Runtime
scripts execute. The contract and its members are the same as on Windows.

The transport uses two `WKScriptMessageHandlerWithReply` channels in the
page content world:

| Channel                | Direction      | Body                     | Reply                         |
| ---------------------- | -------------- | ------------------------ | ----------------------------- |
| `tilecastRuntime`      | Runtime → host | One JSON message         | An acknowledgement            |
| `tilecastHostMessages` | host → Runtime | The document ID (a pull) | A JSON array of host messages |

The host keeps the newest pull open. It answers the pull with the queued
host messages, in order, when it has messages. The transport then pulls
again. A request reply travels as a `response` message with the request ID.

Before the host reads a message, it checks all of these conditions:

- the message is from the main frame;
- the security origin is `tilecast://runtime` with no port;
- the top-level document of the web view is `tilecast://runtime/index.html`;
- the web view is the current renderer generation.

A message that fails a check gets a refusal and does not reach the parser.
Runtime messages go to `webview_host::bridge::parse_runtime_message`, which
applies the 64 KiB limit and the V1 vocabulary. A host message larger than
4 MiB is refused. At most 256 messages and 16 MiB wait for a pull.

### Media autoplay

`mediaTypesRequiringUserActionForPlayback` is empty. Video and audio start
without a gesture, with the mute and volume that the content specifies. The
inactive scheduling policy is `none`, so an occluded window continues to
present.

### Renderer lifecycle and recovery

| Event                                  | Renderer behavior                                                                                                                      |
| -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Start or `Restart`                     | A new web view with a new generation and a new session. The host binds the session to the media registry and sends `UiEvent::Session`. |
| `Reload`                               | The web view reloads the Runtime document. The new document pulls with a new document ID.                                              |
| `webViewWebContentProcessDidTerminate` | `UiEvent::ProcessFailed` with `render-process-exited:terminated`. The shared recovery ladder decides to reload or restart.             |
| The Runtime document fails to load     | `UiEvent::Fatal`. The shared engine restarts the renderer within its limit.                                                            |
| `Shutdown`                             | The host releases the session grants and closes the window.                                                                            |

A restart removes the old web view, its queued messages, its pull, and its
scheme tasks. A callback from an old generation is ignored. The old
session's grants stop resolving when the new session binds.

### Truthful support

`WebKitHost::presents` is `true`. `engine_version` reports the WebKit
build and the macOS release. The renderer features are
`RendererFeatures::BASE`:

- `remoteWeb` is `"host-view"`, and the heartbeat reports `web.remote`.
  Remote web alone does not make the external frame ABI eligible.
- `externalFrames` is `false`. The host does not serve `tcwidget://` and
  does not report `widget.external-runtime`. External Plugin frames
  (`plugin.external-runtime@1`) stay disabled.
- `CapturePreview` answers that preview capture is not available. Final
  output capture belongs to gbyo/tilecast#1928.

The heartbeat reports the Runtime's ready report inside the packaged
ceiling of the platform. Before a Runtime is ready, it reports the ceiling.

Other behavior:

- Capture returns `unavailable`. Player Core settles preview requests as
  unavailable.
- `install_player_update` fails with `unsupported_command`. The heartbeat
  reports the build's version code.
- Autostart, Power Assist, AirPlay, and Presentation Network commands fail
  with `unsupported_command` and a macOS reason.

## Build and test

Run these commands on a Mac:

```sh
make macos-check
make macos-test
```

`tests/pairing.rs` runs the shared pairing scenarios in
`webview_host::testing` over the macOS services with the test sealer. The
Windows host runs the same scenarios over its services. The Keychain unit
test writes a throwaway item to the login Keychain and removes it.

`src/webkit/policy.rs` tests the bridge source checks, the navigation
policy, the host message queue, the store selection, the remote view plan
(no bridge, no schemes, no scripts), the mapping of WebKit errors, and the
viewport conversion without a WebKit process. `webview_host::remote_layer`
tests the data policies, the lifecycle, the navigation decisions, the
YouTube events, the clear plan, and the release plan. The shared
scheme policy has its tests in `webview_host::serve`.

Run the host against a Server. Build the Runtime first
(`npm run build:runtime -w @tilecast/player-runtime`) and point
`TILECAST_RUNTIME_DIR` at `packages/player-runtime/dist/runtime`:

```sh
cargo run -p tilecast-macos -- run --pair https://signs.example.org
cargo run -p tilecast-macos -- run --headless --pair https://signs.example.org
cargo run -p tilecast-macos -- status
```

## Evidence

On 2026-11-16, a local debug build on Apple Silicon (macOS 27.3) ran against a
local Server built from the same branch. The build:

- created a pairing session with platform `macos` and real device facts;
- enrolled after Owner approval, and the Server reported the screen online;
- reconnected after a clean restart without a new pairing session;
- removed its sealed credential after revocation.

On 2026-11-17, a local debug build with the `WKWebView` renderer ran on the
same Mac against a local Server built from the same branch. The build:

- loaded the Runtime from `tilecast://runtime/index.html` and received its
  ready report through the WebKit bridge;
- showed the pairing and idle surfaces, then a playlist with a PNG image, an
  H.264 and AAC video of 15 MB, and a WebM upload, with `image-shown` and
  `video-progress` evidence for each item;
- played the videos through `tcmedia://` range requests (`206`), without a
  gesture, unmuted at the authored volume;
- showed a Layout with a Clock Widget component, whose shadow root had six
  adopted stylesheets;
- loaded an organization font from the font library through `tcmedia://`
  for a Countdown Bar (`FontFace` status `loaded`);
- sent Activity, and the heartbeat reported `playing`, schemas 1, 2, and 3,
  no `web.remote`, and no `widget.external-runtime`;
- activated its committed Layout from local content after a restart, before
  it contacted the Server.

Known results and limits of this evidence:

- The Server transcodes a WebM upload to an H.264 and AAC playback variant,
  so the Player received H.264. VP9 and Opus playback in this renderer is not
  verified.
- The WebKit media loader requested many small ranges. Each range is a
  verified open. Performance on large media is not qualified.
- A rebuilt, ad-hoc-signed binary could not read the Keychain sealing key that
  an earlier build created, so it did not connect after its restart. The
  Keychain policy belongs to gbyo/tilecast#1929.
- The run did not terminate the web content process. Recovery after
  `webViewWebContentProcessDidTerminate` is not verified on a device.
- This evidence does not qualify an Intel Mac, a signed or sandboxed app, a
  launch at login, or a locked login Keychain.

## Remaining work

| Issue              | Work                                                            |
| ------------------ | --------------------------------------------------------------- |
| gbyo/tilecast#1928 | Final-output capture for Studio previews                        |
| gbyo/tilecast#1929 | Keychain policy, local state, and device facts review           |
| gbyo/tilecast#1930 | Kiosk window and process lifecycle; the main-thread AppKit loop |
| gbyo/tilecast#1931 | Bonjour discovery and Local Network access                      |
| gbyo/tilecast#1932 | Server, protocol contracts, and Studio support for `macos`      |
| gbyo/tilecast#1933 | Signed builds and Server-managed updates                        |
| gbyo/tilecast#1934 | Conformance, CI on macOS, and platform docs                     |
