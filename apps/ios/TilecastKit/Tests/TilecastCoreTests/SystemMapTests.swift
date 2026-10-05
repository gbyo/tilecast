import Testing
@testable import TilecastCore

@Suite @MainActor struct SystemMapBridgeTests {
    let bridge = StudioBridge(origin: serverOrigin)
    let center = SystemMapCenter()

    init() {
        bridge.maps = center
    }

    private var payload: [String: Any] {
        [
            "mapId": "fleet-screens",
            "title": "Fleet",
            "points": [
                [
                    "id": "screen-1",
                    "title": "Lobby",
                    "subtitle": "Main Campus · Lobby",
                    "latitude": 34.157,
                    "longitude": -82.027,
                    "tone": "positive",
                    "actionId": "screen-1",
                ],
            ],
        ]
    }

    @Test func aMapRequiresCapabilityNegotiation() {
        let request = envelope("system/map-present", payload)
        #expect(
            bridge.replyValue(to: request, from: .studio)
                == NativeBridgeProtocol.reply(id: nil, error: .unavailable)
        )

        _ = bridge.replyValue(to: envelope("frontend/ready"), from: .studio)
        #expect(
            bridge.replyValue(to: request, from: .studio)
                == NativeBridgeProtocol.reply(id: nil, error: .unavailable)
        )

        _ = bridge.replyValue(
            to: envelope("frontend/ready", ["capabilities": ["systemMap": true]]),
            from: .studio
        )
        #expect(
            bridge.replyValue(to: request, from: .studio)
                == NativeBridgeProtocol.reply(id: nil, payload: [:])
        )
        #expect(center.current?.id == "fleet-screens")
        #expect(center.current?.points.first?.actionID == "screen-1")
    }

    @Test func aNewDocumentWithdrawsItsMap() {
        _ = bridge.replyValue(
            to: envelope("frontend/ready", ["capabilities": ["systemMap": true]]),
            from: .studio
        )
        _ = bridge.replyValue(to: envelope("system/map-present", payload), from: .studio)
        #expect(center.current != nil)

        bridge.mainFrameNavigationStarted()
        #expect(center.current == nil)
    }

    @Test func duplicatePointIDsAreMalformed() {
        var duplicate = payload
        duplicate["points"] = [
            ["id": "screen-1", "title": "One", "latitude": 34.157, "longitude": -82.027],
            ["id": "screen-1", "title": "Two", "latitude": 34.158, "longitude": -82.026],
        ]
        #expect(
            bridge.replyValue(to: envelope("system/map-present", duplicate), from: .studio)
                == NativeBridgeProtocol.reply(id: nil, error: .malformed)
        )
    }

    @Test func StudioCanWithdrawTheMatchingMap() {
        _ = bridge.replyValue(
            to: envelope("frontend/ready", ["capabilities": ["systemMap": true]]),
            from: .studio
        )
        _ = bridge.replyValue(to: envelope("system/map-present", payload), from: .studio)
        _ = bridge.replyValue(
            to: envelope("system/map-dismiss", ["mapId": "fleet-screens"]),
            from: .studio
        )
        #expect(center.current == nil)
    }
}
