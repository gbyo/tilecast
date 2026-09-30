import Foundation
import Testing
import WebKit
@testable import TilecastCore

func alertPayload(_ id: String, buttons: [[String: Any]]? = nil) -> [String: Any] {
    [
        "alertId": id,
        "title": "Delete this schedule?",
        "message": "Screens stop following it at once.",
        "actions": buttons ?? [
            ["id": "cancel", "label": "Cancel", "role": "cancel"],
            ["id": "confirm", "label": "Delete", "role": "destructive"],
        ],
    ]
}

/// Alerts through a bridge, with no page: which messages the app accepts,
/// and which page an alert belongs to.
@MainActor
@Suite struct NativeAlertBridgeTests {
    let center = NativeAlertCenter()
    let main = StudioBridge(origin: serverOrigin)
    let presentation = StudioBridge(origin: serverOrigin, context: .presentation)

    init() {
        main.alerts = center
        presentation.alerts = center
    }

    private func negotiate(_ bridge: StudioBridge, alerts: Bool = true) {
        _ = bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativeAlerts": alerts]]), from: .studio)
    }

    private func present(_ bridge: StudioBridge, _ id: String = "a-1") -> JSONValue {
        bridge.replyValue(to: envelope("alert/present", alertPayload(id)), from: .studio)
    }

    private let accepted = NativeBridgeProtocol.reply(id: nil, payload: [:])
    private let refused = NativeBridgeProtocol.reply(id: nil, error: .unavailable)

    @Test func theAppOffersAlertsToBothPages() {
        for bridge in [main, presentation] {
            let payload = NativeBridgeProtocol.configPayload(context: bridge.context)
            guard case .object(let capabilities)? = payload["capabilities"] else {
                Issue.record("no capabilities")
                return
            }
            #expect(capabilities["nativeAlerts"] == .bool(true))
        }
    }

    @Test func showsTheAlertFromEitherPage() throws {
        negotiate(main)
        #expect(present(main) == accepted)
        let shown = try #require(center.current)
        #expect(shown.context == .main)
        #expect(shown.alert.title == "Delete this schedule?")
        #expect(shown.alert.message == "Screens stop following it at once.")
        #expect(shown.alert.buttons.map(\.role) == [.cancel, .destructive])
        #expect(center.alert(for: .main)?.id == "a-1")
        #expect(center.alert(for: .presentation) == nil)

        center.choose(buttonID: "cancel")
        negotiate(presentation)
        #expect(present(presentation, "a-2") == accepted)
        #expect(center.alert(for: .presentation)?.id == "a-2")
        #expect(center.alert(for: .main) == nil)
    }

    @Test func refusesAnAlertUntilStudioNegotiatedAlerts() {
        #expect(present(main) == refused, "no frontend/ready yet")
        negotiate(main, alerts: false)
        #expect(present(main) == refused, "an older Studio")
        #expect(center.current == nil)
    }

    @Test func showsOneAlertAtATime() {
        negotiate(main)
        negotiate(presentation)
        #expect(present(main, "a-1") == accepted)
        #expect(present(presentation, "a-2") == refused, "Studio then shows its own dialog")
        #expect(present(main, "a-3") == refused)
        #expect(center.current?.alert.id == "a-1")
    }

    /// A payload for each way an alert can be malformed, by name: dictionaries
    /// of `Any` cannot be test arguments.
    static func malformed(_ kind: String) -> [String: Any] {
        switch kind {
        case "no buttons": alertPayload("a-1", buttons: [])
        case "four buttons": alertPayload("a-1", buttons: ["a", "b", "c", "d"].map { ["id": $0, "label": $0] })
        case "repeated ids": alertPayload("a-1", buttons: [["id": "a", "label": "A"], ["id": "a", "label": "B"]])
        case "unknown role": alertPayload("a-1", buttons: [["id": "a", "label": "A", "role": "primary"]])
        case "long label": alertPayload("a-1", buttons: [["id": "a", "label": String(repeating: "l", count: 61)]])
        case "bad alert id": alertPayload("A B")
        default: ["alertId": "a-1", "title": "", "actions": [["id": "a", "label": "A"]]]
        }
    }

    @Test(arguments: ["no buttons", "four buttons", "repeated ids", "unknown role", "long label", "bad alert id", "empty title"])
    func refusesAMalformedAlert(_ kind: String) {
        negotiate(main)
        #expect(main.replyValue(to: envelope("alert/present", Self.malformed(kind)), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, error: .malformed))
        #expect(center.current == nil)
    }

    @Test func aButtonRoleThatIsNotKnownIsAPlainButton() throws {
        #expect(NativeAlert.Button.Role(token: "primary") == .default)
        #expect(NativeAlert.Button.Role(token: nil) == .default)
    }

    @Test func onlyTheAlertsOwnerCanWithdrawIt() {
        negotiate(main)
        negotiate(presentation)
        _ = present(main)
        _ = presentation.replyValue(to: envelope("alert/cancel", ["alertId": "a-1"]), from: .studio)
        #expect(center.current != nil, "another page cannot withdraw it")
        _ = main.replyValue(to: envelope("alert/cancel", ["alertId": "a-other"]), from: .studio)
        #expect(center.current != nil, "another alert id")
        _ = main.replyValue(to: envelope("alert/cancel", ["alertId": "a-1"]), from: .studio)
        #expect(center.current == nil)
    }

    @Test func aNewDocumentWithdrawsItsAlert() {
        negotiate(main)
        _ = present(main)
        main.mainFrameNavigationStarted()
        #expect(center.current == nil)
    }

    @Test func anUnknownButtonChangesNothing() {
        negotiate(main)
        _ = present(main)
        center.choose(buttonID: "nope")
        #expect(center.current != nil)
    }
}

/// The choice reaches the page that asked, in a real WebKit page.
@MainActor
@Suite(.serialized) struct NativeAlertPageTests {
    static let studio = """
        <!doctype html><script>
        window.received = [];
        window.tilecastNativeReceiver = (message) => { window.received.push(message); return true; };
        </script>
        """

    @Test func theChoiceIsSentToTheMainPage() async throws {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("A"))
        let main = StudioPage(profile: profile, dataStore: .nonPersistent(), applicationName: "TilecastTests")
        defer { main.close() }
        for try await _ in main.webPage.load(html: Self.studio, baseURL: URL(string: "https://signage.example.org/")!) {}
        _ = main.bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativeAlerts": true]]), from: .studio)
        #expect(main.bridge.replyValue(to: envelope("alert/present", alertPayload("a-1")), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, payload: [:]))

        main.alerts.choose(buttonID: "confirm")
        #expect(main.alerts.current == nil, "the alert is gone at once")
        try await settle {
            let json = try? await main.webPage.callJavaScript("return JSON.stringify(window.received)") as? String
            return json?.contains("alert/action") == true
        }
        let json = try await main.webPage.callJavaScript("return JSON.stringify(window.received)") as? String ?? "[]"
        let received = try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]] ?? []
        #expect(received.count == 1)
        #expect(received.first?["type"] as? String == "alert/action")
        let payload = received.first?["payload"] as? [String: Any]
        #expect(payload?["alertId"] as? String == "a-1")
        #expect(payload?["actionId"] as? String == "confirm")
    }
}
