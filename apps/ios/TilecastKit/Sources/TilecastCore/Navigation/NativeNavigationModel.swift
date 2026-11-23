import Foundation
import Observation

/// A native navigation selection token. Every Studio destination can be a
/// direct selection in sidebarAdaptable navigation; `.more` is the compact
/// container for secondary destinations and server controls.
public enum NavigationTab: Hashable, Sendable {
    case destination(String)
    case more
}

/// Native navigation for one Studio page: what to show, and what is
/// selected.
///
/// Studio owns the confirmed content location, while the native tab bar may
/// optimistically reflect a tap before Studio finishes navigation. The one
/// WebView stays attached to the last confirmed tab until Studio reports its
/// new location in `navigation/state`; if an unsaved-changes prompt stops
/// navigation, that acknowledgement rolls the tab selection back. The model
/// never reads a path: Studio's `activeDestinationID` is the only input.
@MainActor
@Observable
public final class NativeNavigationModel {
    /// Compact tabs before More, in catalog order.
    public static let maximumPrimaryTabs = 4

    public private(set) var catalog: NavigationCatalog?
    public private(set) var activeDestinationID: String?
    /// Diagnostics only.
    public private(set) var path: String?
    /// What compact navigation highlights: a primary destination or More.
    /// A tab tap updates this immediately so the control responds natively.
    public private(set) var compactSelectedTab: NavigationTab = .more
    /// The compact slot allowed to expose the confirmed Studio frame. It
    /// changes only after Studio acknowledges navigation, so a stale WebKit
    /// frame is never
    /// revealed under an optimistically selected tab.
    private var compactSettledTab: NavigationTab = .more
    /// The actual destination whose Studio frame is settled. Compact
    /// navigation may map this destination into More, while regular-width
    /// iPad sidebarAdaptable navigation selects it directly.
    private var settledDestinationID: String?
    /// In compact More: true shows the destination list, false shows Studio.
    public private(set) var compactMoreShowsList = true

    /// The chrome of the current page. Drives the native back bar.
    public private(set) var chrome = NavigationChrome()

    /// Sends `navigation/back`. Set by the bridge.
    @ObservationIgnored var requestBack: () -> Void = {}
    /// Sends `navigation/request`. Set by the bridge.
    @ObservationIgnored var requestNavigation: (String) -> Void = { _ in }
    /// A request Studio has not acknowledged yet.
    @ObservationIgnored private var pendingRequest: String?

    public init() {}

    /// True when Studio has a non-empty catalog: the app shows native
    /// navigation instead of its fallback chrome.
    public var isAvailable: Bool { catalog != nil }

    /// Primary destinations that fit in compact navigation before More.
    public var primaryDestinations: [NavigationCatalog.Destination] {
        Array((catalog?.destinations ?? []).filter { $0.placement == .primary }.prefix(Self.maximumPrimaryTabs))
    }

    /// Destinations that do not occupy one of the compact primary tab slots,
    /// kept in Studio's catalog groups. Compact navigation renders these in
    /// More; regular-width iPad renders them directly as sidebar TabSections.
    public var secondaryGroups: [NavigationCatalog.Group] {
        let primary = Set(primaryDestinations.map(\.id))
        return (catalog?.groups ?? []).compactMap { group in
            let destinations = group.destinations.filter { !primary.contains($0.id) }
            return destinations.isEmpty ? nil : .init(id: group.id, title: group.title, destinations: destinations)
        }
    }

    /// The compact slot that shows the one Studio page, or nil while the More
    /// list covers it. This follows Studio's confirmed location, not an
    /// optimistic tab selection.
    public var compactFrontendTab: NavigationTab? {
        compactSettledTab == .more && compactMoreShowsList ? nil : compactSettledTab
    }

    /// The selection for regular-width iPad's sidebarAdaptable TabView.
    /// Unlike compact navigation, every catalog destination has its own native
    /// tab in the sidebar, including destinations marked for More on compact
    /// layouts. A pending request is reflected optimistically.
    public var adaptiveSelectedTab: NavigationTab {
        if let pendingRequest, catalog?.destination(withID: pendingRequest) != nil {
            return .destination(pendingRequest)
        }
        if let settledDestinationID, catalog?.destination(withID: settledDestinationID) != nil {
            return .destination(settledDestinationID)
        }
        if let id = primaryDestinations.first?.id ?? catalog?.destinations.first?.id {
            return .destination(id)
        }
        return .more
    }

    /// The regular-width iPad tab whose content slot may expose the confirmed
    /// Studio frame. It never follows an optimistic selection before Studio
    /// acknowledges it.
    public var adaptiveFrontendTab: NavigationTab? {
        guard let settledDestinationID, catalog?.destination(withID: settledDestinationID) != nil else {
            return nil
        }
        return .destination(settledDestinationID)
    }

    /// True while regular-width iPad selection has moved ahead of Studio's
    /// painted destination.
    public var isAdaptiveSelectionPending: Bool {
        guard case .destination(let selectedID) = adaptiveSelectedTab else { return false }
        return selectedID != settledDestinationID
    }

    /// True only during the short interval between an optimistic compact-tab
    /// tap and Studio's navigation acknowledgement.
    public var isCompactSelectionPending: Bool {
        compactSelectedTab != compactSettledTab
    }

    // MARK: From Studio

    /// Replaces the catalog. An empty catalog withdraws native navigation.
    public func apply(_ catalog: NavigationCatalog) {
        let first = self.catalog == nil
        self.catalog = catalog.isEmpty ? nil : catalog
        guard self.catalog != nil else {
            // Native navigation is withdrawn, for example on sign-out.
            chrome = NavigationChrome()
            return
        }
        if first {
            showInitialSelection()
        } else if let settledDestinationID,
                  self.catalog?.destination(withID: settledDestinationID) == nil {
            showInitialSelection()
        } else if !compactMoreShowsList {
            // Placement metadata can change between catalog snapshots. Keep
            // the settled destination, but remap the compact navigation slot.
            reconcile()
        }
    }

    public func apply(_ state: NavigationState) {
        let changed = state.activeDestinationID != activeDestinationID
        activeDestinationID = state.activeDestinationID
        path = state.path
        let acknowledged = pendingRequest != nil
        pendingRequest = nil
        // While the More list covers Studio, an unrelated update (a changed
        // query string, say) must not pull the user off the list.
        if changed || acknowledged || compactFrontendTab != nil { reconcile() }
    }

    public func apply(_ chrome: NavigationChrome) {
        self.chrome = chrome
    }

    public func reset() {
        chrome = NavigationChrome()
        catalog = nil
        activeDestinationID = nil
        path = nil
        compactSelectedTab = .more
        compactSettledTab = .more
        settledDestinationID = nil
        compactMoreShowsList = true
        pendingRequest = nil
    }

    // MARK: From the user

    /// A compact tab-bar tap, including a tap on the tab already selected.
    public func selectCompactTab(_ tab: NavigationTab) {
        switch tab {
        case .more:
            // A second tap on More returns to its list. This is app-owned
            // navigation, so it can settle immediately without Studio.
            compactSelectedTab = .more
            compactSettledTab = .more
            compactMoreShowsList = true
        case .destination(let id):
            guard catalog?.destination(withID: id) != nil else { return }
            // Give the native control immediate feedback, but leave
            // compactSettledTab alone until Studio reports the route after paint.
            compactSelectedTab = .destination(id)
            open(id)
        }
    }

    /// A direct destination selection from regular-width iPad's
    /// sidebarAdaptable TabView. The system sidebar can select every
    /// destination, not only compact
    /// primary tabs.
    public func selectAdaptiveTab(_ tab: NavigationTab) {
        guard case .destination(let id) = tab,
              catalog?.destination(withID: id) != nil else { return }

        // Keep the compact projection in sync too. If the iPad window becomes
        // compact before Studio acknowledges the route, the system can switch
        // tab structures without briefly highlighting the previous page.
        compactSelectedTab = primaryDestinations.contains(where: { $0.id == id })
            ? .destination(id)
            : .more
        compactMoreShowsList = false
        open(id)
    }

    /// The bridge could not deliver a request to Studio. Ignore a failure
    /// from an older request, but roll back the optimistic selection when the
    /// current request never reached the frontend.
    func navigationRequestFailed(_ destinationID: String) {
        guard pendingRequest == destinationID else { return }
        pendingRequest = nil
        compactSelectedTab = compactSettledTab
    }

    /// The native back button. Studio's router decides where it goes.
    public func goBack() {
        guard chrome.showsBackBar else { return }
        requestBack()
    }

    /// A destination chosen in More or the sidebar.
    public func open(_ destinationID: String) {
        guard catalog?.destination(withID: destinationID) != nil else { return }
        pendingRequest = destinationID
        requestNavigation(destinationID)
    }

    // MARK: Selection

    /// Shows Studio where its current destination lives.
    private func reconcile() {
        guard let catalog else { return }
        if let id = activeDestinationID, primaryDestinations.contains(where: { $0.id == id }) {
            let tab = NavigationTab.destination(id)
            compactSelectedTab = tab
            compactSettledTab = tab
            settledDestinationID = id
            compactMoreShowsList = false
        } else if let id = activeDestinationID, catalog.destination(withID: id) != nil {
            compactSelectedTab = .more
            compactSettledTab = .more
            settledDestinationID = id
            compactMoreShowsList = false
        } else {
            // A location with no destination, such as My Account, stays in
            // whichever tab last showed Studio. An acknowledgement also
            // rolls back any optimistic selection to that confirmed tab.
            compactSelectedTab = compactSettledTab
            if compactFrontendTab == nil { compactMoreShowsList = false }
        }
    }

    private func showInitialSelection() {
        if let id = activeDestinationID, catalog?.destination(withID: id) != nil {
            reconcile()
        } else if let destination = primaryDestinations.first ?? catalog?.destinations.first {
            let tab = NavigationTab.destination(destination.id)
            compactSelectedTab = primaryDestinations.contains(where: { $0.id == destination.id })
                ? tab
                : .more
            compactSettledTab = compactSelectedTab
            settledDestinationID = destination.id
            compactMoreShowsList = false
        } else {
            compactSelectedTab = .more
            compactSettledTab = .more
            settledDestinationID = nil
            compactMoreShowsList = true
        }
    }
}
