#if DEBUG
import Foundation
import TilecastCore

/// Launch arguments that let UI tests exercise native intake without the
/// user's Photos library, iCloud, or a real sign-in. They exist only in
/// Debug builds: Release builds contain none of this.
///
/// - `-TilecastFixtureMediaPicker` replaces the system pickers with two
///   generated images. The upload, progress, and completion are the real ones.
/// - `-TilecastFixtureNativeCredential` gives every server a stored refresh
///   token, so the app can rotate it against the fixture server's
///   `ios-session` endpoint like a signed-in app.
/// - `-TilecastFixtureQRScanner` replaces the camera with a stub scanner
///   whose Simulate button returns `-TilecastFixtureQRPayload`, or a
///   default wrong-installation approval URL when no payload is given.
/// - `-TilecastFixtureQRUnavailable` advertises the scanner but fails
///   every scan without showing anything, like a revoked permission.
enum FixtureLaunch {
    static let arguments = ProcessInfo.processInfo.arguments
    static var mediaPicker: Bool { arguments.contains("-TilecastFixtureMediaPicker") }
    static var nativeCredential: Bool { arguments.contains("-TilecastFixtureNativeCredential") }
    static var qrScanner: Bool { arguments.contains("-TilecastFixtureQRScanner") }
    static var qrUnavailable: Bool { arguments.contains("-TilecastFixtureQRUnavailable") }
    static var qrPayload: String? {
        guard let flag = arguments.firstIndex(of: "-TilecastFixtureQRPayload"),
              arguments.indices.contains(flag + 1) else { return nil }
        return arguments[flag + 1]
    }

    /// A 1×1 PNG.
    private static let png = Data(base64Encoded: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==")!

    static func mediaSources() -> [any MediaIntakeSource] {
        [FixtureMediaSource(name: "fixture-one.png", bytes: png), FixtureMediaSource(name: "fixture-two.png", bytes: png + Data([0]))]
    }
}

struct FixtureMediaSource: MediaIntakeSource {
    let name: String
    let bytes: Data

    func materialize(into directory: URL, staging: MediaStaging) async throws -> MediaIntakeFile {
        let url = directory.appending(path: UUID().uuidString, directoryHint: .notDirectory)
        try bytes.write(to: url)
        return try staging.describe(url, displayName: name)
    }
}

/// A credential store that always holds a refresh token.
final class FixtureCredentialStore: NativeCredentialStore, @unchecked Sendable {
    func refreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError) -> String? { "tcr_fixture" }
    func setRefreshToken(_ token: String, for key: NativeCredentialKey) throws(NativeCredentialStoreError) {}
    func deleteRefreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError) {}
    func storedKeys() throws(NativeCredentialStoreError) -> [NativeCredentialKey] { [] }
}
#endif
