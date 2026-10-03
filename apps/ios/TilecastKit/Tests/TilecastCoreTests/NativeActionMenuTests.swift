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

func triggerPayload(_ id: String) -> [String: Any] {
    var payload = menuPayload(id)
    payload["rect"] = ["x": 0.8, "y": 0.25, "width": 0.08, "height": 0.05]
    return payload
}

/// Menus through a bridge, with no page: which messages the app accepts,
/// and which page owns each registration.
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
        _ = bridge.replyValue(
            to: envelope("frontend/ready", ["capabilities": ["nativeActionMenus": menus]]),
            from: .studio
        )
    }

    private func arm(_ bridge: StudioBridge, _ id: String = "m-1") -> JSONValue {
        bridge.replyValue(to: envelope("action-menu/arm", menuPayload(id)), from: .studio)
    }

    private func register(_ bridge: StudioBridge, _ id: String = "m-1") -> JSONValue {
        bridge.replyValue(to: envelope("action-menu/register-trigger", triggerPayload(id)), from: .studio)
    }

    private let accepted = NativeBridgeProtocol.reply(id: nil, payload: [:])
    private let refused = NativeBridgeProtocol.reply(id: nil, error: .unavailable)

    @Test func theAppOffersGenericAndAnchoredMenusToBothPages() {
        for bridge in [main, presentation] {
            let payload = NativeBridgeProtocol.configPayload(context: bridge.context)
            guard case .object(let capabilities)? = payload["capabilities"] else {
                Issue.record("no capabilities")
                return
            }
            #expect(capabilities["nativeActionMenus"] == .bool(true))
            #expect(capabilities["nativeActionMenuAnchors"] == .bool(true))
        }
    }

    @Test func legacyImmediatePresentationIsRefusedSoStudioFallsBackToWeb() {
        negotiate(main)
        let reply = main.replyValue(
            to: envelope("action-menu/present", menuPayload("m-legacy")),
            from: .studio
        )
        #expect(reply == refused)
    }

    @Test func refusesMenusUntilStudioNegotiatedThem() {
        #expect(arm(main) == refused)
        #expect(register(main) == refused)
        negotiate(main, menus: false)
        #expect(arm(main) == refused)
        #expect(register(main) == refused)
        #expect(center.armed == nil)
        #expect(center.triggers.isEmpty)
    }

    @Test func registersAnAnchoredTriggerForEitherPage() throws {
        negotiate(main)
        #expect(register(main) == accepted)
        let mainTrigger = try #require(center.triggers(for: .main).first)
        #expect(mainTrigger.menu.label == "Actions for Fixture")
        #expect(mainTrigger.menu.items.map(\.id) == ["open", "restart", "delete"])
        #expect(mainTrigger.rect.x == 0.8)
        #expect(mainTrigger.rect.width == 0.08)
        #expect(center.triggers(for: .presentation).isEmpty)

        negotiate(presentation)
        #expect(register(presentation, "m-2") == accepted)
        #expect(center.triggers(for: .presentation).map(\.id) == ["m-2"])
    }

    @Test func updatingARegistrationReplacesItsDescriptorAndRect() throws {
        negotiate(main)
        #expect(register(main) == accepted)
        var updated = triggerPayload("m-1")
        updated["label"] = "Updated actions"
        updated["rect"] = ["x": 0.7, "y": 0.4, "width": 0.1, "height": 0.06]
        #expect(
            main.replyValue(
                to: envelope("action-menu/register-trigger", updated),
                from: .studio
            ) == accepted
        )
        let trigger = try #require(center.triggers(for: .main).first)
        #expect(center.triggers.count == 1)
        #expect(trigger.menu.label == "Updated actions")
        #expect(trigger.rect.x == 0.7)
    }

    @Test func anotherPageCannotReplaceOrUnregisterATrigger() {
        negotiate(main)
        negotiate(presentation)
        _ = register(main)
        #expect(register(presentation) == refused)
        _ = presentation.replyValue(
            to: envelope("action-menu/unregister-trigger", ["menuId": "m-1"]),
            from: .studio
        )
        #expect(center.triggers(for: .main).map(\.id) == ["m-1"])
        _ = main.replyValue(
            to: envelope("action-menu/unregister-trigger", ["menuId": "m-1"]),
            from: .studio
        )
        #expect(center.triggers.isEmpty)
    }

    @Test func malformedNormalizedBoundsAreRejected() {
        negotiate(main)
        var payload = triggerPayload("m-1")
        payload["rect"] = ["x": 0.95, "y": 0.2, "width": 0.2, "height": 0.1]
        let malformed = NativeBridgeProtocol.reply(id: nil, error: .malformed)
        #expect(
            main.replyValue(
                to: envelope("action-menu/register-trigger", payload),
                from: .studio
            ) == malformed
        )
        #expect(center.triggers.isEmpty)
    }

    @Test func refusesAMalformedMenu() {
        negotiate(main)
        let malformed = NativeBridgeProtocol.reply(id: nil, error: .malformed)
        #expect(main.replyValue(to: envelope("action-menu/arm", ["menuId": "m-1", "label": "L", "groups": []]), from: .studio) == malformed)
        #expect(main.replyValue(to: envelope("action-menu/arm", ["menuId": "m-1", "label": "L", "groups": [["items": []]]]), from: .studio) == malformed)
        #expect(main.replyValue(to: envelope("action-menu/arm", ["menuId": "m-1", "label": "L", "groups": [["items": [["id": "a", "label": "A"], ["id": "a", "label": "B"]]]]), from: .studio) == malformed)
        #expect(main.replyValue(to: envelope("action-menu/disarm", ["menuId": "M 1"]), from: .studio) == malformed)
        #expect(center.armed == nil)
    }

    @Test func anUnknownRoleIsADefaultAction() {
        #expect(NativeActionMenu.Item.Role(token: "primary") == .default)
        #expect(NativeActionMenu.Item.Role(token: nil) == .default)
        #expect(NativeActionMenu.Item.Role(token: "destructive") == .destructive)
    }

    @Test func armingReplacesTheArmedMenu() {
        negotiate(main)
        negotiate(presentation)
        #expect(arm(main, "m-1") == accepted)
        #expect(arm(main, "m-2") == accepted)
        #expect(center.armed?.menu.id == "m-2")
        #expect(center.armed?.context == .main)
        #expect(arm(presentation, "m-3") == accepted)
        #expect(center.armed?.menu.id == "m-3")
        #expect(center.armedMenu(for: .presentation)?.id == "m-3")
        #expect(center.armedMenu(for: .main) == nil)
    }

    @Test func onlyTheMenusOwnerCanDisarmIt() {
        negotiate(main)
        negotiate(presentation)
        _ = arm(main, "m-1")
        _ = presentation.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-1"]), from: .studio)
        #expect(center.armed != nil)
        _ = main.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-other"]), from: .studio)
        #expect(center.armed != nil)
        _ = main.replyValue(to: envelope("action-menu/disarm", ["menuId": "m-1"]), from: .studio)
        #expect(center.armed == nil)
    }

    @Test func aNewDocumentWithdrawsItsMenusAndTriggers() {
        negotiate(main)
        _ = arm(main)
        _ = register(main, "m-trigger")
        main.mainFrameNavigationStarted()
        #expect(center.armed == nil)
        #expect(center.showing == nil)
        #expect(center.triggers.isEmpty)
    }

    @Test func aLongPressConsumesTheArmedMenu() {
        negotiate(main)
        _ = arm(main, "m-1")
        #expect(center.consumeArmed(for: .main)?.id == "m-1")
        #expect(center.consumeArmed(for: .main)?.id == "m-1")
        #expect(center.showing?.menu.id == "m-1")
        #expect(center.consumeArmed(for: .presentation) == nil)
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
        #expect(center.consumeArmed(for: .main) == nil)
    }

    @Test func aStaleShowingChoiceIsIgnored() {
        negotiate(main)
        _ = arm(main, "m-1")
        _ = center.consumeArmed(for: .main)
        center.chooseShowing(actionID: "open", menuID: "m-old")
        #expect(center.showing?.menu.id == "m-1")
        center.chooseShowing(actionID: "restart", menuID: "m-1")
        #expect(center.showing?.menu.id == "m-1")
        _ = arm(main, "m-2")
        #expect(center.showing == nil)
        center.chooseShowing(actionID: "open", menuID: "m-1")
        #expect(center.armed?.menu.id == "m-2")
    }

    @Test func withdrawingClearsTheShowingMenu() {
        negotiate(main)
        _ = arm(main, "m-1")
        _ = center.consumeArmed(for: .main)
        main.mainFrameNavigationStarted()
        #expect(center.showing == nil)
    }
}
