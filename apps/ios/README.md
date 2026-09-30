# Tilecast for iOS and iPadOS

A native host for Tilecast Studio. Read [`docs/ios-app.md`](../../docs/ios-app.md) before you change the app: it contains the architecture rules, the hosting model, and the transport security policy.

## Requirements

- Xcode 26 or later
- an iOS 26 or later simulator, or a device

The app's only packages are Apple's [Swift OpenAPI Generator](https://github.com/apple/swift-openapi-generator), OpenAPI Runtime, OpenAPI URLSession, and HTTP Types. `TilecastKit/Package.resolved` pins them; Xcode and `swift test` both use it. You do not need other tools.

## Build and run

Open `Tilecast.xcodeproj` and run the **Tilecast** scheme. The project uses synchronized folders, so a new file below `Tilecast/`, `TilecastUITests/`, or `TilecastKit/` does not change the project file. Put build settings in `Config/*.xcconfig`, not in the project file.

To run on a device, copy `Config/Local.xcconfig.example` to `Config/Local.xcconfig` and set your team and a bundle identifier that your team can register. Git ignores `Local.xcconfig`.

To connect to a local development server from the simulator, add `http://127.0.0.1:8080`, or the port your server uses.

## Test

Core logic tests run on the Mac without a simulator:

```sh
cd apps/ios/TilecastKit
swift test
```

The full suite runs on the iOS Simulator, as in CI. The UI tests start a loopback fixture server (`TilecastUITests/FixtureStudioServer.swift`), so they need no Tilecast server and no network access. Run the UI tests a second time with `scripts/simulator-destination.py --ipad` to test the iPad sidebar.

```sh
cd apps/ios
scripts/check-architecture.sh
DESTINATION=$(scripts/simulator-destination.py)
xcodebuild build-for-testing -project Tilecast.xcodeproj -scheme Tilecast -destination "$DESTINATION" -derivedDataPath build/DerivedData -skipPackagePluginValidation
scripts/check-localization.py build/DerivedData
xcodebuild test-without-building -project Tilecast.xcodeproj -scheme Tilecast -destination "$DESTINATION" -derivedDataPath build/DerivedData -only-testing:TilecastCoreTests
xcodebuild test-without-building -project Tilecast.xcodeproj -scheme Tilecast -destination "$DESTINATION" -derivedDataPath build/DerivedData -only-testing:TilecastUITests
```

## Generated API client

`TilecastKit/Sources/TilecastAPI` is generated at build time from the composed contract. Its `openapi.yaml` is a symbolic link to `docs/openapi.yaml`. Change the contract in `docs/openapi/core.yaml` or a plugin's `api/openapi.yaml`, run `npm run plugins:generate`, and rebuild. Do not copy the contract or check in generated Swift.

The generator runs as a package build plugin. Xcode asks you to trust it the first time. From the command line, pass `-skipPackagePluginValidation` to `xcodebuild`, as the commands above do. To update a dependency, run `swift package update` in `TilecastKit` and commit `Package.resolved`. CI resolves with `-disableAutomaticPackageResolution`, so a stale `Package.resolved` fails the build.

Native API code lives in `TilecastCore/Auth/`. Read [Authentication](../../docs/ios-app.md#authentication) before you change it: the access token stays in memory, the refresh token stays in the Keychain, and neither may reach page JavaScript or the bridge.

## Native bridge and navigation

Studio sends the app its navigation catalog through the native bridge. The app renders the catalog and never names a Studio route or destination. Read [Native bridge](../../docs/ios-app.md#native-bridge) and [Native navigation](../../docs/ios-app.md#native-navigation) before you change `TilecastKit/Sources/TilecastCore/Bridge/` or `TilecastKit/Sources/TilecastCore/Navigation/`. The protocol contract is [`packages/native-bridge-schema`](../../packages/native-bridge-schema/README.md). Its fixtures run in the Core tests and in the Studio tests.

The app shows the one Studio web view through `StudioOverlay`. A `WebPage` can have only one `WebView`, so a layout marks where Studio goes with `StudioSlotView` and never creates a `WebView` itself.

## Typography

Native text uses Geist, the Studio typeface. Use `Font.geist(.body)`, `Font.geist(.footnote)`, and so on, not a system text style. Read [Typography](../../docs/ios-app.md#typography) for the parts of UIKit chrome that `Typography.applyAppearance()` covers and the system surfaces that keep the system font.

## Navigation icons

Tabs, the More list, and the iPad sidebar use Studio's Lucide icons. The icon assets and their Swift maps are generated from Studio. Do not edit them. Run `npm run ios:icons:generate` from the repository root after you change `apps/dashboard/src/navigation/NavigationIcon.tsx` or update `lucide-react`. Read [Icons](../../docs/ios-app.md#icons).

## Localization

Add user-visible text as a SwiftUI literal or with `String(localized:)`. Then add the key, with Spanish and Russian translations, to `Tilecast/Resources/Localizable.xcstrings`. `scripts/check-localization.py` fails when a translation is missing.
