import XCTest

/// System integrations against `FixtureStudioServer`: haptics, the share
/// sheet, deep links, and native media intake. The pickers are replaced by
/// generated files (`-TilecastFixtureMediaPicker`), so no test touches the
/// Photos library or iCloud; the upload, the progress sheet, and Studio's
/// result are the real ones.
final class NativeSystemUITests: XCTestCase {
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

    @MainActor private func webText(_ label: String) -> XCUIElement {
        app.webViews.staticTexts[label]
    }

    @MainActor private func webButton(_ label: String) -> XCUIElement {
        app.webViews.buttons[label]
    }

    @MainActor private var documentLabel: String {
        app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Document '")).firstMatch.label
    }

    /// The system share sheet, whichever way this OS identifies it.
    @MainActor private var shareSheet: XCUIElement {
        app.otherElements["ActivityListView"]
    }

    @MainActor private func closeShareSheet() {
        // The sheet has a close button on iPhone; an iPad popover closes when
        // the person taps outside it.
        let close = app.buttons["Close"]
        if close.exists { close.tap() } else { app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.05)).tap() }
        XCTAssertTrue(shareSheet.waitForNonExistence(timeout: 10))
    }

    // MARK: Haptics and share

    @MainActor
    func testStudioCanRequestSemanticFeedback() {
        launchWithFixtureServer()
        webButton("Haptic").tap()
        XCTAssertTrue(webText("Haptic ok").waitForExistence(timeout: 5), "the host accepted the request")
    }

    @MainActor
    func testStudioCanOpenTheSystemShareSheet() {
        launchWithFixtureServer()
        let document = documentLabel
        webButton("Share").tap()
        XCTAssertTrue(webText("Share ok").waitForExistence(timeout: 5))
        XCTAssertTrue(shareSheet.waitForExistence(timeout: 10), "the system share sheet is up")
        closeShareSheet()
        XCTAssertEqual(documentLabel, document, "sharing does not reload Studio")
    }

    @MainActor
    func testAnUnsafeShareNeverReachesTheSystem() {
        launchWithFixtureServer()
        webButton("Share unsafe").tap()
        XCTAssertTrue(webText("Share malformed").waitForExistence(timeout: 5))
        XCTAssertFalse(shareSheet.waitForExistence(timeout: 2))
    }

    @MainActor
    func testAPresentationSheetCanShareToo() throws {
        launchWithFixtureServer()
        webButton("Open fixture sheet").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Fixture Sheet"].waitForExistence(timeout: 20))
        let share = webButton("Share from sheet")
        XCTAssertTrue(share.waitForExistence(timeout: 10))
        share.tap()
        XCTAssertTrue(shareSheet.waitForExistence(timeout: 10), "the share sheet appears above the native sheet")
        closeShareSheet()
        XCTAssertTrue(app.navigationBars.staticTexts["Fixture Sheet"].exists, "the native sheet stays")
    }

    // MARK: Deep links

    @MainActor
    func testADeepLinkOpensAPathInAConfiguredInstallation() throws {
        launchWithFixtureServer()
        let document = documentLabel
        let link = "tilecast-ios://open?installation=8c7d4a52-6a1e-4c1a-9f2b-2f6f0e6d7a10&path=%2Flayouts"
        XCUIDevice.shared.system.open(URL(string: link)!)
        if !app.wait(for: .runningForeground, timeout: 10) { app.activate() }
        XCTAssertTrue(webText("Layouts page").waitForExistence(timeout: 20), "React Router navigated")
        XCTAssertEqual(documentLabel, document, "the page was never reloaded for a link")
    }

    @MainActor
    func testALinkForAnUnknownInstallationShowsANoticeAndChangesNothing() throws {
        launchWithFixtureServer()
        let link = "tilecast-ios://open?installation=11111111-2222-4333-8444-555555555555&path=%2Flayouts"
        XCUIDevice.shared.system.open(URL(string: link)!)
        if !app.wait(for: .runningForeground, timeout: 10) { app.activate() }
        XCTAssertTrue(app.alerts["Can’t Open Link"].waitForExistence(timeout: 10))
        app.alerts.buttons["OK"].tap()
        XCTAssertTrue(webText("Overview page").exists, "Studio stays where it was")
    }

    // MARK: Native media intake

    /// Studio's own control, which asks for native intake when it can.
    @MainActor private func startIntake() {
        webButton("Upload media").tap()
    }

    @MainActor
    func testNativeIntakeUploadsWithTheNativeCredentialAndTellsStudio() throws {
        launchWithFixtureServer(extraArguments: ["-TilecastFixtureMediaPicker", "-TilecastFixtureNativeCredential"])
        let document = documentLabel
        startIntake()

        let source = app.buttons["Photo Library"]
        XCTAssertTrue(source.waitForExistence(timeout: 10), "the native source choice appears")
        source.tap()

        let sheet = app.otherElements["media.intake.sheet"]
        XCTAssertTrue(sheet.waitForExistence(timeout: 10), "the native progress sheet appears")
        let done = app.buttons["media.intake.done"]
        XCTAssertTrue(done.waitForExistence(timeout: 10))
        // Both files reach the server, and Studio hears only how it ended.
        XCTAssertTrue(webText("Intake completed 2").waitForExistence(timeout: 30))
        XCTAssertTrue(app.staticTexts["fixture-one.png"].exists)
        XCTAssertTrue(app.staticTexts["fixture-two.png"].exists)
        XCTAssertTrue(done.isEnabled)
        done.tap()
        XCTAssertTrue(sheet.waitForNonExistence(timeout: 10))

        XCTAssertEqual(documentLabel, document, "the same Studio page is under the sheet")
        XCTAssertEqual(server.api.uploads.map(\.filename), ["fixture-one.png", "fixture-two.png"])
        XCTAssertEqual(server.api.uploads.map(\.completed), [true, true])
        XCTAssertEqual(server.api.uploads.map(\.data.count), [70, 71])
        XCTAssertEqual(server.api.uploads.map(\.mimeType), ["image/png", "image/png"])

        let uploadRequests = server.api.seen.filter { $0.path.hasPrefix("/api/v1/uploads") }
        XCTAssertFalse(uploadRequests.isEmpty)
        for request in uploadRequests {
            XCTAssertTrue(request.headers["authorization"]?.hasPrefix("Bearer tca_fixture") == true, "\(request.method) uses the bearer token")
            XCTAssertNil(request.headers["cookie"], "no cookie on \(request.method)")
            XCTAssertNil(request.headers["x-csrf-token"], "no CSRF token on \(request.method)")
        }
    }

    @MainActor
    func testCancellingTheSourceChoiceLeavesStudioUnchanged() throws {
        launchWithFixtureServer(extraArguments: ["-TilecastFixtureMediaPicker", "-TilecastFixtureNativeCredential"])
        let document = documentLabel
        startIntake()
        let cancel = app.buttons["Cancel"]
        XCTAssertTrue(cancel.waitForExistence(timeout: 10))
        cancel.tap()
        XCTAssertTrue(webText("Intake cancelled 0").waitForExistence(timeout: 10))
        XCTAssertEqual(documentLabel, document)
        XCTAssertTrue(server.api.uploads.isEmpty)
    }

    @MainActor
    func testIntakeFallsBackToStudiosUploaderWithoutANativeCredential() throws {
        // No -TilecastFixtureNativeCredential: an older server, or a signed-out app.
        launchWithFixtureServer(extraArguments: ["-TilecastFixtureMediaPicker"])
        startIntake()
        XCTAssertTrue(webText("Web uploader").waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Photo Library"].exists, "no native picker without the credential")
        XCTAssertTrue(server.api.uploads.isEmpty)
    }

    @MainActor
    func testIntakeKeepsTheRegularWidthSidebarOnIPad() throws {
        try XCTSkipUnless(isPad, "The sidebar is the regular-width iPad layout")
        launchWithFixtureServer(extraArguments: ["-TilecastFixtureMediaPicker", "-TilecastFixtureNativeCredential"])
        XCTAssertTrue(app.otherElements["native.sidebar"].exists || app.collectionViews["native.sidebar"].exists || app.tables["native.sidebar"].exists)
        startIntake()
        let source = app.buttons["Photo Library"]
        XCTAssertTrue(source.waitForExistence(timeout: 10))
        source.tap()
        XCTAssertTrue(webText("Intake completed 2").waitForExistence(timeout: 30))
        app.buttons["media.intake.done"].tap()
        XCTAssertTrue(app.otherElements["native.sidebar"].exists || app.collectionViews["native.sidebar"].exists || app.tables["native.sidebar"].exists)
        XCTAssertEqual(server.api.uploads.count, 2)
    }
}
