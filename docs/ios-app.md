# Tilecast for iOS and iPadOS

The Tilecast iOS app is a native host for Tilecast Studio. SwiftUI owns the Apple-platform shell and system integrations. The Studio React frontend, loaded from the configured server, stays the authoritative interface for Tilecast product surfaces. Shared contracts connect the two.

The app is in `apps/ios`. It targets iOS 26 and iPadOS 26 and later, uses Swift 6 with complete concurrency checking. Its only package dependencies are Apple's Swift OpenAPI Generator, OpenAPI Runtime, OpenAPI URLSession transport, and HTTP Types.

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
- bypass certificate evaluation;
- read the Photos library or ask for its permission;
- give native media intake an HTTP client of its own, or let it reach a web page, a cookie, the Keychain, or an authorization header;
- create a custom haptic pattern, or present a share sheet outside `SystemSharePresenter`;
- claim associated domains, because Tilecast installations use unrelated domains.

Tests can use Studio paths and destination identifiers as data.

## Components

| Part                     | Location                                                | Responsibility                                                                                                |
| ------------------------ | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| App target               | `apps/ios/Tilecast/`                                    | SwiftUI scenes, native tabs and sidebar, server switching, add-server flow, connection states, localized text |
| `TilecastCore`           | `apps/ios/TilecastKit/Sources/TilecastCore/`            | Server profiles, address policy, installation identity, WebKit storage, navigation policy, hosting            |
| Native authentication    | `apps/ios/TilecastKit/Sources/TilecastCore/Auth/`       | Sign-in callback checks, the iOS session client, the credential store, `NativeAuthSession`, bearer transport  |
| `TilecastAPI`            | `apps/ios/TilecastKit/Sources/TilecastAPI/`             | The API client, generated at build time from `docs/openapi.yaml`. It contains no hand-written code            |
| Native bridge            | `apps/ios/TilecastKit/Sources/TilecastCore/Bridge/`     | The only code that handles page scripting: the message handler, protocol validation, and the receiver call    |
| Native navigation model  | `apps/ios/TilecastKit/Sources/TilecastCore/Navigation/` | The navigation catalog, selection that follows Studio, and icon tokens                                        |
| Deep links               | `apps/ios/TilecastKit/Sources/TilecastCore/DeepLinks/`  | The `tilecast-ios://open` URL, its path rules, and the resolver that `StudioHost` runs                        |
| Media intake             | `apps/ios/TilecastKit/Sources/TilecastCore/Media/`      | Temporary staging, the resumable uploader, and the intake coordinator. It has no user interface               |
| System integrations      | `apps/ios/Tilecast/Features/System/`, `Features/Media/` | Semantic haptics, the share adapter, the deep-link notice, and the media pickers and progress sheet           |
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

`InstallationIdentity` is the one hand-written API model in the app. It is the version-independent bootstrap document that every client reads before it knows anything else about a server. All other endpoints use the generated client. See [Generated API client](#generated-api-client).

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

### File chooser

A `WebPage` with no dialog presenter cancels every file chooser, so a Studio upload button would do nothing. The app gives each Studio page a `StudioDialogPresenter` (`WebPage.DialogPresenting`) that answers `<input type="file">` only. WebKit exposes only whether the input allows multiple files, so the app cannot read the accepted types.

- Only a frame of the server's own origin can open a chooser.
- `SystemFileInputPicker` shows an action sheet with **Photo Library** and **Choose Files…**. The Photos picker (`PHPickerViewController`) runs out of process and needs no Photos permission. The document picker returns copies in temporary space.
- WebKit gives the page access to exactly the chosen files. Studio uploads them with its own uploader, as in a browser, so this path needs no native credential.
- JavaScript alerts, confirmations, and prompts keep WebKit's defaults.

Native media intake is a separate path. When the app has a native credential, Studio asks the app to upload, and no file goes through the page.

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
- The bridge carries presentation data, navigation data, credential-free sign-out coordination, and the small requests and results of the system integrations only. It never carries a password, an OAuth token, a refresh token, a session cookie, a Keychain value, or a CSRF token. It has no file access.

### Version 1 messages

| Type                            | Direction        | Purpose                                                                          |
| ------------------------------- | ---------------- | -------------------------------------------------------------------------------- |
| `config/get`                    | Studio to native | Studio asks for the protocol version and capabilities                            |
| `frontend/ready`                | Studio to native | Studio finished its host integration. The app accepts it more than one time      |
| `navigation/catalog`            | Studio to native | A complete snapshot of navigation destinations that replaces the previous one    |
| `navigation/state`              | Studio to native | The destination that Studio resolved for its current location, and the path      |
| `navigation/request`            | native to Studio | The app asks Studio to open a destination by its opaque identifier               |
| `navigation/chrome`             | Studio to native | Main page only. The page title and, for a drill-in page, the name of its parent  |
| `navigation/back`               | native to Studio | Main page only. The user tapped the native back button. The payload is empty     |
| `auth/sign-out-request`         | native to Studio | The app asks Studio to sign out with its normal logout                           |
| `auth/signed-out`               | Studio to native | Studio completed its logout. The payload is empty                                |
| `presentation/open`             | Studio to native | Main page only. Ask for a native presentation of a `/__native/modal` route       |
| `presentation/ready`            | Studio to native | Presentation page only. Its Studio is signed in and receives presentations       |
| `presentation/update`           | Studio to native | Presentation page only. A new header snapshot, size, or dismissibility           |
| `presentation/close`            | Studio to native | Presentation page only. Dismiss the presentation                                 |
| `presentation/navigate`         | Studio to native | Presentation page only. Dismiss, then navigate the main page to a Studio path    |
| `presentation/show`             | native to Studio | Presentation page only. Show this route for this presentation, without a load    |
| `presentation/action`           | native to Studio | Presentation page only. The user chose a header action                           |
| `presentation/dismissed`        | native to Studio | Presentation page only. The sheet went away                                      |
| `presentation/ended`            | native to Studio | Main page only. A presentation ended, so Studio refetches its active queries     |
| `navigation/open-path`          | native to Studio | Main page only. A presentation or a deep link asked Studio to navigate to a path |
| `alert/present`                 | Studio to native | Either page. Show a native alert with one to three buttons                       |
| `alert/cancel`                  | Studio to native | Either page. Withdraw an alert that the page presented                           |
| `alert/action`                  | native to Studio | Either page. The user chose a button of an alert that the page presented         |
| `system/haptic`                 | Studio to native | Either page. Standard system feedback for a semantic type                        |
| `system/share`                  | Studio to native | Either page. The system share sheet for user-visible content                     |
| `system/media-intake-status`    | Studio to native | Main page only. Whether the app can start media intake now                       |
| `system/media-intake`           | Studio to native | Main page only. Choose media with system pickers and upload it                   |
| `system/media-intake-completed` | native to Studio | Main page only. A small result: request identifier, outcome, and count           |

The `config/get` reply reports `protocolVersion: 1`, `capabilities.nativeNavigation: true`, and `capabilities.authLifecycle: true`. Studio reports its own capabilities in the `frontend/ready` payload, as `capabilities.authLifecycle: true`. The app sends `auth/sign-out-request` only to a Studio that reported this capability. Studio sends `auth/signed-out` only to an app that offered it. Studio detects the app by the exact `tilecastNative` handler and this reply. It does not read the user agent, and it does not compare server or app versions. A browser has no such handler, so Studio sends nothing in a browser.

Milestone 4 adds the presentation messages to version 1. They are additive, and both sides use them only after capability negotiation. See [Native presentations](#native-presentations).

Milestone 8A adds the `system/*` messages and four host capabilities. They are additive too: each one is negotiated on its own, so version 1 stays the only version. See [System integrations](#system-integrations).

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

### Drill-in pages

A page such as a screen's detail, or a Layout in the editor, is a drill-in from a list page. Studio already draws a breadcrumb trail for it. Studio sends that trail as `navigation/chrome`: the last item is the title, and the item before it is the page that back leads to. When the message has a `back`, the app shows a native navigation bar with a system back button that has the parent's name, and the title. A top-level page gets no bar.

The back button sends `navigation/back` with no path. Studio navigates to the previous item of its trail with React Router, so an unsaved-changes prompt still appears. The app never learns a path or a route name. While the app shows the trail, Studio leaves its own breadcrumbs out of the topbar. A host that answers `unknown_type` to `navigation/chrome` keeps them.

No page needs code for this. The trail comes from the route metadata that Studio already has, so a new page with a breadcrumb gets the bar. The bar has no swipe-back gesture yet: the web view has no back stack of its own, and the gesture would have to call `navigation/back`.

### iPhone

The app uses a SwiftUI `TabView`:

- The first destinations that Studio marks `primary` become tabs, up to four. Studio marks Overview, Fleet, and Media as `primary`.
- The last tab is the app's own More tab.
- The first tap on More shows a grouped list of every other destination, in Studio's groups, and the server controls: server switching, Add Server, Manage Servers, and Reload.
- A destination in the list opens in the same Studio page, inside the More tab. More stays selected while a More destination is open.
- A tap on More while More is selected shows the list again.

Studio keeps its own topbar with breadcrumbs, search, notifications, and editor controls. It hides its sidebar and the sidebar button, and it shows the account menu in the topbar. The app shows no navigation bar above Studio while native navigation is active.

#### Studio beneath the tab bar

The iOS 26 tab bar floats over its content. Studio must be the content that shows through the glass, so the tab bar does not show an empty strip.

The one Studio web view is a sibling of the shell in `StudioShell`, and it is not a child of any layout. Its layer order depends on the layout:

- In every layout but the tabs, the web view is above the shell. `StudioOverlay` places it over the active slot.
- In the compact tab layout, the web view is behind the shell. The `TabView` and its navigation containers are transparent (`containerBackground(.clear, for: .navigation)`), so the page shows through them and the tab bar is drawn above the page. The More tab shows either the More list or Studio, because the list is opaque.
- `StudioShell` changes only `zIndex`, so the web view is not rebuilt and no second `WebView` exists.
- `StudioSlotView(extendsBelowTabBar: true)` measures the frame of the tab content and the bottom inset that the tab bar causes, and adds the inset to the frame. `StudioOverlay` applies the same inset with `safeAreaPadding(.bottom, _)`, so content scrolls under the bar and stops above it.

`TransparentTabContainer` is the one UIKit adapter for this. `TabView` is a `UITabBarController`, and its container views paint an opaque background that SwiftUI cannot remove. The adapter finds the controller from inside a tab and clears the background color of its container views, never the tab bar. The container views also swallow touches where they are transparent. The adapter gives the controller's view, for that one instance, a runtime subclass with a `hitTest`, and it does the same for each wrapper view that SwiftUI puts around the controller. While Studio shows, the `hitTest` keeps only hits on the tab bar and the navigation bar, so every other touch reaches the web view behind. While the More list shows, it changes nothing. The layering is not verified on a device or a simulator. If Studio is blank in the tabs, a container still paints an opaque background, and the web view must go back above the shell. The regular-width iPad sidebar and the fallback chrome keep the web view above the shell.

The app does not minimize the tab bar while the page scrolls. A `WebView` does not take part in the tab bar's scroll tracking.

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

## Native presentations

Studio owns the content. SwiftUI owns the presentation. A supported Studio surface can show in a native SwiftUI sheet with native chrome, and Studio renders everything inside it. The surfaces are Live Stream, the Layout preview, the Playlist preview, media asset details, incident details in Activity, and the update deployment status. A browser keeps its own popup, Sheet, or Drawer. The Layout editor saves the draft first, then opens the sheet, as it does for the popup. The decision record is [ADR: two WebPages, one data store](adr/ios-native-presentations.md).

### Two pages, one data store

The app has two privileged pages for the active server. Both use the server's persistent `WKWebsiteDataStore`, so both have the same HttpOnly Studio session cookie:

- the main Studio page;
- one reusable presentation page, `PresentationPage`, with a new `WebPage.Configuration`, the same navigation policy, and its own bridge.

Each bridge has a context, which the `config/get` reply reports as `context`:

| Context        | Accepts                                                                                                                                       |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `main`         | Navigation catalog and state, the auth lifecycle, `presentation/open`, media intake, and the shared `system/haptic` and `system/share`        |
| `presentation` | `presentation/ready`, `presentation/update`, `presentation/close`, `presentation/navigate`, and the shared `system/haptic` and `system/share` |

A message from the other context gets a `forbidden` reply. The presentation page cannot publish the navigation catalog, the app never asks it to sign out, and it never receives an OAuth token. The auxiliary page has no bridge. It shows any same-origin page that Studio opens in a new window, so it must not get a privileged bridge.

### Capability negotiation

The app reports `capabilities.nativePresentations: true`. Studio reports the same capability in `frontend/ready`. Studio sends `presentation/open` only to a main page whose host offers the capability. The app prewarms, shows, and relays only for a Studio that reported it. An older app does not offer the capability, so Studio shows its own dialogs. An older Studio does not report it, so the app makes no presentation page.

### The reserved route

Presentation routes are below `/__native/modal`, outside the Studio dashboard shell. They have no sidebar, topbar, breadcrumbs, or navigation catalog, but they have the normal providers and the signed-in session. They have no navigation or search metadata. Outside a presentation page, the root redirects to `/`.

The app knows only the root. Studio owns every child route, for example `/__native/modal/live-stream/:screenId`, so a new presentation needs no Swift change. `scripts/check-architecture.sh` fails when app sources name a child route.

Both sides validate paths. `presentation/open` and `presentation/show` accept only a relative same-origin path in the tree. `presentation/navigate` accepts only an ordinary same-origin Studio path outside `/__native`. Both refuse other origins, `//host`, schemes, backslashes, whitespace, control characters, and dot segments.

### Lifecycle

1. After signed-in Studio in the main page negotiates presentations and sends its catalog, the app prewarms the presentation page at `/__native/modal`. App launch and the main page do not wait for it.
2. Studio sends `presentation/open` with a new opaque presentation id, the route, a localized title, and a size. The app accepts one presentation at a time. When the app refuses, Studio shows its web dialog.
3. The sheet opens immediately with the title and a native loader. When the page is ready, the app sends `presentation/show`. Studio routes to the child with React Router and keys it with the presentation id. The app never loads a presentation route.
4. The page sends `presentation/update` with complete header snapshots. The app ignores messages for an id that is not active.
5. When the sheet goes away for any reason, the app sends `presentation/dismissed`. Studio goes back to the empty root. This removes the content and stops transient work, for example a live stream lease.
6. The presentation page has its own query cache, so a change that a presentation saved is stale in the main page. When any presentation ends, the app sends `presentation/ended` to the main page, if that page negotiated presentations. Studio refetches its active queries. This is generic: the app does not know what the presentation changed.
7. `presentation/navigate` dismisses the sheet. The app then relays the path with `navigation/open-path`, and the React Router of the main page navigates, so unsaved-change blockers apply. The app never loads a URL in the main page for it.

The app keeps the page for the next presentation. On a memory warning, the app discards the page when no sheet shows it. These also discard it: a server switch or removal, a changed installation, sign-out, and a new main document that did not negotiate. If its content process stops while the page is hidden, the app discards it. If the page is visible, the sheet shows an error with Try Again, which rebuilds only the presentation page.

### The sheet

`PresentationSheet` is a SwiftUI `.sheet` with a `NavigationStack`, a `WebView` of the presentation page, and a native toolbar: close or back, the title and subtitle, icon actions, and an overflow menu. All of it comes from the Studio descriptor. Action ids are opaque, and an unknown icon token shows the generic icon.

- `compact` uses the medium and large detents with a drag indicator, and `.form` sizing on iPad.
- `full` uses the large detent, and `.page` sizing on iPad. Any other size is `full`.
- `dismissible: false` disables interactive dismissal.

A dialog that Studio opens in a presentation shows in the presentation page. The Studio dialog primitives make the sheet grow to `full`, and it stays full. Milestone 4 has no stacked native presentations. A new-window request from the presentation page is refused.

### Adding a presentation

Add a child route to `presentationRoutes` in `apps/dashboard/src/App.tsx`. Open it with `useOpenNativePresentation()` from `apps/dashboard/src/native-presentation/`, and show the web dialog when it returns `false`. Describe the chrome with `usePresentationChrome()`. Use `useNativePresentation()` to close or to navigate. Do not change `apps/ios`.

### Alerts

A confirmation must match the platform, so Studio can ask the app to show a native alert. The alert is not a presentation: it has no route, and it can show over the main page or over a presentation sheet.

1. Studio sends `alert/present` with a new opaque alert id, a localized title, an optional localized message, and one to three buttons. Each button has an opaque id, a localized label, and a role: `default`, `cancel`, or `destructive`. An unknown role is a default button.
2. The app accepts one alert at a time. It replies `unavailable` when another alert shows, when Studio did not report `nativeAlerts`, or for a page that has no bridge. Studio then shows its own dialog, as in a browser.
3. When the user chooses a button, the app sends `alert/action` with the alert id and the button id to the page that asked. Studio ignores an alert id that it does not know.
4. An alert belongs to its page. A new document withdraws the alert of the main page. A presentation that ends withdraws the alert of the presentation page. Studio can also send `alert/cancel`, for example when the component that asked went away.

`useConfirm` in Studio uses this path, so all its call sites, and the plugins that use it, get a native alert with no change. A request whose body is not plain text uses the web dialog. A confirmation written as its own `AlertDialog` is a web dialog on iOS until it moves to `useConfirm`. The media library and the media asset sheet have moved. The app shows the text that Studio sends. It has no copy of its own for any confirmation.

### Which surfaces move to a sheet

A surface is a good fit when Studio can open it by an identifier, and when the page under it does not hold unsaved state that the surface must edit. The port is mostly on the app side: the sheet, the sizing, the lifecycle, and the refetch when a sheet ends are all generic. Each surface adds only a Studio route and one call where it opens.

| Surface                                             | Status | Notes                                                                                              |
| --------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------- |
| Live Stream                                         | Done   | `/__native/modal/live-stream/:screenId`                                                            |
| Layout preview                                      | Done   | Saves the draft first. Replaces a popup, which the app cannot open                                 |
| Playlist preview                                    | Done   | Replaces a popup, which the app cannot open                                                        |
| Media asset details                                 | Done   | `/__native/modal/asset/:id`. Widgets, websites, and archived assets stay in Studio                 |
| Activity incident details                           | Done   | `/__native/modal/activity-incident/:id`. Actions close the sheet, as they close the Drawer         |
| Activity proof-of-play record details               | Stay   | The API has no read by identifier, and the bridge must not carry the record. Add the read first    |
| Update deployment status                            | Done   | `/__native/modal/update-deployment/:id`. Polls, retries, and cancels as the Drawer does            |
| Confirmations (`useConfirm`, 13 call sites)         | Done   | Not a presentation. Native alerts, through `alert/present`                                         |
| Playlist item inspector and Playlist details drawer | Stay   | They edit unsaved editor state in the page beneath. A separate document cannot share that state    |
| Create and edit forms                               | Stay   | Low value, and most save into page state                                                           |
| Pair Screen                                         | Stay   | Milestone 5 makes it native for camera scanning. It is not a presentation port                     |
| Security, plugin pages, content pickers, settings   | Stay   | Secrets are shown once, plugins are not known to the app, and pickers and settings hold page state |

A surface that saves data needs no code for the main page. When any sheet ends, the app sends `presentation/ended`, and Studio refetches its active queries.

## System integrations

Milestone 8A adds four system integrations. Each one uses the system's own interface, and Studio decides when to use it. None of them moves a Tilecast product surface out of Studio.

Each integration is a separate capability in the `config/get` reply, so an older app and an older Studio keep working. A capability that is absent or not `true` is unavailable. A browser has no host: Studio sends nothing and keeps its web behavior.

| Capability          | Pages              | Studio reports in `frontend/ready` | Purpose                                                       |
| ------------------- | ------------------ | ---------------------------------- | ------------------------------------------------------------- |
| `systemHaptics`     | main, presentation | not needed                         | Standard system feedback for a semantic type                  |
| `systemShare`       | main, presentation | not needed                         | The system share sheet                                        |
| `nativeMediaIntake` | main               | `nativeMediaIntake`                | System pickers and a native upload. Studio handles the result |
| `deepLinks`         | main               | `deepLinks`                        | The app delivers a validated path from a deep link            |

No credential, cookie, CSRF token, Keychain value, file byte, or OAuth token crosses the bridge in either direction.

### Semantic haptics

`system/haptic` carries one value, `feedback`. The vocabulary is `selection`, `success`, `warning`, `error`, `start`, and `stop`. Studio names the meaning of a state change that it already knows about. The app maps the meaning onto SwiftUI `SensoryFeedback` with `sensoryFeedback(trigger:_:)`, so the effect follows the device and the person's settings.

- There is no custom vibration pattern. There is no message for one page, for example a message for one publish action.
- Studio does not send feedback for every click. Studio sends it after a meaningful state change, for example when an upload finishes or fails.
- The app accepts a well-formed value that it does not know and performs nothing. A newer Studio can add a value without a failure in an older app. A malformed value gets a `malformed` reply.
- The main page and the presentation page use the same request.

`SystemFeedback` holds a counter and the last request. The counter is the trigger, so the same feedback can play twice in a row.

### System share

`system/share` asks the app to open the system share sheet for normal, user-visible content:

- `title`, at most 200 characters, for the preview;
- `text`, at most 2000 characters;
- `url`, at most 2048 characters.

At least `text` or `url` is required. The app refuses a request that is not valid:

- A `url` must be an absolute `http` or `https` URL without user information. The app refuses `javascript:`, `file:`, `data:`, and every other scheme, a relative URL, whitespace, and backslashes.
- The app refuses a URL whose query or fragment names a credential, for example `access_token`, `token`, `code`, `csrf`, `session`, `signature`, or `password`.
- The app refuses text, a title, or a URL that contains a Tilecast credential prefix: `tca_`, `tcr_`, `tc_device_`, or `tc_pair`.
- The app replies `unavailable` for a URL that points to the connected server's own `/api` or `/__native` tree. Those addresses authorize with the session, so they mean nothing to another person.

Studio applies the same rules before it sends a request, with the same shared fixtures.

SwiftUI has `ShareLink`, which is a view, and no imperative share API. A request that arrives from the bridge has no view to present from. `SystemSharePresenter` in `Tilecast/Features/System/` is the one isolated UIKit adapter. It presents `UIActivityViewController` from the top view controller, so a share from a presentation sheet appears above that sheet. It supplies the title as link metadata for the preview. It builds no share interface of its own. An iPad shows the sheet in a popover. One share sheet can be open at a time; a second request gets `unavailable`.

Studio uses the reply to choose. When the reply is not `ok`, Studio keeps its web behavior, for example `navigator.share` or a copy button. Use `useNativeShare()` and `useNativeShareAvailable()` in `apps/dashboard/src/native-host/useNativeSystem.ts`. No Studio surface shares content yet. The hooks and the native side are ready for the first one.

### Deep links

A deep link brings a person back into a configured Tilecast installation. The URL is `tilecast-ios://open?installation=<installation-id>&path=<studio-path>`. The path is percent-encoded. `DeepLink` in `TilecastCore/DeepLinks/` builds and reads it.

- The URL holds no secret. It names an installation, never an address. The app does not claim universal links or associated domains, because a Tilecast installation can use any domain.
- The OAuth callback `tilecast-ios://oauth/callback` uses the same scheme and a different host. `DeepLink.parse` ignores it, and the sign-in session keeps handling it.
- A link with a repeated parameter, user information, a port, a fragment, or a URL longer than 4096 characters is invalid. Unknown extra parameters are ignored.

The path is valid when it is an ordinary same-origin Studio path: it starts with a single `/`, it has at most 2048 characters, and it has no control character, whitespace, backslash, or dot segment (also percent-encoded). It must not be in `/__native`, `/login`, `/setup`, or `/oauth`. Sign-in, first-run setup, and OAuth approval have their own entry points. The rule is generic: the app does not list Studio routes. The shared fixture `deepLinkPaths` in `packages/native-bridge-schema/fixtures/messages-v1.json` holds the accepted and refused paths, and Studio and the app both run it.

`StudioHost.open(_:)` is the one resolver. A push notification or an App Intent later builds a `DeepLink` and calls it, so no second routing path exists:

1. The resolver finds a server profile with the installation ID. If none exists, it shows a notice that says the link cannot be opened, and it does nothing else. It contacts no host and it never adds a server from an incoming URL.
2. It queues the link, and it opens the profile's server when that server is not active. Opening a server verifies its installation identity first. A changed installation shows the identity-changed state, and the link ends.
3. The link waits until the main page is ready. The page is ready when its Studio finished the bridge handshake, reported `deepLinks`, and published its navigation catalog, which means that it is signed in. A link that arrives before launch finishes, during sign-in, or before Studio loads waits for that moment.
4. The app sends the path with `navigation/open-path`, and React Router navigates. Unsaved-change blockers apply. The app never loads the page URL for a link. Studio validates the path again and refuses the authentication paths.
5. A link expires after five minutes. Switching to another server, removing the server, and signing out also end it. Studio retries a delivery that its router did not accept for a short time, because Studio can report ready before its router listens.

### Native media intake

The app has no native Media library. Native media intake does one job:

```text
Choose media with Apple's system UI
        ↓
upload it with the native Tilecast API credential
        ↓
tell Studio how it ended
        ↓
Studio stays the product interface
```

Studio keeps browsing, organizing, editing, assigning, and publishing media.

#### Entry point and fallback

Studio decides when "Upload media" is available. In `MediaUploadPanel`, the **Choose files** button uses native intake when the host can, and the browser file input everywhere else.

1. When the panel mounts, Studio sends `system/media-intake-status`. The reply `available` is `true` only when the app has a native credential for the connected server. A server released before native API access, and an app that signed out, report `false`.
2. When `available` is `true`, a click sends `system/media-intake` with an opaque `requestId`, media kind hints (`image`, `video`), and `multiple`. The request has no file data, no path, and no credential.
3. When the reply is `unavailable`, Studio stops offering native intake and uses its own uploader. The status answer arrives before the click, so the click that opens the browser file input still has its user gesture.

A presentation page cannot start intake. The app ignores the request from a page that is not the main page with `forbidden`.

#### Choosing

`MediaIntakeCoordinator` moves the flow to `choosing`, and the app shows a dialog with **Photo Library** and **Choose Files…**.

- **Photo Library** uses `PhotosPicker`. The app asks for the `.compatible` encoding, so the picker gives JPEG instead of HEIC and widely supported video. The app does not ask for the Photos library permission and does not read the library. `PhotosPickerItem.loadTransferable` copies the item to a file through `Transferable`.
- **Choose Files…** uses `fileImporter`. The URL is security scoped. `FileImportSource` opens access for the copy only, reads the file with file coordination (which also downloads an iCloud Drive file), and releases access when the copy ends.
- Multiple selection works where the picker supports it. There is no custom Photos or Files browser. A camera action is not part of Milestone 8A.

#### Upload transport

`MediaUploader` uses Tilecast's existing resumable upload protocol through the generated Swift client. There is no iOS-only upload API and no second REST client.

| Step     | Operation              | Notes                                                                                     |
| -------- | ---------------------- | ----------------------------------------------------------------------------------------- |
| Create   | `createUploadSession`  | Sends the file name, the MIME type, and the size                                          |
| Append   | `appendUploadBytes`    | `PATCH` with `Upload-Offset`. A chunk is 2 MiB. The server answers `204` when it saved it |
| Recover  | `inspectUploadSession` | `HEAD`. The `Upload-Offset` header tells the app how many bytes the server holds          |
| Finalize | `completeUpload`       | The server checks the size and starts processing. `409` means that bytes are missing      |
| Cancel   | `cancelUpload`         | Best effort, when an upload ends without an asset                                         |
| Follow   | `getAsset`             | Read for display only, until the server marks the asset ready or failed                   |

- The client sends `Authorization: Bearer` from `NativeAuthSession` and nothing else. `BearerAuthenticationMiddleware` removes any `Cookie` header, and the upload sets no `X-CSRF-Token`. The session has no cookie storage and refuses every redirect. Certificates are evaluated normally. Nothing in this code logs the header.
- After a lost answer, a network error, `408`, `429`, or a `5xx` status, the uploader asks the server for its offset with `HEAD` and continues from there. A chunk that arrived is not sent again, and a chunk that did not arrive is not skipped. After five consecutive failures of one step, the upload ends with a message that the server is not reachable.
- A `401` rotates the access token one time through the normal single-flight rotation. A second `401` ends the upload as unauthenticated.
- `413`, `415`, and `507` map to "larger than the server allows", "type not accepted", and "no space left". A `200` answer to `completeUpload` whose body the app does not understand still counts as a finished upload, because the server finalized it.

The generated client refuses enum values that the contract does not list. A newer server that adds an asset status could break `getAsset` in an installed app. The app treats an unreadable status as "uploaded", and the upload never fails because of it.

#### Temporary files

`MediaStaging` keeps every copy below one directory in the app's temporary space. Each intake has a subdirectory. Names are generated: a picked file name is display text and upload metadata, and it never becomes a path. The app removes path components, control characters, and characters past 255 from a name.

- A copy is removed as soon as its upload ends, whichever way it ends.
- The intake directory is removed after success, after the person cancels, after a definitive failure, when the app switches servers, when the person signs out, and when the person removes the server.
- `sweepStaging()` at launch removes anything that an ended app left behind.
- Media contents are not stored in app preferences, in the Keychain, in state restoration, or on the bridge.

#### Progress

While files transfer, the app shows a sheet with the file name, a progress bar, and one state for each file: preparing, uploading, processing on the server, uploaded, failed with a reason, or cancelled. **Cancel** stops the transfer; files that already arrived stay on the server. **Done** closes the sheet, and swiping the sheet away is off while files transfer. The upload runs while the app is in the foreground. The app does not promise completion after iOS suspends or ends the app. A background `URLSession` is not part of Milestone 8A.

A picker or the sheet never rebuilds or moves the Studio web view. Their presentations belong to the shell root, and the same `StudioPage` shows under them.

#### The result

When every upload ends, the app sends `system/media-intake-completed` with `requestId`, `outcome`, and `uploadedCount`:

| Outcome     | Meaning                                                            |
| ----------- | ------------------------------------------------------------------ |
| `completed` | Every chosen file uploaded                                         |
| `partial`   | Some files uploaded and some did not, or the person cancelled late |
| `failed`    | No file uploaded, for a reason other than cancellation             |
| `cancelled` | The person cancelled before any file uploaded                      |

The message has no file data, no token, and no asset model. Studio refetches its own `["assets"]` queries when `uploadedCount` is more than zero, through `NativeMediaIntakeRefresh`. The panel that asked shows a short status line. If the Studio page that asked no longer exists, the app finishes locally: it drops the message and does not reload a page.

A switch to another server or a sign-out ends the intake and sends nothing, because the page that asked belongs to a session that ended.

#### Testing

Automated tests use no Photos library and no iCloud. Fixtures replace the pickers:

- Swift tests run the uploader against a fake upload server, with fault injection for lost answers, dropped connections, `503`, `409`, redirects, and cancellation. They check the wire: the bearer token, no cookie, no CSRF token, and the offsets sent.
- Debug builds accept `-TilecastFixtureMediaPicker`, which replaces the system pickers with two generated images, and `-TilecastFixtureNativeCredential`, which gives every server a stored refresh token. The UI tests use them with `FixtureStudioServer`, which speaks the upload protocol. Release builds contain none of this code.

For a real test with the Photos picker and the Files app, see `apps/ios/README.md`.

## Authentication

The app has two authentication channels for each server. They are kept separate:

| Credential                   | Where it is kept                                  | Who uses it            |
| ---------------------------- | ------------------------------------------------- | ---------------------- |
| HttpOnly Studio cookie       | The server's `WKWebsiteDataStore` only            | Studio in the web view |
| OAuth access token (`tca_`)  | Memory in `NativeAuthSession` only                | Native API calls       |
| OAuth refresh token (`tcr_`) | The Keychain only                                 | `NativeAuthSession`    |
| Password, passkey, MFA       | The server's own pages in the system browser only | The server             |

Page JavaScript and the native bridge never get an access token, a refresh token, the cookie, the CSRF token, or a Keychain value. The web view does not use bearer authentication. Native API requests do not use the Studio cookie.

### Sign-in

When Studio reaches `/login`, the app starts `ASWebAuthenticationSession` at the configured server's origin. The server's own sign-in page handles passwords, authenticator codes, recovery codes, passkeys, and the enrollment policy. The app does not show a native password, code, or passkey form.

1. `IOSSignInRequest` makes a PKCE S256 challenge and a random state. The fixed `tilecast-ios` client uses the exact callback `tilecast-ios://oauth/callback`.
2. The server records the approval and redirects to the callback with the code, the state, and `iss` (RFC 9207). `iss` is the origin of the approval page, as the browser reports it in the `Origin` header. The approval requires the session cookie and its CSRF token, so only a Studio page from that server can make the request. The server does not use forwarded headers for `iss`. When the request carries no usable `Origin`, the server refuses the ceremony instead of returning a callback without `iss`, so this server never looks like one released before `iss` existed.
3. The app refuses the callback if the state is wrong, or if `iss` is present and is not the origin of the server that started the attempt. The app refuses it before the code goes anywhere. This prevents a mix-up between the many unrelated servers that one app can connect to.
4. `NativeAuthSession` sends the code and the verifier to `POST /api/v1/oauth/ios-session`. The server sets the normal Studio cookie and returns the grant's native credential.
5. The app writes the refresh token to the Keychain. Native API access starts only after this write succeeds. The app keeps the access token in memory.
6. The app puts the cookie into only this server's data store, and reloads Studio.

One authorization gives both channels, so the user authorizes one time. The grant is "Tilecast for iOS" in the user's account security. It stays active until the user signs out, removes the server, accepts a changed installation, or revokes the grant, or until the server invalidates it.

The server links the Studio session to the grant. Revoking the grant ends the Studio session. Signing out of that Studio session revokes the grant. When the server signs a user out everywhere (a password change, a factor reset, or deactivation), it also revokes each grant that backs a Studio session, because such a grant could start a new session.

### Credential storage

`NativeCredentialStore` keeps only refresh tokens. `KeychainCredentialStore` stores each one as a generic password in the data protection keychain:

- The account is the profile UUID and the installation ID. Two installations never share an item, also when the same user signs in to both. A profile that is rebound to a new installation cannot read the old item.
- The accessibility class is `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`, so later background work can refresh. The item is not synchronized to iCloud Keychain and is not restored to another device.
- The app deletes the item when the user removes the server, and before a changed installation can use the profile. At launch, the app deletes items that no profile owns. Keychain items can stay after the app's files are gone, for example after a reinstall.

The refresh token is never in `UserDefaults`, `ServerDirectory`, JSON files, logs, bridge messages, or state restoration. `NativeCredential` descriptions do not show the tokens.

### Refresh

`NativeAuthSession` is an actor for one verified server. `StudioHost` makes it only after the installation identity check passes, and discards it when the page closes.

- The actor replaces the access token one minute before it expires.
- Refresh is single-flight. All callers that need a new token wait for the same rotation. Tilecast revokes the whole grant when a rotated refresh token is presented again, so two concurrent rotations would sign the app out.
- Refresh uses `POST /api/v1/oauth/ios-session` with `grant_type=refresh_token`. The server refuses a refresh token of another client before it consumes it, so a CLI or MCP token cannot start a Studio session. The general token endpoint does not rotate `tilecast-ios` tokens.
- The actor writes the new refresh token to the Keychain before it gives the new access token to a caller. If the write fails, the app deletes the credential and the user signs in again. The server already retired the old token, and the app does not keep a refresh token only in memory.
- A refused refresh (`invalid_grant`, reuse detection, a revoked grant, or an inactive account) deletes the credential. The app does not try again. A timeout, a DNS failure, an offline device, rate limiting, or a server error keeps the credential.
- A plain refresh does not change the Studio cookie, because a new cookie under a running page would strand Studio's CSRF token. When Studio's own session ends and Studio reaches `/login`, the app asks for `studio_session: true`. The server then starts a new session for the grant, and the app reloads Studio without the browser. If the server refuses, the app opens the system sign-in sheet.

### Sign-out and revocation

Sign-out means the whole app session for that server:

- **From Studio.** Studio does its normal cookie and CSRF logout. Before it shows the sign-in page, it sends `auth/signed-out`. The app revokes the grant (best effort), deletes the refresh token, and drops the access token.
- **From the app.** The Sign Out control is in the iPhone More list, the iPad server menu, and the fallback menu. The app deletes the credential first, then sends `auth/sign-out-request`, and Studio does its normal logout. The app does not need a CSRF token. Then the app deletes this server's cookies. Revoking the grant on the server is best effort. If the server cannot be reached, or the app ends while Studio is asked, the local deletion already occurred. Other website data, such as preferences and caches, stays.

After an explicit sign-out, the profile records `signedOutAt`. The app shows its Sign In control and does not open the browser by itself, also after a relaunch. A completed sign-in clears the record. A missing or expired session still opens the browser, as before.

If the grant is revoked remotely, the next refresh fails, and the app deletes the credential one time. If Studio still looks signed in, the app asks Studio to sign out. The linked Studio session has already ended on the server.

The app revokes a grant only through a connection whose installation identity was verified. When the user removes a server that is not connected, or accepts a changed installation, the app deletes the credential locally and sends it nowhere.

### Older servers and older apps

- A current app with a server released before native API access: the server returns only `{"authenticated": true}` and the cookie, and the callback has no `iss`. The app signs in to Studio and native API access is unavailable. The app accepts a callback without `iss`, because such a server cannot send it. State and PKCE still protect that callback.
- An older app with a current server: the older app imports the cookie and ignores the response body, as before. The grant stays active until Studio signs out, which revokes it.

### Generated API client

`TilecastAPI` is generated at build time by the Swift OpenAPI Generator package plugin. `Sources/TilecastAPI/openapi.yaml` is a symbolic link to the composed `docs/openapi.yaml`, so there is no second copy of the contract and no generated Swift in the repository. The configuration does not filter operations. Do not hand-write models for Tilecast endpoints; change the contract instead.

`NativeAuthSession.makeClient()` gives a client for the verified server's address. `BearerAuthenticationMiddleware` is the only code that adds authentication. It sends `Authorization: Bearer` and removes any `Cookie` header. After a 401 response, it rotates and tries one more time. The URLSession has no cookie storage, no cache, no credential storage, and refuses redirects, so the token and the authorization code go only to the server's origin.

The generated client refuses response properties and enum values that the contract does not list. Response schemas that the app decodes before it knows the server version (`IOSSession` and `OAuthTokens`) are open. A later native workflow must make its response schemas open, or must check the server's capabilities first, so that a newer server does not break an installed app.

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

| Milestone | Scope                                                                                                                                                                   |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1         | Host foundation: server profiles, per-server WebKit storage, one main Studio page, navigation policy, server switching                                                  |
| 2         | Implemented: versioned native bridge (`packages/native-bridge-schema`), capability handshake, navigation catalog, iPhone tabs, iPad sidebar                             |
| 3         | Implemented: native API authentication, generated API client, Keychain refresh token, sign-out and revocation. It adds no native product pages                          |
| 4         | Implemented: native presentations, shell-less Studio route, SwiftUI sheets, one reusable presentation page, fallback to web dialogs                                     |
| 5         | Native Pair Screen with scanning and manual code entry                                                                                                                  |
| 6         | Settings contract version 2 with semantic metadata, consumed by Studio first                                                                                            |
| 7         | Native generic settings renderer, with fallback to Studio for anything it cannot render                                                                                 |
| 8A        | Implemented: system share, semantic haptics, deep links, and native media intake. Full-bleed Studio beneath the tab bar is not done                                     |
| 8B        | Push notifications, notification actions, App Intents and Shortcuts, and screen quick actions. See [ADR: push and quick actions](adr/ios-m8b-push-and-quick-actions.md) |

Everything not listed as native stays in Studio. After Milestone 8 most of the product interface, by surface area, is still Studio. Milestone 8A adds no native product screen: the app has no native Media library.

## Known limitations after Milestone 8A

- Studio opens the Layout and Playlist previews with `window.open`. `WebPage` has no new-window hook, so these previews do not open in the app. They can move to native presentations later.
- Downloads, such as settings export, are refused with a notice. `WebPage` has no download delegate.
- The app has one window. iPad multiple windows will return when each scene can own a server safely.
- Passkey sign-in uses the system authentication browser. See [Authentication](#authentication).
- Studio ends above the floating tab bar. It does not extend beneath it. See [Studio above the tab bar](#studio-above-the-tab-bar).
- Native media intake is the only workflow that calls the native API. Milestone 3 is the foundation for later native workflows.
- Native uploads run while the app is in the foreground. The app does not promise that an upload continues after iOS suspends or ends the app. See [Native media intake](#native-media-intake).
- The Keychain tests need a signed test process. They are skipped by `swift test` on macOS and in the unsigned CI build, where the in-memory store tests cover the same logic.
- The Studio topbar stays a Studio component. This is intentional: breadcrumbs, search, notifications, and editor controls remain Studio features.

## Build and test

See `apps/ios/README.md` for commands. CI runs the `ios_ci` job in `.github/workflows/ci-ios.yml` on `macos-26` when a pull request changes `apps/ios/`, `packages/native-bridge-schema/`, the OpenAPI contract (`docs/openapi/` and `docs/openapi.yaml`), or the shared server address corpus. A change to the bridge schema also runs the dashboard checks, because Studio tests run the same fixtures. An ordinary Studio or server change does not build the app, because the app loads Studio from the server at runtime. This includes Studio's own bridge code in `apps/dashboard/src/native-host/`, which the dashboard tests cover. `scripts/ci/affected.mjs` records these edges. Add one when the app starts to compile or test against another contract, such as the settings schema.
