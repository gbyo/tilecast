import Foundation

/// The path rules of deep links.
///
/// A deep link asks the app to bring the user back into a configured Tilecast
/// installation, at a Studio path. It is not a route list: the app never
/// names a Studio page. It refuses only what no link may reach: the reserved
/// native tree, and the authentication flows, which have their own entry
/// points (sign-in, first-run setup, and OAuth approval). Studio validates
/// the path again before it navigates.
public enum DeepLinkPaths {
    static let authenticationRoots = ["/login", "/setup", "/oauth"]

    /// An ordinary same-origin Studio path that is not part of an
    /// authentication flow.
    public static func isValid(_ value: String) -> Bool {
        guard PresentationPaths.isStudioPath(value) else { return false }
        let path = value.prefix { $0 != "?" && $0 != "#" }
        return !authenticationRoots.contains { path == $0 || path.hasPrefix($0 + "/") }
    }
}
