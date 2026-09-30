import Foundation

/// What the host does with one navigation request from the Studio page.
public enum StudioNavigationDecision: Equatable, Sendable {
    /// Load it in the requesting frame.
    case allow
    /// Refuse it silently.
    case cancel
    /// Sign-in belongs to the system authentication browser.
    case signIn
    /// Refuse it in the page and hand the URL to the system, which opens the
    /// user's browser (or Mail, Phone, Messages).
    case openExternally(URL)
    /// A same-origin page asked for a new window. The host shows it in a
    /// bounded auxiliary page that shares this server's data store, so the
    /// main Studio page keeps its state.
    case openAuxiliary(URL)
    /// A download or attachment. WebPage has no download delegate, so the
    /// host refuses it and tells the user.
    case unsupportedDownload
}

/// The origin and navigation policy for a privileged Studio page.
///
/// The main frame only ever shows the configured server's origin. That page
/// holds the Studio session and, from Milestone 2, the native bridge, so a
/// different site must never replace it. Everything else is routed:
///
/// | Request | Result |
/// |---|---|
/// | main frame, server origin | load |
/// | main frame, other `http`/`https` | system browser |
/// | new window, server origin | auxiliary page |
/// | new window, other `http`/`https` | system browser |
/// | `mailto:`, `tel:`, `sms:` | system handler |
/// | subframe `http`/`https`/`about`/`data`/`blob` | load (Studio CSP decides) |
/// | download or attachment | refused with a notice |
/// | anything else (`javascript:`, `file:`, custom schemes) | refused |
public struct StudioNavigationPolicy: Sendable {
    public let origin: WebOrigin

    static let systemSchemes: Set<String> = ["mailto", "tel", "sms"]
    static let subframeSchemes: Set<String> = ["http", "https", "about", "data", "blob"]

    public init(origin: WebOrigin) {
        self.origin = origin
    }

    public func decide(
        url: URL?,
        isMainFrame: Bool,
        opensNewWindow: Bool,
        shouldDownload: Bool
    ) -> StudioNavigationDecision {
        guard let url, let scheme = url.scheme?.lowercased() else { return .cancel }
        if shouldDownload { return .unsupportedDownload }
        if Self.systemSchemes.contains(scheme) { return .openExternally(url) }

        let isWeb = scheme == "http" || scheme == "https"
        let isServerOrigin = isWeb && WebOrigin(url) == origin

        if opensNewWindow {
            if isServerOrigin { return .openAuxiliary(url) }
            return isWeb ? .openExternally(url) : .cancel
        }
        if isMainFrame {
            if isServerOrigin && url.path == "/login" { return .signIn }
            if isServerOrigin { return .allow }
            if scheme == "about", url.absoluteString == "about:blank" { return .allow }
            return isWeb ? .openExternally(url) : .cancel
        }
        return Self.subframeSchemes.contains(scheme) ? .allow : .cancel
    }

    /// Decides a response. Attachments and content WebKit cannot display are
    /// downloads, which the host does not support yet.
    public func decide(response: URLResponse, canShowMIMEType: Bool) -> StudioNavigationDecision {
        if !canShowMIMEType { return .unsupportedDownload }
        let disposition = (response as? HTTPURLResponse)?.value(forHTTPHeaderField: "Content-Disposition")
        if let disposition, disposition.lowercased().hasPrefix("attachment") { return .unsupportedDownload }
        return .allow
    }
}
