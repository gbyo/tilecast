// swift-tools-version: 6.2
import PackageDescription

// Host logic for the Tilecast iOS app that does not depend on SwiftUI views:
// server profiles, address policy, installation identity, WebKit storage
// isolation, the Studio navigation policy, and native API authentication.
// The app target owns all UI.
//
// TilecastAPI is generated at build time from docs/openapi.yaml by the
// Swift OpenAPI Generator plugin. Package.resolved pins every dependency.
let package = Package(
    name: "TilecastKit",
    // macOS is listed only so `swift test` can run these tests on a Mac
    // without a simulator. The shipping product is the iOS app.
    platforms: [.iOS(.v26), .macOS(.v26)],
    products: [
        .library(name: "TilecastCore", targets: ["TilecastCore"]),
    ],
    dependencies: [
        .package(url: "https://github.com/apple/swift-openapi-generator", from: "1.13.1"),
        .package(url: "https://github.com/apple/swift-openapi-runtime", from: "1.12.2"),
        .package(url: "https://github.com/apple/swift-openapi-urlsession", from: "1.3.1"),
        .package(url: "https://github.com/apple/swift-http-types", from: "1.8.0"),
    ],
    targets: [
        .target(
            name: "TilecastAPI",
            dependencies: [.product(name: "OpenAPIRuntime", package: "swift-openapi-runtime")],
            plugins: [.plugin(name: "OpenAPIGenerator", package: "swift-openapi-generator")]
        ),
        .target(
            name: "TilecastCore",
            dependencies: [
                "TilecastAPI",
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
                .product(name: "OpenAPIURLSession", package: "swift-openapi-urlsession"),
            ]
        ),
        .testTarget(
            name: "TilecastCoreTests",
            dependencies: [
                "TilecastCore",
                "TilecastAPI",
                .product(name: "HTTPTypes", package: "swift-http-types"),
                .product(name: "OpenAPIRuntime", package: "swift-openapi-runtime"),
            ]
        ),
    ],
    swiftLanguageModes: [.v6]
)
