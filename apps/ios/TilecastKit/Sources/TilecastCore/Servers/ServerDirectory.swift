import Foundation
import Observation

public enum ServerDirectoryError: Error, Equatable, Sendable {
    /// This installation is already configured, possibly under another address.
    case alreadyAdded(ServerProfile)
}

/// The persisted list of servers and the active selection. Records hold no
/// secrets; see `ServerProfile`.
public struct ServerDirectorySnapshot: Codable, Equatable, Sendable {
    public static let currentVersion = 1

    public var version: Int
    public var servers: [ServerProfile]
    public var activeServerID: UUID?

    public init(servers: [ServerProfile] = [], activeServerID: UUID? = nil) {
        self.version = Self.currentVersion
        self.servers = servers
        self.activeServerID = activeServerID
    }
}

public protocol ServerDirectoryStorage: Sendable {
    func load() throws -> ServerDirectorySnapshot?
    func save(_ snapshot: ServerDirectorySnapshot) throws
}

/// Stores the directory as JSON in Application Support, excluded from
/// backups because every record is bound to device-local WebKit storage.
public struct FileServerDirectoryStorage: ServerDirectoryStorage {
    public let fileURL: URL

    public init(fileURL: URL) {
        self.fileURL = fileURL
    }

    public static func applicationSupport() throws -> FileServerDirectoryStorage {
        let directory = try FileManager.default.url(
            for: .applicationSupportDirectory, in: .userDomainMask, appropriateFor: nil, create: true
        )
        return FileServerDirectoryStorage(fileURL: directory.appending(path: "servers.json"))
    }

    public func load() throws -> ServerDirectorySnapshot? {
        guard FileManager.default.fileExists(atPath: fileURL.path(percentEncoded: false)) else { return nil }
        let snapshot = try JSONDecoder.directory.decode(ServerDirectorySnapshot.self, from: Data(contentsOf: fileURL))
        return snapshot.version <= ServerDirectorySnapshot.currentVersion ? snapshot : nil
    }

    public func save(_ snapshot: ServerDirectorySnapshot) throws {
        try FileManager.default.createDirectory(
            at: fileURL.deletingLastPathComponent(), withIntermediateDirectories: true
        )
        var options: Data.WritingOptions = [.atomic]
        #if os(iOS)
        options.insert(.completeFileProtectionUntilFirstUserAuthentication)
        #endif
        try JSONEncoder.directory.encode(snapshot).write(to: fileURL, options: options)
        var url = fileURL
        var values = URLResourceValues()
        values.isExcludedFromBackup = true
        try? url.setResourceValues(values)
    }
}

public final class InMemoryServerDirectoryStorage: ServerDirectoryStorage, @unchecked Sendable {
    private let lock = NSLock()
    private var snapshot: ServerDirectorySnapshot?

    public init(_ snapshot: ServerDirectorySnapshot? = nil) {
        self.snapshot = snapshot
    }

    public func load() throws -> ServerDirectorySnapshot? {
        lock.withLock { snapshot }
    }

    public func save(_ snapshot: ServerDirectorySnapshot) throws {
        lock.withLock { self.snapshot = snapshot }
    }
}

extension JSONEncoder {
    static var directory: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}

extension JSONDecoder {
    static var directory: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return decoder
    }
}

/// The configured servers. One profile exists per Tilecast installation.
@MainActor
@Observable
public final class ServerDirectory {
    public private(set) var servers: [ServerProfile]
    public private(set) var activeServerID: UUID?
    /// The last persistence error, if saving failed. Nothing is lost in
    /// memory; the next successful save writes the full snapshot.
    public private(set) var lastSaveError: String?

    @ObservationIgnored private let storage: any ServerDirectoryStorage

    public init(storage: any ServerDirectoryStorage) {
        self.storage = storage
        let snapshot = (try? storage.load()) ?? ServerDirectorySnapshot()
        servers = snapshot.servers
        activeServerID = snapshot.servers.contains { $0.id == snapshot.activeServerID }
            ? snapshot.activeServerID
            : snapshot.servers.first?.id
    }

    public var activeServer: ServerProfile? {
        activeServerID.flatMap(server(withID:))
    }

    public func server(withID id: UUID) -> ServerProfile? {
        servers.first { $0.id == id }
    }

    /// Adds a verified server. The display name defaults to the
    /// organization name the server reports.
    @discardableResult
    public func add(
        address: ServerAddress,
        identity: InstallationIdentity,
        displayName: String? = nil,
        now: Date = .now
    ) throws(ServerDirectoryError) -> ServerProfile {
        if let existing = servers.first(where: { $0.installationID == identity.installationID }) {
            throw .alreadyAdded(existing)
        }
        let profile = ServerProfile(
            displayName: Self.cleanName(displayName, fallback: identity.organizationName, address: address),
            address: address,
            identity: identity,
            createdAt: now
        )
        servers.append(profile)
        save()
        return profile
    }

    public func rename(_ id: UUID, to name: String) {
        update(id) { profile in
            profile.displayName = Self.cleanName(name, fallback: profile.organizationName, address: profile.address)
        }
    }

    public func activate(_ id: UUID, now: Date = .now) {
        guard server(withID: id) != nil else { return }
        activeServerID = id
        update(id) { $0.lastOpenedAt = now }
    }

    /// Removes a profile and returns it so the caller can delete its data
    /// store. If it was active, the most recently opened remaining server
    /// becomes active.
    @discardableResult
    public func remove(_ id: UUID) -> ServerProfile? {
        guard let index = servers.firstIndex(where: { $0.id == id }) else { return nil }
        let removed = servers.remove(at: index)
        if activeServerID == id {
            activeServerID = servers.max { ($0.lastOpenedAt ?? $0.createdAt) < ($1.lastOpenedAt ?? $1.createdAt) }?.id
        }
        save()
        return removed
    }

    public func recordStudioPath(_ path: String?, for id: UUID) {
        guard server(withID: id)?.lastStudioPath != path else { return }
        update(id) { $0.lastStudioPath = path }
    }

    /// Binds a profile to a different installation that now answers at its
    /// address. The profile gets a fresh data store so no cookie or cached
    /// state from the old installation reaches the new one; the returned
    /// identifier is the old store, which the caller must delete.
    public func rebind(_ id: UUID, to identity: InstallationIdentity) throws(ServerDirectoryError) -> UUID? {
        if let other = servers.first(where: { $0.installationID == identity.installationID && $0.id != id }) {
            throw .alreadyAdded(other)
        }
        var oldStore: UUID?
        update(id) { profile in
            oldStore = profile.websiteDataStoreID
            profile.installationID = identity.installationID
            profile.organizationName = identity.organizationName
            profile.websiteDataStoreID = UUID()
            profile.lastStudioPath = nil
        }
        return oldStore
    }

    public var knownDataStoreIDs: Set<UUID> {
        Set(servers.map(\.websiteDataStoreID))
    }

    private func update(_ id: UUID, _ change: (inout ServerProfile) -> Void) {
        guard let index = servers.firstIndex(where: { $0.id == id }) else { return }
        change(&servers[index])
        save()
    }

    private func save() {
        do {
            try storage.save(ServerDirectorySnapshot(servers: servers, activeServerID: activeServerID))
            lastSaveError = nil
        } catch {
            lastSaveError = String(describing: error)
        }
    }

    static func cleanName(_ name: String?, fallback: String, address: ServerAddress) -> String {
        let trimmed = name?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmed.isEmpty { return String(trimmed.prefix(80)) }
        let organization = fallback.trimmingCharacters(in: .whitespacesAndNewlines)
        return organization.isEmpty ? address.host : String(organization.prefix(80))
    }
}
