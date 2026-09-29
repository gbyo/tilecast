# Tilecast for iOS and iPadOS

A native host for Tilecast Studio. Read [`docs/ios-app.md`](../../docs/ios-app.md) before you change the app: it contains the architecture rules, the hosting model, and the transport security policy.

## Requirements

- Xcode 26 or later
- an iOS 26 or later simulator, or a device

The app has no third-party packages. You do not need other tools.

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

The full suite runs on the iOS Simulator, as in CI:

```sh
cd apps/ios
scripts/check-architecture.sh
DESTINATION=$(scripts/simulator-destination.py)
xcodebuild build-for-testing -project Tilecast.xcodeproj -scheme Tilecast -destination "$DESTINATION" -derivedDataPath build/DerivedData
scripts/check-localization.py build/DerivedData
xcodebuild test-without-building -project Tilecast.xcodeproj -scheme Tilecast -destination "$DESTINATION" -derivedDataPath build/DerivedData -only-testing:TilecastCoreTests
xcodebuild test-without-building -project Tilecast.xcodeproj -scheme Tilecast -destination "$DESTINATION" -derivedDataPath build/DerivedData -only-testing:TilecastUITests
```

## Localization

Add user-visible text as a SwiftUI literal or with `String(localized:)`. Then add the key, with Spanish and Russian translations, to `Tilecast/Resources/Localizable.xcstrings`. `scripts/check-localization.py` fails when a translation is missing.
