import Foundation
import Testing
import WebKit
@testable import TilecastCore

/// The native credential's lifecycle across server profiles, installation
/// changes, sign-in, and sign-out.
@MainActor
@Suite struct StudioHostAuthenticationTests {
    let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
    let stores = FakeDataStores()
    let client = FakeIdentityClient()
    let credentials = InMemoryCredentialStore()
    /// One fake server per address, so a test sees which installation a
    /// credential was presented to.
    let servers = SessionServers()

    final class SessionServers: @unchecked Sendable {
        private let lock = NSLock()
        private var byHost: [String: FakeSessionServer] = [:]
        subscript(host: String) -> FakeSessionServer {
            lock.withLock {
                if let server = byHost[host] { return server }
                let server = FakeSessionServer(host: host)
                byHost[host] = server
                return server
            }
        }
    }

    func makeHost() -> StudioHost {
        let servers = servers
        return StudioHost(
            directory: directory, dataStores: stores, identityClient: client, credentials: credentials,
            sessionService: { servers[$0.host] }, applicationName: "TilecastTests"
        )
    }

    func addServer(_ host: String) throws -> ServerProfile {
        let identity = identity(host)
        let profile = try directory.add(address: address(host), identity: identity)
        client.answers[profile.address.description] = .success(identity)
        return profile
    }

    /// A completed system-browser sign-in for the connected server.
    func signIn(_ host: StudioHost) async throws -> StudioPage {
        let page = try #require(host.page)
        try await host.completeSignIn(code: "code", verifier: "verifier", for: page)
        return page
    }

    func cookies(_ page: StudioPage) async -> [String] {
        await page.websiteDataStore.httpCookieStore.allCookies().map(\.value).sorted()
    }

    @Test func signInImportsTheCookieAndKeepsTheRefreshToken() async throws {
        let profile = try addServer("a.example.org")
        let host = makeHost()
        await host.activate(profile.id)
        let page = try await signIn(host)
        #expect(await cookies(page) == ["studio-session"])
        #expect(try credentials.refreshToken(for: NativeCredentialKey(profile: profile)) == "tcr_refresh1")
        #expect(try await host.nativeAuth?.accessToken() == "tca_access1")
        page.close()
    }

    @Test func anOlderServerSignsInToStudioOnly() async throws {
        let profile = try addServer("old.example.org")
        servers["old.example.org"].issuesCredentials = false
        let host = makeHost()
        await host.activate(profile.id)
        let page = try await signIn(host)
        #expect(await cookies(page) == ["studio-session"])
        #expect(try credentials.storedKeys().isEmpty)
        #expect(page.phase == .loading, "Studio reloads signed in")
        page.close()
    }

    @Test func removingAServerDeletesItsCredential() async throws {
        let a = try addServer("a.example.org")
        let b = try addServer("b.example.org")
        let host = makeHost()
        await host.activate(a.id)
        _ = try await signIn(host)
        try credentials.setRefreshToken("tcr_other", for: NativeCredentialKey(profile: b))

        await host.remove(a.id)
        #expect(try credentials.storedKeys() == [NativeCredentialKey(profile: b)])
        try await Task.sleep(for: .milliseconds(50))
        #expect(servers["a.example.org"].revokedTokens == ["tcr_refresh1"], "revoked at the verified server")

        await host.remove(b.id)
        #expect(try credentials.storedKeys().isEmpty)
        #expect(servers["b.example.org"].revokedTokens.isEmpty, "an unverified server is never sent a credential")
    }

    @Test func acceptingANewInstallationDeletesTheOldCredentialFirst() async throws {
        let profile = try addServer("a.example.org")
        let host = makeHost()
        await host.activate(profile.id)
        _ = try await signIn(host)
        let replacement = identity("Reinstalled")
        client.answers[profile.address.description] = .success(replacement)
        await host.retry()
        #expect(host.connection == .identityChanged(profile, found: replacement))
        #expect(host.nativeAuth == nil, "no native session for an unverified installation")

        try await host.trustNewInstallation(profile.id, identity: replacement)
        #expect(try credentials.storedKeys().isEmpty)
        #expect(servers["a.example.org"].revokedTokens.isEmpty, "the new installation never sees the old credential")
        let rebound = try #require(directory.server(withID: profile.id))
        #expect(host.nativeAuth?.key == NativeCredentialKey(profile: rebound))
        #expect(host.nativeAuth?.key.installationID == replacement.installationID)
        await #expect(throws: NativeAuthError.unauthenticated) { try await host.nativeAuth?.accessToken() }
        #expect(servers["a.example.org"].refreshCalls.isEmpty)
        host.page?.close()
    }

    @Test func sweepsCredentialsNoProfileOwns() async throws {
        let profile = try addServer("a.example.org")
        let owned = NativeCredentialKey(profile: profile)
        let orphan = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        let staleInstallation = NativeCredentialKey(serverID: profile.id, installationID: UUID())
        for key in [owned, orphan, staleInstallation] { try credentials.setRefreshToken("tcr_\(key)", for: key) }
        let host = makeHost()
        await host.start()
        #expect(try credentials.storedKeys() == [owned])
        host.page?.close()
    }

    @Test func switchingServersNeverCrossesCredentials() async throws {
        let a = try addServer("a.example.org")
        let b = try addServer("b.example.org")
        let host = makeHost()
        await host.activate(a.id)
        _ = try await signIn(host)
        await host.activate(b.id)
        #expect(host.nativeAuth?.key == NativeCredentialKey(profile: b))
        await #expect(throws: NativeAuthError.unauthenticated) { try await host.nativeAuth?.accessToken() }
        #expect(servers["b.example.org"].refreshCalls.isEmpty, "A's refresh token never reaches B")

        await host.activate(a.id)
        #expect(try await host.nativeAuth?.accessToken() == "tca_access2")
        #expect(servers["a.example.org"].refreshCalls.map(\.token) == ["tcr_refresh1"])
        host.page?.close()
    }

    @Test func studioSignOutDeletesTheCredentialAndWaitsForTheUser() async throws {
        let profile = try addServer("a.example.org")
        let host = makeHost()
        await host.activate(profile.id)
        let page = try await signIn(host)

        host.studioSignedOut(page)
        #expect(directory.server(withID: profile.id)?.signedOutAt != nil)
        try await Task.sleep(for: .milliseconds(50))
        #expect(try credentials.storedKeys().isEmpty)
        #expect(servers["a.example.org"].revokedTokens == ["tcr_refresh1"])

        // Studio reaches its sign-in page: no browser sheet opens by itself.
        #expect(await host.resumeSession(for: page) == .waitForUser)

        // Choosing Sign In completes normally and clears the sign-out.
        try await host.completeSignIn(code: "code", verifier: "verifier", for: page)
        #expect(directory.server(withID: profile.id)?.signedOutAt == nil)
        page.close()
    }

    @Test func nativeSignOutWorksOffline() async throws {
        let profile = try addServer("a.example.org")
        let host = makeHost()
        await host.activate(profile.id)
        let page = try await signIn(host)
        // No Studio answers the bridge here, as when the server is offline.
        await host.signOut()
        #expect(try credentials.storedKeys().isEmpty)
        #expect(await cookies(page).isEmpty)
        #expect(directory.server(withID: profile.id)?.signedOutAt != nil)
        #expect(await host.resumeSession(for: page) == .waitForUser)
        page.close()
    }

    @Test func anExpiredStudioSessionRenewsFromTheNativeCredential() async throws {
        let profile = try addServer("a.example.org")
        let host = makeHost()
        await host.activate(profile.id)
        let page = try await signIn(host)

        #expect(await host.resumeSession(for: page) == .signedIn)
        #expect(await cookies(page) == ["renewed"])
        #expect(servers["a.example.org"].refreshCalls == [.init(token: "tcr_refresh1", studioSession: true)])
        page.close()
    }

    @Test func aRefusedRenewalFallsBackToTheBrowser() async throws {
        let profile = try addServer("a.example.org")
        let host = makeHost()
        await host.activate(profile.id)
        let page = try await signIn(host)
        servers["a.example.org"].revokeGrant()
        #expect(await host.resumeSession(for: page) == .presentBrowser)
        #expect(try credentials.storedKeys().isEmpty)
        page.close()
    }

    @Test func withoutACredentialStudioUsesTheBrowser() async throws {
        let profile = try addServer("a.example.org")
        let host = makeHost()
        await host.activate(profile.id)
        let page = try #require(host.page)
        #expect(await host.resumeSession(for: page) == .presentBrowser)
        #expect(servers["a.example.org"].refreshCalls.isEmpty)
        page.close()
    }

    @Test func aPageThatIsNoLongerCurrentCannotSignIn() async throws {
        let a = try addServer("a.example.org")
        let b = try addServer("b.example.org")
        let host = makeHost()
        await host.activate(a.id)
        let old = try #require(host.page)
        await host.activate(b.id)
        await #expect(throws: IOSSignInError.invalidCallback) {
            try await host.completeSignIn(code: "code", verifier: "verifier", for: old)
        }
        #expect(try credentials.storedKeys().isEmpty)
        host.page?.close()
    }

    @Test func matchesOnlyThisServersCookies() {
        let server = address("a.example.org")
        #expect(StudioHost.cookie(studioCookie(host: "a.example.org"), belongsTo: server))
        #expect(StudioHost.cookie(studioCookie(host: ".a.example.org"), belongsTo: server))
        #expect(!StudioHost.cookie(studioCookie(host: "video.example.com"), belongsTo: server))
    }
}
