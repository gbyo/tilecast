import Foundation
import Security
import Testing
@testable import TilecastCore

/// Exercises the real Keychain. An unsigned test process on macOS cannot use
/// the data protection keychain (errSecMissingEntitlement), so these tests
/// run where the platform allows it, which includes the iOS Simulator in CI.
enum KeychainProbe {
    static let available: Bool = {
        let store = KeychainCredentialStore(service: "org.tilecast.tests.probe.\(UUID().uuidString)")
        let key = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        defer { try? store.deleteRefreshToken(for: key) }
        return (try? store.setRefreshToken("probe", for: key)) != nil
    }()
}

@Suite(.serialized, .enabled(if: KeychainProbe.available))
struct KeychainCredentialStoreTests {
    let store = KeychainCredentialStore(service: "org.tilecast.tests.\(UUID().uuidString)")

    @Test func storesUpdatesAndDeletesOneRefreshToken() throws {
        let key = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        defer { try? store.deleteRefreshToken(for: key) }
        #expect(try store.refreshToken(for: key) == nil)
        try store.setRefreshToken("tcr_first", for: key)
        try store.setRefreshToken("tcr_second", for: key)
        #expect(try store.refreshToken(for: key) == "tcr_second", "rotation replaces the item")
        #expect(try store.storedKeys() == [key])
        try store.deleteRefreshToken(for: key)
        try store.deleteRefreshToken(for: key)
        #expect(try store.refreshToken(for: key) == nil)
    }

    @Test func keepsInstallationsApart() throws {
        let a = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        let b = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        let rebound = NativeCredentialKey(serverID: a.serverID, installationID: UUID())
        defer { store.deleteRefreshTokens(except: []) }
        try store.setRefreshToken("tcr_a", for: a)
        try store.setRefreshToken("tcr_b", for: b)
        #expect(try store.refreshToken(for: rebound) == nil)
        store.deleteRefreshTokens(forServer: a.serverID)
        #expect(try store.storedKeys() == [b])
        store.deleteRefreshTokens(except: [])
        #expect(try store.storedKeys().isEmpty)
    }

    /// Readable after first unlock for later background work, never synced
    /// to iCloud Keychain, and never restored to another device.
    @Test func usesADeviceOnlyAccessibilityClass() throws {
        let key = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        defer { try? store.deleteRefreshToken(for: key) }
        try store.setRefreshToken("tcr_token", for: key)
        let query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: store.service,
            kSecAttrAccount as String: key.account,
            kSecUseDataProtectionKeychain as String: true,
            kSecReturnAttributes as String: true,
        ]
        var result: CFTypeRef?
        #expect(SecItemCopyMatching(query as CFDictionary, &result) == errSecSuccess)
        let attributes = try #require(result as? [String: Any])
        #expect(attributes[kSecAttrAccessible as String] as? String == kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly as String)
        #expect((attributes[kSecAttrSynchronizable as String] as? Bool ?? false) == false)
    }
}
