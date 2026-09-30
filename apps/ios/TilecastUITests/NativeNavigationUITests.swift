import XCTest

/// Native navigation against `FixtureStudioServer`, a loopback stand-in for
/// a Tilecast server. The fixture's destinations are made up, so these
/// tests also show that the shell renders whatever catalog Studio sends.
final class NativeNavigationUITests: XCTestCase {
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

    /// Launches with no servers, then adds the fixture through the app's
    /// own add-server flow.
    @MainActor private func launchWithFixtureServer() {
        app = XCUIApplication()
        app.launchArguments = ["-TilecastEphemeralServers", "-AppleLanguages", "(en)"]
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
    }

    /// Text inside the Studio page.
    @MainActor private func studioText(_ label: String) -> XCUIElement {
        app.webViews.staticTexts[label]
    }

    @MainActor private var documentLabel: String {
        app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH 'Document '")).firstMatch.label
    }

    @MainActor
    func testTabsDriveTheOneStudioPage() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom == .pad, "iPad uses the sidebar")
        launchWithFixtureServer()
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 20), "native tabs replace the fallback chrome")
        for title in ["Overview", "Fleet", "Media", "More"] {
            XCTAssertTrue(tabBar.buttons[title].exists, title)
        }
        XCTAssertFalse(tabBar.buttons["Layouts"].exists, "non-primary destinations live in More")
        XCTAssertTrue(studioText("Overview page").waitForExistence(timeout: 10))
        XCTAssertFalse(app.webViews.links["Browser sidebar"].exists, "Studio hides its sidebar")
        XCTAssertFalse(app.buttons["studio.more"].exists, "no second bar above Studio")
        let document = documentLabel

        tabBar.buttons["Fleet"].tap()
        XCTAssertTrue(studioText("Fleet page").waitForExistence(timeout: 5))
        XCTAssertTrue(tabBar.buttons["Fleet"].isSelected)
        tabBar.buttons["Media"].tap()
        XCTAssertTrue(studioText("Media page").waitForExistence(timeout: 5))
        XCTAssertEqual(documentLabel, document, "native navigation must not reload Studio")

        tabBar.buttons["More"].tap()
        let roomBookings = app.buttons["Room Bookings"]
        XCTAssertTrue(roomBookings.waitForExistence(timeout: 5), "a destination the app has no code for")
        XCTAssertTrue(app.buttons["Manage Servers…"].exists)
        app.buttons["Layouts"].tap()
        XCTAssertTrue(studioText("Layouts page").waitForExistence(timeout: 5))
        XCTAssertTrue(tabBar.buttons["More"].isSelected, "More stays selected for a More destination")

        tabBar.buttons["More"].tap()
        XCTAssertTrue(roomBookings.waitForExistence(timeout: 5), "a second tap returns to the list")

        tabBar.buttons["Fleet"].tap()
        XCTAssertTrue(studioText("Fleet page").waitForExistence(timeout: 5))
        XCTAssertEqual(documentLabel, document, "the same page survives every destination change")
    }

    @MainActor
    func testRegularWidthIPadShowsTheSidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPhone uses tabs")
        XCUIDevice.shared.orientation = .landscapeLeft
        launchWithFixtureServer()
        let sidebar = app.collectionViews["native.sidebar"]
        let layouts = sidebar.staticTexts["Layouts"]
        XCTAssertTrue(layouts.waitForExistence(timeout: 20), "the sidebar lists Studio's catalog")
        XCTAssertTrue(sidebar.staticTexts["Room Bookings"].exists)
        XCTAssertFalse(app.tabBars.firstMatch.exists)
        XCTAssertTrue(studioText("Overview page").waitForExistence(timeout: 10))
        let document = documentLabel

        layouts.tap()
        XCTAssertTrue(studioText("Layouts page").waitForExistence(timeout: 5))
        sidebar.staticTexts["Room Bookings"].tap()
        XCTAssertTrue(studioText("Room Bookings page").waitForExistence(timeout: 5))
        XCTAssertEqual(documentLabel, document)
        XCTAssertTrue(app.buttons["native.serverMenu"].exists)
    }
}
