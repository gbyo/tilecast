import XCTest

/// Native action menus against `FixtureStudioServer`: anchored three-dot
/// menus and the armed menu a long press shows. The fixture speaks Studio's
/// side of the bridge, so the tests prove the app renders generic menus it
/// has never heard of and reports the chosen opaque ids.
final class NativeActionMenuUITests: XCTestCase {
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

    @MainActor private func dismissMenu() {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.05)).tap()
    }

    // MARK: Three-dot menus

    @MainActor
    func testChoosingAnActionReportsItsId() {
        launchWithFixtureServer()
        let document = documentLabel
        webButton("Show menu").tap()
        let rename = app.buttons["actionMenu.action.rename"]
        XCTAssertTrue(rename.waitForExistence(timeout: 10), "the native menu shows the fixture's action")
        rename.tap()
        XCTAssertTrue(webText("Chose rename").waitForExistence(timeout: 5), "Studio hears the opaque action id")
        XCTAssertEqual(documentLabel, document, "choosing does not reload Studio")
    }

    @MainActor
    func testADisabledActionStaysDisabled() {
        launchWithFixtureServer()
        webButton("Show menu").tap()
        let duplicate = app.buttons["actionMenu.action.duplicate"]
        XCTAssertTrue(duplicate.waitForExistence(timeout: 10))
        XCTAssertFalse(duplicate.isEnabled, "a disabled action cannot be chosen")
        dismissMenu()
        XCTAssertFalse(webText("Chose duplicate").exists)
    }

    @MainActor
    func testChoosingADestructiveActionReportsItsId() {
        launchWithFixtureServer()
        webButton("Show menu").tap()
        let delete = app.buttons["actionMenu.action.delete"]
        XCTAssertTrue(delete.waitForExistence(timeout: 10))
        delete.tap()
        XCTAssertTrue(webText("Chose delete").waitForExistence(timeout: 5))
    }

    @MainActor
    func testAPresentationSheetCanShowAMenuToo() {
        launchWithFixtureServer()
        webButton("Open fixture sheet").tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Fixture Sheet"].waitForExistence(timeout: 20))
        let showMenu = webButton("Show menu from sheet")
        XCTAssertTrue(showMenu.waitForExistence(timeout: 10))
        showMenu.tap()
        let ping = app.buttons["actionMenu.action.sheet-ping"]
        XCTAssertTrue(ping.waitForExistence(timeout: 10), "the menu shows above the native sheet")
        ping.tap()
        XCTAssertTrue(webText("Sheet chose sheet-ping").waitForExistence(timeout: 5))
        XCTAssertTrue(app.navigationBars.staticTexts["Fixture Sheet"].exists, "the native sheet stays")
    }

    // MARK: Armed menus

    @MainActor
    func testALongPressShowsTheArmedMenu() {
        launchWithFixtureServer()
        let document = documentLabel
        let row = webText("Press me")
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        // The press arms the menu on its way down; the hold lets the menu
        // build before the release disarms it.
        row.press(forDuration: 1.5)
        let open = app.menuItems["Arm open"]
        XCTAssertTrue(open.waitForExistence(timeout: 10), "the long press shows the armed menu")
        open.tap()
        XCTAssertTrue(webText("Chose arm-open").waitForExistence(timeout: 5))
        XCTAssertEqual(documentLabel, document, "choosing does not reload Studio")
    }
}
