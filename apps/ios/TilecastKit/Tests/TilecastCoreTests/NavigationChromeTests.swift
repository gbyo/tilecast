import Foundation
import Testing
@testable import TilecastCore

/// The native back bar: what Studio describes, and what the back button
/// sends.
@MainActor
@Suite struct NavigationChromeTests {
    let bridge = StudioBridge(origin: serverOrigin)

    private func chrome(_ payload: [String: Any]) -> JSONValue {
        bridge.replyValue(to: envelope("navigation/chrome", payload), from: .studio)
    }

    @Test func aDrillInShowsABackBarWithTheParentsName() {
        #expect(chrome(["title": "Lobby north", "back": ["label": "Fleet"]]) == NativeBridgeProtocol.reply(id: nil, payload: [:]))
        #expect(bridge.navigation.chrome == NavigationChrome(title: "Lobby north", backLabel: "Fleet"))
        #expect(bridge.navigation.chrome.showsBackBar)
    }

    @Test func aTopLevelPageShowsNoBar() {
        _ = chrome(["title": "Lobby north", "back": ["label": "Fleet"]])
        _ = chrome(["title": "Fleet"])
        #expect(!bridge.navigation.chrome.showsBackBar)
        #expect(bridge.navigation.chrome.title == "Fleet")
    }

    @Test func aMalformedChromeChangesNothing() {
        _ = chrome(["title": "Lobby north", "back": ["label": "Fleet"]])
        #expect(chrome(["title": ""]) == NativeBridgeProtocol.reply(id: nil, error: .malformed))
        #expect(chrome(["title": "x", "back": ["label": "Fleet", "path": "/screens"]]) == NativeBridgeProtocol.reply(id: nil, error: .malformed))
        #expect(bridge.navigation.chrome.title == "Lobby north")
    }

    @Test func thePresentationPageMayNotDescribeTheMainPage() {
        let presentation = StudioBridge(origin: serverOrigin, context: .presentation)
        #expect(presentation.replyValue(to: envelope("navigation/chrome", ["title": "x"]), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, error: .forbidden))
        #expect(!presentation.navigation.chrome.showsBackBar)
    }

    @Test func withdrawingNavigationRemovesTheBar() {
        _ = bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: .studio)
        _ = chrome(["title": "Lobby north", "back": ["label": "Fleet"]])
        _ = bridge.replyValue(to: envelope("navigation/catalog", ["groups": []]), from: .studio)
        #expect(!bridge.navigation.chrome.showsBackBar)
    }

    @Test func backIsIgnoredWithoutABar() {
        var sent = 0
        bridge.navigation.requestBack = { sent += 1 }
        bridge.navigation.goBack()
        #expect(sent == 0)
        _ = chrome(["title": "Lobby north", "back": ["label": "Fleet"]])
        bridge.navigation.goBack()
        #expect(sent == 1)
    }
}
