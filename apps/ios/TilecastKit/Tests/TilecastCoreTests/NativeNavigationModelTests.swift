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
        #expect(model.moreGroups.flatMap(\.destinations).map(\.id) == ["delta", "echo"])
        #expect(model.moreGroups.map(\.title) == ["Other"])
    }

    @Test func extraPrimaryDestinationsMoveToMore() {
        let (model, _) = makeModel(catalog(primary: ["a", "b", "c", "d", "e", "f"], more: ["g"]))
        #expect(model.primaryDestinations.map(\.id) == ["a", "b", "c", "d"])
        #expect(model.moreGroups.flatMap(\.destinations).map(\.id) == ["e", "f", "g"])
    }

    @Test func aStudioReleaseCanChangeWhichDestinationsArePrimary() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["room-bookings"]), active: "alpha")
        model.apply(catalog(primary: ["alpha", "room-bookings"], more: ["bravo"]))
        #expect(model.primaryDestinations.map(\.id) == ["alpha", "room-bookings"])
        #expect(model.moreGroups.flatMap(\.destinations).map(\.id) == ["bravo"])
    }

    @Test func startsOnTheActiveDestination() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["charlie"]), active: "bravo")
        #expect(model.selectedTab == .destination("bravo"))
        #expect(model.frontendTab == .destination("bravo"))

        let (inMore, _) = makeModel(catalog(primary: ["alpha"], more: ["charlie"]), active: "charlie")
        #expect(inMore.selectedTab == .more)
        #expect(inMore.frontendTab == .more, "a More destination shows Studio in the More tab")
    }

    @Test func startsOnTheFirstTabForALocationWithNoDestination() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: []))
        #expect(model.selectedTab == .destination("alpha"))
        #expect(model.frontendTab == .destination("alpha"))
    }

    @Test func aTapRequestsNavigationWithoutChangingSelection() {
        let (model, requests) = makeModel(catalog(primary: ["alpha", "bravo"], more: []), active: "alpha")
        model.selectTab(.destination("bravo"))
        #expect(requests.sent == ["bravo"])
        #expect(model.selectedTab == .destination("alpha"), "selection waits for Studio")

        model.apply(NavigationState(activeDestinationID: "bravo", path: "/anything"))
        #expect(model.selectedTab == .destination("bravo"))
    }

    @Test func aBlockedNavigationKeepsTheCurrentSelection() {
        let (model, requests) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["charlie"]), active: "charlie")
        model.selectTab(.destination("alpha"))
        #expect(requests.sent == ["alpha"])
        // Studio's unsaved-changes prompt stopped the navigation, and Studio
        // acknowledged with the unchanged location.
        model.apply(NavigationState(activeDestinationID: "charlie"))
        #expect(model.selectedTab == .more)
        #expect(model.frontendTab == .more, "the prompt is visible where the page is")
    }

    @Test func aBlockedRequestFromTheMoreListRevealsTheCurrentPage() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: ["charlie"]), active: "bravo")
        model.selectTab(.more)
        #expect(model.frontendTab == nil, "the list covers Studio")
        model.open("charlie")
        model.apply(NavigationState(activeDestinationID: "bravo"))
        #expect(model.selectedTab == .destination("bravo"))
        #expect(model.frontendTab == .destination("bravo"))
    }

    @Test func moreShowsItsListThenStudio() {
        let (model, requests) = makeModel(catalog(primary: ["alpha"], more: ["charlie", "delta"]), active: "alpha")
        model.selectTab(.more)
        #expect(model.selectedTab == .more)
        #expect(model.moreShowsList)

        model.open("delta")
        #expect(requests.sent == ["delta"])
        model.apply(NavigationState(activeDestinationID: "delta"))
        #expect(model.selectedTab == .more, "More stays selected for a More destination")
        #expect(model.frontendTab == .more)

        model.selectTab(.more)
        #expect(model.moreShowsList, "a second tap returns to the list")
        #expect(model.frontendTab == nil)
    }

    @Test func unrelatedUpdatesDoNotLeaveTheMoreList() {
        let (model, _) = makeModel(catalog(primary: ["alpha"], more: ["charlie"]), active: "alpha")
        model.selectTab(.more)
        model.apply(NavigationState(activeDestinationID: "alpha", path: "/alpha?filter=online"))
        #expect(model.moreShowsList)
        #expect(model.path == "/alpha?filter=online")
    }

    @Test func aLocationWithNoDestinationStaysInItsTab() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: []), active: "bravo")
        model.apply(NavigationState(activeDestinationID: nil, path: "/somewhere"))
        #expect(model.selectedTab == .destination("bravo"))
        #expect(model.frontendTab == .destination("bravo"))
        // Tapping the tab again asks Studio to go to the destination.
        var sent: [String] = []
        model.requestNavigation = { sent.append($0) }
        model.selectTab(.destination("bravo"))
        #expect(sent == ["bravo"])
    }

    @Test func ignoresRequestsForUnknownDestinations() {
        let (model, requests) = makeModel(catalog(primary: ["alpha"], more: []))
        model.open("zulu")
        #expect(requests.sent.isEmpty)
    }

    @Test func aReplacementCatalogMovesSelectionOffARemovedTab() {
        let (model, _) = makeModel(catalog(primary: ["alpha", "bravo"], more: []), active: "bravo")
        model.apply(catalog(primary: ["alpha"], more: ["bravo"]))
        #expect(model.selectedTab == .more)
        #expect(model.frontendTab == .more)
    }

    @Test func resetForgetsEverything() {
        let (model, _) = makeModel(catalog(primary: ["alpha"], more: ["bravo"]), active: "bravo")
        model.reset()
        #expect(!model.isAvailable)
        #expect(model.activeDestinationID == nil)
        #expect(model.selectedTab == .more)
    }
}
