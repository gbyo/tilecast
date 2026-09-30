# Tilecast native bridge schema

This package is the language-neutral contract between Tilecast Studio and a native host application, such as the Tilecast iOS app. It contains JSON only. Studio (TypeScript) and the iOS app (Swift) each validate against the same fixtures, so neither implementation is the normative protocol.

- `schema-v1.json` is the JSON Schema (draft 2020-12) for protocol version 1.
- `fixtures/messages-v1.json` is the shared corpus. Every implementation decodes each case and must reach the listed outcome.
- `icon-tokens.json` lists the semantic navigation icon tokens that hosts recognize.

Read `docs/ios-app.md` for the architecture this protocol serves.

## Transport

Studio calls the native host through one WebKit script message handler named `tilecastNative`:

```js
const reply =
  await window.webkit.messageHandlers.tilecastNative.postMessage(message);
```

Every message receives one reply. The native host sends a message to Studio by calling the single receiver function `window.tilecastNativeReceiver(message)`. The receiver returns `true` when it accepts the message. The host passes the message as a function argument and never builds script source from message content.

A host registers the handler only on its privileged Studio pages: the main page and the presentation page. Each bridge has a context, `main` or `presentation`, and refuses the other context's messages with `forbidden`. It refuses a message from a subframe, from a content world other than the page, or from any origin other than the configured Tilecast server.

## Envelope

```json
{ "version": 1, "id": "optional", "type": "navigation/state", "payload": {} }
```

- `version` is an integer. A receiver checks it first, and refuses a version it does not implement before it reads anything else.
- `type` names the message. An unknown type in a valid envelope is not an error: the receiver ignores it, and a native host replies `unknown_type`.
- `payload` is always an object.
- The envelope has no other properties. Payloads may gain optional properties in version 1. A receiver ignores properties it does not know.

A reply is `{ "version": 1, "ok": true, "payload": {} }` or `{ "version": 1, "ok": false, "error": { "code": "malformed" } }`. It echoes `id` when the message had one. Error codes are `malformed`, `unknown_type`, `unsupported_version` (with `supportedVersions`), `forbidden`, and `unavailable`.

## Version 1 messages

| Type                 | Direction        | Purpose                                                                |
| -------------------- | ---------------- | ---------------------------------------------------------------------- |
| `config/get`         | Studio to native | Ask for the host's protocol version and capabilities                   |
| `frontend/ready`     | Studio to native | Studio finished its host integration. Idempotent                       |
| `navigation/catalog` | Studio to native | A complete, localized snapshot of navigation destinations              |
| `navigation/state`   | Studio to native | The destination Studio resolved for the current location, and the path |
| `navigation/request` | native to Studio | Ask Studio to open a destination by its opaque identifier              |

The `config/get` reply payload is `{ "protocolVersion": 1, "capabilities": { "nativeNavigation": true } }`. A capability that is absent or not `true` is unavailable.

Destination and group identifiers are opaque. Only Studio knows what they mean. A native host never receives or derives a Studio path for routine navigation: it sends the identifier, and Studio resolves it with React Router. `navigation/state.path` is the location path without its query string, for diagnostics only. `activeDestinationId` is authoritative for native selection. A catalog with no groups means native navigation is not available now, for example on the sign-in page.

After Studio handles a `navigation/request`, it sends `navigation/state` even when the location did not change, for example because an unsaved-changes prompt stopped the navigation. The host uses that message to reconcile its selection.

The alert messages (`alert/present`, `alert/cancel`, and `alert/action`) need the `nativeAlerts` capability on both sides. Either page can present an alert, and the host reports the choice to the page that asked.

`navigation/chrome` tells the host when the page is a drill-in, with a title and the name of the page back leads to. The host then shows a native navigation bar, and its back button sends `navigation/back`. Neither message carries a path. A host that answers `unknown_type` to `navigation/chrome` leaves Studio with its own breadcrumbs.

The presentation messages (`presentation/*` and `navigation/open-path`) need the `nativePresentations` capability on both sides. Presentation paths are in the reserved `/__native/modal` tree. A host knows only that root. See `docs/ios-app.md`.

## System messages

Milestone 8A adds messages that let Studio use system features. Each one has its own capability, so a host and a Studio negotiate them one by one.

| Type                            | Direction        | Pages              | Purpose                                                   |
| ------------------------------- | ---------------- | ------------------ | --------------------------------------------------------- |
| `system/haptic`                 | Studio to native | main, presentation | Standard system feedback for a semantic `feedback` value  |
| `system/share`                  | Studio to native | main, presentation | The system share sheet for `title`, `text`, and `url`     |
| `system/media-intake-status`    | Studio to native | main               | Reply payload `{ "available": boolean }`                  |
| `system/media-intake`           | Studio to native | main               | Choose media with system pickers. The host uploads it     |
| `system/media-intake-completed` | native to Studio | main               | `requestId`, `outcome`, and `uploadedCount`. No file data |

The host offers `systemShare`, `systemHaptics`, `nativeMediaIntake`, and `deepLinks` in the `config/get` reply. Studio reports `nativeMediaIntake` and `deepLinks` in `frontend/ready`, because it must handle the host's messages for them. A deep link reaches Studio as `navigation/open-path`.

- The `feedback` vocabulary is `selection`, `success`, `warning`, `error`, `start`, and `stop`. A host accepts a well-formed value that it does not know and performs nothing.
- A `url` in `system/share` is an absolute `http` or `https` URL without user information. A host refuses a URL, a title, or text that carries a credential, and a URL whose query or fragment names one.
- No message carries a credential, a cookie, a CSRF token, a file byte, a file path, or an OAuth token.

The `deepLinkPaths` list in the fixtures holds the paths that a deep link may and may not open. Both Studio and the host run it.

## Icons

`icon` is advisory. A host maps the tokens in `icon-tokens.json` to its own symbols and shows a generic icon for any other token. Studio can use a new token without a host release.

## Compatibility

- Add an optional payload property, a message type, or an icon token in version 1.
- Removing a property, changing its meaning, or making it required needs version 2.
- Changing this package selects the dashboard and iOS CI jobs.
