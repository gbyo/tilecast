import XCTest

/// QR scanning against `FixtureStudioServer`: the pair sheet, the fixture
/// scanner, and the result's way back into the sheet. The camera is
/// replaced (`-TilecastFixtureQRScanner`), so no test needs one; the
/// bridge, the presentation, and the fixture's scan flow are the real
/// ones. What the scanned text means stays React's job, covered by the
/// dashboard tests and manual validation.
final class NativeQRScannerUITests: XCTestCase {
    private var server: FixtureStudioServer!
    private var app: XCUIApplication!

    override func setUpWithError() throws {
        continueAfterFailure = false
        server = try FixtureStudioServer()
    }

    override func tearDown() {
        server?.stop()
        super.tearDown()
    }

    @MainActor private var isPad: Bool { UIDevice.current.userInterfaceIdiom == .pad }

    /// An approval URL for the fixture installation, as a Player would
    /// encode it. The installation id is the fixture server's own.
    private var payload: String {
        "\(server.address)/screens/pair/K7Q2XD?installation=8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10"
    }

    /// Launches with no servers, then adds the fixture through the app's own
    /// add-server flow.
    @MainActor private func launchWithFixtureServer(extraArguments: [String] = []) {
        if isPad { XCUIDevice.shared.orientation = .landscapeLeft }
        app = XCUIApplication()
        app.launchArguments = ["-TilecastEphemeralServers", "-AppleLanguages", "(en)"] + extraArguments
        app.launch()
        let addServer = app.buttons["welcome.addServer"]
        XCTAssertTrue(addServer.waitForExistence(timeout: 10))
        addServer.tap()
        let address = app.textFields["addServer.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.typeText("\(server.address)\n")
        let add = app.buttons["addServer.add"]
        XCTAssertTrue(add.waitForExistence(timeout: 10))
        add.tap()
        XCTAssertTrue(webText("Overview page").waitForExistence(timeout: 20))
    }

    @MainActor private func launchWithFixtureScanner() {
        launchWithFixtureServer(extraArguments: ["-TilecastFixtureQRScanner", "-TilecastFixtureQRPayload", payload])
    }

    @MainActor private func webText(_ label: String) -> XCUIElement {
        app.webViews.staticTexts[label]
    }

    @MainActor private func webButton(_ label: String) -> XCUIElement {
        app.webViews.buttons[label]
    }

    @MainActor private var documentLabel: String {
        app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Document '")).firstMatch.label
    }

    @MainActor private var presentationDocumentLabel: String {
        app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Presentation document '")).firstMatch.label
    }

    /// Opens the pair sheet and waits until it shows.
    @MainActor private func openPairSheet() {
        webButton("Pair screen").tap()
        XCTAssertTrue(webText("Pair opened natively").waitForExistence(timeout: 10))
        XCTAssertTrue(app.navigationBars.staticTexts["Pair Screen"].waitForExistence(timeout: 20))
        XCTAssertTrue(webButton("Scan QR code").waitForExistence(timeout: 10))
    }

    @MainActor
    func testScanFromAPairSheetReturnsToTheSameSheet() {
        launchWithFixtureScanner()
        let document = documentLabel
        openPairSheet()
        let presentationDocument = presentationDocumentLabel

        webButton("Scan QR code").tap()
        let simulate = app.buttons["fixture.qr.simulate"]
        XCTAssertTrue(simulate.waitForExistence(timeout: 10), "the scanner appears above the pair sheet")
        XCTAssertEqual(app.staticTexts["fixture.qr.payload"].label, payload)
        simulate.tap()

        XCTAssertTrue(webText("Scanned \(payload)").waitForExistence(timeout: 10), "the result reaches the sheet")
        XCTAssertEqual(presentationDocumentLabel, presentationDocument, "the presentation document was not recreated")
        XCTAssertEqual(documentLabel, document, "the main document was not reloaded")
        XCTAssertTrue(app.navigationBars.staticTexts["Pair Screen"].exists, "the same pair sheet is still there")

        webButton("Close from page").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Pair Screen"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(webText("Overview page").exists, "Studio stays where it was")
        if isPad {
            XCTAssertTrue(app.collectionViews["native.sidebar"].staticTexts["Layouts"].exists, "the sidebar is intact")
        }
    }

    @MainActor
    func testScanCancellationKeepsTheSheet() {
        launchWithFixtureScanner()
        openPairSheet()
        let presentationDocument = presentationDocumentLabel

        webButton("Scan QR code").tap()
        let cancel = app.buttons["fixture.qr.cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        cancel.tap()

        XCTAssertTrue(webText("Scan cancelled").waitForExistence(timeout: 10))
        XCTAssertEqual(presentationDocumentLabel, presentationDocument)
        XCTAssertTrue(app.navigationBars.staticTexts["Pair Screen"].exists, "cancelling changes no pairing state")
    }

    @MainActor
    func testUnsupportedScannerKeepsManualEntry() {
        // No fixture scanner: the simulator has no camera, so the host
        // offers no Scan action anywhere.
        launchWithFixtureServer()
        XCTAssertFalse(webButton("Scan QR").waitForExistence(timeout: 2))

        webButton("Pair screen").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Pair Screen"].waitForExistence(timeout: 20))
        XCTAssertTrue(webText("Enter the code shown on the Player").waitForExistence(timeout: 10))
        XCTAssertFalse(webButton("Scan QR code").exists, "no Scan action without a scanner")
    }

    @MainActor
    func testUnavailableScannerFallsBackToManualEntry() {
        launchWithFixtureServer(extraArguments: ["-TilecastFixtureQRUnavailable"])
        openPairSheet()
        let presentationDocument = presentationDocumentLabel

        webButton("Scan QR code").tap()
        XCTAssertTrue(webText("Scan unavailable").waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["fixture.qr.simulate"].waitForExistence(timeout: 2), "no scanner appears")
        XCTAssertTrue(webText("Enter the code shown on the Player").exists, "manual entry stays available")
        XCTAssertEqual(presentationDocumentLabel, presentationDocument)
    }

    @MainActor
    func testMainPageCanScanToo() {
        launchWithFixtureScanner()
        let document = documentLabel

        webButton("Scan QR").tap()
        let simulate = app.buttons["fixture.qr.simulate"]
        XCTAssertTrue(simulate.waitForExistence(timeout: 10))
        simulate.tap()

        XCTAssertTrue(webText("Scanned \(payload)").waitForExistence(timeout: 10))
        XCTAssertEqual(documentLabel, document)
    }

    @MainActor
    func testIPadPairSheetKeepsTheSidebar() throws {
        try XCTSkipUnless(isPad, "iPhone uses tabs")
        launchWithFixtureScanner()
        openPairSheet()
        let sidebar = app.collectionViews["native.sidebar"]
        XCTAssertTrue(sidebar.staticTexts["Layouts"].waitForExistence(timeout: 10), "the sidebar stays behind the sheet")
        webButton("Close from page").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Pair Screen"].waitForNonExistence(timeout: 10))
        XCTAssertTrue(sidebar.staticTexts["Layouts"].exists, "the sidebar is intact afterwards")
    }
}
