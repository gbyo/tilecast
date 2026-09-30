import XCTest

/// Launch smoke tests for the native shell. They need no Tilecast server:
/// each run starts with an empty, in-memory server list.
final class ServerSetupUITests: XCTestCase {
    override func setUp() {
        continueAfterFailure = false
    }

    @MainActor
    func testFirstRunOffersToAddAServer() {
        let app = XCUIApplication()
        app.launchArguments = ["-TilecastEphemeralServers", "-AppleLanguages", "(en)"]
        app.launch()

        let addServer = app.buttons["welcome.addServer"]
        XCTAssertTrue(addServer.waitForExistence(timeout: 10))
        addServer.tap()

        let address = app.textFields["addServer.address"]
        XCTAssertTrue(address.waitForExistence(timeout: 5))
        address.typeText("http://signage.example.org\n")

        // Public cleartext is refused locally, before any request is made.
        let problem = app.staticTexts.matching(identifier: "addServer.problem").firstMatch
        XCTAssertTrue(problem.waitForExistence(timeout: 5))
        XCTAssertTrue(problem.label.contains("HTTPS"))
    }
}
