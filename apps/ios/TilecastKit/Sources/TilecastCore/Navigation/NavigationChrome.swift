import Foundation

/// The chrome Studio describes for the page it shows: a title, and where
/// back leads. When `backLabel` is set the page is a drill-in, and the app
/// shows a native navigation bar with a back button. The app never learns
/// a path; back sends `navigation/back` and Studio's router decides.
public struct NavigationChrome: Equatable, Sendable {
    public var title: String?
    /// The name of the page back leads to, already localized.
    public var backLabel: String?

    public init(title: String? = nil, backLabel: String? = nil) {
        self.title = title
        self.backLabel = backLabel
    }

    /// Whether the app shows a bar with a back button.
    public var showsBackBar: Bool { backLabel != nil }
}
