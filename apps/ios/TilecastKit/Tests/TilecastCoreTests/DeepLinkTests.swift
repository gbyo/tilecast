import Foundation
import Testing
@testable import TilecastCore

@Suite struct DeepLinkParsingTests {
    let installation = UUID(uuidString: "8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e")!

    func url(_ query: String, host: String = "open", scheme: String = "tilecast-ios") -> URL {
        URL(string: "\(scheme)://\(host)?\(query)")!
    }

    @Test func readsAnInstallationAndAStudioPath() throws {
        let link = try #require(DeepLink(installationID: installation, path: "/screens/screen-1?tab=activity#top"))
        let built = try #require(link.url)
        #expect(DeepLink.parse(built) == .link(link))
        #expect(DeepLink.parse(url("installation=8F1C7F5E-3A3B-4A53-9A57-9B1C1F0A7F3E&path=%2Fscreens")) == .link(DeepLink(installationID: installation, path: "/screens")!))
    }

    @Test func aBuiltURLNeverPutsThePathInTheHostPositionOrLeaksSecrets() throws {
        let link = try #require(DeepLink(installationID: installation, path: "/a?b=c&d=e"))
        let built = try #require(link.url).absoluteString
        #expect(built.hasPrefix("tilecast-ios://open?"))
        #expect(built.contains("path=/a?b%3Dc%26d%3De") || built.contains("path=%2Fa"))
        for forbidden in ["token", "cookie", "csrf", "password", "http"] { #expect(!built.localizedCaseInsensitiveContains(forbidden)) }
        #expect(DeepLink.parse(URL(string: built)!) == .link(link))
    }

    /// The OAuth callback shares the scheme. This resolver never handles it.
    @Test func ignoresTheOAuthCallback() {
        #expect(DeepLink.parse(URL(string: "tilecast-ios://oauth/callback?code=x&state=y")!) == .notForOpening)
        #expect(DeepLink.parse(URL(string: "https://open?installation=x")!) == .notForOpening)
        #expect(DeepLink.parse(URL(string: "tilecast://open?installation=x")!) == .notForOpening)
    }

    @Test(arguments: [
        "path=%2Fscreens",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e",
        "installation=not-a-uuid&path=%2Fscreens",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=screens",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2F%2Fevil.example",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=https%3A%2F%2Fevil.example%2F",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=javascript%3Aalert(1)",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fscreens%2F..%2F..%2Fsettings",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fscreens%5Cevil",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fscreens%00",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fscreens%0A",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2F__native%2Fmodal",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Flogin",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fsetup",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Foauth%2Fapprove%3Fx%3D1",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fscreens",
        "installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fscreens&path=%2Fmedia",
    ])
    func refusesAnUnsafeLink(_ query: String) {
        #expect(DeepLink.parse(url(query)) == .invalid)
    }

    @Test func refusesAnOversizedOrAnnotatedLink() {
        let long = "/" + String(repeating: "a", count: 4100)
        let encoded = long.addingPercentEncoding(withAllowedCharacters: .alphanumerics)!
        #expect(DeepLink.parse(url("installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=\(encoded)")) == .invalid)
        #expect(DeepLink.parse(URL(string: "tilecast-ios://user@open?installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fa")!) == .invalid)
        #expect(DeepLink.parse(URL(string: "tilecast-ios://open/extra?installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fa")!) == .invalid)
        #expect(DeepLink.parse(URL(string: "tilecast-ios://open?installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fa#frag")!) == .invalid)
    }

    @Test func refusesToBuildALinkForAForbiddenPath() {
        #expect(DeepLink(installationID: installation, path: "/login") == nil)
        #expect(DeepLink(installationID: installation, path: "//evil.example") == nil)
    }

    @Test func ignoresParametersItDoesNotKnow() {
        let link = DeepLink.parse(url("installation=8f1c7f5e-3a3b-4a53-9a57-9b1c1f0a7f3e&path=%2Fscreens&from=notification"))
        #expect(link == .link(DeepLink(installationID: installation, path: "/screens")!))
    }
}

/// The resolver in `StudioHost`: which installation a link opens, and when
/// its path reaches Studio.
@MainActor
@Suite struct DeepLinkResolverTests {
    let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
    let stores = FakeDataStores()
    let client = FakeIdentityClient()
    let credentials = InMemoryCredentialStore()

    func makeHost() -> StudioHost {
        StudioHost(directory: directory, dataStores: stores, identityClient: client, credentials: credentials, applicationName: "TilecastTests")
    }

    func addServer(_ host: String, name: String) throws -> ServerProfile {
        let identity = identity(name)
        let profile = try directory.add(address: address(host), identity: identity)
        client.answers[profile.address.description] = .success(identity)
        return profile
    }

    func link(_ profile: ServerProfile, _ path: String = "/screens/screen-1") -> DeepLink {
        DeepLink(installationID: profile.installationID, path: path)!
    }

    /// Records what the host delivers, instead of running JavaScript.
    final class Deliveries {
        var paths: [String] = []
        var accept = true
    }

    func record(_ host: StudioHost) -> Deliveries {
        let deliveries = Deliveries()
        host.deepLinkDelivery = { _, path in
            deliveries.paths.append(path)
            return deliveries.accept
        }
        return deliveries
    }

    /// What Studio does when it boots signed in: negotiate, report the
    /// capabilities, and publish its catalog.
    func sender(_ page: StudioPage) -> BridgeSender {
        BridgeSender(isMainFrame: true, isPageWorld: true, origin: page.address.origin)
    }

    func studioBecomesReady(_ page: StudioPage, deepLinks: Bool = true, catalog: Bool = true) {
        let sender = sender(page)
        _ = page.bridge.replyValue(to: envelope("config/get"), from: sender)
        _ = page.bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["deepLinks": deepLinks]]), from: sender)
        if catalog { _ = page.bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: sender) }
    }

    func settle() async {
        for _ in 0..<20 { await Task.yield() }
    }

    @Test func aWarmLinkGoesToTheReadyStudioOfTheActiveServer() async throws {
        let profile = try addServer("a.example.org", name: "A")
        directory.activate(profile.id)
        let host = makeHost()
        await host.start()
        let deliveries = record(host)
        let page = try #require(host.page)

        await host.open(link(profile))
        #expect(deliveries.paths.isEmpty, "Studio has not reported ready")
        studioBecomesReady(page)
        await settle()
        #expect(deliveries.paths == ["/screens/screen-1"])
        page.close()
    }

    @Test func aColdLinkOpensItsServerFirstAndWaitsForStudio() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        directory.activate(a.id)
        let host = makeHost()
        let deliveries = record(host)
        // The link arrives before launch has connected anything.
        await host.open(link(b, "/media"))
        #expect(host.page == nil)
        #expect(deliveries.paths.isEmpty)

        await host.start()
        let page = try #require(host.page)
        #expect(page.serverID == b.id, "launch opens the linked installation, not the last active one")
        #expect(deliveries.paths.isEmpty, "the page is not ready yet")
        studioBecomesReady(page)
        await settle()
        #expect(deliveries.paths == ["/media"])
        page.close()
    }

    @Test func aLinkForAnotherInstallationSwitchesServersAndVerifiesItFirst() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        let host = makeHost()
        await host.start()
        await host.activate(a.id)
        let deliveries = record(host)
        let first = try #require(host.page)
        studioBecomesReady(first)

        await host.open(link(b))
        let second = try #require(host.page)
        #expect(second.serverID == b.id)
        #expect(deliveries.paths.isEmpty, "nothing reaches the old page or the new page before it is ready")
        studioBecomesReady(second)
        await settle()
        #expect(deliveries.paths == ["/screens/screen-1"])
        second.close()
    }

    @Test func aLinkForAnInstallationThatChangedIsDropped() async throws {
        let a = try addServer("a.example.org", name: "A")
        client.answers[a.address.description] = .success(identity("Somebody Else"))
        let host = makeHost()
        await host.start()
        let deliveries = record(host)

        await host.open(link(a))
        #expect(host.page == nil)
        if case .identityChanged = host.connection {} else { Issue.record("expected the identity-changed state") }
        #expect(deliveries.paths.isEmpty)
        #expect(stores.existing.isEmpty, "no page opened the old installation's data store")
    }

    @Test func anUnknownInstallationShowsANoticeAndContactsNoOne() async throws {
        let a = try addServer("a.example.org", name: "A")
        directory.activate(a.id)
        let host = makeHost()
        await host.start()
        let deliveries = record(host)
        let identityRequests = client.answers.count
        let unknown = DeepLink(installationID: UUID(), path: "/screens")!

        await host.open(unknown)
        #expect(host.deepLinkNotice == .notConfigured)
        #expect(host.page?.serverID == a.id, "the active server stays as it was")
        #expect(directory.servers.count == 1, "an untrusted link never adds a server")
        #expect(client.answers.count == identityRequests)
        studioBecomesReady(try #require(host.page))
        await settle()
        #expect(deliveries.paths.isEmpty)
        host.dismissDeepLinkNotice()
        #expect(host.deepLinkNotice == nil)
        host.page?.close()
    }

    @Test func aMalformedURLShowsAnUnopenableNotice() async throws {
        let host = makeHost()
        await host.open(URL(string: "tilecast-ios://open?installation=x&path=%2Flogin")!)
        #expect(host.deepLinkNotice == .unopenable)
        await host.open(URL(string: "tilecast-ios://oauth/callback?code=1&state=2")!)
        #expect(host.deepLinkNotice == .unopenable, "the OAuth callback changes nothing")
    }

    @Test func aLinkWaitsForAStudioThatReportedTheCapability() async throws {
        let profile = try addServer("a.example.org", name: "A")
        directory.activate(profile.id)
        let host = makeHost()
        await host.start()
        let deliveries = record(host)
        let page = try #require(host.page)
        await host.open(link(profile))
        studioBecomesReady(page, deepLinks: false)
        await settle()
        #expect(deliveries.paths.isEmpty, "an older Studio does not report deepLinks")
        // A newer Studio reports it after a reload of the same page.
        studioBecomesReady(page)
        await settle()
        #expect(deliveries.paths == ["/screens/screen-1"])
        page.close()
    }

    @Test func aLinkWaitsThroughSignInAndNeverGoesToTheLoginPage() async throws {
        let profile = try addServer("a.example.org", name: "A")
        directory.activate(profile.id)
        let host = makeHost()
        await host.start()
        let deliveries = record(host)
        let page = try #require(host.page)
        // Signed out: Studio has no catalog, so it cannot take a link.
        studioBecomesReady(page, catalog: false)
        await host.open(link(profile))
        await settle()
        #expect(deliveries.paths.isEmpty)
        _ = page.bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: sender(page))
        await settle()
        #expect(deliveries.paths == ["/screens/screen-1"])
        page.close()
    }

    @Test func deliversOnceAndOnlyWhenStudioAcceptsIt() async throws {
        let profile = try addServer("a.example.org", name: "A")
        directory.activate(profile.id)
        let host = makeHost()
        await host.start()
        let deliveries = record(host)
        deliveries.accept = false
        let page = try #require(host.page)
        studioBecomesReady(page)
        await host.open(link(profile))
        try await Task.sleep(for: .milliseconds(900))
        #expect(deliveries.paths.count > 1, "the host retries while Studio's router is not listening yet")
        deliveries.accept = true
        try await Task.sleep(for: .milliseconds(2000))
        let delivered = deliveries.paths.count
        // A later readiness change does not deliver it again.
        studioBecomesReady(page)
        await settle()
        #expect(deliveries.paths.count == delivered)
        page.close()
    }

    @Test func aServerSwitchEndsALinkForTheOldServer() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        let host = makeHost()
        await host.start()
        await host.activate(a.id)
        let deliveries = record(host)
        await host.open(link(a))
        // The person opens B before A's Studio was ready.
        await host.activate(b.id)
        let page = try #require(host.page)
        studioBecomesReady(page)
        await settle()
        #expect(deliveries.paths.isEmpty)
        page.close()
    }

    @Test func aLinkExpires() async throws {
        let profile = try addServer("a.example.org", name: "A")
        directory.activate(profile.id)
        let clock = TestClock()
        let host = StudioHost(
            directory: directory, dataStores: stores, identityClient: client, credentials: credentials,
            applicationName: "TilecastTests", now: { clock.now }
        )
        await host.start()
        let deliveries = record(host)
        let page = try #require(host.page)
        await host.open(link(profile))
        clock.advance(StudioHost.deepLinkLifetime + 1)
        studioBecomesReady(page)
        await settle()
        #expect(deliveries.paths.isEmpty)
        page.close()
    }

    @Test func removingTheServerEndsItsLink() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        let host = makeHost()
        await host.start()
        await host.activate(a.id)
        let deliveries = record(host)
        await host.open(link(a))
        await host.remove(a.id)
        let page = try #require(host.page)
        #expect(page.serverID == b.id)
        studioBecomesReady(page)
        await settle()
        #expect(deliveries.paths.isEmpty)
        page.close()
    }
}
