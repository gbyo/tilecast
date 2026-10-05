import Foundation
import Testing
import WebKit
@testable import TilecastCore

/// A driver the test completes by hand, so withdrawal can run first.
actor ScanGate {
    private var continuation: CheckedContinuation<QRScanOutcome, Never>?

    func wait() async -> QRScanOutcome {
        await withCheckedContinuation { continuation = $0 }
    }

    func complete(_ outcome: QRScanOutcome) {
        continuation?.resume(returning: outcome)
        continuation = nil
    }
}

/// Scans through bridges, with no page: which messages the app accepts,
/// and which page a scan belongs to.
@MainActor
@Suite struct QRScanBridgeTests {
    let center = QRScanCenter()
    let system = SystemIntegrationHandlers()
    let main = StudioBridge(origin: serverOrigin)
    let presentation = StudioBridge(origin: serverOrigin, context: .presentation)

    init() {
        center.system = system
        main.scanners = center
        presentation.scanners = center
        system.isQRScannerAvailable = { true }
        system.scanQR = { _ in .scanned("https://signage.example.org/") }
    }

    private func negotiate(_ bridge: StudioBridge) {
        _ = bridge.replyValue(to: envelope("frontend/ready", [:]), from: .studio)
    }

    private func scan(_ bridge: StudioBridge, _ id: String = "qr-1") -> JSONValue {
        bridge.replyValue(to: envelope("system/scan-qr", ["requestId": id]), from: .studio)
    }

    private func scannerCapability(in reply: JSONValue) -> Bool? {
        guard case .object(let top) = reply,
              case .object(let payload)? = top["payload"],
              case .object(let capabilities)? = payload["capabilities"],
              case .bool(let available)? = capabilities["systemQrScanner"] else { return nil }
        return available
    }

    private let accepted = NativeBridgeProtocol.reply(id: nil, payload: [:])
    private let refused = NativeBridgeProtocol.reply(id: nil, error: .unavailable)

    @Test func theAppOffersTheScannerToBothPagesWhenHardwareCanScan() {
        for bridge in [main, presentation] {
            bridge.isQRScannerAvailable = { true }
            #expect(scannerCapability(in: bridge.replyValue(to: envelope("config/get"), from: .studio)) == true)
            bridge.isQRScannerAvailable = { false }
            #expect(scannerCapability(in: bridge.replyValue(to: envelope("config/get"), from: .studio)) == false)
            bridge.isQRScannerAvailable = nil
            #expect(scannerCapability(in: bridge.replyValue(to: envelope("config/get"), from: .studio)) == false)
        }
    }

    @Test func refusesAScanUntilStudioIsReady() {
        #expect(scan(main) == refused, "no frontend/ready yet")
        #expect(center.current == nil)
        negotiate(main)
        #expect(scan(main) == accepted)
        #expect(center.current?.request.requestID == "qr-1")
    }

    @Test func refusesAScanWithoutAScanner() {
        negotiate(main)
        system.scanQR = nil
        #expect(scan(main) == refused)
        #expect(center.current == nil)
    }

    @Test func refusesAScanWhenTheScannerIsUnavailable() {
        negotiate(main)
        system.isQRScannerAvailable = { false }
        #expect(scan(main) == refused)
        #expect(center.current == nil)
    }

    @Test func refusesAScanForABridgeWithNoCenter() {
        let bare = StudioBridge(origin: serverOrigin)
        _ = bare.replyValue(to: envelope("frontend/ready", [:]), from: .studio)
        #expect(bare.replyValue(to: envelope("system/scan-qr", ["requestId": "qr-1"]), from: .studio) == refused)
    }

    @Test func eitherPageMayScanButOnlyOneAtATime() {
        negotiate(main)
        negotiate(presentation)
        #expect(scan(main, "qr-1") == accepted)
        #expect(center.current?.context == .main)
        #expect(scan(presentation, "qr-2") == refused, "Studio keeps manual entry")
        #expect(scan(main, "qr-3") == refused)
        #expect(center.current?.request.requestID == "qr-1")

        center.withdraw(from: main)
        #expect(scan(presentation, "qr-2") == accepted)
        #expect(center.current?.context == .presentation)
    }

    @Test func acceptsARequestIdAtTheBound() {
        negotiate(main)
        let id = "qr-" + String(repeating: "a", count: 125)
        #expect(id.count == 128)
        #expect(scan(main, id) == accepted)
        #expect(center.current?.request.requestID == id)
    }

    /// A payload for each way a scan request can be malformed, by name:
    /// dictionaries of `Any` cannot be test arguments.
    static func malformed(_ kind: String) -> [String: Any] {
        switch kind {
        case "no id": [:]
        case "oversized id": ["requestId": "qr-" + String(repeating: "a", count: 126)]
        case "bad id": ["requestId": "QR 7"]
        case "extra property": ["requestId": "qr-1", "prompt": "Point the camera"]
        default: ["requestId": 7]
        }
    }

    @Test(arguments: ["no id", "oversized id", "bad id", "extra property", "numeric id"])
    func refusesAMalformedScanRequest(_ kind: String) {
        negotiate(main)
        #expect(main.replyValue(to: envelope("system/scan-qr", Self.malformed(kind)), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, error: .malformed))
        #expect(center.current == nil)
    }

    @Test func onlyTheScansOwnerWithdrawsIt() {
        negotiate(main)
        negotiate(presentation)
        _ = scan(main)
        center.withdraw(from: presentation)
        #expect(center.current != nil, "another page cannot withdraw it")
        center.withdraw(context: .presentation)
        #expect(center.current != nil, "another context cannot withdraw it")
        center.withdraw(from: main)
        #expect(center.current == nil)
    }

    @Test func aNewDocumentWithdrawsItsScan() {
        negotiate(main)
        _ = scan(main)
        main.mainFrameNavigationStarted()
        #expect(center.current == nil)
    }

    @Test func uninstallWithdrawsItsScan() {
        negotiate(main)
        _ = scan(main)
        main.uninstall()
        #expect(center.current == nil)
    }

    @Test func aCompletedScanClears() async throws {
        negotiate(main)
        #expect(scan(main) == accepted)
        #expect(center.current?.request.requestID == "qr-1")
        try await settle { center.current == nil }
    }

    @Test func aLateResultAfterWithdrawalResolvesNothing() async throws {
        let gate = ScanGate()
        system.scanQR = { _ in await gate.wait() }
        negotiate(main)
        #expect(scan(main, "qr-1") == accepted)
        center.withdraw(from: main)
        #expect(center.current == nil)
        #expect(scan(main, "qr-2") == accepted)
        await gate.complete(.scanned("late"))
        try await Task.sleep(for: .milliseconds(100))
        #expect(center.current?.request.requestID == "qr-2", "the stale finish changes nothing")
    }

    @Test func resultsNormalizeForTheBridge() {
        #expect(QRScanCenter.normalize(.scanned("https://signage.example.org/")) == .scanned("https://signage.example.org/"))
        #expect(QRScanCenter.normalize(.scanned(String(repeating: "a", count: 4096))) == .scanned(String(repeating: "a", count: 4096)))
        #expect(QRScanCenter.normalize(.scanned("")) == .cancelled)
        #expect(QRScanCenter.normalize(.scanned(String(repeating: "a", count: 4097))) == .unavailable)
        #expect(QRScanCenter.normalize(.cancelled) == .cancelled)
        #expect(QRScanCenter.normalize(.unavailable) == .unavailable)
    }
}

/// Scan results in real WebKit pages: what reaches the page that asked,
/// and what never reaches another one.
@MainActor
@Suite(.serialized) struct QRScanPageTests {
    static let studio = """
        <!doctype html><script>
        window.received = [];
        window.hasBridge = typeof window.webkit !== "undefined"
          && typeof window.webkit.messageHandlers !== "undefined"
          && typeof window.webkit.messageHandlers.tilecastNative !== "undefined";
        window.tilecastNativeReceiver = (message) => { window.received.push(message); return true; };
        </script>
        """

    func makeMainPage(system: SystemIntegrationHandlers = SystemIntegrationHandlers()) throws -> StudioPage {
        let directory = ServerDirectory(storage: InMemoryServerDirectoryStorage())
        let profile = try directory.add(address: address("signage.example.org"), identity: identity("A"))
        return StudioPage(profile: profile, dataStore: .nonPersistent(), applicationName: "TilecastTests", system: system)
    }

    func negotiate(_ bridge: StudioBridge, capabilities: [String: Bool] = [:]) {
        _ = bridge.replyValue(to: envelope("config/get"), from: .studio)
        _ = bridge.replyValue(to: envelope("frontend/ready", ["capabilities": capabilities]), from: .studio)
    }

    func received(in page: WebPage) async throws -> [[String: Any]] {
        let json = try await page.callJavaScript("return JSON.stringify(window.received ?? [])") as? String ?? "[]"
        return try JSONSerialization.jsonObject(with: Data(json.utf8)) as? [[String: Any]] ?? []
    }

    @Test func theScannedTextReachesThePageThatAsked() async throws {
        let system = SystemIntegrationHandlers()
        system.isQRScannerAvailable = { true }
        system.scanQR = { _ in .scanned("https://signage.example.org/screens/pair/K7Q2XD?installation=A") }
        let main = try makeMainPage(system: system)
        defer { main.close() }
        for try await _ in main.webPage.load(html: Self.studio, baseURL: URL(string: "https://signage.example.org/")!) {}
        negotiate(main.bridge)
        #expect(main.bridge.replyValue(to: envelope("system/scan-qr", ["requestId": "qr-1"]), from: .studio)
            == NativeBridgeProtocol.reply(id: nil, payload: [:]))

        try await settle { (try? await self.received(in: main.webPage))?.count == 1 }
        let messages = try await received(in: main.webPage)
        #expect(messages.count == 1)
        #expect(messages.first?["type"] as? String == "system/qr-scan-result")
        let payload = messages.first?["payload"] as? [String: Any]
        #expect(payload?["requestId"] as? String == "qr-1")
        #expect(payload?["outcome"] as? String == "scanned")
        #expect(payload?["value"] as? String == "https://signage.example.org/screens/pair/K7Q2XD?installation=A")
        #expect(main.scanners.current == nil)
    }

    @Test func aWithdrawnScanResolvesAsCancelledAndLateResultsAreDropped() async throws {
        let system = SystemIntegrationHandlers()
        let gate = ScanGate()
        system.isQRScannerAvailable = { true }
        system.scanQR = { _ in await gate.wait() }
        let main = try makeMainPage(system: system)
        defer { main.close() }
        for try await _ in main.webPage.load(html: Self.studio, baseURL: URL(string: "https://signage.example.org/")!) {}
        negotiate(main.bridge)
        _ = main.bridge.replyValue(to: envelope("system/scan-qr", ["requestId": "qr-1"]), from: .studio)
        #expect(main.scanners.current != nil)

        main.scanners.withdraw(from: main.bridge)
        try await settle { (try? await self.received(in: main.webPage))?.count == 1 }
        let payload = try await received(in: main.webPage).first?["payload"] as? [String: Any]
        #expect(payload?["requestId"] as? String == "qr-1")
        #expect(payload?["outcome"] as? String == "cancelled")
        #expect(payload?["value"] == nil)

        await gate.complete(.scanned("late"))
        try await Task.sleep(for: .milliseconds(200))
        #expect(try await received(in: main.webPage).count == 1, "the late result reaches no page")
        #expect(main.scanners.current == nil)
    }

    @Test func endingAPresentationCancelsItsScan() async throws {
        let system = SystemIntegrationHandlers()
        let gate = ScanGate()
        system.isQRScannerAvailable = { true }
        system.scanQR = { _ in await gate.wait() }
        let main = try makeMainPage(system: system)
        defer { main.close() }
        let policy = StudioNavigationPolicy(origin: main.address.origin)
        main.presentations.makePage = { [address = main.address, store = main.websiteDataStore] in
            let page = PresentationPage(address: address, dataStore: store, applicationName: "TilecastTests", policy: policy)
            page.loader = { webPage, url in
                _ = webPage.load(html: Self.studio, baseURL: url)
            }
            return page
        }
        negotiate(main.bridge, capabilities: ["nativePresentations": true])
        _ = main.bridge.replyValue(to: envelope("navigation/catalog", catalogPayload(["alpha"])), from: .studio)
        _ = main.bridge.replyValue(to: envelope("presentation/open", openPayload("p-1")), from: .studio)
        let page = try #require(main.presentations.page)
        _ = page.bridge.replyValue(to: envelope("config/get"), from: .studio)
        _ = page.bridge.replyValue(to: envelope("frontend/ready", ["capabilities": ["nativePresentations": true]]), from: .studio)
        // The fixture answers presentation/show, so it must be loaded first.
        try await settle { (try? await page.webPage.callJavaScript("return typeof window.tilecastNativeReceiver")) as? String == "function" }
        _ = page.bridge.replyValue(to: envelope("presentation/ready", [:]), from: .studio)
        try await settle { main.presentations.contentState == .ready }

        _ = page.bridge.replyValue(to: envelope("system/scan-qr", ["requestId": "qr-9"]), from: .studio)
        #expect(main.scanners.current?.context == .presentation)

        main.presentations.dismiss()
        try await settle { (try? await self.received(in: page.webPage))?.contains { $0["type"] as? String == "system/qr-scan-result" } == true }
        let result = try await received(in: page.webPage).first { $0["type"] as? String == "system/qr-scan-result" }
        let payload = result?["payload"] as? [String: Any]
        #expect(payload?["requestId"] as? String == "qr-9")
        #expect(payload?["outcome"] as? String == "cancelled")
        #expect(main.scanners.current == nil)

        await gate.complete(.scanned("late"))
        try await Task.sleep(for: .milliseconds(200))
        let results = try await received(in: page.webPage).filter { $0["type"] as? String == "system/qr-scan-result" }
        #expect(results.count == 1, "the late result reaches no newer presentation")
    }

    @Test func theAuxiliaryPageHasNoScanner() async throws {
        let main = try makeMainPage()
        defer { main.close() }
        for try await _ in main.webPage.load(html: Self.studio, baseURL: URL(string: "https://signage.example.org/")!) {}
        #expect(try await main.webPage.callJavaScript("return window.hasBridge") as? Bool == true)
        main.handle(.openAuxiliary(URL(string: "https://signage.example.org/docs")!))
        let auxiliary = try #require(main.auxiliaryPage)
        for try await _ in auxiliary.load(html: Self.studio, baseURL: URL(string: "https://signage.example.org/docs")!) {}
        #expect(try await auxiliary.callJavaScript("return window.hasBridge") as? Bool == false)
    }
}

/// A scan ends with its session and its server.
@MainActor
@Suite struct QRScanHostTests {
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

    func beginScan(host: StudioHost, gate: ScanGate) async throws -> StudioPage {
        host.system.isQRScannerAvailable = { true }
        host.system.scanQR = { _ in await gate.wait() }
        let page = try #require(host.page)
        // The bridge answers only its own server's origin, and these hosts
        // use their own addresses rather than the shared test origin.
        let sender = BridgeSender(isMainFrame: true, isPageWorld: true, origin: page.bridge.origin)
        _ = page.bridge.replyValue(to: envelope("frontend/ready", [:]), from: sender)
        _ = page.bridge.replyValue(to: envelope("system/scan-qr", ["requestId": "qr-1"]), from: sender)
        #expect(page.scanners.current != nil)
        return page
    }

    @Test func signingOutCancelsTheScan() async throws {
        let profile = try addServer("a.example.org", name: "A")
        directory.activate(profile.id)
        let host = makeHost()
        await host.start()
        let gate = ScanGate()
        let page = try await beginScan(host: host, gate: gate)

        host.studioSignedOut(page)
        #expect(page.scanners.current == nil)
        await gate.complete(.scanned("late"))
        try await Task.sleep(for: .milliseconds(100))
        #expect(page.scanners.current == nil)
        page.close()
    }

    @Test func switchingServersCancelsTheScan() async throws {
        let first = try addServer("a.example.org", name: "A")
        let second = try addServer("b.example.org", name: "B")
        directory.activate(first.id)
        let host = makeHost()
        await host.start()
        let gate = ScanGate()
        let page = try await beginScan(host: host, gate: gate)

        await host.activate(second.id)
        #expect(page.scanners.current == nil)
        let next = try #require(host.page)
        #expect(next.scanners.current == nil, "a scan never follows its server")
        await gate.complete(.scanned("late"))
        try await Task.sleep(for: .milliseconds(100))
        #expect(next.scanners.current == nil)
        next.close()
    }
}
