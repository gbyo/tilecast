import Foundation

/// A request to bring the user back into a configured Tilecast installation,
/// at a Studio path.
///
/// The URL shape is `tilecast-ios://open?installation=<installation-id>&path=<studio-path>`.
/// It holds no secret. It names an installation, never an address, so opening
/// one cannot make the app contact a host it was not already configured for:
/// the app resolves the installation against its own server profiles and
/// refuses a link for an installation it does not know.
///
/// The app does not claim arbitrary HTTPS domains as universal links,
/// because a Tilecast installation can live on any domain. A push
/// notification or an App Intent that must open Studio builds one of these
/// links and hands it to the same resolver, so there is one routing path.
public struct DeepLink: Equatable, Sendable {
    public let installationID: UUID
    /// A validated same-origin Studio path with its optional query and fragment.
    public let path: String

    /// The link's host and scheme. The OAuth callback shares the scheme
    /// with another host and is never handled here.
    public static let scheme = "tilecast-ios"
    public static let host = "open"
    static let maximumURLLength = 4096

    /// Nil when `path` is not a path a link may open.
    public init?(installationID: UUID, path: String) {
        guard DeepLinkPaths.isValid(path) else { return nil }
        self.installationID = installationID
        self.path = path
    }

    /// The URL for this link, for a sender that lives in the app.
    public var url: URL? {
        var components = URLComponents()
        components.scheme = Self.scheme
        components.host = Self.host
        components.queryItems = [
            URLQueryItem(name: "installation", value: installationID.uuidString.lowercased()),
            URLQueryItem(name: "path", value: path),
        ]
        return components.url
    }

    public enum Parsed: Equatable, Sendable {
        /// A valid link.
        case link(DeepLink)
        /// It asks to open something, but not in a form the app accepts.
        case invalid
        /// Not a request to open anything, for example the OAuth callback.
        /// Other code owns it; the resolver ignores it.
        case notForOpening
    }

    /// Reads an incoming URL. Nothing is opened, loaded, or contacted here.
    public static func parse(_ url: URL) -> Parsed {
        guard url.scheme?.lowercased() == scheme, url.host(percentEncoded: false)?.lowercased() == host else {
            return .notForOpening
        }
        guard url.absoluteString.count <= maximumURLLength,
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false),
              components.user == nil, components.password == nil, components.port == nil,
              components.fragment == nil, components.path.isEmpty || components.path == "/",
              let items = components.queryItems else { return .invalid }
        var values: [String: String] = [:]
        for item in items where ["installation", "path"].contains(item.name) {
            // A repeated parameter is ambiguous, so the link is refused.
            guard values[item.name] == nil, let value = item.value else { return .invalid }
            values[item.name] = value
        }
        guard let installation = values["installation"].flatMap(UUID.init(uuidString:)),
              let path = values["path"],
              let link = DeepLink(installationID: installation, path: path) else { return .invalid }
        return .link(link)
    }
}

/// What the app tells the person when a link cannot be opened. It never
/// names a host, because the link named none.
public enum DeepLinkNotice: Equatable, Sendable {
    /// The link is for an installation this device has no server for.
    case notConfigured
    /// The link is malformed, or names a place links cannot open.
    case unopenable
}
