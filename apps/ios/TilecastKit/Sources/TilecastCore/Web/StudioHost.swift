import Foundation
import Observation
import WebKit

/// What the app does when Studio needs a signed-in session.
public enum SignInStep: Equatable, Sendable {
    /// Show the Sign In control and wait: the user signed out explicitly.
    case waitForUser
    /// Open the system sign-in sheet.
    case presentBrowser
    /// The native credential started a new Studio session; Studio reloads.
    case signedIn
}

/// Owns the single main Studio page for the active server.
///
/// Only one main `StudioPage` exists at a time. Switching servers closes the
/// old page before the new one is built. Before any page loads, the host
/// re-reads the server's public installation identity: if the address now
/// serves a different installation, Studio is not loaded, so the old
/// installation's session cookie is never sent to it.
///
/// The host also owns the connected server's `NativeAuthSession`. It exists
/// only after the identity check passed, and it is bound to that profile,
/// installation, and address, so a native credential is never presented to
/// another installation.
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
    /// The native API credential lifecycle for the connected server.
    public private(set) var nativeAuth: NativeAuthSession?

    @ObservationIgnored private let dataStores: any WebsiteDataStoreManaging
    @ObservationIgnored private let identityClient: any InstallationIdentityFetching
    @ObservationIgnored private let credentials: any NativeCredentialStore
    @ObservationIgnored private let sessionService: @Sendable (ServerAddress) -> any IOSSessionExchanging
    @ObservationIgnored private let applicationName: String
    /// Incremented on every activation so a slow identity check for a
    /// server the user already left cannot build a page.
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var nativeAuthEvents: Task<Void, Never>?

    public init(
        directory: ServerDirectory,
        dataStores: any WebsiteDataStoreManaging,
        identityClient: any InstallationIdentityFetching,
        credentials: any NativeCredentialStore,
        sessionService: @escaping @Sendable (ServerAddress) -> any IOSSessionExchanging = { IOSSessionClient(address: $0) },
        applicationName: String
    ) {
        self.directory = directory
        self.dataStores = dataStores
        self.identityClient = identityClient
        self.credentials = credentials
        self.sessionService = sessionService
        self.applicationName = applicationName
    }

    public var page: StudioPage? {
        if case .connected(let page) = connection { page } else { nil }
    }

    /// Opens the directory's active server, if any.
    public func start() async {
        sweepOrphanedCredentials()
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
        // The grant is revoked only through a session whose installation was
        // verified in this connection; other credentials are deleted locally.
        if let nativeAuth, nativeAuth.key.serverID == id { await nativeAuth.signOut() }
        if wasActive { closePage() }
        guard let removed = directory.remove(id) else { return }
        credentials.deleteRefreshTokens(forServer: removed.id)
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
        // Never sent anywhere: the address now belongs to another installation.
        credentials.deleteRefreshTokens(forServer: id)
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

    /// Deletes native credentials no profile owns: a removed profile, an
    /// installation a profile was rebound away from, or a Keychain item
    /// that outlived an earlier installation of the app.
    public func sweepOrphanedCredentials() {
        credentials.deleteRefreshTokens(except: directory.knownCredentialKeys)
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
            let auth = NativeAuthSession(
                key: NativeCredentialKey(profile: current),
                address: current.address,
                exchanger: sessionService(current.address),
                store: credentials
            )
            page.bridge.onSignedOut = { [weak self, weak page] in
                if let self, let page { self.studioSignedOut(page) }
            }
            nativeAuth = auth
            watch(auth, page: page)
            connection = .connected(page)
            page.start()
        }
    }

    // MARK: Authentication

    /// Decides what happens when Studio reaches its sign-in page. After an
    /// explicit sign-out the app waits for the user. Otherwise a stored
    /// native credential starts a new Studio session without the browser,
    /// and anything else opens the system sign-in sheet.
    public func resumeSession(for page: StudioPage) async -> SignInStep {
        guard page === self.page, let profile = directory.server(withID: page.serverID) else { return .waitForUser }
        if profile.signedOutAt != nil { return .waitForUser }
        guard let auth = nativeAuth, await auth.hasCredential else { return .presentBrowser }
        let cookie: HTTPCookie
        do {
            cookie = try await auth.renewStudioSession()
        } catch {
            return .presentBrowser
        }
        guard page === self.page, !page.isClosed else { return .waitForUser }
        await page.websiteDataStore.httpCookieStore.setCookie(cookie)
        guard page === self.page, !page.isClosed else { return .waitForUser }
        page.resumeAfterSignIn()
        return .signedIn
    }

    /// Completes a system-browser sign-in whose callback already passed its
    /// state and issuer checks: redeems the code, keeps the native
    /// credential, imports the Studio cookie into only this server's data
    /// store, and reloads Studio.
    public func completeSignIn(code: String, verifier: String, for page: StudioPage) async throws(IOSSignInError) {
        guard page === self.page, !page.isClosed, let auth = nativeAuth else { throw .invalidCallback }
        let result: NativeSignInResult
        do {
            result = try await auth.completeSignIn(code: code, verifier: verifier)
        } catch .missingCookie {
            throw .missingCookie
        } catch {
            throw .serverRejected
        }
        guard page === self.page, !page.isClosed else { throw .invalidCallback }
        await page.websiteDataStore.httpCookieStore.setCookie(result.cookie)
        guard page === self.page, !page.isClosed else { throw .invalidCallback }
        directory.recordSignIn(page.serverID)
        page.resumeAfterSignIn()
    }

    /// Signs the app out of the active server: the native credential
    /// first, then Studio's own logout when Studio supports the request,
    /// then this server's session cookies. The local credential is deleted
    /// before waiting on Studio, so ending the app during the bridge wait
    /// still leaves the user signed out. Studio logout and remote
    /// revocation are best effort. Other website data stays.
    public func signOut() async {
        guard let page else { return }
        directory.recordSignOut(page.serverID)
        if let nativeAuth, nativeAuth.key.serverID == page.serverID { await nativeAuth.signOut() }
        _ = await page.bridge.requestSignOut()
        guard page === self.page, !page.isClosed else { return }
        let cookies = page.websiteDataStore.httpCookieStore
        for cookie in await cookies.allCookies() where Self.cookie(cookie, belongsTo: page.address) {
            await cookies.deleteCookie(cookie)
        }
        guard page === self.page, !page.isClosed else { return }
        page.reload()
    }

    static func cookie(_ cookie: HTTPCookie, belongsTo address: ServerAddress) -> Bool {
        let domain = cookie.domain.hasPrefix(".") ? String(cookie.domain.dropFirst()) : cookie.domain
        return domain.lowercased() == address.host.lowercased()
    }

    /// Studio signed out by itself, from its account menu.
    func studioSignedOut(_ page: StudioPage) {
        guard page === self.page else { return }
        directory.recordSignOut(page.serverID)
        if let nativeAuth { Task { await nativeAuth.signOut() } }
    }

    /// The server refused the native credential while Studio still looked
    /// signed in, for example after the grant was revoked from account
    /// security. The app authorization is over, so Studio signs out too.
    private func watch(_ auth: NativeAuthSession, page: StudioPage) {
        nativeAuthEvents?.cancel()
        nativeAuthEvents = Task { [weak self] in
            for await event in auth.events {
                guard let self, auth === self.nativeAuth, page === self.page else { return }
                switch event {
                case .authenticationLost:
                    guard !page.signInRequired else { continue }
                    directory.recordSignOut(page.serverID)
                    if await !page.bridge.requestSignOut(), page === self.page { page.reload() }
                }
            }
        }
    }

    private func closePage() {
        generation += 1
        nativeAuthEvents?.cancel()
        nativeAuthEvents = nil
        nativeAuth = nil
        guard let page else { return }
        directory.recordStudioPath(page.currentStudioPath, for: page.serverID)
        page.close()
        connection = .noServer
    }
}
