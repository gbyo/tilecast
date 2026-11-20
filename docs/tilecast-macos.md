# Tilecast Player for macOS

**Status:** In development. The host composes Player Core, pairs, and
reconciles with a Server. It does not present content. It is not released.
Tracking issue: gbyo/tilecast#1922.

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
  range parsing, remote web surfaces, and the capture broker;
- the sealed credential and pairing-session stores;
- the release version rule (`release_version`), which runs the shared
  corpus in `packages/player-contracts/fixtures/release-versions.json`.

The crate calls no OS API and does not branch on a platform name. A
platform supplies its answers through the narrow seams in
`webview_host::host`:

| Seam            | Windows                           | macOS                                   |
| --------------- | --------------------------------- | --------------------------------------- |
| `HostIdentity`  | `tilecast-windows`, `webview2`    | `tilecast-macos`, `wkwebview`           |
| `DeviceFacts`   | Registry, monitor, and tick count | `sysctl`, `NSLocale`, and Core Graphics |
| `RendererHost`  | WebView2 on its STA thread        | Not available yet (gbyo/tilecast#1926)  |
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

## Current behavior

The host:

- pairs with the ordinary pairing protocol and enrolls once;
- verifies installation identity before it sends the credential;
- keeps a session across a restart and resumes it;
- reconciles configuration and manifests and prepares verified content;
- runs commands, Activity, and telemetry through Player Core;
- removes the credential when the Server revokes it.

The host reports truthful support:

- `RendererHost::presents` is `false`. The heartbeat reports no
  presentation schemas and no native presentation capabilities. The
  presentation task parks with `renderer_unavailable`.
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

Run the host against a Server:

```sh
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

This evidence does not qualify an Intel Mac, a signed or sandboxed app, a
launch at login, or a locked login Keychain.

## Remaining work

| Issue              | Work                                                            |
| ------------------ | --------------------------------------------------------------- |
| gbyo/tilecast#1926 | `WKWebView` renderer and Runtime bridge (`RendererHost`)        |
| gbyo/tilecast#1927 | Isolated Website and YouTube views                              |
| gbyo/tilecast#1928 | Final-output capture for Studio previews                        |
| gbyo/tilecast#1929 | Keychain policy, local state, and device facts review           |
| gbyo/tilecast#1930 | Kiosk window and process lifecycle; the main-thread AppKit loop |
| gbyo/tilecast#1931 | Bonjour discovery and Local Network access                      |
| gbyo/tilecast#1932 | Server, protocol contracts, and Studio support for `macos`      |
| gbyo/tilecast#1933 | Signed builds and Server-managed updates                        |
| gbyo/tilecast#1934 | Conformance, CI on macOS, and platform docs                     |
