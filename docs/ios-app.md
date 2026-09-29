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

`apps/ios/scripts/check-architecture.sh` enforces the mechanical parts of these rules in CI. It fails when app sources:

- name a Studio route or a Studio navigation destination;
- use a WebKit script message handler, a user content controller, or `callJavaScript` outside `TilecastCore/Bridge/`;
- inject a user script, call `evaluateJavaScript`, or register a message handler that does not reply;
- run any script other than the static bridge receiver script;
- reach the Keychain, cookies, files, or the network from the bridge;
- add an App Transport Security exception other than `NSAllowsLocalNetworking`;
- bypass certificate evaluation.

Tests can use Studio paths and destination identifiers as data.

## Components

| Part                     | Location                                                | Responsibility                                                                                                |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| App target               | `apps/ios/Tilecast/`                                    | SwiftUI scenes, native tabs and sidebar, server switching, add-server flow, connection states, localized text |
| `TilecastCore`           | `apps/ios/TilecastKit/Sources/TilecastCore/`            | Server profiles, address policy, installation identity, WebKit storage, navigation policy, hosting            |
| Native bridge            | `apps/ios/TilecastKit/Sources/TilecastCore/Bridge/`     | The only code that handles page scripting: the message handler, protocol validation, and the receiver call    |
| Native navigation model  | `apps/ios/TilecastKit/Sources/TilecastCore/Navigation/` | The navigation catalog, selection that follows Studio, and icon tokens                                        |
| Bridge contract          | `packages/native-bridge-schema/`                        | The language-neutral protocol, icon tokens, and the shared fixtures that Studio and the app run               |
| Studio native host       | `apps/dashboard/src/native-host/`                       | Studio's side of the bridge: detection, capability negotiation, catalog, state, and requests                  |
| Core tests               | `apps/ios/TilecastKit/Tests/TilecastCoreTests/`         | Swift Testing suites; run on macOS with `swift test` and on the iOS Simulator                                 |
| UI tests                 | `apps/ios/TilecastUITests/`                             | Smoke tests against a loopback fixture server; no network access                                              |
| Build settings           | `apps/ios/Config/*.xcconfig`                            | All build settings; the project file holds none                                                               |
| CI and repository checks | `apps/ios/scripts/`                                     | Simulator selection, localization parity, architecture boundaries                                             |

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

Native code loads a URL only to start the page, to restore the last path at launch, or to recover from a failure. Native navigation sends a navigation request to Studio through the bridge, and React Router performs it. Native code never changes the page URL for a routine route change, because that would bypass the unsaved-change blockers.

The same `StudioPage` and `WebPage` stay in use while the user moves between native tabs, More, and sidebar rows. A destination change does not reload the page.

A `WebPage` can have only one `WebView`. SwiftUI can build a new view before it removes an old view, for example when the selected tab changes. The app therefore creates one `WebView` for the page and never moves it. Each layout marks the area for Studio with a `StudioSlotView`: the fallback content area, the selected tab, the More tab, or the split view detail. `StudioOverlay` places the one web view over the active area. While the More list covers Studio, the web view stays in place but is hidden.

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

The auxiliary page shows a same-origin page that Studio opened in a new window, in a sheet, so the main page keeps its state. At most one auxiliary page exists. A new-window request from the auxiliary page loads in place. The auxiliary page has its own WebKit configuration, so it does not get the native bridge.

### Recovery

If the web content process ends, for example while the app is in the background, the page reloads. If the process ends more than twice in 30 seconds, the app shows an error with a retry control.

## Native bridge

The native bridge is a small, versioned protocol between Studio and the app. `packages/native-bridge-schema` is the contract. It contains JSON only: `schema-v1.json`, `icon-tokens.json`, and `fixtures/messages-v1.json`. The TypeScript and Swift implementations both run the shared fixtures, so neither implementation is the normative protocol.

### Transport

- Studio calls the one script message handler, `tilecastNative`, with `window.webkit.messageHandlers.tilecastNative.postMessage(message)`. The handler is a `WKScriptMessageHandlerWithReply`, so every message gets one reply.
- The app registers the handler through `WebPage.Configuration.userContentController`. It injects no user script.
- The app sends a message to Studio with `WebPage.callJavaScript`. The function body is static. It calls `window.tilecastNativeReceiver(message)` and passes the message as an argument. The app never builds script source from message content.
- All of this code is in `TilecastCore/Bridge/`. The architecture check fails when page scripting occurs anywhere else.

### Security

The bridge is privileged. The app applies these rules:

- Only the main Studio page has the handler. The auxiliary page has a different configuration without it.
- The bridge refuses a message from a subframe, from a content world other than the page world, and from any origin other than the configured server origin. The refusal is a `forbidden` reply.
- The bridge validates the envelope and the payload before it dispatches a message. An unknown message type gets an `unknown_type` reply. A malformed message gets a `malformed` reply. Another protocol version gets an `unsupported_version` reply.
- The user content controller holds the handler. The handler holds the bridge weakly, so the page and the bridge do not keep each other alive. Closing the page removes the handler and clears the navigation state.
- The bridge carries presentation and navigation data only. It never carries a password, an OAuth token, a refresh token, a session cookie, a Keychain value, or a CSRF token. It has no file access.

### Version 1 messages

| Type                 | Direction        | Purpose                                                                       |
| -------------------- | ---------------- | ----------------------------------------------------------------------------- |
| `config/get`         | Studio to native | Studio asks for the protocol version and capabilities                         |
| `frontend/ready`     | Studio to native | Studio finished its host integration. The app accepts it more than one time   |
| `navigation/catalog` | Studio to native | A complete snapshot of navigation destinations that replaces the previous one |
| `navigation/state`   | Studio to native | The destination that Studio resolved for its current location, and the path   |
| `navigation/request` | native to Studio | The app asks Studio to open a destination by its opaque identifier            |

The `config/get` reply reports `protocolVersion: 1` and `capabilities.nativeNavigation: true`. Studio detects the app by the exact `tilecastNative` handler and this reply. It does not read the user agent, and it does not compare server or app versions. A browser has no such handler, so Studio sends nothing in a browser.

Presentation messages for Milestone 4 will be new message types in the same protocol. Version 1 does not define them.

### Document changes

Each document negotiates with `config/get`. When a main-frame navigation commits a new document that did not negotiate, the app clears the previous document's navigation. An older Studio without the bridge therefore gets the fallback chrome.

## Native navigation

Studio navigation metadata is the source of truth. Swift renders an opaque catalog and never owns Tilecast's route list.

### Studio's navigation model

A Studio route that is a navigation destination has a `navigation` entry in its route handle (`StudioNavigationMetadata` in `apps/dashboard/src/navigation/studioNavigation.tsx`):

- `id`: a stable, opaque destination identifier;
- `group`: one of Studio's semantic groups: `home`, `screens`, `content`, `presentations`, `operations`, or `secondary`;
- `labelKey`: the translation key of the label;
- `icon`: a semantic icon token;
- `order`: the position in the group;
- `mobilePlacement`: `primary` or `more`, with `more` as the default;
- `end` and `excludeActiveOn`: matching details that only Studio uses.

The destination path is the route's own path in the route tree. No other list of destinations exists. Studio resolves the model one time: core route metadata, plugin secondary navigation after each plugin's own visibility query, and localized labels. The browser sidebar and the native catalog both use this resolved model.

Studio also resolves the active destination. It uses the longest matching destination path and applies the exact-match and exclusion rules. For example, `/screens/<id>` belongs to the Screens destination, and `/screens/archive` belongs to no destination. The app receives only the destination identifier.

### Catalog and state

When the app negotiated `nativeNavigation`, Studio sends the catalog from its authenticated chrome. Labels and group titles are already localized. A language change sends a new catalog. When Studio leaves its authenticated chrome, for example after sign-out, it sends an empty catalog. An empty catalog means that native navigation is not available now.

Studio sends `navigation/state` when the location or the active destination changes. `activeDestinationId` is authoritative. It is `null` when the location belongs to no destination, for example My Account. `path` is the location path without its query string. It is for diagnostics only. The app does not derive a selection from it.

### Navigation requests

A native tap never loads a URL. The sequence is:

1. The app sends `navigation/request` with the destination identifier.
2. Studio finds the identifier in its current model. If the identifier is not there, Studio refuses the request and sends its catalog and state again.
3. Studio calls React Router's `navigate`.
4. An unsaved-changes blocker can stop the navigation. The user decides in Studio's own dialog.
5. Studio sends `navigation/state`. It sends the state also when the location did not change.
6. The app moves its selection only when that state names a different destination.

The app does not change the selection when the user taps. If the user cancels an unsaved-changes dialog, the selection stays with the current page, and the editor keeps its state. Before a request, the app makes sure that the Studio page is visible, so the user can see a dialog.

Forms plugin editors use `useBlocker`. The Settings and Preferences leave warnings use `useNavigationWarning`, which also uses `useBlocker` for navigation that does not start from a link. The Layout and Playlist editors save automatically and do not block navigation.

### iPhone

The app uses a SwiftUI `TabView`:

- The first destinations that Studio marks `primary` become tabs, up to four. Studio marks Overview, Fleet, and Media as `primary`.
- The last tab is the app's own More tab.
- The first tap on More shows a grouped list of every other destination, in Studio's groups, and the server controls: server switching, Add Server, Manage Servers, and Reload.
- A destination in the list opens in the same Studio page, inside the More tab. More stays selected while a More destination is open.
- A tap on More while More is selected shows the list again.

Studio keeps its own topbar with breadcrumbs, search, notifications, and editor controls. It hides its sidebar and the sidebar button, and it shows the account menu in the topbar. The app shows no navigation bar above Studio while native navigation is active.

### iPad

On an iPad in regular width, the app uses a `NavigationSplitView`. The sidebar shows the server menu at the top, then every catalog group in order, with the secondary group last. The detail column is the same Studio page. An iPad window in compact width uses the iPhone tabs.

### Fallback

Native navigation is progressive enhancement. The app keeps its fallback chrome from Milestone 1 when Studio sends no catalog: on the sign-in and setup pages, with an older Studio, and after a bridge failure. The fallback chrome has the server switcher above the page, and Studio shows its own sidebar.

Studio also falls back by itself. If negotiation fails, times out, or reports no `nativeNavigation`, or if the app refuses the catalog, Studio shows its sidebar exactly as a browser does.

### Icons

`icon` is advisory. The app shows the same Lucide icon for each token as the Studio sidebar. Any other token gets Studio's generic icon. A new Studio destination can use a new token without an app release.

`apps/ios/scripts/generate-navigation-icons.mjs` generates the icons from Studio. It reads the token mapping in `apps/dashboard/src/navigation/NavigationIcon.tsx` and the icon geometry from the `lucide-react` version in `package-lock.json`. It writes these files:

- one vector template image for each icon in `apps/ios/Tilecast/Resources/Assets.xcassets/Lucide/`;
- the token-to-asset map in `TilecastCore/Navigation/NavigationIconImages.gen.swift`;
- `Tilecast/App/AppIcon.gen.swift`, the icons for the app's own navigation controls, such as More, the server list, and Reload.

Do not edit these files. After you change the Studio mapping or update `lucide-react`, run `npm run ios:icons:generate`. `make generated-check` fails when the files are out of date. The Lucide ISC license ships in the app bundle in `Resources/Licenses/`.

Tabs, the More list, the iPad sidebar, and the server menus use these icons. Other native views, such as connection errors, keep SF Symbols.

### Plugins

Plugin pages are always Studio pages. A plugin page below `/plugins/` opens in the Studio page with no Swift change. A plugin secondary-navigation item appears in the native catalog after the same visibility rules that the browser sidebar uses. Its destination identifier is `plugin:<plugin id>:<item id>`. An item can name an `iconToken`; without one, the app shows its generic plugin icon. A plugin never writes Swift, and the app has no plugin API.

### Adding a destination

To add a destination, add a Studio route with `navigation` metadata and a localized label. Do not change `apps/ios`. After the server updates, the installed app receives the new catalog. On an iPad, the destination appears in its sidebar group. On an iPhone, it appears in More unless its metadata says `primary`. A tap sends only its identifier, and Studio renders its React page in the same Studio page.

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

## Typography

Native chrome uses Geist, the Studio typeface, so that the app and the Studio page look like one interface. Studio uses monospaced text in the system monospaced font, so native monospaced text also stays in the system font.

- The app bundles the Geist variable fonts from the [Geist project](https://github.com/vercel/geist-font), version 1.7.2, in `apps/ios/Tilecast/Resources/Fonts/`. `Info.plist` registers them in `UIAppFonts`. The SIL Open Font License, `Resources/Licenses/Geist-OFL.txt`, ships in the bundle with the fonts.
- `Font.geist(_:)` in `apps/ios/Tilecast/App/Typography.swift` gives Geist at the size of a system text style. The size follows Dynamic Type. `.headline` is semibold, as in the system style.
- The app root sets `.geist(.body)` as the default font. A view that sets a font must use `Font.geist(_:)`, not a system text style such as `.footnote`.
- Section headers, section footers, and `ContentUnavailableView` titles set their own font, so each one sets `Font.geist(_:)` explicitly.
- `Typography.applyAppearance()` sets Geist on UIKit chrome that the SwiftUI font environment does not reach: navigation bar titles, bar buttons, tab bar items, segmented controls, and search fields. For navigation bars, it changes only the font attributes. The iOS 26 tab bar reads item fonts only from a `UITabBarAppearance`, so the app sets a default tab bar appearance with Geist item titles.
- Alerts, confirmation dialogs, menus, context menus, and swipe actions use the system font. iOS does not let an app change their font.

## Localization

App text is in `apps/ios/Tilecast/Resources/Localizable.xcstrings`, and the local network permission text is in `InfoPlist.xcstrings`. English is the source language. Spanish and Russian ship with it, matching Studio. Translations follow the Studio terms in `apps/dashboard/src/locales/` and `docs/localization/ru-reference.json`.

`apps/ios/scripts/check-localization.py` compares the strings the compiler extracts with the catalog after a build. It fails when a key is missing a Spanish or Russian translation, or when the catalog contains an unused key.

## Milestones

| Milestone | Scope                                                                                                                                       |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Host foundation: server profiles, per-server WebKit storage, one main Studio page, navigation policy, server switching                      |
| 2         | Implemented: versioned native bridge (`packages/native-bridge-schema`), capability handshake, navigation catalog, iPhone tabs, iPad sidebar |
| 3         | Native API access, Keychain for native credentials, sign-out and revocation                                                                 |
| 4         | Native presentation: frameless Studio route, SwiftUI sheets, one reusable presentation page, fallback to web dialogs                        |
| 5         | Native Pair Screen with scanning and manual code entry                                                                                      |
| 6         | Settings contract version 2 with semantic metadata, consumed by Studio first                                                                |
| 7         | Native generic settings renderer, with fallback to Studio for anything it cannot render                                                     |
| 8         | Media intake, Share, push notifications and deep links, haptics, screen quick actions                                                       |

Everything not listed as native stays in Studio. After Milestone 8 most of the product interface, by surface area, is still Studio.

## Known limitations after Milestone 2

- Studio opens the Layout and Playlist previews with `window.open`. `WebPage` has no new-window hook, so these previews do not open in the app. Milestone 4 presentation replaces them.
- Downloads, such as settings export, are refused with a notice. `WebPage` has no download delegate.
- The app has one window. iPad multiple windows will return when each scene can own a server safely.
- Passkey sign-in uses the system authentication browser. See [Authentication](#authentication).
- Native sheets and the presentation protocol are not part of Milestone 2.
- The Studio topbar stays a Studio component. This is intentional: breadcrumbs, search, notifications, and editor controls remain Studio features.

## Build and test

See `apps/ios/README.md` for commands. CI runs the `ios_ci` job in `.github/workflows/ci-ios.yml` on `macos-26` when a pull request changes `apps/ios/`, `packages/native-bridge-schema/`, or the shared server address corpus. A change to the bridge schema also runs the dashboard checks, because Studio tests run the same fixtures. An ordinary Studio or server change does not build the app, because the app loads Studio from the server at runtime. This includes Studio's own bridge code in `apps/dashboard/src/native-host/`, which the dashboard tests cover. `scripts/ci/affected.mjs` records these edges. Add one when the app starts to compile or test against another contract, such as the OpenAPI contract or the settings schema.
