import Foundation
import Testing
import WebKit
@testable import TilecastCore

let serverOrigin = WebOrigin(URL(string: "https://signage.example.org")!)!

extension BridgeSender {
    static let studio = BridgeSender(isMainFrame: true, isPageWorld: true, origin: serverOrigin)
}

func envelope(_ type: String, _ payload: [String: Any] = [:], id: String? = nil) -> [String: Any] {
    var message: [String: Any] = ["version": 1, "type": type, "payload": payload]
    if let id { message["id"] = id }
    return message
}

func catalogPayload(_ ids: [String], primary: Set<String> = []) -> [String: Any] {
    ["groups": [["id": "main", "items": ids.map {
        ["id": $0, "title": $0.capitalized, "icon": "home", "mobilePlacement": primary.contains($0) ? "primary" : "more"]
    }]]]
}

@MainActor
@Suite struct StudioBridgeTests {
    let bridge = StudioBridge(origin: serverOrigin)

    func reply(_ body: Any?, from sender: BridgeSender = .studio) -> JSONValue {
        bridge.replyValue(to: body, from: sender)
    }

    @Test func answersConfigGetWithNativeNavigation() {
        #expect(reply(envelope("config/get", id: "c1")) == .object([
            "version": .number(1), "id": .string("c1"), "ok": .bool(true),
            "payload": .object(["protocolVersion": .number(1), "capabilities": .object(["nativeNavigation": .bool(true)])]),
        ]))
    }

    @Test(arguments: [
        BridgeSender(isMainFrame: false, isPageWorld: true, origin: serverOrigin),
        BridgeSender(isMainFrame: true, isPageWorld: false, origin: serverOrigin),
        BridgeSender(isMainFrame: true, isPageWorld: true, origin: nil),
        BridgeSender(isMainFrame: true, isPageWorld: true, origin: WebOrigin(URL(string: "https://evil.example")!)),
        BridgeSender(isMainFrame: true, isPageWorld: true, origin: WebOrigin(URL(string: "http://signage.example.org")!)),
        BridgeSender(isMainFrame: true, isPageWorld: true, origin: WebOrigin(URL(string: "https://signage.example.org:8443")!)),
    ])
    func refusesEverySenderButStudiosMainFrame(_ sender: BridgeSender) {
        #expect(reply(envelope("navigation/catalog", catalogPayload(["alpha"])), from: sender)
            == NativeBridgeProtocol.reply(id: nil, error: .forbidden))
        #expect(!bridge.navigation.isAvailable, "a refused sender changes nothing")
    }

    @Test func matchesWebKitSecurityOriginPorts() {
        // WebKit reports a default port as 0.
        #expect(WebOrigin(scheme: "HTTPS", host: "Signage.Example.org", port: 0) == serverOrigin)
        #expect(WebOrigin(scheme: "https", host: "signage.example.org", port: 443) == serverOrigin)
        #expect(WebOrigin(scheme: "about", host: "", port: 0) == nil)
    }

    @Test func toleratesUnknownTypesAndRefusesOtherVersions() {
        #expect(reply(envelope("presentation/open", id: "p1")) == NativeBridgeProtocol.reply(id: "p1", error: .unknownType))
        #expect(reply(["version": 2, "type": "config/get", "payload": [:]]) == NativeBridgeProtocol.reply(id: nil, error: .unsupportedVersion))
        #expect(reply("config/get") == NativeBridgeProtocol.reply(id: nil, error: .malformed))
        #expect(reply(nil) == NativeBridgeProtocol.reply(id: nil, error: .malformed))
    }

    @Test func replacesTheCatalogWithEachSnapshot() {
        _ = reply(envelope("navigation/catalog", catalogPayload(["alpha", "bravo"], primary: ["alpha"])))
        #expect(bridge.navigation.catalog?.destinations.map(\.id) == ["alpha", "bravo"])
        _ = reply(envelope("navigation/catalog", catalogPayload(["charlie"])))
        #expect(bridge.navigation.catalog?.destinations.map(\.id) == ["charlie"])
    }

    @Test func aRefusedCatalogWithdrawsTheOldOne() {
        _ = reply(envelope("navigation/catalog", catalogPayload(["alpha"])))
        #expect(bridge.navigation.isAvailable)
        let refused = reply(envelope("navigation/catalog", ["groups": [["id": "main", "items": [["id": "/alpha"]]]]]))
        #expect(refused == NativeBridgeProtocol.reply(id: nil, error: .malformed))
        #expect(!bridge.navigation.isAvailable, "Studio shows its sidebar again, so the app stops showing tabs")
    }

    @Test func selectionFollowsNavigationStateNotThePath() {
        _ = reply(envelope("navigation/catalog", catalogPayload(["alpha", "bravo"], primary: ["alpha", "bravo"])))
        _ = reply(envelope("navigation/state", ["activeDestinationId": "bravo", "path": "/alpha/looks-like-alpha"]))
        #expect(bridge.navigation.activeDestinationID == "bravo")
        #expect(bridge.navigation.selectedTab == .destination("bravo"))
    }

    @Test func treatsFrontendReadyAsIdempotent() {
        #expect(!bridge.isFrontendReady)
        for _ in 0..<2 {
            #expect(reply(envelope("frontend/ready")) == NativeBridgeProtocol.reply(id: nil, payload: [:]))
        }
        #expect(bridge.isFrontendReady)
    }

    @Test func aNewDocumentWithoutTheBridgeDropsTheOldNavigation() {
        _ = reply(envelope("config/get"))
        _ = reply(envelope("navigation/catalog", catalogPayload(["alpha"])))
        bridge.mainFrameNavigationStarted()
        bridge.mainFrameCommitted()
        #expect(!bridge.navigation.isAvailable)
    }

    @Test func aNewDocumentThatNegotiatedEarlyKeepsItsNavigation() {
        // WebKit may deliver the new document's first messages before the
        // app observes the commit.
        bridge.mainFrameNavigationStarted()
        _ = reply(envelope("config/get"))
        _ = reply(envelope("navigation/catalog", catalogPayload(["alpha"])))
        bridge.mainFrameCommitted()
        #expect(bridge.navigation.isAvailable)
    }

    @Test func sendsNothingBeforeStudioIsReady() async {
        #expect(await bridge.send(NativeBridgeProtocol.navigationRequest(destinationID: "alpha")) == false)
    }

    @Test func uninstallingForgetsStudiosNavigation() {
        _ = reply(envelope("frontend/ready"))
        _ = reply(envelope("navigation/catalog", catalogPayload(["alpha"])))
        bridge.uninstall()
        #expect(!bridge.navigation.isAvailable)
        #expect(!bridge.isFrontendReady)
    }
}

/// Exercises the bridge in real WebKit pages: what JavaScript can reach.
@MainActor
@Suite(.serialized) struct StudioBridgeWebKitTests {
    func makePage() throws -> StudioPage {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("A"))
        return StudioPage(profile: profile, dataStore: .nonPersistent(), applicationName: "TilecastTests")
    }

    func load(_ html: String, in page: WebPage) async throws {
        for try await _ in page.load(html: html, baseURL: URL(string: "https://signage.example.org/")!) {}
    }

    /// Studio's side of the handshake, as the React native host runs it.
    static let studio = """
        <!doctype html><script>
        window.tilecastNativeReceiver = (message) => {
          window.received = message;
          return message.type === "navigation/request";
        };
        </script>
        """

    @Test func studioReachesTheBridgeAndTheAppReachesStudio() async throws {
        let page = try makePage()
        defer { page.close() }
        try await load(Self.studio, in: page.webPage)

        let reply = try await page.webPage.callJavaScript("""
            const handler = window.webkit.messageHandlers.tilecastNative;
            const config = await handler.postMessage({ version: 1, type: "config/get", payload: {} });
            await handler.postMessage({ version: 1, type: "frontend/ready", payload: {} });
            await handler.postMessage({ version: 1, type: "navigation/catalog", payload: {
              groups: [{ id: "main", items: [{ id: "alpha", title: "Alpha", icon: "home", mobilePlacement: "primary" }] }]
            } });
            return config.payload.capabilities.nativeNavigation;
            """)
        #expect(reply as? Bool == true)
        #expect(page.bridge.navigation.catalog?.destinations.map(\.id) == ["alpha"])

        #expect(await page.bridge.send(NativeBridgeProtocol.navigationRequest(destinationID: "alpha")))
        let received = try await page.webPage.callJavaScript("return window.received.payload.destinationId")
        #expect(received as? String == "alpha")
    }

    @Test func aSubframeCannotUseTheBridge() async throws {
        let page = try makePage()
        defer { page.close() }
        try await load(Self.studio + "<iframe srcdoc=\"<p>widget</p>\"></iframe>", in: page.webPage)
        try await Task.sleep(for: .milliseconds(200))

        let result = try await page.webPage.callJavaScript("""
            const frame = document.querySelector("iframe").contentWindow;
            const reply = await frame.webkit.messageHandlers.tilecastNative.postMessage(
              { version: 1, type: "navigation/catalog", payload: { groups: [{ id: "x", items: [{ id: "evil", title: "Evil", icon: "home" }] }] } }
            );
            return reply.error.code;
            """)
        #expect(result as? String == "forbidden")
        #expect(!page.bridge.navigation.isAvailable)
    }

    @Test func theAuxiliaryPageHasNoBridge() async throws {
        let page = try makePage()
        defer { page.close() }
        try await load(Self.studio, in: page.webPage)
        #expect(try await page.webPage.callJavaScript("return typeof window.webkit?.messageHandlers?.tilecastNative") as? String == "object")

        page.handle(.openAuxiliary(URL(string: "https://signage.example.org/preview")!))
        let auxiliary = try #require(page.auxiliaryPage)
        try await load("<!doctype html><p>preview</p>", in: auxiliary)
        #expect(try await auxiliary.callJavaScript("return typeof window.webkit?.messageHandlers?.tilecastNative") as? String == "undefined")
    }

    @Test func aClosedPageRemovesTheHandler() async throws {
        let page = try makePage()
        try await load(Self.studio, in: page.webPage)
        page.close()
        #expect(try await page.webPage.callJavaScript("return typeof window.webkit?.messageHandlers?.tilecastNative") as? String == "undefined")
    }

    @Test func thePageAndBridgeAreReleasedAfterClose() async throws {
        weak var weakPage: StudioPage?
        weak var weakBridge: StudioBridge?
        do {
            let page = try makePage()
            try await load(Self.studio, in: page.webPage)
            weakPage = page
            weakBridge = page.bridge
            page.close()
        }
        try await Task.sleep(for: .milliseconds(100))
        #expect(weakPage == nil, "the message handler must not retain the page")
        #expect(weakBridge == nil)
    }
}
