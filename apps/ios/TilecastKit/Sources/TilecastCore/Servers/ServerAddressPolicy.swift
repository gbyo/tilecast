import Foundation

/// Why a typed server address was refused. The app maps each case to
/// localized text; Core carries no user-visible strings.
public enum ServerAddressError: Error, Equatable, Sendable {
    case empty
    case unsupportedScheme
    case invalid
    case containsPath
    case publicHTTP
}

/// A normalized Tilecast server origin: scheme, lowercased host, and an
/// explicit port when one was typed. It never has a path, query, fragment, or
/// user information.
public struct ServerAddress: Hashable, Codable, Sendable, CustomStringConvertible {
    public let url: URL
    /// True for plain HTTP, which the policy allows only on the local network.
    public let isLocalCleartext: Bool

    public var description: String { url.absoluteString }

    /// Always valid: the policy only produces HTTP(S) URLs with a host.
    public var origin: WebOrigin { WebOrigin(url)! }

    public var scheme: String { url.scheme ?? "" }
    /// True for hosts on the local network, whatever the scheme. Reaching
    /// them requires the Local Network privacy permission.
    public var isLocalNetwork: Bool { ServerAddressPolicy.isLocalNetworkHost(host) }
    public var host: String { url.host(percentEncoded: false) ?? "" }
    public var port: Int? { url.port }

    /// The address string the user sees, e.g. `signage.example.org` or
    /// `http://192.168.1.50:8080`. HTTPS is implied when omitted.
    public var displayString: String {
        isLocalCleartext ? url.absoluteString : String(url.absoluteString.dropFirst("https://".count))
    }

    /// Builds a URL on this origin from an absolute path such as `/screens`.
    /// Returns nil for anything that is not a same-origin absolute path.
    public func url(forPath path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//") else { return nil }
        guard let candidate = URL(string: path, relativeTo: url)?.absoluteURL,
              WebOrigin(candidate) == origin else { return nil }
        return candidate
    }
}

/// The product-wide server address floor, shared with every Tilecast Player
/// through `packages/player-contracts/fixtures/server-url-policy.json`:
///
/// - whitespace and a trailing slash are removed, a bare host means HTTPS;
/// - explicit ports are preserved;
/// - only HTTP and HTTPS are accepted, and HTTPS is never downgraded;
/// - plain HTTP is allowed only for private IPv4, IPv4 link-local, loopback,
///   `localhost`, and `.local` hosts;
/// - user information, paths, queries, and fragments are refused.
///
/// App Transport Security enforces the same boundary a second time: the app
/// sets only `NSAllowsLocalNetworking`, so cleartext to a public host name is
/// refused by the system even if this policy were bypassed.
public enum ServerAddressPolicy {
    public static func normalize(_ input: String) -> Result<ServerAddress, ServerAddressError> {
        var candidate = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !candidate.isEmpty else { return .failure(.empty) }
        if !candidate.contains("://") { candidate = "https://" + candidate }

        guard let components = URLComponents(string: candidate),
              let rawScheme = components.scheme else { return .failure(.invalid) }
        let scheme = rawScheme.lowercased()
        guard scheme == "http" || scheme == "https" else { return .failure(.unsupportedScheme) }
        guard components.user == nil, components.password == nil,
              components.query == nil, components.fragment == nil,
              let rawHost = components.host, !rawHost.isEmpty else { return .failure(.invalid) }
        guard components.path.isEmpty || components.path == "/" else { return .failure(.containsPath) }

        let host = rawHost.trimmingCharacters(in: CharacterSet(charactersIn: "[]")).lowercased()
        guard isValidHost(host) else { return .failure(.invalid) }
        let localCleartext = scheme == "http"
        if localCleartext, !isLocalNetworkHost(host) { return .failure(.publicHTTP) }

        let displayHost = host.contains(":") ? "[\(host)]" : host
        let port = components.port.map { ":\($0)" } ?? ""
        guard let url = URL(string: "\(scheme)://\(displayHost)\(port)") else { return .failure(.invalid) }
        return .success(ServerAddress(url: url, isLocalCleartext: localCleartext))
    }

    static func isLocalNetworkHost(_ host: String) -> Bool {
        if host == "localhost" || host.hasSuffix(".local") { return true }
        if host == "::1" { return true }
        let octets = host.split(separator: ".", omittingEmptySubsequences: false)
        guard octets.count == 4 else { return false }
        let values = octets.compactMap { UInt8($0) }
        guard values.count == 4 else { return false }
        switch (values[0], values[1]) {
        case (10, _), (127, _), (192, 168), (169, 254): return true
        case (172, 16...31): return true
        default: return false
        }
    }

    private static func isValidHost(_ host: String) -> Bool {
        if host.contains(":") { return host.allSatisfy { $0.isHexDigit || $0 == ":" || $0 == "." } }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "-."))
        return host.unicodeScalars.allSatisfy(allowed.contains) && !host.hasPrefix(".") && !host.hasSuffix(".")
    }
}

/// A web origin: scheme, host, and effective port.
public struct WebOrigin: Hashable, Sendable {
    public let scheme: String
    public let host: String
    public let port: Int

    public init?(_ url: URL) {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https",
              let host = url.host(percentEncoded: false)?.lowercased(), !host.isEmpty else { return nil }
        self.scheme = scheme
        self.host = host.trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        self.port = url.port ?? (scheme == "https" ? 443 : 80)
    }

    /// An origin from its parts, as WebKit reports a frame's security
    /// origin. Port 0 means the scheme's default port.
    public init?(scheme: String, host: String, port: Int) {
        let scheme = scheme.lowercased()
        let host = host.lowercased().trimmingCharacters(in: CharacterSet(charactersIn: "[]"))
        guard scheme == "http" || scheme == "https", !host.isEmpty, (0...65535).contains(port) else { return nil }
        self.scheme = scheme
        self.host = host
        self.port = port == 0 ? (scheme == "https" ? 443 : 80) : port
    }
}
