import Foundation
import Observation

/// Semantic styling for a point in the host's native map.
///
/// Studio names only the meaning. The app decides how that meaning maps to
/// MapKit marker colors, so the bridge never carries CSS colors or Fleet
/// status vocabulary.
public enum SystemMapTone: String, Equatable, Sendable {
    case `default`
    case positive
    case warning
    case critical
    case muted
}

/// One bounded point that Studio asks the host to show.
///
/// IDs and actions are opaque to the host. Coordinates are the only domain
/// information the native surface needs.
public struct SystemMapPoint: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let subtitle: String?
    public let latitude: Double
    public let longitude: Double
    public let tone: SystemMapTone
    public let actionID: String?

    public init(
        id: String,
        title: String,
        subtitle: String? = nil,
        latitude: Double,
        longitude: Double,
        tone: SystemMapTone = .default,
        actionID: String? = nil
    ) {
        self.id = id
        self.title = title
        self.subtitle = subtitle
        self.latitude = latitude
        self.longitude = longitude
        self.tone = tone
        self.actionID = actionID
    }
}

/// A complete native-map snapshot. A new request with the same id replaces
/// the visible points without creating another presentation.
public struct SystemMapPresentation: Identifiable, Equatable, Sendable {
    public let id: String
    public let title: String
    public let points: [SystemMapPoint]

    public init(id: String, title: String, points: [SystemMapPoint]) {
        self.id = id
        self.title = title
        self.points = points
    }
}

/// Owns the one system map the main Studio page may present.
///
/// This stays generic: it knows coordinates, labels, tones, and opaque action
/// ids, never screens, locations, routes, or Fleet state. A document change
/// withdraws the map so an old page can never act on a new page.
@MainActor
@Observable
public final class SystemMapCenter {
    public private(set) var current: SystemMapPresentation?
    @ObservationIgnored private weak var owner: StudioBridge?

    public init() {}

    func present(_ presentation: SystemMapPresentation, from bridge: StudioBridge) -> Bool {
        guard bridge.context == .main else { return false }
        if let owner, owner !== bridge { return false }
        if let current, current.id != presentation.id { return false }
        owner = bridge
        current = presentation
        return true
    }

    func dismiss(mapID: String, from bridge: StudioBridge) {
        guard owner === bridge, current?.id == mapID else { return }
        clear()
    }

    func withdraw(from bridge: StudioBridge) {
        guard owner === bridge else { return }
        clear()
    }

    public func withdrawAll() {
        clear()
    }

    /// The person dismissed the sheet with system UI or its Done button.
    public func userDismissed() {
        guard let presentation = current, let owner else {
            clear()
            return
        }
        clear()
        Task {
            await owner.sendSystemMapDismissed(mapID: presentation.id)
        }
    }

    /// The person chose a point action. Only an action Studio supplied for
    /// the current snapshot may cross back over the bridge.
    public func perform(actionID: String) {
        guard
            let presentation = current,
            presentation.points.contains(where: { $0.actionID == actionID }),
            let owner
        else { return }
        clear()
        Task {
            _ = await owner.sendSystemMapAction(mapID: presentation.id, actionID: actionID)
            await owner.sendSystemMapDismissed(mapID: presentation.id)
        }
    }

    private func clear() {
        current = nil
        owner = nil
    }
}
