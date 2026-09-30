import CryptoKit
import Foundation
import Security

public enum IOSSignInError: Error, Equatable {
    case randomUnavailable
    case invalidCallback
    /// The callback names another authorization server than the one this
    /// attempt started at (RFC 9207). The code is never sent anywhere.
    case issuerMismatch
    case accessDenied
    case serverRejected
    case missingCookie
}

/// One browser authorization attempt bound to a server, a PKCE verifier,
/// and an unpredictable callback state. No value is persisted.
public struct IOSSignInRequest: Sendable {
    public static let clientID = "tilecast-ios"
    public static let redirectURI = "tilecast-ios://oauth/callback"

    public let authorizationURL: URL
    public let verifier: String
    public let state: String
    /// The server this attempt started at. A callback must come from it.
    public let issuer: WebOrigin

    public init(server: ServerAddress) throws {
        issuer = server.origin
        func random(_ count: Int) throws -> String {
            var bytes = [UInt8](repeating: 0, count: count)
            guard SecRandomCopyBytes(kSecRandomDefault, count, &bytes) == errSecSuccess else {
                throw IOSSignInError.randomUnavailable
            }
            return Data(bytes).base64URLEncodedString()
        }
        verifier = try random(32)
        state = try random(24)
        let digest = SHA256.hash(data: Data(verifier.utf8))
        let challenge = Data(digest).base64URLEncodedString()
        var components = URLComponents(url: server.url, resolvingAgainstBaseURL: false)!
        components.path = "/oauth/approve"
        components.queryItems = [
            URLQueryItem(name: "client_id", value: Self.clientID),
            URLQueryItem(name: "redirect_uri", value: Self.redirectURI),
            URLQueryItem(name: "scope", value: "read write admin"),
            URLQueryItem(name: "state", value: state),
            URLQueryItem(name: "code_challenge", value: challenge),
            URLQueryItem(name: "code_challenge_method", value: "S256"),
        ]
        authorizationURL = components.url!
    }

    /// Validates the callback and returns its authorization code. The state
    /// must match this attempt. The callback's `iss` must name the server
    /// this attempt started at, so a code another installation issued is
    /// never redeemed here. A callback without `iss` comes from a server
    /// released before issuer identification and is accepted on state and
    /// PKCE alone.
    public func code(from callback: URL) throws(IOSSignInError) -> String {
        guard callback.scheme == "tilecast-ios", callback.host == "oauth", callback.path == "/callback",
              let items = URLComponents(url: callback, resolvingAgainstBaseURL: false)?.queryItems,
              let receivedState = Self.single("state", in: items), receivedState == state else {
            throw .invalidCallback
        }
        let issuers = items.filter { $0.name == "iss" }
        if !issuers.isEmpty {
            guard issuers.count == 1, let value = issuers[0].value, Self.origin(ofIssuer: value) == issuer else {
                throw .issuerMismatch
            }
        }
        if Self.single("error", in: items) == "access_denied" {
            throw .accessDenied
        }
        guard let code = Self.single("code", in: items), !code.isEmpty else {
            throw .invalidCallback
        }
        return code
    }

    private static func single(_ name: String, in items: [URLQueryItem]) -> String? {
        let matches = items.filter { $0.name == name }
        return matches.count == 1 ? matches[0].value : nil
    }

    /// An issuer identifier is an origin: a scheme and a host, with an
    /// optional port and nothing else.
    static func origin(ofIssuer value: String) -> WebOrigin? {
        guard let url = URL(string: value), let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil, components.query == nil, components.fragment == nil,
              components.percentEncodedPath.isEmpty else { return nil }
        return WebOrigin(url)
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
