import Foundation

/// Studio's navigation destinations, as the most recent `navigation/catalog`
/// message described them.
///
/// The app renders the catalog and nothing else. Destination and group
/// identifiers are opaque: only Studio knows which page one leads to, and a
/// Studio release can add, remove, rename, or reorder destinations without
/// an app release. Titles arrive already localized.
public struct NavigationCatalog: Equatable, Sendable {
    public enum Placement: String, Equatable, Sendable {
        /// Studio prefers a tab of its own in a compact-width layout.
        case primary
        /// The destination belongs in More in a compact-width layout.
        case more
    }

    public struct Destination: Equatable, Sendable, Identifiable {
        public let id: String
        public let title: String
        /// Advisory semantic icon token. See `NavigationIcon`.
        public let icon: String
        public let placement: Placement

        public init(id: String, title: String, icon: String, placement: Placement = .more) {
            self.id = id
            self.title = title
            self.icon = icon
            self.placement = placement
        }
    }

    public struct Group: Equatable, Sendable, Identifiable {
        public let id: String
        /// Nil for a group Studio shows without a heading.
        public let title: String?
        public let destinations: [Destination]

        public init(id: String, title: String?, destinations: [Destination]) {
            self.id = id
            self.title = title
            self.destinations = destinations
        }
    }

    /// In display order, as Studio sent them.
    public let groups: [Group]

    public init(groups: [Group]) {
        self.groups = groups
    }

    public var destinations: [Destination] { groups.flatMap(\.destinations) }

    /// No destinations: Studio is showing a page without navigation, such as
    /// sign-in, or it withdrew native navigation.
    public var isEmpty: Bool { groups.allSatisfy(\.destinations.isEmpty) }

    public func destination(withID id: String) -> Destination? {
        destinations.first { $0.id == id }
    }
}

/// The destination Studio resolved for its current location.
public struct NavigationState: Equatable, Sendable {
    /// Authoritative for native selection. Nil when the location belongs to
    /// no destination.
    public let activeDestinationID: String?
    /// For diagnostics only. The app never derives selection from a path.
    public let path: String?

    public init(activeDestinationID: String?, path: String? = nil) {
        self.activeDestinationID = activeDestinationID
        self.path = path
    }
}
