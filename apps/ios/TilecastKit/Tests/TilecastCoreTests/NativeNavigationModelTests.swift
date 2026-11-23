import Foundation
import Testing
@testable import TilecastCore

/// A catalog in the shape Studio sends, with made-up destinations: the model
/// must work for any catalog, not for Tilecast's current pages.
func catalog(primary: [String], more: [String], extraGroup: [String] = []) -> NavigationCatalog {
    NavigationCatalog(groups: [
        .init(id: "main", title: nil, destinations: primary.map { .init(id: $0, title: $0.capitalized, icon: "home", placement: .primary) }),
        .init(id: "other", title: "Other", destinations: more.map { .init(id: $0, title: $0.capitalized, icon: "door-calendar") }),
    ] + (extraGroup.isEmpty ? [] : [
        .init(id: "extra", title: nil, destinations: extraGroup.map { .init(id: $0, title: $0.capitalized, icon: "plugin") }),
    ]))
}

@MainActor
@Suite struct NativeNavigationModelTests {
    final class Requests {
        var sent: [String] = []
    }

    func makeModel(_ catalog: NavigationCatalog? = nil, active: String? = nil) -> (NativeNavigationModel, Requests) {
        let model = NativeNavigationModel()
        let requests = Requests()
        model.requestNavigation = { requests.sent.append($0) }
        if let active { model.apply(NavigationState(activeDestinationID: active)) }
        if let catalog { model.apply(catalog) }
        return (model, requests)
    }

    @Test func isUnavailableUntilACatalogArrives() {
        let (model, _) = makeModel()
        #expect(!model.isAvailable)
        model.apply(catalog(primary: ["alpha"], more: []))
        #expect(model.isAvailable)
        model.apply(NavigationCatalog(groups: []))
        #expect(!model.isAvailable, "an empty catalog withdraws native navigation")
    }

    @Test func primaryTabsComeFromTheCatalog() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo", "charlie"], more: ["delta", "echo"]))
        #expect(model.primaryDestinations.map(\.id) == ["alpha", "bravo", "charlie"])
        #expect(model.secondaryGroups.flatMap(\.destinations).map(\.id) == ["delta", "echo"])
        #expect(model.secondaryGroups.map(\.title) == ["Other"])
    }

    @Test func extraPrimaryDestinationsMoveToMore() {
        let (model, _) = makeModel(catalog(primary: ["a", "b", "c", "d", "e", "f"], more: ["g"]))
        #expect(model.primaryDestinations.map(\.id) == ["a", "b", "c", "d"])
        #expect(model.secondaryGroups.flatMap(\.destinations).map(\.id) == ["e", "f", "g"])
    }

    @Test func aStudioReleaseCanChangeWhichDestinationsArePrimary() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["room-bookings"]), active: "alpha")
        model.apply(catalog(primary: ["alpha", "room-bookings"], more: ["bravo"]))
        #expect(model.primaryDestinations.map(\.id) == ["alpha", "room-bookings"])
        #expect(model.secondaryGroups.flatMap(\.destinations).map(\.id) == ["bravo"])
    }

    @Test func movingASecondaryDestinationToPrimaryRemapsOnlyCompactNavigation() {
        let (model, _) = makeModel(
            catalog(primary: ["alpha"], more: ["charlie"]),
            active: "charlie"
        )
        #expect(model.compactSelectedTab == .more)
        #expect(model.adaptiveSelectedTab == .destination("charlie"))

        model.apply(catalog(primary: ["alpha", "charlie"], more: []))
        #expect(model.compactSelectedTab == .destination("charlie"))
        #expect(model.compactFrontendTab == .destination("charlie"))
        #expect(model.adaptiveSelectedTab == .destination("charlie"))
        #expect(model.adaptiveFrontendTab == .destination("charlie"))
    }

    @Test func startsOnTheActiveDestination() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["charlie"]), active: "bravo")
        #expect(model.compactSelectedTab == .destination("bravo"))
        #expect(model.compactFrontendTab == .destination("bravo"))

        let (inMore, _) = makeModel(catalog(primary: ["alpha"], more: ["charlie"]), active: "charlie")
        #expect(inMore.compactSelectedTab == .more)
        #expect(inMore.compactFrontendTab == .more, "a More destination shows Studio in the compact More tab")
        #expect(inMore.adaptiveSelectedTab == .destination("charlie"))
        #expect(inMore.adaptiveFrontendTab == .destination("charlie"), "iPad selects the same destination directly")
    }

    @Test func startsOnTheFirstTabForALocationWithNoDestination() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: []))
        #expect(model.compactSelectedTab == .destination("alpha"))
        #expect(model.compactFrontendTab == .destination("alpha"))
    }

    @Test func aTapSelectsImmediatelyButWaitsToMoveStudio() {
        let (model, requests) = makeModel(catalog(primary: ["alpha", "bravo"], more: []), active: "alpha")
        model.selectCompactTab(.destination("bravo"))
        #expect(requests.sent == ["bravo"])
        #expect(model.compactSelectedTab == .destination("bravo"), "the native tab responds to the tap immediately")
        #expect(model.compactFrontendTab == .destination("alpha"), "Studio stays on the last confirmed tab")
        #expect(model.isCompactSelectionPending)

        model.apply(NavigationState(activeDestinationID: "bravo", path: "/anything"))
        #expect(model.compactSelectedTab == .destination("bravo"))
        #expect(model.compactFrontendTab == .destination("bravo"))
        #expect(!model.isCompactSelectionPending)
    }

    @Test func adaptiveSidebarSelectsSecondaryDestinationsDirectly() {
        let (model, requests) = makeModel(
            catalog(primary: ["alpha"], more: ["charlie"]),
            active: "alpha"
        )

        model.selectAdaptiveTab(.destination("charlie"))
        #expect(requests.sent == ["charlie"])
        #expect(model.adaptiveSelectedTab == .destination("charlie"))
        #expect(model.adaptiveFrontendTab == .destination("alpha"))
        #expect(model.isAdaptiveSelectionPending)
        // A mid-navigation size-class change already has the right compact
        // projection: this secondary destination belongs in More.
        #expect(model.compactSelectedTab == .more)
        #expect(model.isCompactSelectionPending)

        model.apply(NavigationState(activeDestinationID: "charlie"))
        #expect(model.adaptiveSelectedTab == .destination("charlie"))
        #expect(model.adaptiveFrontendTab == .destination("charlie"))
        #expect(!model.isAdaptiveSelectionPending)
        #expect(model.compactSelectedTab == .more)
        #expect(model.compactFrontendTab == .more)
    }

    @Test func anUndeliveredRequestRollsBackTheOptimisticSelection() {
        let (model, requests) = makeModel(catalog(primary: ["alpha", "bravo"], more: []), active: "alpha")
        model.selectCompactTab(.destination("bravo"))
        #expect(requests.sent == ["bravo"])
        #expect(model.compactSelectedTab == .destination("bravo"))
        #expect(model.isCompactSelectionPending)

        model.navigationRequestFailed("bravo")
        #expect(model.compactSelectedTab == .destination("alpha"))
        #expect(model.compactFrontendTab == .destination("alpha"))
        #expect(model.adaptiveSelectedTab == .destination("alpha"))
        #expect(model.adaptiveFrontendTab == .destination("alpha"))
        #expect(!model.isCompactSelectionPending)
        #expect(!model.isAdaptiveSelectionPending)
    }

    @Test func aBlockedNavigationKeepsTheCurrentSelection() {
        let (model, requests) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["charlie"]), active: "charlie")
        model.selectCompactTab(.destination("alpha"))
        #expect(requests.sent == ["alpha"])
        #expect(model.compactSelectedTab == .destination("alpha"), "the tap is reflected optimistically")
        #expect(model.compactFrontendTab == .more, "the confirmed Studio page does not move early")
        #expect(model.adaptiveSelectedTab == .destination("alpha"))
        #expect(model.adaptiveFrontendTab == .destination("charlie"))
        #expect(model.isCompactSelectionPending)
        #expect(model.isAdaptiveSelectionPending)
        // Studio's unsaved-changes prompt stopped the navigation, and Studio
        // acknowledged with the unchanged location.
        model.apply(NavigationState(activeDestinationID: "charlie"))
        #expect(model.compactSelectedTab == .more, "the rejected optimistic selection rolls back")
        #expect(model.compactFrontendTab == .more, "the prompt is visible where the page is")
        #expect(model.adaptiveSelectedTab == .destination("charlie"))
        #expect(model.adaptiveFrontendTab == .destination("charlie"))
        #expect(!model.isCompactSelectionPending)
        #expect(!model.isAdaptiveSelectionPending)
    }

    @Test func aBlockedRequestFromTheMoreListRevealsTheCurrentPage() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["charlie"]), active: "bravo")
        model.selectCompactTab(.more)
        #expect(model.compactFrontendTab == nil, "the list covers Studio")
        model.open("charlie")
        model.apply(NavigationState(activeDestinationID: "bravo"))
        #expect(model.compactSelectedTab == .destination("bravo"))
        #expect(model.compactFrontendTab == .destination("bravo"))
    }

    @Test func moreShowsItsListThenStudio() {
        let (model, requests) = makeModel(catalog(primary: ["alpha"], more: ["charlie", "delta"]), active: "alpha")
        model.selectCompactTab(.more)
        #expect(model.compactSelectedTab == .more)
        #expect(model.compactMoreShowsList)

        model.open("delta")
        #expect(requests.sent == ["delta"])
        #expect(model.adaptiveSelectedTab == .destination("delta"))
        model.apply(NavigationState(activeDestinationID: "delta"))
        #expect(model.compactSelectedTab == .more, "More stays selected for a compact More destination")
        #expect(model.compactFrontendTab == .more)
        #expect(model.adaptiveSelectedTab == .destination("delta"))
        #expect(model.adaptiveFrontendTab == .destination("delta"))

        model.selectCompactTab(.more)
        #expect(model.compactMoreShowsList, "a second tap returns to the list")
        #expect(model.compactFrontendTab == nil)
    }

    @Test func unrelatedUpdatesDoNotLeaveTheMoreList() {
        let (model, _) = makeModel(catalog(primary: ["alpha"], more: ["charlie"]), active: "alpha")
        model.selectCompactTab(.more)
        model.apply(NavigationState(activeDestinationID: "alpha", path: "/alpha?filter=online"))
        #expect(model.compactMoreShowsList)
        #expect(model.path == "/alpha?filter=online")
    }

    @Test func aLocationWithNoDestinationStaysInItsTab() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: []), active: "bravo")
        model.apply(NavigationState(activeDestinationID: nil, path: "/somewhere"))
        #expect(model.compactSelectedTab == .destination("bravo"))
        #expect(model.compactFrontendTab == .destination("bravo"))
        // Tapping the tab again asks Studio to go to the destination.
        var sent: [String] = []
        model.requestNavigation = { sent.append($0) }
        model.selectCompactTab(.destination("bravo"))
        #expect(sent == ["bravo"])
    }

    @Test func ignoresRequestsForUnknownDestinations() {
        let (model, requests) = makeModel(catalog(primary: ["alpha"], more: []))
        model.open("zulu")
        #expect(requests.sent.isEmpty)

        model.selectCompactTab(.destination("zulu"))
        #expect(requests.sent.isEmpty)
        #expect(model.compactSelectedTab == .destination("alpha"), "an invalid optimistic selection is ignored")
        #expect(!model.isCompactSelectionPending)
    }

    @Test func aReplacementCatalogMovesSelectionOffARemovedTab() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: []), active: "bravo")
        model.apply(catalog(primary: ["alpha"], more: ["bravo"]))
        #expect(model.compactSelectedTab == .more)
        #expect(model.compactFrontendTab == .more)
        #expect(model.adaptiveSelectedTab == .destination("bravo"))
        #expect(model.adaptiveFrontendTab == .destination("bravo"))
    }

    @Test func resetForgetsEverything() {
        let (model, _) = makeModel(catalog(primary: ["alpha"], more: ["bravo"]), active: "bravo")
        model.reset()
        #expect(!model.isAvailable)
        #expect(model.activeDestinationID == nil)
        #expect(model.compactSelectedTab == .more)
        #expect(model.adaptiveSelectedTab == .more)
        #expect(model.adaptiveFrontendTab == nil)
    }
}
