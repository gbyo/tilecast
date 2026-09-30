import Foundation
import Security

/// Names the one native credential a server profile may hold. The key binds
/// the credential to both the local profile and the installation that issued
/// it, so rebinding a profile to another installation can never select the
/// old installation's credential, and two installations never share one,
/// even when the same person signs in to both.
public struct NativeCredentialKey: Hashable, Sendable, CustomStringConvertible {
    public let serverID: UUID
    public let installationID: UUID

    public init(serverID: UUID, installationID: UUID) {
        self.serverID = serverID
        self.installationID = installationID
    }

    public init(profile: ServerProfile) {
        self.init(serverID: profile.id, installationID: profile.installationID)
    }

    /// The Keychain account name.
    var account: String { "\(serverID.uuidString.lowercased())/\(installationID.uuidString.lowercased())" }

    init?(account: String) {
        let parts = account.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2, let server = UUID(uuidString: String(parts[0])),
              let installation = UUID(uuidString: String(parts[1])) else { return nil }
        self.init(serverID: server, installationID: installation)
    }

    public var description: String { account }
}

public struct NativeCredentialStoreError: Error, Equatable, Sendable {
    public let status: OSStatus
}

/// Durable storage for native refresh tokens, and nothing else. Access
/// tokens are never persisted; see `NativeAuthSession`.
public protocol NativeCredentialStore: Sendable {
    func refreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError) -> String?
    func setRefreshToken(_ token: String, for key: NativeCredentialKey) throws(NativeCredentialStoreError)
    /// Succeeds when no credential exists.
    func deleteRefreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError)
    func storedKeys() throws(NativeCredentialStoreError) -> [NativeCredentialKey]
}

extension NativeCredentialStore {
    /// Deletes every credential stored for a profile, under any installation.
    public func deleteRefreshTokens(forServer serverID: UUID) {
        for key in (try? storedKeys()) ?? [] where key.serverID == serverID {
            try? deleteRefreshToken(for: key)
        }
    }

    /// Deletes credentials that no configured profile owns. Keychain items
    /// can outlive the app's files, for example after a reinstall, so the
    /// store is not assumed to match the server directory.
    public func deleteRefreshTokens(except known: Set<NativeCredentialKey>) {
        for key in (try? storedKeys()) ?? [] where !known.contains(key) {
            try? deleteRefreshToken(for: key)
        }
    }
}

/// Keeps refresh tokens as Keychain generic passwords in the data protection
/// keychain. Items are readable after the first unlock, so later background
/// work can refresh, and never leave this device: they are excluded from
/// iCloud Keychain and from backups restored to another device.
public struct KeychainCredentialStore: NativeCredentialStore {
    public static let defaultService = "org.tilecast.ios.native-api.refresh-token"

    public let service: String

    public init(service: String = KeychainCredentialStore.defaultService) {
        self.service = service
    }

    private func query(_ key: NativeCredentialKey? = nil) -> [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecUseDataProtectionKeychain as String: true,
            kSecAttrSynchronizable as String: false,
        ]
        if let key { query[kSecAttrAccount as String] = key.account }
        return query
    }

    public func refreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError) -> String? {
        var request = query(key)
        request[kSecReturnData as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw NativeCredentialStoreError(status: status) }
        return String(data: data, encoding: .utf8)
    }

    public func setRefreshToken(_ token: String, for key: NativeCredentialKey) throws(NativeCredentialStoreError) {
        let attributes: [String: Any] = [
            kSecValueData as String: Data(token.utf8),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        var status = SecItemUpdate(query(key) as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            status = SecItemAdd(query(key).merging(attributes) { $1 } as CFDictionary, nil)
        }
        guard status == errSecSuccess else { throw NativeCredentialStoreError(status: status) }
    }

    public func deleteRefreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError) {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw NativeCredentialStoreError(status: status) }
    }

    public func storedKeys() throws(NativeCredentialStoreError) -> [NativeCredentialKey] {
        var request = query()
        request[kSecReturnAttributes as String] = true
        request[kSecMatchLimit as String] = kSecMatchLimitAll
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess, let items = result as? [[String: Any]] else { throw NativeCredentialStoreError(status: status) }
        return items.compactMap { ($0[kSecAttrAccount as String] as? String).flatMap(NativeCredentialKey.init(account:)) }
    }
}

/// A store that forgets everything when the process ends. UI tests and core
/// tests use it; it also backs the app when it runs with ephemeral servers.
public final class InMemoryCredentialStore: NativeCredentialStore, @unchecked Sendable {
    private let lock = NSLock()
    private var tokens: [NativeCredentialKey: String] = [:]
    private var _failsWrites = false

    public init() {}

    /// Set to make every write fail, as an unavailable Keychain would.
    public var failsWrites: Bool {
        get { lock.withLock { _failsWrites } }
        set { lock.withLock { _failsWrites = newValue } }
    }

    public func refreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError) -> String? {
        lock.withLock { tokens[key] }
    }

    public func setRefreshToken(_ token: String, for key: NativeCredentialKey) throws(NativeCredentialStoreError) {
        let stored = lock.withLock { () -> Bool in
            guard !_failsWrites else { return false }
            tokens[key] = token
            return true
        }
        if !stored { throw NativeCredentialStoreError(status: errSecNotAvailable) }
    }

    public func deleteRefreshToken(for key: NativeCredentialKey) throws(NativeCredentialStoreError) {
        lock.withLock { _ = tokens.removeValue(forKey: key) }
    }

    public func storedKeys() throws(NativeCredentialStoreError) -> [NativeCredentialKey] {
        lock.withLock { Array(tokens.keys) }
    }
}
