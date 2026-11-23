import XCTest

/// Adaptive native navigation against `FixtureStudioServer`, a loopback stand-in for
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

    /// The iOS 26 tab bar floats over its content. Studio's web view must
    /// extend beneath it, so the glass samples the page, instead of ending
    /// above the bar and leaving an empty strip.
    @MainActor
    func testStudioReachesBeneathTheFloatingTabBar() throws {
        launchWithFixtureServer()
        assertStudioReachesBeneathTheTabBar()
    }

    /// The same composition with the phone on its side, where the safe
    /// areas differ.
    @MainActor
    func testStudioReachesBeneathTheTabBarInLandscape() throws {
        XCUIDevice.shared.orientation = .landscapeLeft
        addTeardownBlock { XCUIDevice.shared.orientation = .portrait }
        launchWithFixtureServer()
        assertStudioReachesBeneathTheTabBar()
    }

    @MainActor private func assertStudioReachesBeneathTheTabBar() {
        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 20))
        // A short page: the fixed marker sits at the bottom of the web view.
        XCTAssertTrue(studioText("Overview page").waitForExistence(timeout: 10))
        let webView = app.webViews.firstMatch
        let marker = app.webViews.staticTexts["Viewport bottom"]
        XCTAssertTrue(marker.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(webView.frame.maxY, tabBar.frame.minY, "the web view continues beneath the tab bar")
        XCTAssertEqual(webView.frame.maxY, app.frame.maxY, accuracy: 1, "the web view reaches the screen bottom")
        XCTAssertLessThanOrEqual(marker.frame.maxY, tabBar.frame.minY + 1, "fixed bottom content stays above the bar")

        // A long page: the last control scrolls into reach above the bar.
        tabBar.buttons["Fleet"].tap()
        XCTAssertTrue(studioText("Fleet page").waitForExistence(timeout: 5))
        let bottom = app.webViews.buttons["Bottom action"]
        for _ in 0..<15 where !(bottom.exists && bottom.isHittable && bottom.frame.maxY <= tabBar.frame.minY) {
            app.webViews.firstMatch.swipeUp()
        }
        XCTAssertTrue(bottom.isHittable)
        XCTAssertLessThanOrEqual(bottom.frame.maxY, tabBar.frame.minY, "the last control is not left under the tab bar")
        bottom.tap()
        XCTAssertTrue(studioText("Bottom action pressed").waitForExistence(timeout: 5))
    }

    @MainActor
    func testIPadStartsWithContentFirstTabNavigation() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad-specific launch behavior")
        XCUIDevice.shared.orientation = .portrait
        addTeardownBlock { XCUIDevice.shared.orientation = .portrait }
        launchWithFixtureServer()

        let tabBar = app.tabBars.firstMatch
        XCTAssertTrue(tabBar.waitForExistence(timeout: 20), "iPadOS starts with the content-first tab representation")
        XCTAssertFalse(app.collectionViews["native.sidebar"].exists, "Tilecast must not force a permanent sidebar on iPad")
        XCTAssertTrue(studioText("Overview page").waitForExistence(timeout: 10))

        tabBar.buttons["More"].tap()
        XCTAssertTrue(app.buttons["Layouts"].waitForExistence(timeout: 5), "secondary destinations stay reachable without consuming content width")
        XCTAssertTrue(app.buttons["Manage Servers…"].exists)
    }

}
