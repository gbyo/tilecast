import CryptoKit
import Foundation
import Security

public enum IOSSignInError: Error, Equatable {
    case randomUnavailable
    case invalidCallback
    case accessDenied
    case serverRejected
    case missingCookie
}

/// One browser authorization attempt bound to a server, a PKCE verifier,
/// and an unpredictable callback state. No value is persisted.
public struct IOSSignInRequest {
    public static let clientID = "tilecast-ios"
    public static let redirectURI = "tilecast-ios://oauth/callback"

    public let authorizationURL: URL
    public let verifier: String
    public let state: String

    public init(server: ServerAddress) throws {
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

    public func code(from callback: URL) throws -> String {
        guard callback.scheme == "tilecast-ios", callback.host == "oauth", callback.path == "/callback",
              let parts = URLComponents(url: callback, resolvingAgainstBaseURL: false),
              parts.queryItems?.first(where: { $0.name == "state" })?.value == state else {
            throw IOSSignInError.invalidCallback
        }
        if parts.queryItems?.first(where: { $0.name == "error" })?.value == "access_denied" {
            throw IOSSignInError.accessDenied
        }
        guard let code = parts.queryItems?.first(where: { $0.name == "code" })?.value, !code.isEmpty else {
            throw IOSSignInError.invalidCallback
        }
        return code
    }
}

private extension Data {
    func base64URLEncodedString() -> String {
        base64EncodedString().replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
    }
}
