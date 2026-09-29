import Foundation
import Testing
import WebKit
@testable import TilecastCore

@MainActor
final class FakeDataStores: WebsiteDataStoreManaging {
    var existing: Set<UUID> = []
    var removed: [UUID] = []

    func dataStore(for identifier: UUID) -> WKWebsiteDataStore {
        existing.insert(identifier)
        return .nonPersistent()
    }

    func removeDataStore(for identifier: UUID) async throws {
        removed.append(identifier)
        existing.remove(identifier)
    }

    func existingDataStoreIdentifiers() async -> [UUID] {
        Array(existing)
    }
}

/// Answers identity requests from a table. A request for a gated address
/// suspends until the test releases it, to exercise overlapping activations.
final class FakeIdentityClient: InstallationIdentityFetching, @unchecked Sendable {
    private let lock = NSLock()
    private var _answers: [String: Result<InstallationIdentity, InstallationIdentityError>] = [:]
    private var gated: Set<String> = []
    private var waiting: [String: CheckedContinuation<Void, Never>] = [:]
    /// Yields each gated address once its request is suspended.
    let suspended: AsyncStream<String>
    private let suspendedContinuation: AsyncStream<String>.Continuation

    init() {
        (suspended, suspendedContinuation) = AsyncStream.makeStream()
    }

    var answers: [String: Result<InstallationIdentity, InstallationIdentityError>] {
        get { lock.withLock { _answers } }
        set { lock.withLock { _answers = newValue } }
    }

    func gate(_ key: String) {
        lock.withLock { _ = gated.insert(key) }
    }

    func release(_ key: String) {
        lock.withLock { () -> CheckedContinuation<Void, Never>? in
            gated.remove(key)
            return waiting.removeValue(forKey: key)
        }?.resume()
    }

    func identity(at address: ServerAddress) async throws(InstallationIdentityError) -> InstallationIdentity {
        let key = address.description
        if lock.withLock({ gated.contains(key) }) {
            await withCheckedContinuation { continuation in
                lock.withLock { waiting[key] = continuation }
                suspendedContinuation.yield(key)
            }
        }
        guard let answer = answers[key] else { throw .unreachable }
        return try answer.get()
    }
}

@MainActor
@Suite struct StudioHostTests {
    let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
    let stores = FakeDataStores()
    let client = FakeIdentityClient()

    func makeHost() -> StudioHost {
        StudioHost(directory: directory, dataStores: stores, identityClient: client, applicationName: "TilecastTests")
    }

    func addServer(_ host: String, name: String) throws -> ServerProfile {
        let identity = identity(name)
        let profile = try directory.add(address: address(host), identity: identity)
        client.answers[profile.address.description] = .success(identity)
        return profile
    }

    @Test func connectsTheActiveServerWithItsOwnDataStore() async throws {
        let profile = try addServer("a.example.org", name: "A")
        directory.activate(profile.id)
        let host = makeHost()
        await host.start()

        let page = try #require(host.page)
        #expect(page.serverID == profile.id)
        #expect(stores.existing == [profile.websiteDataStoreID])
        page.close()
    }

    @Test func keepsOnlyOneMainPage() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        let host = makeHost()
        await host.activate(a.id)
        let first = try #require(host.page)
        await host.activate(b.id)
        let second = try #require(host.page)
        #expect(first !== second)
        #expect(second.serverID == b.id)
        #expect(directory.activeServerID == b.id)
        second.close()
    }

    @Test func doesNotLoadStudioWhenTheInstallationChanged() async throws {
        let profile = try addServer("a.example.org", name: "A")
        let impostor = identity("Somebody Else")
        client.answers[profile.address.description] = .success(impostor)
        let host = makeHost()
        await host.activate(profile.id)

        #expect(host.connection == .identityChanged(profile, found: impostor))
        #expect(host.page == nil)
        #expect(stores.existing.isEmpty, "no page may open the old installation's data store")
    }

    @Test func trustingANewInstallationDeletesTheOldWebData() async throws {
        let profile = try addServer("a.example.org", name: "A")
        let replacement = identity("Reinstalled")
        client.answers[profile.address.description] = .success(replacement)
        let host = makeHost()
        await host.activate(profile.id)

        try await host.trustNewInstallation(profile.id, identity: replacement)
        let rebound = try #require(directory.server(withID: profile.id))
        #expect(stores.removed == [profile.websiteDataStoreID])
        #expect(host.page?.serverID == profile.id)
        #expect(stores.existing == [rebound.websiteDataStoreID])
        host.page?.close()
    }

    @Test func reportsAnUnreachableServer() async throws {
        let profile = try addServer("a.example.org", name: "A")
        client.answers[profile.address.description] = .failure(.untrustedCertificate)
        let host = makeHost()
        await host.activate(profile.id)
        #expect(host.connection == .unavailable(profile, .untrustedCertificate))
    }

    @Test func removingAServerDeletesItsDataStoreAndOpensTheNextOne() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        let host = makeHost()
        await host.activate(b.id)
        await host.activate(a.id)

        await host.remove(a.id)
        #expect(stores.removed == [a.websiteDataStoreID])
        #expect(directory.server(withID: a.id) == nil)
        #expect(host.page?.serverID == b.id)

        await host.remove(b.id)
        #expect(stores.removed == [a.websiteDataStoreID, b.websiteDataStoreID])
        #expect(host.connection == .noServer)
    }

    @Test func removingAnInactiveServerLeavesTheActivePageAlone() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        let host = makeHost()
        await host.activate(a.id)
        let page = try #require(host.page)
        await host.remove(b.id)
        #expect(host.page === page)
        #expect(stores.removed == [b.websiteDataStoreID])
        page.close()
    }

    @Test func sweepsDataStoresNoServerReferences() async throws {
        let profile = try addServer("a.example.org", name: "A")
        let orphan = UUID()
        stores.existing = [profile.websiteDataStoreID, orphan]
        await makeHost().sweepOrphanedDataStores()
        #expect(stores.removed == [orphan])
    }

    @Test func aSlowCheckForAServerTheUserLeftCannotOpenIt() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        client.gate(a.address.description)
        let host = makeHost()

        let slow = Task { await host.activate(a.id) }
        for await key in client.suspended where key == a.address.description { break }
        #expect(host.connection == .verifying(a))
        await host.activate(b.id)
        client.release(a.address.description)
        await slow.value

        #expect(host.page?.serverID == b.id)
        #expect(!stores.existing.contains(a.websiteDataStoreID))
        host.page?.close()
    }
}

/// Exercises real WebKit storage: the property the per-server design relies on.
@MainActor
@Suite(.serialized) struct WebsiteDataStoreIsolationTests {
    @Test func serversDoNotShareCookies() async throws {
        let stores = WebsiteDataStores()
        let first = UUID()
        let second = UUID()
        defer {
            Task { @MainActor in
                try? await stores.removeDataStore(for: first)
                try? await stores.removeDataStore(for: second)
            }
        }
        let cookie = try #require(HTTPCookie(properties: [
            .name: "tilecast_session", .value: "opaque", .domain: "signage.example.org", .path: "/",
        ]))
        let firstStore = stores.dataStore(for: first)
        let secondStore = stores.dataStore(for: second)
        await firstStore.httpCookieStore.setCookie(cookie)

        let firstCookies = await firstStore.httpCookieStore.allCookies()
        let secondCookies = await secondStore.httpCookieStore.allCookies()
        #expect(firstCookies.contains { $0.name == "tilecast_session" })
        #expect(!secondCookies.contains { $0.name == "tilecast_session" })
    }

    @Test func removingAStoreDeletesIt() async throws {
        let stores = WebsiteDataStores()
        let identifier = UUID()
        let cookie = try #require(HTTPCookie(properties: [
            .name: "tilecast_session", .value: "opaque", .domain: "signage.example.org", .path: "/",
        ]))
        do {
            let store = stores.dataStore(for: identifier)
            await store.httpCookieStore.setCookie(cookie)
            #expect(await store.httpCookieStore.allCookies().contains { $0.name == "tilecast_session" })
        }
        #expect(await stores.existingDataStoreIdentifiers().contains(identifier))

        try await stores.removeDataStore(for: identifier)
        #expect(await !stores.existingDataStoreIdentifiers().contains(identifier))
        let recreated = await stores.dataStore(for: identifier).httpCookieStore.allCookies()
        #expect(!recreated.contains { $0.name == "tilecast_session" })
        try? await stores.removeDataStore(for: identifier)
    }
}

@MainActor
@Suite struct StudioPageTests {
    func makePage(lastPath: String? = nil) throws -> StudioPage {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("A"))
        directory.recordStudioPath(lastPath, for: profile.id)
        return StudioPage(profile: directory.server(withID: profile.id)!, dataStore: .nonPersistent(),
                          applicationName: "TilecastTests")
    }

    @Test func keepsAtMostOneAuxiliaryPage() throws {
        let page = try makePage()
        page.handle(.openAuxiliary(URL(string: "https://signage.example.org/a")!))
        let auxiliary = try #require(page.auxiliaryPage)
        page.handle(.openAuxiliary(URL(string: "https://signage.example.org/b")!))
        #expect(page.auxiliaryPage === auxiliary)
        page.close()
        #expect(page.auxiliaryPage == nil)
    }

    @Test func queuesSystemEventsInOrder() throws {
        let page = try makePage()
        let external = URL(string: "https://docs.tilecast.org/")!
        page.handle(.openExternally(external))
        page.handle(.unsupportedDownload)
        page.handle(.cancel)
        #expect(page.takeEvents() == [.openExternally(external), .unsupportedDownload])
        #expect(page.takeEvents().isEmpty)
    }

    @Test func ignoresSupersededAndPolicyRefusedLoads() {
        #expect(StudioPage.failure(for: URLError(.cancelled)) == nil)
        #expect(StudioPage.failure(for: NSError(domain: "WebKitErrorDomain", code: 102)) == nil)
        #expect(StudioPage.failure(for: URLError(.cannotConnectToHost)) == .unreachable)
        #expect(StudioPage.failure(for: URLError(.serverCertificateUntrusted)) == .untrustedCertificate)
    }

    @Test func recoversFromContentProcessTerminationButNotALoop() throws {
        let page = try makePage()
        for _ in 0..<2 {
            page.handle(navigationError: WebPage.NavigationError.webContentProcessTerminated)
            #expect(page.phase == .loading)
        }
        page.handle(navigationError: WebPage.NavigationError.webContentProcessTerminated)
        #expect(page.phase == .failed(.contentProcessEnded))
        page.close()
    }
}
