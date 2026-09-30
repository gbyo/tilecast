import Foundation

/// Semantic feedback that Studio requests with `system/haptic`. Studio names
/// the meaning of a state change; the app decides how it maps onto Apple's
/// standard sensory feedback. There is no custom pattern, and no page-specific
/// vocabulary.
public enum HapticFeedback: String, CaseIterable, Sendable {
    case selection
    case success
    case warning
    case error
    case start
    case stop
}

/// Normal, user-visible content that Studio asks the app to hand to the
/// system share sheet with `system/share`.
public struct SystemShare: Equatable, Sendable {
    public var title: String?
    public var text: String?
    public var url: URL?

    static let maximumTitle = 200
    static let maximumText = 2000
    static let maximumURL = 2048

    /// Decodes the payload of `system/share`, or nil when it must not reach
    /// the share sheet: nothing to share, an unbounded value, an unsafe URL
    /// scheme, or anything that carries a credential. The share sheet can
    /// hand the content to any app, so the rules are strict.
    static func decode(_ payload: [String: JSONValue]) -> SystemShare? {
        var share = SystemShare()
        switch payload["title"] {
        case nil: break
        case .string(let value)? where isBounded(value, maximumTitle): share.title = value
        default: return nil
        }
        switch payload["text"] {
        case nil: break
        case .string(let value)? where isBounded(value, maximumText): share.text = value
        default: return nil
        }
        switch payload["url"] {
        case nil: break
        case .string(let value)?:
            guard let url = shareableURL(value) else { return nil }
            share.url = url
        default: return nil
        }
        guard share.text != nil || share.url != nil else { return nil }
        for part in [share.title, share.text, share.url?.absoluteString] {
            if let part, carriesCredential(part) { return nil }
        }
        return share
    }

    /// The share must not reveal a Tilecast API or app-internal address,
    /// which authorize by the session and mean nothing to another person.
    /// Only the origin of the connected server is checked, because the
    /// bridge knows no other.
    func isPermitted(serverOrigin: WebOrigin) -> Bool {
        guard let url, let origin = WebOrigin(url), origin == serverOrigin else { return true }
        let path = url.path(percentEncoded: false).lowercased()
        return !(path == "/api" || path.hasPrefix("/api/") || path == "/__native" || path.hasPrefix("/__native/"))
    }

    // MARK: Rules

    private static func isBounded(_ value: String, _ maximum: Int) -> Bool {
        !value.isEmpty && value.count <= maximum
    }

    /// An absolute HTTP or HTTPS URL, with no user information, that holds
    /// no credential in its query or fragment. The scheme check refuses
    /// `javascript:`, `file:`, `data:`, and everything else.
    static func shareableURL(_ value: String) -> URL? {
        guard isBounded(value, maximumURL) else { return nil }
        let rest: Substring
        if value.hasPrefix("https://") { rest = value.dropFirst(8) } else if value.hasPrefix("http://") { rest = value.dropFirst(7) } else { return nil }
        // Whitespace and backslashes, which browsers read as slashes, are refused everywhere.
        guard !value.unicodeScalars.contains(where: { $0 == "\\" || $0.value < 0x21 || $0.value == 0x7F || $0.properties.isWhitespace }) else { return nil }
        let authority = rest.prefix { $0 != "/" && $0 != "?" && $0 != "#" }
        guard !authority.isEmpty, !authority.contains("@") else { return nil }
        let withoutFragment = value.prefix { $0 != "#" }
        let query = withoutFragment.drop { $0 != "?" }.dropFirst()
        let fragment = value.drop { $0 != "#" }.dropFirst()
        guard !namesSensitiveParameter(query), !namesSensitiveParameter(fragment) else { return nil }
        return URL(string: value)
    }

    static let credentialPrefixes = ["tca_", "tcr_", "tc_device_", "tc_pair"]

    static func carriesCredential(_ text: String) -> Bool {
        let lowered = text.lowercased()
        return credentialPrefixes.contains { lowered.contains($0) }
    }

    static let sensitiveParameters: Set<String> = [
        "access_token", "refresh_token", "id_token", "token", "password", "passwd", "secret", "client_secret",
        "api_key", "apikey", "x-api-key", "signature", "sig", "auth", "authorization", "session", "sessionid",
        "session_id", "csrf", "csrf_token", "credential", "credentials", "bearer", "code",
    ]

    static func namesSensitiveParameter(_ parameters: Substring) -> Bool {
        parameters.split(whereSeparator: { $0 == "&" || $0 == ";" }).contains { pair in
            let name = pair.prefix { $0 != "=" }.replacingOccurrences(of: "+", with: " ")
            let decoded = name.removingPercentEncoding ?? name
            return sensitiveParameters.contains(decoded.trimmingCharacters(in: .whitespaces).lowercased())
        }
    }
}

/// The kind of media a picker should offer.
public enum MediaIntakeKind: String, CaseIterable, Equatable, Sendable {
    case image
    case video
}

/// Studio's request for `system/media-intake`. It carries no file data, no
/// path, and no credential: only an opaque id and what the picker should offer.
public struct MediaIntakeRequest: Equatable, Sendable {
    public var requestID: String
    public var kinds: [MediaIntakeKind]
    public var allowsMultiple: Bool

    public init(requestID: String, kinds: [MediaIntakeKind] = MediaIntakeKind.allCases, allowsMultiple: Bool = true) {
        self.requestID = requestID
        self.kinds = kinds
        self.allowsMultiple = allowsMultiple
    }
}

/// How native media intake ended, for `system/media-intake-completed`.
public enum MediaIntakeOutcome: String, Equatable, Sendable {
    case completed
    case partial
    case failed
    case cancelled
}

/// What the app does for `system/haptic` and `system/share`. One instance
/// serves every Studio page of the app, the main page and the presentation
/// page alike, so both reach the same feedback and the same share sheet.
@MainActor
public final class SystemIntegrationHandlers {
    /// Performs standard system feedback for a semantic request.
    public var haptic: (@MainActor (HapticFeedback) -> Void)?
    /// Presents the system share sheet. Returns whether it did.
    public var share: (@MainActor (SystemShare) -> Bool)?
    /// Chooses files for a web `<input type="file">`, with the system
    /// pickers. Nil when the person cancels. The files are readable by the
    /// page and live in temporary space.
    public var chooseFiles: (@MainActor (_ allowsMultiple: Bool) async -> [URL]?)?

    public init() {}

    func install(on bridge: StudioBridge) {
        bridge.onHaptic = { [weak self] feedback in self?.haptic?(feedback) }
        bridge.onShare = { [weak self] share in self?.share?(share) ?? false }
    }
}
