# Tilecast for iOS and iPadOS

The Tilecast iOS app is a native host for Tilecast Studio. SwiftUI owns the Apple-platform shell and system integrations. The Studio React frontend, loaded from the configured server, stays the authoritative interface for Tilecast product surfaces. Shared contracts connect the two.

The app is in `apps/ios`. It targets iOS 26 and iPadOS 26 and later, uses Swift 6 with complete concurrency checking, and has no third-party dependencies.

## Architecture rules

These rules apply to every change to the app and to every Studio change that affects it. Review a native feature against them before you design it.

1. A normal Tilecast feature belongs in Studio by default.
2. Adding a Studio route must not require a Swift change. Native navigation comes from metadata that Studio provides.
3. Plugin interfaces are always Studio interfaces. A plugin author never builds iOS UI.
4. Editors stay in Studio: Layout, Playlist, Widget, Data Source, and Schedule editors.
5. Complex resource-management pages stay in Studio: Fleet, Screen detail, Media library, Campaigns, Activity, dependency tools, and administration.
6. Native UI is for app chrome, system integrations, small stable workflows that benefit from a platform API, and UI generated from a shared contract.
7. Do not copy a domain state machine into Swift only to change its appearance.
8. Never give a native OAuth token, refresh token, password, or other long-lived secret to page JavaScript.
9. Use generic bridge messages. Add a page-specific message only when a generic navigation or presentation message cannot express the task.
10. Detect features with capability negotiation, not with server or app version comparisons.
11. Browser Studio is a first-class client. Studio must work the same when no native host is present.

`apps/ios/scripts/check-architecture.sh` enforces the mechanical parts of these rules in CI. It fails when app sources name a Studio route, inject page scripts outside the bridge, add an App Transport Security exception other than `NSAllowsLocalNetworking`, or bypass certificate evaluation.

## Components

| Part                     | Location                                        | Responsibility                                                                                     |
| ------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| App target               | `apps/ios/Tilecast/`                            | SwiftUI scenes, server switching, add-server flow, connection states, localized text               |
| `TilecastCore`           | `apps/ios/TilecastKit/Sources/TilecastCore/`    | Server profiles, address policy, installation identity, WebKit storage, navigation policy, hosting |
| Core tests               | `apps/ios/TilecastKit/Tests/TilecastCoreTests/` | Swift Testing suites; run on macOS with `swift test` and on the iOS Simulator                      |
| UI tests                 | `apps/ios/TilecastUITests/`                     | Launch smoke tests that need no server                                                             |
| Build settings           | `apps/ios/Config/*.xcconfig`                    | All build settings; the project file holds none                                                    |
| CI and repository checks | `apps/ios/scripts/`                             | Simulator selection, localization parity, architecture boundaries                                  |

`TilecastCore` holds no user-visible strings, so the app target maps each Core error value to localized text.

## Servers

A server profile (`ServerProfile`) records one Tilecast installation:

- a stable local UUID that is never sent to the server;
- a display name, which defaults to the organization name;
- the normalized server address;
- the installation ID and organization name from the server identity;
- the authentication mode;
- the identifier of the server's persistent WebKit data store;
- the last Studio path, for state restoration;
- creation and last-opened times.

Profiles contain no secrets. `ServerDirectory` stores them as JSON in Application Support, excluded from backups, because each profile refers to WebKit storage on this device only. One profile exists for each installation. The app refuses to add an installation a second time under another address.

### Address policy

`ServerAddressPolicy` applies the product-wide server address floor. It runs the shared corpus in `packages/player-contracts/fixtures/server-url-policy.json`, the same corpus the Linux, Android, and Edge Players run:

- a bare host means HTTPS, and explicit ports are kept;
- only HTTP and HTTPS are accepted, and HTTPS is never downgraded;
- plain HTTP is accepted only for private IPv4, IPv4 link-local, loopback, `localhost`, and `.local` hosts;
- user information, paths, queries, and fragments are refused.

The iOS policy also accepts `http://[::1]` for simulator development. It does not accept IPv6 link-local addresses, because their zone identifiers make a stored address specific to one network interface.

### Installation identity

Before the app adds a server, and again each time it opens one, it reads `GET /api/v1/system/identity` with an ephemeral `URLSession` that shares no cookies with Studio. The document must report `product: tilecast` and API version `v1`.

The app binds each profile to the installation ID it reported when it was added. If the address later reports a different installation, the app does not load Studio, so the old installation's session cookie is not sent to it. The user can remove the profile, or accept the new installation. Acceptance deletes the old website data and gives the profile a new data store. This is the rule Players follow before they send a stored credential.

`InstallationIdentity` is the one hand-written API model in the app. It is the version-independent bootstrap document that every client reads before it knows anything else about a server. Ordinary endpoints will use a client generated from the composed OpenAPI contract when native API access starts in Milestone 3.

## Studio hosting

The app uses the iOS 26 SwiftUI WebKit API, `WebPage` and `WebView`. It does not wrap `WKWebView` in a `UIViewRepresentable`.

### One main page

`StudioHost` owns exactly one main `StudioPage`, for the active server. Native navigation must not create a page for each tab. Switching servers closes the old page before the next one is built. Studio owns routing inside the page: React Router state, unsaved-change blockers, redirects, loaders, plugin routes, and URL state.

Native code loads a URL only to start the page, to restore the last path at launch, or to recover from a failure. From Milestone 2, native navigation sends a navigation request to React Router through the bridge. It never changes the page URL for a routine route change, because that would bypass the unsaved-change blockers.

Native back and forward gestures are off, because React Router owns history. Link previews are off, because a preview loads outside the navigation policy.

### Website data isolation

Each server has its own persistent `WKWebsiteDataStore`, created with `WKWebsiteDataStore(forIdentifier:)`. Cookies, cache, local storage, IndexedDB, and service workers never cross between installations. Every page for one server uses that server's store: the main page, the auxiliary page, and the presentation page that Milestone 4 adds.

Removing a server deletes its data store. WebKit keeps the state of a live store object in memory, so the app first removes every data type from the store and then deletes the store identifier. At launch, the app deletes any store that no profile refers to, for example after the app ended between removing a profile and deleting its store.

### Navigation policy

The main frame shows only the configured server's origin (scheme, host, and port). The page holds the Studio session and, from Milestone 2, the native bridge, so a different site must never replace it.

| Request                                               | Result                                           |
| ----------------------------------------------------- | ------------------------------------------------ |
| Main frame, server origin                             | Load                                             |
| Main frame, other `http` or `https` origin            | Open in the system browser                       |
| New window (`target="_blank"`), server origin         | Open in the auxiliary page                       |
| New window, other `http` or `https` origin            | Open in the system browser                       |
| `mailto:`, `tel:`, `sms:`                             | Open with the system handler                     |
| Subframe `http`, `https`, `about`, `data`, `blob`     | Load; the Studio Content Security Policy decides |
| Download or attachment                                | Refuse and show a notice                         |
| Any other scheme, including `javascript:` and `file:` | Refuse                                           |

The auxiliary page shows a same-origin page that Studio opened in a new window, in a sheet, so the main page keeps its state. At most one auxiliary page exists. A new-window request from the auxiliary page loads in place.

### Recovery

If the web content process ends, for example while the app is in the background, the page reloads. If the process ends more than twice in 30 seconds, the app shows an error with a retry control.

## Authentication

When Studio navigates to `/login`, the app starts `ASWebAuthenticationSession` at the configured server's real origin. iOS owns the consent sheet and browser. The server's own sign-in page handles passwords, authenticator codes, recovery codes, passkeys, and enrollment policy. The app does not imitate the consent sheet.

The fixed first-party `tilecast-ios` client uses a PKCE S256 authorization code and the exact `tilecast-ios://oauth/callback` redirect. The app verifies callback state. The rate-limited `/api/v1/oauth/ios-session` endpoint consumes the code, revokes its temporary grant, and sets an ordinary HttpOnly Studio cookie. The app imports that cookie into only the configured server's isolated WebKit store, then reloads Studio. No OAuth access or refresh token is kept on the device or exposed to page JavaScript.

The app checks installation identity before it opens Studio. The cookie handoff also checks the response origin. A changed installation must be accepted explicitly, which removes the old WebKit data before another sign-in starts. First-time server setup remains in Studio until the organization creates its Owner account.

## Transport security

The app follows App Transport Security with one exception, `NSAllowsLocalNetworking`. That key permits cleartext connections to IP addresses, unqualified host names, and `.local` hosts. `ServerAddressPolicy` narrows it to the private, link-local, and loopback addresses that the shared policy allows. Cleartext to a public host name stays blocked by the system, even if the application policy were bypassed.

- HTTPS certificates are evaluated by the system. The app has no option to accept an invalid or untrusted certificate.
- A server with a certificate from a private certificate authority works after the user installs that authority's profile on the device and turns on full trust for it in Settings > General > About > Certificate Trust Settings.
- Plain HTTP is for trusted local networks only. The add-server flow shows that the connection is not encrypted before the user confirms.
- A connection to a local network address requires the Local Network privacy permission. The app declares `NSLocalNetworkUsageDescription`. When a local server cannot be reached, the error text tells the user to check that permission and opens Settings.
- Loopback addresses need no permission. They are useful in the iOS Simulator only.

## Localization

App text is in `apps/ios/Tilecast/Resources/Localizable.xcstrings`, and the local network permission text is in `InfoPlist.xcstrings`. English is the source language. Spanish and Russian ship with it, matching Studio. Translations follow the Studio terms in `apps/dashboard/src/locales/` and `docs/localization/ru-reference.json`.

`apps/ios/scripts/check-localization.py` compares the strings the compiler extracts with the catalog after a build. It fails when a key is missing a Spanish or Russian translation, or when the catalog contains an unused key.

## Milestones

| Milestone | Scope                                                                                                                          |
| --------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1         | Host foundation: server profiles, per-server WebKit storage, one main Studio page, navigation policy, server switching         |
| 2         | Versioned native bridge (`packages/native-bridge-schema`), capability handshake, navigation catalog, iPhone tabs, iPad sidebar |
| 3         | Native API access, Keychain for native credentials, sign-out and revocation                                                    |
| 4         | Native presentation: frameless Studio route, SwiftUI sheets, one reusable presentation page, fallback to web dialogs           |
| 5         | Native Pair Screen with scanning and manual code entry                                                                         |
| 6         | Settings contract version 2 with semantic metadata, consumed by Studio first                                                   |
| 7         | Native generic settings renderer, with fallback to Studio for anything it cannot render                                        |
| 8         | Media intake, Share, push notifications and deep links, haptics, screen quick actions                                          |

Everything not listed as native stays in Studio. After Milestone 8 most of the product interface, by surface area, is still Studio.

## Known limitations in Milestone 1

- Studio opens the Layout and Playlist previews with `window.open`. `WebPage` has no new-window hook, so these previews do not open in the app. Milestone 4 presentation replaces them.
- Downloads, such as settings export, are refused with a notice. `WebPage` has no download delegate.
- Studio keeps its own navigation, including the mobile sidebar, until native navigation arrives in Milestone 2. The native bar shows the server switcher above the Studio top bar.
- The app has one window. iPad multiple windows will return when each scene can own a server safely.
- Passkey sign-in uses the system authentication browser. See [Authentication](#authentication).

## Build and test

See `apps/ios/README.md` for commands. CI runs the `ios_ci` job in `.github/workflows/ci-ios.yml` on `macos-26` when a pull request changes `apps/ios/` or the shared server address corpus. A Studio or server change does not build the app, because the app loads Studio from the server at runtime. `scripts/ci/affected.mjs` records these edges; add one when the app starts to compile or test against another contract, such as the bridge schema, the OpenAPI contract, or the settings schema.
