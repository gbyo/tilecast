import Foundation
import Testing
import WebKit
@testable import TilecastCore

let presentationRoot = "/__native/modal"
/// A child route. The app never names one; tests use it as data.
let fixtureRoute = "/__native/modal/fixture/one"

/// Waits for a condition that WebKit or a bridge task makes true. The limit
/// is generous because a loaded CI runner starts a web content process slowly.
@MainActor
func settle(timeout: Duration = .seconds(30), _ condition: @MainActor () async -> Bool) async throws {
    let deadline = ContinuousClock.now + timeout
    while await !condition() {
        guard ContinuousClock.now < deadline else {
            Issue.record("condition not met in time")
            return
        }
        try await Task.sleep(for: .milliseconds(20))
    }
}

func openPayload(_ id: String, path: String = fixtureRoute, title: String = "Fixture", extra: [String: Any] = [:]) -> [String: Any] {
    ["presentationId": id, "path": path, "title": title].merging(extra) { $1 }
}

/// Bridge contexts: each page may send only its own messages.
@MainActor
@Suite struct PresentationBridgeContextTests {
    let main = StudioBridge(origin: serverOrigin)
    let presentation = StudioBridge(origin: serverOrigin, context: .presentation)

    @Test func thePresentationBridgeReportsItsContextAndNoMainCapabilities() {
        #expect(presentation.replyValue(to: envelope("config/get"), from: .studio) == NativeBridgeProtocol.reply(id: nil, payload: [
            "protocolVersion": .number(1),
            "context": .string("presentation"),
            "capabilities": .object([
                "nativeNavigation": .bool(false), "authLifecycle": .bool(false), "nativePresentations": .bool(true), "nativeAlerts": .bool(true),
                "systemShare": .bool(true), "systemHaptics": .bool(true), "systemQrScanner": .bool(false),
                "systemMap": .bool(false), "nativeMediaIntake": .bool(false), "deepLinks": .bool(false),
            ]),
        ]))
    }

    /// A valid message of each type, whichever bridge receives it.
    static func valid(_ type: String) -> [String: Any] {
        switch type {
        case "navigation/catalog": envelope(type, catalogPayload(["alpha"]))
        case "navigation/state": envelope(type, ["activeDestinationId": "alpha"])
        case "presentation/open": envelope(type, openPayload("p-1"))
        case "presentation/update": envelope(type, ["presentationId": "p-1", "size": "full"])
        case "presentation/close": envelope(type, ["presentationId": "p-1"])
        case "presentation/navigate": envelope(type, ["presentationId": "p-1", "path": "/screens"])
        case "system/media-intake": envelope(type, ["requestId": "mi-1"])
        case "system/map-present": envelope(type, [
            "mapId": "fleet-screens",
            "title": "Fleet",
            "points": [["id": "screen-1", "title": "Lobby", "latitude": 34.157, "longitude": -82.027]],
        ])
        case "system/map-dismiss": envelope(type, ["mapId": "fleet-screens"])
        default: envelope(type)
        }
    }

    @Test(arguments: ["navigation/catalog", "navigation/state", "auth/signed-out", "presentation/open", "system/media-intake", "system/media-intake-status", "system/map-present", "system/map-dismiss"])
    func thePresentationBridgeRefusesMainPageMessages(_ type: String) {
        let message = Self.valid(type)
        _ = presentation.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativePresentations": true, "authLifecycle": true]]), from: .studio)
        var signedOut = false
        presentation.onSignedOut = { signedOut = true }
        var opened = false
        presentation.onPresentationOpen = { _ in opened = true; return true }
        presentation.isMediaIntakeAvailable = { true }
        presentation.onMediaIntake = { _ in opened = true; return true }
        #expect(presentation.replyValue(to: message, from: .studio) == NativeBridgeProtocol.reply(id: nil, error: .forbidden))
        #expect(!presentation.navigation.isAvailable, "a presentation never publishes the main navigation")
        #expect(!signedOut, "a presentation is not a second auth lifecycle owner")
        #expect(!opened)
    }

    @Test func aPresentationPageIsNeverAskedToSignOut() async {
        // Even when its Studio claims the capability.
        _ = presentation.replyValue(to: envelope("frontend/ready", ["capabilities": ["authLifecycle": true]]), from: .studio)
        #expect(presentation.frontendCapabilities.authLifecycle)
        #expect(await presentation.requestSignOut(timeout: .milliseconds(50)) == false)
    }

    @Test(arguments: ["presentation/ready", "presentation/update", "presentation/close", "presentation/navigate"])
    func theMainBridgeRefusesPresentationPageMessages(_ type: String) {
        let message = Self.valid(type)
        var received: [PresentationPageMessage] = []
        main.onPresentationMessage = { received.append($0) }
        #expect(main.replyValue(to: message, from: .studio) == NativeBridgeProtocol.reply(id: nil, error: .forbidden))
        #expect(received.isEmpty)
    }

    @Test(arguments: [
        BridgeSender(isMainFrame: false, isPageWorld: true, origin: serverOrigin),
        BridgeSender(isMainFrame: true, isPageWorld: false, origin: serverOrigin),
        BridgeSender(isMainFrame: true, isPageWorld: true, origin: WebOrigin(URL(string: "https://evil.example")!)),
    ])
    func thePresentationBridgeRefusesOtherSenders(_ sender: BridgeSender) {
        var received: [PresentationPageMessage] = []
        presentation.onPresentationMessage = { received.append($0) }
        #expect(presentation.replyValue(to: envelope("presentation/close", ["presentationId": "p-1"]), from: sender)
            == NativeBridgeProtocol.reply(id: nil, error: .forbidden))
        #expect(received.isEmpty)
    }

    @Test func theMainBridgeRefusesAPresentationWhenStudioDidNotNegotiateOne() {
        main.onPresentationOpen = { _ in true }
        #expect(main.replyValue(to: envelope("presentation/open", openPayload("p-1")), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, error: .unavailable), "no frontend/ready yet")
        _ = main.replyValue(to: envelope("frontend/ready", ["capabilities": ["authLifecycle": true]]), from: .studio)
        #expect(main.replyValue(to: envelope("presentation/open", openPayload("p-1")), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, error: .unavailable), "an older Studio")
        _ = main.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativePresentations": true]]), from: .studio)
        #expect(main.replyValue(to: envelope("presentation/open", openPayload("p-1")), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, payload: [:]))
    }

    @Test(arguments: [
        "/screens/screen-1",
        "https://evil.example/__native/modal",
        "//evil.example/__native/modal",
        "/__native/modal/../settings",
        "javascript:alert(1)",
    ])
    func pathsOutsideThePresentationTreeAreMalformed(_ path: String) {
        _ = main.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativePresentations": true]]), from: .studio)
        var opened = false
        main.onPresentationOpen = { _ in opened = true; return true }
        #expect(main.replyValue(to: envelope("presentation/open", openPayload("p-1", path: path)), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, error: .malformed))
        #expect(!opened)
    }
}

@Suite struct PresentationPathTests {
    @Test(arguments: [presentationRoot, "/__native/modal/fixture", "/__native/modal/fixture?step=2#top"])
    func acceptsTheReservedTree(_ path: String) {
        #expect(PresentationPaths.isPresentationPath(path))
        #expect(!PresentationPaths.isStudioPath(path), "the reserved tree is never a navigation destination")
    }

    @Test(arguments: [
        "", "/", "/__native", "/__native/modals", "/screens", "__native/modal", "//evil.example/__native/modal",
        "https://signage.example.org/__native/modal", "file:///__native/modal", "/__native/modal/..",
        "/__native/modal/%2E%2E/screens", "/__native/modal/\\evil", "/__native/modal/a b", "/__native/modal/\u{7}",
        "/__native/modal/" + String(repeating: "a", count: 1010),
    ])
    func refusesEverythingElseAsAPresentationPath(_ path: String) {
        #expect(!PresentationPaths.isPresentationPath(path))
    }

    @Test(arguments: ["/", "/screens/screen-1?tab=activity", "/settings/general#x", "/@evil.example"])
    func acceptsSameOriginStudioPaths(_ path: String) {
        #expect(PresentationPaths.isStudioPath(path))
    }

    @Test(arguments: [
        "screens", "//evil.example", "//user@evil.example/", "/\\evil.example", "https://evil.example/",
        "javascript:alert(1)", "/screens/../../settings", "/__native/other", "/screens\u{0}",
    ])
    func refusesOtherOriginsAndUnsafePathsForNavigation(_ path: String) {
        #expect(!PresentationPaths.isStudioPath(path))
    }
}

/// The presentation lifecycle in real WebKit pages. The presentation page
/// loads a fixture that speaks Studio's side of the presentation protocol,
/// as `apps/dashboard/src/native-presentation` does.
@MainActor
@Suite(.serialized) struct PresentationLifecycleTests {
    static let baseURL = URL(string: "https://signage.example.org/")!

    /// Studio in the presentation page. It shows each route it is sent
    /// with the History API, refuses a route containing "refuse", and
    /// records every message.
    static let presentationStudio = """
        <!doctype html><script>
        window.received = [];
        window.tilecastNativeReceiver = (message) => {
          window.received.push(message);
          if (message.type === "presentation/show") {
            if (message.payload.path.includes("refuse")) return false;
            history.replaceState(null, "", message.payload.path);
          }
          return message.type.startsWith("presentation/");
        };
        (async () => {
          const handler = window.webkit.messageHandlers.tilecastNative;
          const config = await handler.postMessage({ version: 1, type: "config/get", payload: {} });
          window.context = config.payload.context;
          await handler.postMessage({ version: 1, type: "frontend/ready", payload: { capabilities: { nativePresentations: true } } });
          if (!location.search.includes("silent")) {
            await handler.postMessage({ version: 1, type: "presentation/ready", payload: {} });
          }
        })();
        </script>
        """

    /// Studio in the main page: records messages and negotiates.
    static let mainStudio = """
        <!doctype html><script>
        window.received = [];
        window.tilecastNativeReceiver = (message) => { window.received.push(message); return true; };
        </script>
        """

    func makeMainPage(dataStore: WKWebsiteDataStore = .nonPersistent()) throws -> StudioPage {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("A"))
        return StudioPage(profile: profile, dataStore: dataStore, applicationName: "TilecastTests")
    }

    /// Replaces the page factory so presentation pages load the fixture.
    func useFixture(in main: StudioPage, query: String = "", readyTimeout: Duration = .seconds(20)) {
        let policy = StudioNavigationPolicy(origin: main.address.origin)
        main.presentations.makePage = { [address = main.address, store = main.websiteDataStore] in
            let page = PresentationPage(address: address, dataStore: store, applicationName: "TilecastTests", policy: policy)
            page.readyTimeout = readyTimeout
            page.loader = { webPage, url in
                _ = webPage.load(html: Self.presentationStudio, baseURL: URL(string: url.absoluteString + query)!)
            }
            return page
        }
    }

    /// Main Studio negotiates, as the React native host does.
    func negotiate(_ main: StudioPage, presentations: Bool = true, signedIn: Bool = true) {
        _ = main.bridge.replyValue(to: envelope("config/get"), from: .studio)
        _ = main.bridge.replyValue(
            to: envelope("frontend/ready", ["capabilities": ["authLifecycle": true, "nativePresentations": presentations]]),
            from: .studio
        )
        if signedIn { _ = main.bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: .studio) }
    }

    func open(_ main: StudioPage, _ id: String, path: String = fixtureRoute, extra: [String: Any] = [:]) -> JSONValue {
        main.bridge.replyValue(to: envelope("presentation/open", openPayload(id, path: path, extra: extra)), from: .studio)
    }

    func received(in page: WebPage) async throws -> [[String: Any]] {
        let json = try await page.callJavaScript("return JSON.stringify(window.received ?? [])") as? String ?? "[]"
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]] ?? []
    }

    func receivedTypes(in page: WebPage) async throws -> [String] {
        try await received(in: page).compactMap { $0["type"] as? String }
    }

    /// Sends a message as Studio in the presentation page would.
    func fromPresentation(_ main: StudioPage, _ type: String, _ payload: [String: Any]) -> JSONValue? {
        main.presentations.page?.bridge.replyValue(to: envelope(type, payload), from: .studio)
    }

    @Test func thePresentationPageSharesTheDataStoreButNotTheBridge() async throws {
        let store = WKWebsiteDataStore.nonPersistent()
        let main = try makeMainPage(dataStore: store)
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let presentation = try #require(main.presentations.page)
        #expect(presentation.websiteDataStore === store, "the same Studio session cookie")
        #expect(presentation.bridge !== main.bridge)
        #expect(presentation.bridge.context == .presentation)
        #expect(presentation.webPage !== main.webPage)
        try await settle { presentation.phase == .ready }
        #expect(try await presentation.webPage.callJavaScript("return window.context") as? String == "presentation")
    }

    @Test func prewarmsOnceAfterSignedInStudioNegotiates() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main, signedIn: false)
        #expect(main.presentations.page == nil, "not before Studio is signed in")
        _ = main.bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: .studio)
        let page = try #require(main.presentations.page)
        _ = main.bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha", "bravo"])), from: .studio)
        _ = main.bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativePresentations": true]]), from: .studio)
        #expect(main.presentations.page === page)
        #expect(main.presentations.pagesBuilt == 1)
        try await settle { page.phase == .ready }
        #expect(page.webPage.url?.path == presentationRoot, "it boots the empty presentation root")
    }

    @Test func anOlderStudioGetsNoPresentationPage() throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main, presentations: false)
        #expect(main.presentations.page == nil)
        #expect(open(main, "p-1") == NativeBridgeProtocol.reply(id: nil, error: .unavailable))
        #expect(main.presentations.presentation == nil)
        #expect(main.presentations.pagesBuilt == 0)
    }

    @Test func anOpenBeforePrewarmBootsThePageThenShowsTheRoute() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main, signedIn: false)
        #expect(open(main, "p-1", extra: ["subtitle": "Lobby", "size": "compact", "dismissible": false])
            == NativeBridgeProtocol.reply(id: nil, payload: [:]))
        let presentation = try #require(main.presentations.presentation)
        #expect(presentation.header == PresentationHeader(title: "Fixture", subtitle: "Lobby"))
        #expect(presentation.size == .compact)
        #expect(!presentation.isDismissible)
        #expect(main.presentations.contentState == .loading, "the sheet shows the native loader first")
        let page = try #require(main.presentations.page)
        try await settle { main.presentations.contentState == .ready }
        #expect(try await receivedTypes(in: page.webPage) == ["presentation/show"])
        #expect(page.webPage.url?.path == fixtureRoute, "Studio routed; the app did not load it")
    }

    @Test func dismissingKeepsThePageForTheNextPresentation() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        try await settle { page.phase == .ready }

        _ = open(main, "p-1")
        try await settle { main.presentations.contentState == .ready }
        _ = fromPresentation(main, "presentation/update", [
            "presentationId": "p-1", "size": "compact", "dismissible": false,
            "header": ["title": "Old", "actions": [["id": "refresh", "label": "Refresh", "icon": "activity"]], "menu": [["id": "more", "label": "More"]]],
        ])
        #expect(main.presentations.presentation?.header.actions.count == 1)
        main.presentations.dismiss(presentationID: "p-1")
        #expect(main.presentations.presentation == nil)
        try await settle { (try? await self.receivedTypes(in: page.webPage))?.last == "presentation/dismissed" }

        #expect(open(main, "p-2", path: "/__native/modal/fixture/two") == NativeBridgeProtocol.reply(id: nil, payload: [:]))
        let second = try #require(main.presentations.presentation)
        #expect(second.header == PresentationHeader(title: "Fixture"), "no title, toolbar, or menu from p-1")
        #expect(second.size == .full)
        #expect(second.isDismissible)
        try await settle { main.presentations.contentState == .ready }
        #expect(main.presentations.page === page, "the booted page is reused")
        #expect(main.presentations.pagesBuilt == 1)
        let shows = try await received(in: page.webPage).filter { $0["type"] as? String == "presentation/show" }
        #expect(shows.compactMap { ($0["payload"] as? [String: Any])?["presentationId"] as? String } == ["p-1", "p-2"])
    }

    @Test func messagesForAnEarlierPresentationAreIgnored() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        _ = open(main, "p-1")
        main.presentations.dismiss()
        _ = open(main, "p-2")
        let current = try #require(main.presentations.presentation)

        _ = fromPresentation(main, "presentation/update", ["presentationId": "p-1", "header": ["title": "Stale"], "size": "compact"])
        _ = fromPresentation(main, "presentation/close", ["presentationId": "p-1"])
        _ = fromPresentation(main, "presentation/navigate", ["presentationId": "p-1", "path": "/screens"])
        main.presentations.dismiss(presentationID: "p-1")
        #expect(main.presentations.presentation == current, "p-2 keeps its chrome and stays on screen")
    }

    @Test func anUpdateReplacesTheWholeHeader() throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        _ = open(main, "p-1")
        _ = fromPresentation(main, "presentation/update", ["presentationId": "p-1", "header": [
            "title": "Lobby", "subtitle": "Screen", "navigation": "back", "navigationLabel": "Back",
            "actions": [["id": "refresh", "label": "Refresh", "icon": "door-calendar"]],
        ]])
        let first = try #require(main.presentations.presentation?.header)
        #expect(first.navigation == .back)
        #expect(first.actions.map(\.icon) == ["door-calendar"], "an unknown icon token is kept for the generic fallback")

        _ = fromPresentation(main, "presentation/update", ["presentationId": "p-1", "header": ["title": "Lobby"]])
        #expect(main.presentations.presentation?.header == PresentationHeader(title: "Lobby"))
        _ = fromPresentation(main, "presentation/update", ["presentationId": "p-1", "size": "compact"])
        #expect(main.presentations.presentation?.header.title == "Lobby", "an update without a header keeps it")
        #expect(main.presentations.presentation?.size == .compact)
    }

    @Test func thePageCanCloseItself() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        try await settle { page.phase == .ready }
        _ = open(main, "p-1")
        _ = fromPresentation(main, "presentation/close", ["presentationId": "p-1"])
        #expect(main.presentations.presentation == nil)
        try await settle { (try? await self.receivedTypes(in: page.webPage))?.last == "presentation/dismissed" }
    }

    @Test func navigatingOutDismissesAndRelaysThroughTheMainRouter() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        for try await _ in main.webPage.load(html: Self.mainStudio, baseURL: Self.baseURL) {}
        _ = try await main.webPage.callJavaScript("""
            const handler = window.webkit.messageHandlers.tilecastNative;
            await handler.postMessage({ version: 1, type: "config/get", payload: {} });
            await handler.postMessage({ version: 1, type: "frontend/ready", payload: { capabilities: { nativePresentations: true } } });
            window.opened = await handler.postMessage({ version: 1, type: "presentation/open", payload: {
              presentationId: "p-1", path: "\(fixtureRoute)", title: "Fixture" } });
            """)
        #expect(try await main.webPage.callJavaScript("return window.opened.ok") as? Bool == true)
        let mainURL = main.webPage.url
        _ = fromPresentation(main, "presentation/navigate", ["presentationId": "p-1", "path": "/screens/screen-1?tab=activity"])
        #expect(main.presentations.presentation == nil, "the sheet is dismissed first")
        try await settle { (try? await self.received(in: main.webPage))?.isEmpty == false }
        try await settle { (try? await self.received(in: main.webPage))?.count == 2 }
        let relayed = try await received(in: main.webPage)
        #expect(relayed.compactMap { $0["type"] as? String } == ["presentation/ended", "navigation/open-path"])
        #expect((relayed.last?["payload"] as? [String: Any])?["path"] as? String == "/screens/screen-1?tab=activity")
        #expect(main.webPage.url == mainURL, "the main page is never loaded for it")
    }

    @Test func endingAPresentationTellsTheMainPageToRefetch() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        for try await _ in main.webPage.load(html: Self.mainStudio, baseURL: Self.baseURL) {}
        _ = try await main.webPage.callJavaScript("""
            const handler = window.webkit.messageHandlers.tilecastNative;
            await handler.postMessage({ version: 1, type: "config/get", payload: {} });
            await handler.postMessage({ version: 1, type: "frontend/ready", payload: { capabilities: { nativePresentations: true } } });
            window.opened = await handler.postMessage({ version: 1, type: "presentation/open", payload: {
              presentationId: "p-1", path: "\(fixtureRoute)", title: "Fixture" } });
            """)
        #expect(try await main.webPage.callJavaScript("return window.opened.ok") as? Bool == true)
        #expect(try await received(in: main.webPage).isEmpty, "nothing ended yet")
        main.presentations.dismiss(presentationID: "p-1")
        try await settle { (try? await self.received(in: main.webPage))?.isEmpty == false }
        let relayed = try await received(in: main.webPage)
        #expect(relayed.compactMap { $0["type"] as? String } == ["presentation/ended"])
        #expect((relayed.first?["payload"] as? [String: Any])?["presentationId"] as? String == "p-1")
        main.presentations.dismiss(presentationID: "p-1")
        #expect(try await received(in: main.webPage).count == 1, "a repeated dismissal ends nothing")
    }

    @Test func endingAPresentationWithdrawsItsAlertButNotTheMainPages() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        try await settle { page.phase == .ready }
        _ = open(main, "p-1")
        try await settle { main.presentations.contentState == .ready }

        _ = page.bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativeAlerts": true]]), from: .studio)
        #expect(page.bridge.replyValue(to: envelope("alert/present", alertPayload("a-1")), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, payload: [:]))
        #expect(main.alerts.alert(for: .presentation)?.id == "a-1")
        #expect(main.alerts.alert(for: .main) == nil, "the sheet shows its own alert")

        main.presentations.dismiss(presentationID: "p-1")
        #expect(main.alerts.current == nil, "the alert does not outlive its presentation")
    }

    @Test func aMemoryWarningDiscardsOnlyAHiddenPage() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let first = try #require(main.presentations.page)
        _ = open(main, "p-1")
        main.presentations.handleMemoryWarning()
        #expect(main.presentations.page === first, "never while a sheet shows it")

        main.presentations.dismiss()
        main.presentations.handleMemoryWarning()
        #expect(main.presentations.page == nil)
        #expect(first.isClosed)
        #expect(try await first.webPage.callJavaScript("return typeof window.webkit?.messageHandlers?.tilecastNative") as? String == "undefined",
                "its bridge is released")

        _ = open(main, "p-2")
        let second = try #require(main.presentations.page)
        #expect(second !== first)
        #expect(main.presentations.pagesBuilt == 2)
        try await settle { main.presentations.contentState == .ready }
    }

    @Test func aTerminatedHiddenPageIsDiscarded() throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        page.handle(navigationError: WebPage.NavigationError.webContentProcessTerminated)
        #expect(main.presentations.page == nil)
        #expect(main.phase == .loading, "the main page is untouched")
    }

    @Test func aTerminatedVisiblePageShowsAnErrorAndRetryRebuildsIt() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        _ = open(main, "p-1")
        try await settle { main.presentations.contentState == .ready }
        page.handle(navigationError: WebPage.NavigationError.webContentProcessTerminated)
        #expect(main.presentations.contentState == .failed(.contentProcessEnded))
        #expect(main.presentations.presentation?.id == "p-1", "the sheet stays with Retry and Close")

        main.presentations.retry()
        #expect(main.presentations.page !== page)
        try await settle { main.presentations.contentState == .ready }
        #expect(main.presentations.presentation?.id == "p-1")
    }

    @Test func aRefusedRouteFails() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        _ = open(main, "p-1", path: "/__native/modal/refuse")
        try await settle { main.presentations.contentState == .failed(.refused) }
        main.presentations.dismiss()
        #expect(main.presentations.page != nil, "a refused route does not cost the booted page")
    }

    @Test func aPageThatNeverReportsReadyFails() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main, query: "?silent", readyTimeout: .milliseconds(300))
        negotiate(main)
        _ = open(main, "p-1")
        try await settle { main.presentations.contentState == .failed(.unavailable) }
        main.presentations.dismiss()
        #expect(main.presentations.page == nil, "a failed page is rebuilt next time")
    }

    @Test func thePresentationPageReceivesOnlyPresentationData() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        _ = open(main, "p-1")
        try await settle { main.presentations.contentState == .ready }
        main.presentations.perform(actionID: "refresh")
        try await settle { (try? await self.receivedTypes(in: page.webPage))?.contains("presentation/action") == true }
        main.presentations.dismiss()
        try await settle { (try? await self.receivedTypes(in: page.webPage))?.last == "presentation/dismissed" }

        let payloadKeys = Set(try await received(in: page.webPage).flatMap { ($0["payload"] as? [String: Any])?.keys ?? [:].keys })
        #expect(payloadKeys == ["presentationId", "path", "actionId"])
        let everything = try #require(try await page.webPage.callJavaScript("return JSON.stringify(window.received)") as? String)
        for secret in ["tca_", "tcr_", "Bearer", "csrf", "cookie", "password", "token"] {
            #expect(!everything.localizedCaseInsensitiveContains(secret), "\(secret)")
        }
        #expect(await page.bridge.requestSignOut() == false, "no auth lifecycle in a presentation page")
    }

    @Test func signInRequiredDiscardsThePage() throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        main.requireSignInIfNeeded(at: URL(string: "https://signage.example.org/login"))
        #expect(main.presentations.page == nil)
        #expect(page.isClosed)
    }

    @Test func signingOutInStudioWithdrawsTheCatalogAndThePage() throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        _ = main.bridge.replyValue(to: envelope("navigation/catalog", ["groups": []]), from: .studio)
        #expect(main.presentations.page == nil)
        #expect(page.isClosed)
    }

    @Test func aNewMainDocumentWithoutNegotiationDiscardsThePage() throws {
        let main = try makeMainPage()
        defer { main.close() }
        useFixture(in: main)
        negotiate(main)
        let page = try #require(main.presentations.page)
        main.bridge.mainFrameNavigationStarted()
        main.bridge.mainFrameCommitted()
        #expect(main.presentations.page == nil)
        #expect(page.isClosed)
    }
}

/// The host closes a server's presentation page with its main page.
@MainActor
@Suite(.serialized) struct PresentationHostLifecycleTests {
    let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
    let stores = FakeDataStores()
    let client = FakeIdentityClient()

    func makeHost() -> StudioHost {
        StudioHost(directory: directory, dataStores: stores, identityClient: client, credentials: InMemoryCredentialStore(), applicationName: "TilecastTests")
    }

    func addServer(_ host: String, name: String) throws -> ServerProfile {
        let identity = identity(name)
        let profile = try directory.add(address: address(host), identity: identity)
        client.answers[profile.address.description] = .success(identity)
        return profile
    }

    /// Negotiates as signed-in Studio and returns the prewarmed page.
    func prewarm(_ page: StudioPage) throws -> PresentationPage {
        let sender = BridgeSender(isMainFrame: true, isPageWorld: true, origin: page.address.origin)
        _ = page.bridge.replyValue(to: envelope("config/get"), from: sender)
        _ = page.bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativePresentations": true]]), from: sender)
        _ = page.bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: sender)
        return try #require(page.presentations.page)
    }

    @Test func switchingServersDestroysThePresentationPage() async throws {
        let a = try addServer("a.example.org", name: "A")
        let b = try addServer("b.example.org", name: "B")
        let host = makeHost()
        await host.activate(a.id)
        let presentation = try prewarm(try #require(host.page))
        await host.activate(b.id)
        #expect(presentation.isClosed)
        let next = try #require(host.page)
        #expect(next.presentations.page == nil, "server B starts without A's presentation page")
        next.close()
    }

    @Test func removingTheServerDestroysThePresentationPage() async throws {
        let a = try addServer("a.example.org", name: "A")
        let host = makeHost()
        await host.activate(a.id)
        let presentation = try prewarm(try #require(host.page))
        await host.remove(a.id)
        #expect(presentation.isClosed)
    }

    @Test func acceptingANewInstallationDestroysThePresentationPage() async throws {
        let a = try addServer("a.example.org", name: "A")
        let host = makeHost()
        await host.activate(a.id)
        let presentation = try prewarm(try #require(host.page))
        let replacement = identity("Reinstalled")
        client.answers[a.address.description] = .success(replacement)
        try await host.trustNewInstallation(a.id, identity: replacement)
        #expect(presentation.isClosed)
        #expect(host.page?.presentations.page == nil)
        host.page?.close()
    }

    @Test func signingOutDestroysThePresentationPage() async throws {
        let a = try addServer("a.example.org", name: "A")
        let host = makeHost()
        await host.activate(a.id)
        let page = try #require(host.page)
        let presentation = try prewarm(page)
        await host.signOut()
        #expect(presentation.isClosed)
        #expect(page.presentations.page == nil)
        page.close()
    }

    @Test func studiosOwnSignOutDestroysThePresentationPage() async throws {
        let a = try addServer("a.example.org", name: "A")
        let host = makeHost()
        await host.activate(a.id)
        let page = try #require(host.page)
        let presentation = try prewarm(page)
        _ = page.bridge.replyValue(to: envelope("auth/signed-out"), from: BridgeSender(isMainFrame: true, isPageWorld: true, origin: page.address.origin))
        #expect(presentation.isClosed)
        page.close()
    }
}
