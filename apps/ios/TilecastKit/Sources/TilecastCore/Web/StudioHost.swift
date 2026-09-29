import Foundation
import Observation
import WebKit

/// Owns the single main Studio page for the active server.
///
/// Only one main `StudioPage` exists at a time. Switching servers closes the
/// old page before the new one is built. Before any page loads, the host
/// re-reads the server's public installation identity: if the address now
/// serves a different installation, Studio is not loaded, so the old
/// installation's session cookie is never sent to it.
@MainActor
@Observable
public final class StudioHost {
    public enum Connection: Equatable {
        case noServer
        case verifying(ServerProfile)
        case unavailable(ServerProfile, InstallationIdentityError)
        case identityChanged(ServerProfile, found: InstallationIdentity)
        case connected(StudioPage)

        public static func == (lhs: Connection, rhs: Connection) -> Bool {
            switch (lhs, rhs) {
            case (.noServer, .noServer): true
            case let (.verifying(a), .verifying(b)): a.id == b.id
            case let (.unavailable(a, x), .unavailable(b, y)): a.id == b.id && x == y
            case let (.identityChanged(a, x), .identityChanged(b, y)): a.id == b.id && x == y
            case let (.connected(a), .connected(b)): a === b
            default: false
            }
        }
    }

    public let directory: ServerDirectory
    public private(set) var connection: Connection = .noServer

    @ObservationIgnored private let dataStores: any WebsiteDataStoreManaging
    @ObservationIgnored private let identityClient: any InstallationIdentityFetching
    @ObservationIgnored private let applicationName: String
    /// Incremented on every activation so a slow identity check for a
    /// server the user already left cannot build a page.
    @ObservationIgnored private var generation = 0

    public init(
        directory: ServerDirectory,
        dataStores: any WebsiteDataStoreManaging,
        identityClient: any InstallationIdentityFetching,
        applicationName: String
    ) {
        self.directory = directory
        self.dataStores = dataStores
        self.identityClient = identityClient
        self.applicationName = applicationName
    }

    public var page: StudioPage? {
        if case .connected(let page) = connection { page } else { nil }
    }

    /// Opens the directory's active server, if any.
    public func start() async {
        await sweepOrphanedDataStores()
        if let id = directory.activeServerID { await activate(id) } else { connection = .noServer }
    }

    /// Makes `id` the active server and loads its Studio page.
    public func activate(_ id: UUID) async {
        guard let profile = directory.server(withID: id) else { return }
        if let page, page.serverID == id { return }
        closePage()
        directory.activate(id)
        await connect(profile)
    }

    /// Retries verification and loading for the active server.
    public func retry() async {
        guard let profile = directory.activeServer else { return }
        closePage()
        await connect(profile)
    }

    /// Removes a server and deletes its website data. If it was active, the
    /// next server opens.
    public func remove(_ id: UUID) async {
        let wasActive = directory.activeServerID == id
        if wasActive { closePage() }
        guard let removed = directory.remove(id) else { return }
        await removeDataStore(removed.websiteDataStoreID)
        guard wasActive else { return }
        if let next = directory.activeServer {
            directory.activate(next.id)
            await connect(next)
        } else {
            generation += 1
            connection = .noServer
        }
    }

    /// WebKit refuses to delete a store while a page still uses it, and a
    /// closed page can outlive its last SwiftUI view briefly. One delayed
    /// retry covers that; the launch sweep covers anything left after it.
    private func removeDataStore(_ identifier: UUID) async {
        do {
            try await dataStores.removeDataStore(for: identifier)
        } catch {
            try? await Task.sleep(for: .seconds(1))
            try? await dataStores.removeDataStore(for: identifier)
        }
    }

    /// Accepts the installation that now answers at a server's address. Its
    /// old website data is deleted first.
    public func trustNewInstallation(_ id: UUID, identity: InstallationIdentity) async throws(ServerDirectoryError) {
        closePage()
        if let oldStore = try directory.rebind(id, to: identity) {
            await removeDataStore(oldStore)
        }
        if let profile = directory.server(withID: id) { await connect(profile) }
    }

    /// Saves the current Studio path so the next launch reopens it.
    public func recordState() {
        guard let page else { return }
        directory.recordStudioPath(page.currentStudioPath, for: page.serverID)
    }

    /// Deletes data stores no profile references, for example after the app
    /// ended between removing a profile and deleting its store.
    public func sweepOrphanedDataStores() async {
        let known = directory.knownDataStoreIDs
        for identifier in await dataStores.existingDataStoreIdentifiers() where !known.contains(identifier) {
            try? await dataStores.removeDataStore(for: identifier)
        }
    }

    private func connect(_ profile: ServerProfile) async {
        generation += 1
        let attempt = generation
        connection = .verifying(profile)
        let result: Result<InstallationIdentity, InstallationIdentityError>
        do {
            result = .success(try await identityClient.identity(at: profile.address))
        } catch {
            result = .failure(error)
        }
        guard attempt == generation, let current = directory.server(withID: profile.id) else { return }

        switch result {
        case .failure(let error):
            connection = .unavailable(current, error)
        case .success(let identity) where identity.installationID != current.installationID:
            connection = .identityChanged(current, found: identity)
        case .success:
            let page = StudioPage(
                profile: current,
                dataStore: dataStores.dataStore(for: current.websiteDataStoreID),
                applicationName: applicationName
            )
            connection = .connected(page)
            page.start()
        }
    }

    private func closePage() {
        generation += 1
        guard let page else { return }
        directory.recordStudioPath(page.currentStudioPath, for: page.serverID)
        page.close()
        connection = .noServer
    }
}
