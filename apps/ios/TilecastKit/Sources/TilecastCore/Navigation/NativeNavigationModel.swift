import Foundation
import Observation

/// A tab in the compact-width layout.
public enum NavigationTab: Hashable, Sendable {
    /// A destination Studio marked primary, by its opaque identifier.
    case destination(String)
    /// The app's More tab: the other destinations and server controls.
    case more
}

/// Native navigation for one Studio page: what to show, and what is
/// selected.
///
/// Selection follows Studio. A tap asks Studio to navigate and changes
/// nothing by itself; the selection moves only when Studio reports its new
/// location in `navigation/state`. If an unsaved-changes prompt stops the
/// navigation, Studio reports the unchanged location, and the selection
/// stays with the page the user is still on. The model never reads a path:
/// Studio's `activeDestinationID` is the only input.
@MainActor
@Observable
public final class NativeNavigationModel {
    /// Tabs for primary destinations; More is always the last tab.
    public static let maximumPrimaryTabs = 4

    public private(set) var catalog: NavigationCatalog?
    public private(set) var activeDestinationID: String?
    /// Diagnostics only.
    public private(set) var path: String?
    public private(set) var selectedTab: NavigationTab = .more
    /// In the More tab: true shows the destination list, false shows Studio.
    public private(set) var moreShowsList = true

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

    /// Tabs before More, in catalog order.
    public var primaryDestinations: [NavigationCatalog.Destination] {
        Array((catalog?.destinations ?? []).filter { $0.placement == .primary }.prefix(Self.maximumPrimaryTabs))
    }

    /// Every other destination, in its catalog group.
    public var moreGroups: [NavigationCatalog.Group] {
        let primary = Set(primaryDestinations.map(\.id))
        return (catalog?.groups ?? []).compactMap { group in
            let destinations = group.destinations.filter { !primary.contains($0.id) }
            return destinations.isEmpty ? nil : .init(id: group.id, title: group.title, destinations: destinations)
        }
    }

    /// The tab that shows the one Studio page, or nil while the More list
    /// covers it.
    public var frontendTab: NavigationTab? {
        selectedTab == .more && moreShowsList ? nil : selectedTab
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
        } else if case .destination(let id) = selectedTab, !primaryDestinations.contains(where: { $0.id == id }) {
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
        if changed || acknowledged || frontendTab != nil { reconcile() }
    }

    public func apply(_ chrome: NavigationChrome) {
        self.chrome = chrome
    }

    public func reset() {
        chrome = NavigationChrome()
        catalog = nil
        activeDestinationID = nil
        path = nil
        selectedTab = .more
        moreShowsList = true
        pendingRequest = nil
    }

    // MARK: From the user

    /// A tab bar tap, including a tap on the tab that is already selected.
    public func selectTab(_ tab: NavigationTab) {
        switch tab {
        case .more:
            // A second tap on More returns to its list.
            selectedTab = .more
            moreShowsList = true
        case .destination(let id):
            open(id)
        }
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
            selectedTab = .destination(id)
            moreShowsList = false
        } else if let id = activeDestinationID, catalog.destination(withID: id) != nil {
            selectedTab = .more
            moreShowsList = false
        } else if frontendTab == nil {
            // A location with no destination, such as My Account, stays in
            // whichever tab showed Studio; reveal it if the list covered it.
            moreShowsList = false
        }
    }

    private func showInitialSelection() {
        if let id = activeDestinationID, catalog?.destination(withID: id) != nil {
            reconcile()
        } else {
            selectedTab = primaryDestinations.first.map { .destination($0.id) } ?? .more
            moreShowsList = false
        }
    }
}
