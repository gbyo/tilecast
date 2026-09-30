import Foundation

/// How much room a presentation asks for. Studio may name other sizes
/// later; the app shows any size it does not know as `full`, so a new size
/// never needs a Swift case.
public enum PresentationSize: String, Equatable, Sendable {
    /// Starts at half height and can grow.
    case compact
    /// The whole sheet.
    case full

    init(token: String) {
        self = Self(rawValue: token) ?? .full
    }
}

/// The native header of a presentation, as Studio describes it. Every
/// update replaces the whole header, so an old toolbar never survives a
/// new snapshot. Labels are localized by Studio; action ids are opaque.
public struct PresentationHeader: Equatable, Sendable {
    public enum Navigation: Equatable, Sendable {
        /// Dismisses the presentation.
        case close
        /// Reports `PresentationHeader.backActionID` to Studio.
        case back
    }

    public struct Action: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        /// Advisory. An unknown token shows the generic icon.
        public let icon: String
    }

    public struct MenuItem: Equatable, Sendable, Identifiable {
        public let id: String
        public let label: String
        public let icon: String?
        public let isDisabled: Bool
    }

    /// The action id a back button reports.
    public static let backActionID = "back"

    public var title: String
    public var subtitle: String?
    public var navigation: Navigation
    public var navigationLabel: String?
    public var menuLabel: String?
    public var actions: [Action]
    public var menu: [MenuItem]

    public init(
        title: String,
        subtitle: String? = nil,
        navigation: Navigation = .close,
        navigationLabel: String? = nil,
        menuLabel: String? = nil,
        actions: [Action] = [],
        menu: [MenuItem] = []
    ) {
        self.title = title
        self.subtitle = subtitle
        self.navigation = navigation
        self.navigationLabel = navigationLabel
        self.menuLabel = menuLabel
        self.actions = actions
        self.menu = menu
    }
}

/// One presentation of a Studio route in a native sheet. The app knows its
/// path only as an opaque route below `PresentationPaths.root`; what it
/// shows belongs to Studio.
public struct NativePresentation: Identifiable, Equatable, Sendable {
    /// Studio's presentation id. It separates this presentation from the
    /// next, so a late message about an old one cannot change it.
    public let id: String
    public let path: String
    public var header: PresentationHeader
    public var size: PresentationSize
    public var isDismissible: Bool

    public init(id: String, path: String, header: PresentationHeader, size: PresentationSize = .full, isDismissible: Bool = true) {
        self.id = id
        self.path = path
        self.header = header
        self.size = size
        self.isDismissible = isDismissible
    }
}

/// A change the presentation page makes to its native chrome. Each value
/// that is present replaces the current one.
public struct PresentationUpdate: Equatable, Sendable {
    public let presentationID: String
    public var header: PresentationHeader?
    public var size: PresentationSize?
    public var isDismissible: Bool?
}

/// The path rules of native presentations.
///
/// The app knows one route: the root of the reserved presentation tree.
/// Every child route belongs to Studio, so a new presentation needs no
/// Swift change, and the app never names one.
public enum PresentationPaths {
    public static let root = "/__native/modal"
    static let reservedTree = "/__native"

    /// A same-origin path inside the presentation tree.
    public static func isPresentationPath(_ value: String) -> Bool {
        isSafeRelativePath(value, maximumLength: 1024) && isInTree(pathComponent(value), root)
    }

    /// An ordinary same-origin Studio path, for navigation out of a
    /// presentation. The reserved tree is never a destination.
    public static func isStudioPath(_ value: String) -> Bool {
        isSafeRelativePath(value, maximumLength: 2048) && !isInTree(pathComponent(value), reservedTree)
    }

    private static func isSafeRelativePath(_ value: String, maximumLength: Int) -> Bool {
        guard !value.isEmpty, value.count <= maximumLength, value.hasPrefix("/"), !value.hasPrefix("//") else { return false }
        // Whitespace, controls, and backslashes, which browsers read as slashes.
        let unsafe = value.unicodeScalars.contains {
            $0 == "\\" || $0.value < 0x20 || $0.value == 0x7F || $0.properties.isWhitespace
        }
        return !unsafe && !hasDotSegment(pathComponent(value))
    }

    private static func pathComponent(_ value: String) -> Substring {
        value.prefix { $0 != "?" && $0 != "#" }
    }

    /// A `.` or `..` segment, also percent-encoded, could leave a tree.
    private static func hasDotSegment(_ path: Substring) -> Bool {
        path.split(separator: "/", omittingEmptySubsequences: false).contains { segment in
            let decoded = segment.lowercased().replacingOccurrences(of: "%2e", with: ".")
            return decoded == "." || decoded == ".."
        }
    }

    private static func isInTree(_ path: Substring, _ tree: String) -> Bool {
        path == tree || path.hasPrefix(tree + "/")
    }
}
