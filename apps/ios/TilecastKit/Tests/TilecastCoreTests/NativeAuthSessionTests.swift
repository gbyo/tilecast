import Foundation
import Testing
@testable import TilecastCore

@Suite struct NativeAuthSessionTests {
    let server = FakeSessionServer()
    let store = InMemoryCredentialStore()
    let clock = TestClock()
    let key = NativeCredentialKey(serverID: UUID(), installationID: UUID())

    init() {
        let clock = clock
        server.now = { clock.now }
    }

    func makeSession() -> NativeAuthSession {
        let clock = clock
        return NativeAuthSession(
            key: key, address: address("signage.example.org"), exchanger: server, store: store,
            now: { clock.now }
        )
    }

    func signedIn() async throws -> NativeAuthSession {
        let session = makeSession()
        let result = try await session.completeSignIn(code: "code", verifier: "verifier")
        #expect(result.nativeAPIAvailable)
        return session
    }

    @Test func persistsOnlyTheRefreshToken() async throws {
        _ = try await signedIn()
        #expect(try store.storedKeys() == [key])
        #expect(try store.refreshToken(for: key) == "tcr_refresh1")
    }

    @Test func keepsTheAccessTokenInMemory() async throws {
        let session = try await signedIn()
        #expect(try await session.accessToken() == "tca_access1")
        #expect(server.refreshCalls.isEmpty)
    }

    /// A relaunch: the access token died with the old object, and the stored
    /// refresh token restores native access with one rotation.
    @Test func restoresAccessAfterRelaunchWithOneRotation() async throws {
        do { _ = try await signedIn() }
        let relaunched = makeSession()
        #expect(await relaunched.hasCredential)
        #expect(try await relaunched.accessToken() == "tca_access2")
        #expect(server.refreshCalls == [.init(token: "tcr_refresh1", studioSession: false)])
        #expect(try store.refreshToken(for: key) == "tcr_refresh2")
        #expect(try await relaunched.accessToken() == "tca_access2", "the rotated token is reused until it nears expiry")
        #expect(server.refreshCalls.count == 1)
    }

    @Test func concurrentCallersShareOneRotation() async throws {
        do { _ = try await signedIn() }
        let session = makeSession()
        let gate = Gate()
        server.refreshGate = gate
        let tokens = try await withThrowingTaskGroup(of: String.self) { group in
            for _ in 0..<10 { group.addTask { try await session.accessToken() } }
            // Let every caller reach the actor before the refresh answers.
            try await Task.sleep(for: .milliseconds(100))
            gate.open()
            return try await group.reduce(into: []) { $0.append($1) }
        }
        #expect(tokens == Array(repeating: "tca_access2", count: 10))
        #expect(server.refreshCalls.count == 1)
        #expect(!server.grantRevoked, "no refresh token was presented twice")
    }

    @Test func refreshesShortlyBeforeExpiry() async throws {
        let session = try await signedIn()
        clock.advance(900 - NativeAuthSession.expirySkew + 1)
        #expect(try await session.accessToken() == "tca_access2")
        #expect(server.refreshCalls.count == 1)
    }

    @Test func commitsTheNewRefreshTokenBeforeHandingOutAccess() async throws {
        do { _ = try await signedIn() }
        let session = makeSession()
        store.failsWrites = true
        await #expect(throws: NativeAuthError.unauthenticated) { try await session.accessToken() }
        // The server retired tcr_refresh1; a token held only in memory is
        // not kept. The user signs in again.
        #expect(try store.storedKeys().isEmpty)
    }

    @Test func aTransientFailureKeepsTheCredential() async throws {
        do { _ = try await signedIn() }
        let session = makeSession()
        server.failNextRefresh(with: .unavailable)
        await #expect(throws: NativeAuthError.unavailable) { try await session.accessToken() }
        #expect(try store.refreshToken(for: key) == "tcr_refresh1")
        #expect(try await session.accessToken() == "tca_access2")
    }

    @Test func aRefusedCredentialIsDeletedOnceWithoutRetrying() async throws {
        do { _ = try await signedIn() }
        let session = makeSession()
        server.revokeGrant()
        var events = session.events.makeAsyncIterator()
        await #expect(throws: NativeAuthError.unauthenticated) { try await session.accessToken() }
        #expect(await events.next() == .authenticationLost)
        #expect(try store.storedKeys().isEmpty)
        await #expect(throws: NativeAuthError.unauthenticated) { try await session.accessToken() }
        #expect(server.refreshCalls.count == 1, "no refresh loop after invalid_grant")
    }

    @Test func signOutDeletesLocallyAndRevokesInTheBackground() async throws {
        let session = try await signedIn()
        let revocation = await session.signOut()
        #expect(try store.storedKeys().isEmpty)
        await #expect(throws: NativeAuthError.unauthenticated) { try await session.accessToken() }
        await revocation.value
        #expect(server.revokedTokens == ["tcr_refresh1"])
    }

    @Test func aRotationInFlightCannotUndoASignOut() async throws {
        do { _ = try await signedIn() }
        let session = makeSession()
        let gate = Gate()
        server.refreshGate = gate
        let pending = Task { try await session.accessToken() }
        try await Task.sleep(for: .milliseconds(50))
        await session.signOut()
        gate.open()
        await #expect(throws: NativeAuthError.unauthenticated) { try await pending.value }
        #expect(try store.storedKeys().isEmpty, "the rotated token was not written back")
    }

    @Test func anOlderServerLeavesNativeAccessUnavailable() async throws {
        server.issuesCredentials = false
        let session = makeSession()
        let result = try await session.completeSignIn(code: "code", verifier: "verifier")
        #expect(!result.nativeAPIAvailable)
        #expect(result.cookie.name == "tilecast_session")
        #expect(try store.storedKeys().isEmpty)
        await #expect(throws: NativeAuthError.unauthenticated) { try await session.accessToken() }
        #expect(server.refreshCalls.isEmpty)
    }

    @Test func aKeychainFailureAtSignInStillSignsInToStudio() async throws {
        store.failsWrites = true
        let session = makeSession()
        let result = try await session.completeSignIn(code: "code", verifier: "verifier")
        #expect(!result.nativeAPIAvailable)
        await #expect(throws: NativeAuthError.unauthenticated) { try await session.accessToken() }
    }

    @Test func aNewSignInReplacesAndRevokesTheOldCredential() async throws {
        let session = try await signedIn()
        _ = try await session.completeSignIn(code: "code", verifier: "verifier")
        #expect(try store.refreshToken(for: key) == "tcr_refresh2")
        #expect(try await session.accessToken() == "tca_access2")
        try await Task.sleep(for: .milliseconds(50))
        #expect(server.revokedTokens == ["tcr_refresh1"])
    }

    @Test func renewingStudioWaitsForARotationInFlight() async throws {
        do { _ = try await signedIn() }
        let session = makeSession()
        let gate = Gate()
        server.refreshGate = gate
        async let access = session.accessToken()
        try await Task.sleep(for: .milliseconds(50))
        async let cookie = session.renewStudioSession()
        try await Task.sleep(for: .milliseconds(50))
        gate.open()
        #expect(try await access == "tca_access2")
        #expect((try await cookie).value == "renewed")
        #expect(server.refreshCalls == [
            .init(token: "tcr_refresh1", studioSession: false),
            .init(token: "tcr_refresh2", studioSession: true),
        ])
        #expect(server.maximumInFlight == 1)
        #expect(!server.grantRevoked)
    }

    @Test func discardDeletesWithoutContactingTheServer() async throws {
        let session = try await signedIn()
        await session.discard()
        #expect(try store.storedKeys().isEmpty)
        try await Task.sleep(for: .milliseconds(50))
        #expect(server.revokedTokens.isEmpty)
    }

    @Test func descriptionsRedactTheCredential() {
        let credential = NativeCredential(accessToken: "tca_secret", refreshToken: "tcr_secret", expiresAt: .now)
        var dumped = ""
        dump(credential, to: &dumped)
        for text in [String(describing: credential), String(reflecting: credential), dumped] {
            #expect(!text.contains("tca_secret") && !text.contains("tcr_secret"), "\(text)")
        }
    }
}

@Suite struct NativeCredentialStoreTests {
    @Test func isolatesServersAndInstallations() throws {
        let store = InMemoryCredentialStore()
        let a = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        let b = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        let rebound = NativeCredentialKey(serverID: a.serverID, installationID: UUID())
        try store.setRefreshToken("tcr_a", for: a)
        try store.setRefreshToken("tcr_b", for: b)
        #expect(try store.refreshToken(for: a) == "tcr_a")
        #expect(try store.refreshToken(for: rebound) == nil, "another installation at the same profile sees nothing")
        store.deleteRefreshTokens(forServer: a.serverID)
        #expect(try store.storedKeys() == [b])
        store.deleteRefreshTokens(except: [])
        #expect(try store.storedKeys().isEmpty)
    }

    @Test func roundTripsKeychainAccounts() {
        let key = NativeCredentialKey(serverID: UUID(), installationID: UUID())
        #expect(NativeCredentialKey(account: key.account) == key)
        #expect(NativeCredentialKey(account: "not-a-key") == nil)
        #expect(NativeCredentialKey(account: "\(UUID())/\(UUID())/extra") == nil)
    }
}
