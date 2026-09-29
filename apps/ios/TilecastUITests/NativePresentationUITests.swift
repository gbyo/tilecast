import XCTest

/// Native presentations against `FixtureStudioServer`. The fixture's
/// presentation route, title, and toolbar are made up, so these tests also
/// show that the sheet renders whatever descriptor Studio sends.
final class NativePresentationUITests: XCTestCase {
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

    /// Launches with no servers, then adds the fixture through the app's
    /// own add-server flow.
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

    @MainActor private func webTextStarting(_ prefix: String) -> XCUIElement {
        app.webViews.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", prefix)).firstMatch
    }

    /// The native title of the sheet, in its navigation bar.
    @MainActor private var sheetTitle: XCUIElement {
        app.navigationBars.staticTexts["Fixture Sheet"]
    }

    @MainActor private func openSheet() {
        let open = app.webViews.buttons["Open fixture sheet"]
        XCTAssertTrue(open.waitForExistence(timeout: 10))
        open.tap()
        XCTAssertTrue(sheetTitle.waitForExistence(timeout: 20), "SwiftUI shows Studio's title")
        XCTAssertTrue(webText("Opened natively").exists, "Studio did not also open its own dialog")
    }

    @MainActor
    func testPresentationOpensNativelyAndIsReused() throws {
        launchWithFixtureServer()
        openSheet()
        XCTAssertTrue(webText("Showing fixture/sheet, time 1").waitForExistence(timeout: 20), "React content inside the sheet")
        let document = webTextStarting("Presentation document ").label

        // Toolbar items come from the header snapshot. The icon token is
        // unknown to the app, so it shows the generic icon.
        let ping = app.buttons["presentation.action.ping"]
        XCTAssertTrue(ping.waitForExistence(timeout: 10))
        XCTAssertEqual(ping.label, "Ping", "VoiceOver reads Studio's label")
        ping.tap()
        XCTAssertTrue(webText("Action ping").waitForExistence(timeout: 5))
        XCTAssertEqual(app.buttons["presentation.menu"].label, "Fixture menu")

        let close = app.buttons["presentation.close"]
        XCTAssertTrue(close.exists)
        close.tap()
        XCTAssertTrue(sheetTitle.waitForNonExistence(timeout: 10))
        XCTAssertTrue(webText("Overview page").exists, "the main Studio page is intact")

        openSheet()
        XCTAssertTrue(webText("Showing fixture/sheet, time 2").waitForExistence(timeout: 20))
        XCTAssertEqual(webTextStarting("Presentation document ").label, document, "the booted presentation page is reused")
        XCTAssertFalse(webText("Action ping").exists, "nothing from the last presentation")

        app.webViews.buttons["Close from page"].tap()
        XCTAssertTrue(sheetTitle.waitForNonExistence(timeout: 10), "a presentation can dismiss itself")
    }

    @MainActor
    func testNavigatingOutDismissesAndMovesTheMainStudio() throws {
        launchWithFixtureServer()
        let mainDocument = webTextStarting("Document ").label
        openSheet()
        let leave = app.webViews.buttons["Go to Layouts"]
        XCTAssertTrue(leave.waitForExistence(timeout: 20))
        leave.tap()
        XCTAssertTrue(sheetTitle.waitForNonExistence(timeout: 10))
        XCTAssertTrue(webText("Layouts page").waitForExistence(timeout: 10), "Studio's router navigated")
        XCTAssertEqual(webTextStarting("Document ").label, mainDocument, "the main page was not reloaded")
        if isPad {
            XCTAssertTrue(app.collectionViews["native.sidebar"].exists)
        } else {
            XCTAssertTrue(app.tabBars.buttons["More"].isSelected, "native selection follows navigation/state")
        }
    }

    @MainActor
    func testPresentationWithLargeTextAndRightToLeftLayout() throws {
        launchWithFixtureServer(extraArguments: [
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXL",
            "-AppleTextDirection", "YES", "-NSForceRightToLeftWritingDirection", "YES",
        ])
        openSheet()
        XCTAssertTrue(webText("Showing fixture/sheet, time 1").waitForExistence(timeout: 20))
        let close = app.buttons["presentation.close"]
        XCTAssertTrue(close.isHittable)
        XCTAssertFalse(close.label.isEmpty)
        XCTAssertTrue(app.buttons["presentation.action.ping"].isHittable)
        close.tap()
        XCTAssertTrue(sheetTitle.waitForNonExistence(timeout: 10))
    }
}
