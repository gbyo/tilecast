import Foundation

/// A menu Studio asked the app to show, with Studio's own localized text.
/// The app never knows what the menu is about: a screen's actions, a
/// layout's actions, and a plugin's actions all look the same here. Only
/// Studio knows what an action does; the app reports the chosen opaque id.
public struct NativeActionMenu: Equatable, Sendable, Identifiable {
    public struct Item: Equatable, Sendable, Identifiable {
        public enum Role: Equatable, Sendable {
            case `default`, destructive

            /// An unknown role is a default action, so Studio can name a
            /// new role without a Swift change.
            init(token: String?) {
                switch token {
                case "destructive": self = .destructive
                default: self = .default
                }
            }
        }

        public let id: String
        public let label: String
        /// Advisory. Nil, or a token the app does not know, shows no icon.
        public let icon: String?
        public let isDisabled: Bool
        public let role: Role
    }

    public struct Group: Equatable, Sendable {
        public let items: [Item]
    }

    public let id: String
    public let label: String
    public let groups: [Group]

    /// Every action, in display order.
    public var items: [Item] { groups.flatMap(\.items) }

    static let maximumGroups = 8
    static let maximumItemsPerGroup = 16
    static let maximumItems = 24
}


/// The visible part of a Studio action trigger, normalized to its WebView
/// viewport. Values are in 0...1, and x + width / y + height never exceed 1.
public struct NativeActionMenuTriggerRect: Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    init?(x: Double, y: Double, width: Double, height: Double) {
        guard x.isFinite, y.isFinite, width.isFinite, height.isFinite,
              x >= 0, y >= 0, width > 0, height > 0,
              x <= 1, y <= 1, x + width <= 1.0001, y + height <= 1.0001 else {
            return nil
        }
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }
}
