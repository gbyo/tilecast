// swift-tools-version: 6.2
import PackageDescription

// Host logic for the Tilecast iOS app that does not depend on SwiftUI views:
// server profiles, address policy, installation identity, WebKit storage
// isolation, and the Studio navigation policy. The app target owns all UI.
let package = Package(
    name: "TilecastKit",
    // macOS is listed only so `swift test` can run these tests on a Mac
    // without a simulator. The shipping product is the iOS app.
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "TilecastCore", targets: ["TilecastCore"]),
    ],
    targets: [
        .target(name: "TilecastCore"),
        .testTarget(name: "TilecastCoreTests", dependencies: ["TilecastCore"]),
    ],
    swiftLanguageModes: [.v6]
)
