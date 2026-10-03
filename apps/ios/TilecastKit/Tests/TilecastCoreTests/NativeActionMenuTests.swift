import Foundation
import Testing
import WebKit
@testable import TilecastCore

func menuPayload(_ id: String, groups: [[String: Any]]? = nil) -> [String: Any] {
    [
        "menuId": id,
        "label": "Actions for Fixture",
        "groups": groups ?? [
            ["items": [
                ["id": "open", "label": "Open", "icon": "open"],
                ["id": "restart", "label": "Restart", "disabled": true],
            ]],
            ["items": [
                ["id": "delete", "label": "Delete", "icon": "trash", "role": "destructive"],
            ]],
        ],
    ]
}

/// Menus through a bridge, with no page: which messages the app accepts,
/// and which page a menu belongs to.
@MainActor
@Suite struct NativeActionMenuBridgeTests {
    let center = NativeActionMenuCenter()
    let main = StudioBridge(origin: serverOrigin)
    let presentation = StudioBridge(origin: serverOrigin, context: .presentation)

    init() {
        main.menus = center
        presentation.menus = center
    }

    private func negotiate(_ bridge: StudioBridge, menus: Bool = true) {
        _ = bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativeActionMenus": menus]]), from: .studio)
    }

    private func present(_ bridge: StudioBridge, _ id: String = "m-1") -> JSONValue {
        bridge.replyValue(to: envelope("action-menu/present", menuPayload(id)), from: .studio)
    }

    private func arm(_ bridge: StudioBridge, _ id: String = "m-1") -> JSONValue {
        bridge.replyValue(to: envelope("action-menu/arm", menuPayload(id)), from: .studio)
    }

    private let accepted = NativeBridgeProtocol.reply(id: nil, payload: [:])
    private let refused = NativeBridgeProtocol.reply(id: nil, error: .unavailable)

    @Test func theAppOffersMenusToBothPages() {
        for bridge in [main, presentation] {
            let payload = NativeBridgeProtocol.configPayload(context: bridge.context)
            guard case .object(let capabilities)? = payload["capabilities"] else {
                Issue.record("no capabilities")
                return
            }
            #expect(capabilities["nativeActionMenus"] == .bool(true))
        }
    }

    @Test func showsTheMenuFromEitherPage() throws {
        negotiate(main)
        #expect(present(main) == accepted)
        let shown = try #require(center.immediate)
        #expect(shown.context == .main)
        #expect(shown.menu.label == "Actions for Fixture")
        #expect(shown.menu.items.map(\.id) == ["open", "restart", "delete"])
        #expect(shown.menu.items.map(\.role) == [.default, .default, .destructive])
        #expect(shown.menu.items.map(\.isDisabled) == [false, true, false])
        #expect(center.menu(for: .main)?.id == "m-1")
        #expect(center.menu(for: .presentation) == nil)

        center.choose(actionID: "open")
        negotiate(presentation)
        #expect(present(presentation, "m-2") == accepted)
        #expect(center.menu(for: .presentation)?.id == "m-2")
        #expect(center.menu(for: .main) == nil)
    }

    @Test func refusesAMenuUntilStudioNegotiatedMenus() {
        #expect(present(main) == refused, "no frontend/ready yet")
        negotiate(main, menus: false)
        #expect(present(main) == refused, "an older Studio")
        #expect(arm(main) == refused, "arming needs the capability too")
        #expect(center.immediate == nil)
        #expect(center.armed == nil)
    }

    @Test func showsOneImmediateMenuAtATime() {
        negotiate(main)
        negotiate(presentation)
        #expect(present(main, "m-1") == accepted)
        #expect(present(presentation, "m-2") == refused, "Studio then shows its own menu")
        #expect(present(main, "m-3") == refused)
        #expect(center.immediate?.menu.id == "m-1")
    }

    @Test func armingReplacesTheArmedMenu() {
        negotiate(main)
        negotiate(presentation)
        #expect(arm(main, "m-1") == accepted)
        #expect(arm(main, "m-2") == accepted, "a fresh press re-arms")
        #expect(center.armed?.menu.id == "m-2")
        #expect(center.armed?.context == .main)
        #expect(arm(presentation, "m-3") == accepted)
        #expect(center.armed?.menu.id == "m-3")
        #expect(center.armedMenu(for: .presentation)?.id == "m-3")
        #expect(center.armedMenu(for: .main) == nil, "the main page shows no other page's menu")
    }

    @Test func refusesAMalformedMenu() {
        negotiate(main)
        let malformed = NativeBridgeProtocol.reply(id: nil, error: .malformed)
        #expect(main.replyValue(to: envelope("action-menu/present", ["menuId": "m-1", "label": "L", "groups": []]), from: .studio) == malformed)
        #expect(main.replyValue(to: envelope("action-menu/present", ["menuId": "m-1", "label": "L", "groups": [["items": []]]]), from: .studio) == malformed)
        #expect(main.replyValue(to: envelope("action-menu/arm", ["menuId": "m-1", "label": "L", "groups": [["items": [["id": "a", "label": "A"], ["id": "a", "label": "B"]]]]]), from: .studio) == malformed)
        #expect(main.replyValue(to: envelope("action-menu/disarm", ["menuId": "M 1"]), from: .studio) == malformed)
        #expect(center.immediate == nil)
        #expect(center.armed == nil)
    }

    @Test func anUnknownRoleIsADefaultAction() {
        #expect(NativeActionMenu.Item.Role(token: "primary") == .default)
        #expect(NativeActionMenu.Item.Role(token: nil) == .default)
        #expect(NativeActionMenu.Item.Role(token: "destructive") == .destructive)
    }

    @Test func onlyTheMenusOwnerCanDisarmIt() {
        negotiate(main)
        negotiate(presentation)
        _ = arm(main, "m-1")
        _ = presentation.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-1"]), from: .studio)
        #expect(center.armed != nil, "another page cannot disarm it")
        _ = main.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-other"]), from: .studio)
        #expect(center.armed != nil, "another menu id")
        _ = main.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-1"]), from: .studio)
        #expect(center.armed == nil)
    }

    @Test func disarmingDismissesThePresentedMenu() {
        negotiate(main)
        _ = present(main)
        _ = main.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-1"]), from: .studio)
        #expect(center.immediate == nil)
    }

    @Test func aNewDocumentWithdrawsItsMenus() {
        negotiate(main)
        _ = present(main)
        _ = arm(main, "m-armed")
        main.mainFrameNavigationStarted()
        #expect(center.immediate == nil)
        #expect(center.armed == nil)
    }

    @Test func anUnknownOrDisabledActionChangesNothing() {
        negotiate(main)
        _ = present(main)
        center.choose(actionID: "nope")
        #expect(center.immediate != nil)
        center.choose(actionID: "restart")
        #expect(center.immediate != nil, "a disabled action cannot be chosen")
    }

    @Test func aLongPressConsumesTheArmedMenu() {
        negotiate(main)
        _ = arm(main, "m-1")
        #expect(center.consumeArmed(for: .main)?.id == "m-1")
        #expect(center.consumeArmed(for: .main)?.id == "m-1", "building twice is harmless")
        #expect(center.showing?.menu.id == "m-1")
        #expect(center.consumeArmed(for: .presentation) == nil, "the other page keeps its default menu")
    }

    @Test func aDisarmAfterConsumeKeepsTheShowingMenu() {
        negotiate(main)
        _ = arm(main, "m-1")
        _ = center.consumeArmed(for: .main)
        _ = main.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-1"]), from: .studio)
        #expect(center.armed == nil)
        center.chooseShowing(actionID: "open", menuID: "m-1")
        #expect(center.showing == nil)
    }

    @Test func choosingTheShowingMenuConsumesTheArmedCopyToo() {
        negotiate(main)
        _ = arm(main, "m-1")
        _ = center.consumeArmed(for: .main)
        center.chooseShowing(actionID: "open", menuID: "m-1")
        #expect(center.showing == nil)
        #expect(center.armed == nil)
        #expect(center.consumeArmed(for: .main) == nil, "no stale menu for the next press")
    }

    @Test func aStaleShowingChoiceIsIgnored() {
        negotiate(main)
        _ = arm(main, "m-1")
        _ = center.consumeArmed(for: .main)
        center.chooseShowing(actionID: "open", menuID: "m-old")
        #expect(center.showing?.menu.id == "m-1")
        center.chooseShowing(actionID: "restart", menuID: "m-1")
        #expect(center.showing?.menu.id == "m-1", "a disabled action cannot be chosen")
        _ = arm(main, "m-2")
        #expect(center.showing == nil, "a new arm supersedes the consumed menu")
        center.chooseShowing(actionID: "open", menuID: "m-1")
        #expect(center.armed?.menu.id == "m-2", "a replaced menu never answers")
    }

    @Test func withdrawingClearsTheShowingMenu() {
        negotiate(main)
        _ = arm(main, "m-1")
        _ = center.consumeArmed(for: .main)
        main.mainFrameNavigationStarted()
        #expect(center.showing == nil)
    }
}
