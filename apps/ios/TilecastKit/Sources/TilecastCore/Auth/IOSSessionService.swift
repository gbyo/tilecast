import Foundation
import OpenAPIRuntime
import TilecastAPI

/// A native OAuth credential as the server issued it. Only the refresh
/// token is ever persisted, and only in the Keychain. Descriptions redact
/// both secrets, so a credential printed by mistake reveals nothing.
public struct NativeCredential: Sendable, Equatable, CustomStringConvertible, CustomReflectable {
    public let accessToken: String
    public let refreshToken: String
    public let expiresAt: Date

    public init(accessToken: String, refreshToken: String, expiresAt: Date) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
    }

    public var description: String { "NativeCredential(expiresAt: \(expiresAt))" }
    public var customMirror: Mirror { Mirror(self, children: ["expiresAt": expiresAt]) }
}

/// What one successful `/api/v1/oauth/ios-session` call produced.
public struct IOSSessionGrant: Sendable {
    /// The Studio session cookie, when the response set one.
    public let cookie: HTTPCookie?
    /// Nil from a server released before native API access.
    public let credential: NativeCredential?
}

public enum IOSSessionError: Error, Equatable, Sendable {
    /// The server refused the code or refresh token, or the account cannot
    /// sign in. Retrying the same request cannot succeed.
    case rejected
    /// The request did not complete or the server could not answer now:
    /// offline, a timeout, a redirect, a server error, or rate limiting.
    case unavailable
    /// A sign-in response without the Studio session cookie.
    case missingCookie
}

/// Calls the Tilecast for iOS bootstrap endpoint. It never sends cookies
/// and never follows redirects; see `NativeAPITransport`.
public protocol IOSSessionExchanging: Sendable {
    /// Redeems a browser authorization code with its PKCE verifier.
    func exchange(code: String, verifier: String) async throws(IOSSessionError) -> IOSSessionGrant
    /// Rotates a refresh token. With `studioSession`, the server also starts
    /// a Studio session and sets its cookie.
    func refresh(refreshToken: String, studioSession: Bool) async throws(IOSSessionError) -> IOSSessionGrant
    /// Revokes the grant behind a credential. Best effort: failures are
    /// ignored, because the local credential is already gone.
    func revoke(token: String) async
}

/// The production bootstrap client, built on the generated Tilecast API
/// client for one verified server.
public struct IOSSessionClient: IOSSessionExchanging {
    public let address: ServerAddress
    private let client: Client

    public init(address: ServerAddress, transport: any ClientTransport = NativeAPITransport.makeTransport()) {
        self.address = address
        client = NativeAPITransport.client(for: address, transport: transport)
    }

    public func exchange(code: String, verifier: String) async throws(IOSSessionError) -> IOSSessionGrant {
        let grant = try await send(.init(
            grantType: .authorizationCode,
            clientId: .tilecastIos,
            code: code,
            redirectUri: IOSSignInRequest.redirectURI,
            codeVerifier: verifier
        ))
        guard grant.cookie != nil else { throw .missingCookie }
        return grant
    }

    public func refresh(refreshToken: String, studioSession: Bool) async throws(IOSSessionError) -> IOSSessionGrant {
        let grant = try await send(.init(
            grantType: .refreshToken,
            clientId: .tilecastIos,
            refreshToken: refreshToken,
            studioSession: studioSession
        ))
        // A rotation without a new credential leaves nothing usable.
        guard grant.credential != nil else { throw .unavailable }
        if studioSession, grant.cookie == nil { throw .missingCookie }
        return grant
    }

    public func revoke(token: String) async {
        _ = try? await client.revokeOAuthCredential(body: .json(.init(token: token)))
    }

    private func send(_ request: Components.Schemas.IOSSessionRequest) async throws(IOSSessionError) -> IOSSessionGrant {
        let output: Operations.CreateIOSStudioSession.Output
        do {
            output = try await client.createIOSStudioSession(body: .json(request))
        } catch {
            throw .unavailable
        }
        switch output {
        case .ok(let ok):
            guard case .json(let payload) = ok.body else { throw .unavailable }
            let cookie = ok.headers.setCookie.flatMap(sessionCookie(from:))
            let credential = payload.data.credential.map {
                NativeCredential(accessToken: $0.accessToken, refreshToken: $0.refreshToken, expiresAt: $0.expiresAt)
            }
            return IOSSessionGrant(cookie: payload.data.authenticated ? cookie : nil, credential: credential)
        case .badRequest, .unauthorized:
            throw .rejected
        case .tooManyRequests, .undocumented:
            throw .unavailable
        }
    }

    /// The HttpOnly Studio cookie for exactly this server's host.
    private func sessionCookie(from header: String) -> HTTPCookie? {
        HTTPCookie.cookies(withResponseHeaderFields: ["Set-Cookie": header], for: address.url)
            .first { $0.isHTTPOnly && $0.domain == address.host }
    }
}
