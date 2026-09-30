import Foundation
import OpenAPIRuntime
import TilecastAPI

public enum NativeAuthError: Error, Equatable, Sendable {
    /// No native credential: it was never issued, the user signed out, or
    /// the server refused it. Only a new browser sign-in restores access.
    case unauthenticated
    /// The server could not be reached or could not answer now. The
    /// credential is kept, and a later call can succeed.
    case unavailable
}

public enum NativeAuthEvent: Equatable, Sendable {
    /// The server refused the credential, for example because the grant was
    /// revoked from account security, and the app deleted it.
    case authenticationLost
}

/// What a completed browser sign-in established.
public struct NativeSignInResult: Sendable {
    /// The Studio session cookie, for this server's WebKit data store only.
    public let cookie: HTTPCookie
    /// False for a server released before native API access, and when the
    /// refresh token could not be committed to the Keychain. Studio works
    /// either way.
    public let nativeAPIAvailable: Bool
}

/// The native API credential lifecycle for one verified server.
///
/// The access token and its expiry live in this actor's memory only; they
/// disappear with it. The refresh token lives in `store` and is read only
/// when a rotation needs it. Rotation is single-flight: every caller that
/// needs a new access token awaits the same rotation, because presenting a
/// rotated refresh token twice makes the server revoke the whole grant.
/// After a rotation, the new refresh token is committed to the store before
/// the new access token is handed to any caller.
public actor NativeAuthSession {
    /// How long before its expiry an access token is replaced.
    public static let expirySkew: TimeInterval = 60

    public nonisolated let key: NativeCredentialKey
    public nonisolated let address: ServerAddress
    /// Credential loss the host should act on.
    public nonisolated let events: AsyncStream<NativeAuthEvent>

    private let exchanger: any IOSSessionExchanging
    private let store: any NativeCredentialStore
    private let now: @Sendable () -> Date
    private let eventContinuation: AsyncStream<NativeAuthEvent>.Continuation

    private var access: (token: String, expiresAt: Date)?
    private var rotation: Task<Rotation, Never>?
    /// Incremented when the credential is replaced or deleted, so a rotation
    /// that was already in flight cannot write its result back.
    private var generation = 0

    private enum Rotation: Sendable {
        case rotated(accessToken: String, cookie: HTTPCookie?)
        case failed(NativeAuthError)
    }

    public init(
        key: NativeCredentialKey,
        address: ServerAddress,
        exchanger: any IOSSessionExchanging,
        store: any NativeCredentialStore,
        now: @escaping @Sendable () -> Date = { .now }
    ) {
        self.key = key
        self.address = address
        self.exchanger = exchanger
        self.store = store
        self.now = now
        (events, eventContinuation) = AsyncStream.makeStream(bufferingPolicy: .bufferingNewest(4))
    }

    deinit {
        eventContinuation.finish()
    }

    /// Whether a refresh token is stored for this server.
    public var hasCredential: Bool {
        ((try? store.refreshToken(for: key)) ?? nil) != nil
    }

    /// Redeems a browser authorization code. The refresh token is committed
    /// before native API access counts as established, and any credential
    /// from an earlier sign-in is replaced and revoked.
    public func completeSignIn(code: String, verifier: String) async throws(IOSSessionError) -> NativeSignInResult {
        let grant = try await exchanger.exchange(code: code, verifier: verifier)
        guard let cookie = grant.cookie else { throw .missingCookie }
        generation += 1
        access = nil
        let previous = (try? store.refreshToken(for: key)) ?? nil
        var available = false
        if let credential = grant.credential {
            do {
                try store.setRefreshToken(credential.refreshToken, for: key)
                access = (credential.accessToken, credential.expiresAt)
                available = true
            } catch {
                try? store.deleteRefreshToken(for: key)
            }
        } else {
            try? store.deleteRefreshToken(for: key)
        }
        if let previous, previous != grant.credential?.refreshToken {
            revokeInBackground(previous)
        }
        return NativeSignInResult(cookie: cookie, nativeAPIAvailable: available)
    }

    /// A current access token, rotating the refresh token first when the
    /// cached one is missing or close to expiry.
    public func accessToken() async throws(NativeAuthError) -> String {
        if let access, access.expiresAt.timeIntervalSince(now()) > Self.expirySkew {
            return access.token
        }
        if let rotation {
            // Share the rotation in flight instead of starting another.
            switch await rotation.value {
            case .rotated(let token, _): return token
            case .failed(let error): throw error
            }
        }
        switch await rotate(studioSession: false) {
        case .rotated(let token, _): return token
        case .failed(let error): throw error
        }
    }

    /// The server refused `token`. The next call rotates instead of reusing
    /// it; a token that was already replaced is ignored.
    public func accessTokenRejected(_ token: String) {
        if access?.token == token { access = nil }
    }

    /// Starts a new Studio session from the native credential, for when
    /// Studio's own session ended but the app authorization did not. The
    /// rotation is the same single-flight rotation API calls use.
    public func renewStudioSession() async throws(NativeAuthError) -> HTTPCookie {
        // Another rotation may start while this one waits, so wait until
        // none is in flight. `rotate` claims the slot without suspending.
        while let rotation { _ = await rotation.value }
        switch await rotate(studioSession: true) {
        case .rotated(_, let cookie?): return cookie
        case .rotated(_, nil): throw .unavailable
        case .failed(let error): throw error
        }
    }

    /// Signs the app out of this server. The local credential is deleted at
    /// once; revoking the grant on the server is best effort and finishes
    /// in the returned task, so sign-out also works offline.
    @discardableResult
    public func signOut() -> Task<Void, Never> {
        let refreshToken = forget()
        guard let refreshToken else { return Task {} }
        return revokeInBackground(refreshToken)
    }

    /// Deletes the local credential without contacting the server, for an
    /// address that now serves another installation.
    public func discard() {
        _ = forget()
    }

    /// A generated Tilecast API client whose requests authenticate with this
    /// session's bearer token and nothing else.
    public nonisolated func makeClient(transport: any ClientTransport = NativeAPITransport.makeTransport()) -> Client {
        NativeAPITransport.client(
            for: address,
            transport: transport,
            middlewares: [BearerAuthenticationMiddleware(session: self)]
        )
    }

    // MARK: Rotation

    private func rotate(studioSession: Bool) async -> Rotation {
        let task = Task { await performRotation(studioSession: studioSession) }
        rotation = task
        return await task.value
    }

    private func performRotation(studioSession: Bool) async -> Rotation {
        defer { rotation = nil }
        let started = generation
        let stored: String?
        do {
            stored = try store.refreshToken(for: key)
        } catch {
            return .failed(.unavailable)
        }
        guard let refreshToken = stored else {
            access = nil
            return .failed(.unauthenticated)
        }
        let grant: IOSSessionGrant
        do {
            grant = try await exchanger.refresh(refreshToken: refreshToken, studioSession: studioSession)
        } catch .rejected {
            guard started == generation else { return .failed(.unauthenticated) }
            loseAuthentication()
            return .failed(.unauthenticated)
        } catch {
            return .failed(.unavailable)
        }
        // Signed out or signed in again while the request was in flight.
        guard started == generation, let credential = grant.credential else { return .failed(.unauthenticated) }
        do {
            try store.setRefreshToken(credential.refreshToken, for: key)
        } catch {
            // The server already retired the old token, and the new one
            // cannot be kept. Requiring a new sign-in is safer than holding
            // a refresh token only in memory.
            loseAuthentication()
            return .failed(.unauthenticated)
        }
        access = (credential.accessToken, credential.expiresAt)
        return .rotated(accessToken: credential.accessToken, cookie: grant.cookie)
    }

    private func loseAuthentication() {
        _ = forget()
        eventContinuation.yield(.authenticationLost)
    }

    /// Drops the access token and deletes the refresh token, returning the
    /// refresh token so the caller can revoke it.
    private func forget() -> String? {
        generation += 1
        access = nil
        let refreshToken = (try? store.refreshToken(for: key)) ?? nil
        try? store.deleteRefreshToken(for: key)
        return refreshToken
    }

    @discardableResult
    private nonisolated func revokeInBackground(_ token: String) -> Task<Void, Never> {
        Task.detached { [exchanger] in await exchanger.revoke(token: token) }
    }
}
