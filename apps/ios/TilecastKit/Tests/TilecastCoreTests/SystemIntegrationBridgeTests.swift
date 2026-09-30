import Foundation
import Testing
import WebKit
@testable import TilecastCore

/// `system/haptic`, `system/share`, and media intake at the bridge: what the
/// app does with each request and which page may send it.
@MainActor
@Suite struct SystemIntegrationBridgeTests {
    let main = StudioBridge(origin: serverOrigin)
    let presentation = StudioBridge(origin: serverOrigin, context: .presentation)

    var ok: JSONValue { NativeBridgeProtocol.reply(id: nil, payload: [:]) }
    func refused(_ code: NativeBridgeProtocol.ErrorCode) -> JSONValue { NativeBridgeProtocol.reply(id: nil, error: code) }

    func negotiate(_ bridge: StudioBridge, capabilities: [String: Bool] = [:]) {
        _ = bridge.replyValue(to: envelope("config/get"), from: .studio)
        _ = bridge.replyValue(to: envelope("frontend/ready", ["capabilities": capabilities]), from: .studio)
    }

    // MARK: Haptics

    @Test(arguments: [StudioBridge.Which.main, .presentation])
    func performsSemanticFeedbackOnEitherPage(_ which: StudioBridge.Which) {
        let bridge = which == .main ? main : presentation
        var performed: [HapticFeedback] = []
        bridge.onHaptic = { performed.append($0) }
        for feedback in HapticFeedback.allCases {
            #expect(bridge.replyValue(to: envelope("system/haptic", ["feedback": feedback.rawValue]), from: .studio) == ok)
        }
        #expect(performed == HapticFeedback.allCases)
    }

    @Test func acceptsAFeedbackItDoesNotKnowAndPerformsNothing() {
        var performed: [HapticFeedback] = []
        main.onHaptic = { performed.append($0) }
        #expect(main.replyValue(to: envelope("system/haptic", ["feedback": "rumble-long"]), from: .studio) == ok)
        #expect(performed.isEmpty)
    }

    @Test(arguments: ["{}", #"{"feedback":3}"#, #"{"feedback":"Success"}"#, #"{"feedback":""}"#])
    func refusesAMalformedFeedback(_ json: String) throws {
        let payload = try #require(try foundationJSON(Data(json.utf8)) as? [String: Any])
        var performed = 0
        main.onHaptic = { _ in performed += 1 }
        #expect(main.replyValue(to: envelope("system/haptic", payload), from: .studio) == refused(.malformed))
        #expect(performed == 0)
    }

    @Test func saysUnavailableWhenNothingPerformsFeedback() {
        #expect(main.replyValue(to: envelope("system/haptic", ["feedback": "success"]), from: .studio) == refused(.unavailable))
    }

    // MARK: Share

    @Test(arguments: [StudioBridge.Which.main, .presentation])
    func presentsTheShareSheetForEitherPage(_ which: StudioBridge.Which) {
        let bridge = which == .main ? main : presentation
        var shared: [SystemShare] = []
        bridge.onShare = { shared.append($0); return true }
        let payload: [String: Any] = ["title": "Lobby", "text": "Doors open at nine.", "url": "https://signage.example.org/events/lobby"]
        #expect(bridge.replyValue(to: envelope("system/share", payload), from: .studio) == ok)
        #expect(shared == [SystemShare(title: "Lobby", text: "Doors open at nine.", url: URL(string: "https://signage.example.org/events/lobby"))])
    }

    @Test func saysUnavailableWhenTheAppCannotPresentTheSheet() {
        main.onShare = { _ in false }
        #expect(main.replyValue(to: envelope("system/share", ["text": "Hello"]), from: .studio) == refused(.unavailable))
        main.onShare = nil
        #expect(main.replyValue(to: envelope("system/share", ["text": "Hello"]), from: .studio) == refused(.unavailable))
    }

    @Test(arguments: [
        "javascript:alert(1)", "file:///etc/passwd", "data:text/plain,hi", "ftp://signage.example.org/",
        "https://user:pw@signage.example.org/", "https://signage.example.org/?access_token=x",
        "https://other.example/cb?code=1&state=2", "//signage.example.org/",
        "https://signage.example.org/a%20b?x=1#access_token=abc",
    ])
    func neverSharesAnUnsafeURL(_ url: String) {
        var shared = 0
        main.onShare = { _ in shared += 1; return true }
        #expect(main.replyValue(to: envelope("system/share", ["url": url]), from: .studio) == refused(.malformed))
        #expect(shared == 0)
    }

    @Test func neverSharesAPrivateAPIAddressOfTheConnectedServer() {
        var shared = 0
        main.onShare = { _ in shared += 1; return true }
        for path in ["/api/v1/assets/1/file", "/API/v1/uploads", "/__native/modal/x", "/api"] {
            let payload: [String: Any] = ["url": "https://signage.example.org\(path)"]
            #expect(main.replyValue(to: envelope("system/share", payload), from: .studio) == refused(.unavailable), "\(path)")
        }
        #expect(shared == 0)
        // Another host's /api path is an ordinary public link.
        #expect(main.replyValue(to: envelope("system/share", ["url": "https://docs.example.com/api/guide"]), from: .studio) == ok)
        #expect(shared == 1)
    }

    @Test func neverSharesATilecastCredential() {
        for text in ["tca_abcdef", "my tcr_abcdef token", "tc_device_x.y"] {
            #expect(main.replyValue(to: envelope("system/share", ["text": text]), from: .studio) == refused(.malformed), "\(text)")
        }
    }

    @Test func boundsWhatItShares() {
        #expect(SystemShare.decode(["text": .string(String(repeating: "a", count: 2000))]) != nil)
        #expect(SystemShare.decode(["text": .string(String(repeating: "a", count: 2001))]) == nil)
        #expect(SystemShare.decode(["title": .string(String(repeating: "a", count: 201)), "text": .string("x")]) == nil)
        #expect(SystemShare.decode(["title": .string("Only a title")]) == nil)
    }

    // MARK: Media intake

    @Test func reportsWhetherIntakeCanStartOnlyToAStudioThatHandlesTheResult() {
        main.isMediaIntakeAvailable = { true }
        #expect(main.replyValue(to: envelope("system/media-intake-status"), from: .studio) == refused(.unavailable), "no frontend/ready")
        negotiate(main, capabilities: ["nativePresentations": true])
        #expect(main.replyValue(to: envelope("system/media-intake-status"), from: .studio) == refused(.unavailable), "an older Studio")
        negotiate(main, capabilities: ["nativeMediaIntake": true])
        #expect(main.replyValue(to: envelope("system/media-intake-status", id: "m1"), from: .studio)
            == NativeBridgeProtocol.reply(id: "m1", payload: ["available": .bool(true)]))
        main.isMediaIntakeAvailable = { false }
        #expect(main.replyValue(to: envelope("system/media-intake-status", id: "m1"), from: .studio)
            == NativeBridgeProtocol.reply(id: "m1", payload: ["available": .bool(false)]))
        main.isMediaIntakeAvailable = nil
        #expect(main.replyValue(to: envelope("system/media-intake-status", id: "m1"), from: .studio)
            == NativeBridgeProtocol.reply(id: "m1", payload: ["available": .bool(false)]))
    }

    @Test func startsIntakeOnlyWhenTheHostCanAndStudioHandlesTheResult() {
        var requests: [MediaIntakeRequest] = []
        main.onMediaIntake = { requests.append($0); return true }
        let payload: [String: Any] = ["requestId": "mi-1", "accept": ["image"], "multiple": false]
        main.isMediaIntakeAvailable = { true }
        #expect(main.replyValue(to: envelope("system/media-intake", payload), from: .studio) == refused(.unavailable), "no frontend/ready")
        negotiate(main, capabilities: ["nativePresentations": true])
        #expect(main.replyValue(to: envelope("system/media-intake", payload), from: .studio) == refused(.unavailable), "an older Studio")
        negotiate(main, capabilities: ["nativeMediaIntake": true])
        main.isMediaIntakeAvailable = { false }
        #expect(main.replyValue(to: envelope("system/media-intake", payload), from: .studio) == refused(.unavailable), "no native credential")
        #expect(requests.isEmpty)
        main.isMediaIntakeAvailable = { true }
        #expect(main.replyValue(to: envelope("system/media-intake", payload), from: .studio) == ok)
        #expect(requests == [MediaIntakeRequest(requestID: "mi-1", kinds: [.image], allowsMultiple: false)])
    }

    @Test func saysUnavailableWhenTheAppRefusesTheRequest() {
        negotiate(main, capabilities: ["nativeMediaIntake": true])
        main.isMediaIntakeAvailable = { true }
        main.onMediaIntake = { _ in false }
        #expect(main.replyValue(to: envelope("system/media-intake", ["requestId": "mi-1"]), from: .studio) == refused(.unavailable))
    }

    @Test func theIntakeMessagesCarryNoFileDataPathOrCredential() throws {
        for payload in [
            ["requestId": "mi-1", "accept": ["image"], "csrf": "x"] as [String: Any],
            ["requestId": "mi-1", "destination": "/tmp/x", "data": "AAAA"],
        ] {
            guard case .accept(.mediaIntake(let request), _) = NativeBridgeProtocol.decode(envelope("system/media-intake", payload)) else {
                Issue.record("intake refused")
                return
            }
            // Only the four fields of the request exist to carry anything.
            #expect(Mirror(reflecting: request).children.map { $0.label } == ["requestID", "kinds", "allowsMultiple"])
        }
    }

    @Test func sendsTheResultOnlyToAStudioThatReportedTheCapability() async {
        #expect(await main.sendMediaIntakeCompleted(requestID: "mi-1", outcome: .completed, uploadedCount: 1) == false, "not ready")
        negotiate(main, capabilities: ["nativePresentations": true])
        #expect(await main.sendMediaIntakeCompleted(requestID: "mi-1", outcome: .completed, uploadedCount: 1) == false, "an older Studio")
        #expect(await presentation.sendMediaIntakeCompleted(requestID: "mi-1", outcome: .completed, uploadedCount: 1) == false, "not the main page")
    }

    // MARK: Deep links

    @Test func aDeepLinkWaitsForASignedInStudioThatReportedTheCapability() async {
        #expect(!main.canReceiveDeepLink)
        negotiate(main, capabilities: ["nativePresentations": true])
        _ = main.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: .studio)
        #expect(!main.canReceiveDeepLink, "an older Studio does not report deepLinks")
        negotiate(main, capabilities: ["deepLinks": true])
        #expect(main.canReceiveDeepLink)
        // Signing out withdraws the catalog, and with it the ability to receive a link.
        _ = main.replyValue(to: envelope("navigation/catalog", ["groups": []]), from: .studio)
        #expect(!main.canReceiveDeepLink)
    }

    @Test(arguments: ["/login", "/setup", "/oauth/approve", "/__native/modal", "//evil.example", "https://evil.example/"])
    func neverDeliversAnAuthenticationOrForeignPath(_ path: String) async {
        negotiate(main, capabilities: ["deepLinks": true])
        _ = main.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: .studio)
        #expect(main.canReceiveDeepLink)
        #expect(await main.openDeepLinkPath(path) == false)
    }
}

extension StudioBridge {
    /// Parameter values for tests that run on both bridge contexts.
    enum Which: Sendable, CustomTestStringConvertible {
        case main, presentation
        var testDescription: String { self == .main ? "main page" : "presentation page" }
    }
}

/// The new messages in real WebKit pages: what Studio's JavaScript sees.
@MainActor
@Suite(.serialized) struct SystemIntegrationWebKitTests {
    func makePage() throws -> StudioPage {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("A"))
        return StudioPage(profile: profile, dataStore: .nonPersistent(), applicationName: "TilecastTests")
    }

    static let studio = """
        <!doctype html><script>
        window.received = [];
        window.tilecastNativeReceiver = (message) => { window.received.push(message); return true; };
        window.post = (type, payload) =>
          window.webkit.messageHandlers.tilecastNative.postMessage({ version: 1, type, payload });
        </script>
        """

    func load(_ page: StudioPage) async throws {
        for try await _ in page.webPage.load(html: Self.studio, baseURL: URL(string: "https://signage.example.org/")!) {}
        _ = try await page.webPage.callJavaScript("""
            await window.post("config/get", {});
            await window.post("frontend/ready", { capabilities: { nativeMediaIntake: true, deepLinks: true } });
            await window.post("navigation/catalog", { groups: [{ id: "main", items: [{ id: "alpha", title: "Alpha", icon: "home" }] }] });
            """)
    }

    @Test func aDeepLinkReachesStudiosReceiverAsAnOpenPathMessage() async throws {
        let page = try makePage()
        defer { page.close() }
        try await load(page)
        #expect(await page.bridge.openDeepLinkPath("/screens/screen-1?tab=activity"))
        let received = try #require(try await page.webPage.callJavaScript("""
            return window.received.map((message) => `${message.type} ${message.payload.path} ${Object.keys(message.payload).length}`).join("|")
            """) as? String)
        #expect(received == "navigation/open-path /screens/screen-1?tab=activity 1")
    }

    @Test func theMediaIntakeResultCarriesOnlyTheCoordinationFields() async throws {
        let page = try makePage()
        defer { page.close() }
        try await load(page)
        #expect(await page.bridge.sendMediaIntakeCompleted(requestID: "mi-1", outcome: .partial, uploadedCount: 2))
        let keys = try #require(try await page.webPage.callJavaScript("""
            return JSON.stringify(Object.keys(window.received[0].payload).sort())
            """) as? String)
        #expect(keys == #"["outcome","requestId","uploadedCount"]"#)
    }

    @Test func studioReachesShareHapticAndIntakeThroughTheRealHandler() async throws {
        let page = try makePage()
        defer { page.close() }
        var haptics: [HapticFeedback] = []
        var shares: [SystemShare] = []
        page.bridge.onHaptic = { haptics.append($0) }
        page.bridge.onShare = { shares.append($0); return true }
        page.bridge.isMediaIntakeAvailable = { true }
        page.bridge.onMediaIntake = { _ in true }
        try await load(page)
        let replies = try #require(try await page.webPage.callJavaScript("""
            const results = [];
            results.push((await window.post("system/haptic", { feedback: "success" })).ok);
            results.push((await window.post("system/share", { text: "Hello", url: "https://signage.example.org/x" })).ok);
            results.push((await window.post("system/share", { url: "javascript:alert(1)" })).error.code);
            results.push((await window.post("system/media-intake-status", {})).payload.available);
            results.push((await window.post("system/media-intake", { requestId: "mi-1" })).ok);
            return JSON.stringify(results);
            """) as? String)
        #expect(replies == #"[true,true,"malformed",true,true]"#)
        #expect(haptics == [.success])
        #expect(shares.count == 1)
    }
}
