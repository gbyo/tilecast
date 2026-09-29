import Foundation
import Testing
@testable import TilecastCore

@Suite struct IOSSignInRequestTests {
    @Test func usesTheConfiguredServerOrigin() throws {
        let address = try ServerAddressPolicy.normalize("https://tilecast.weeklywildcat.com:8443").get()
        let attempt = try IOSSignInRequest(server: address)
        let url = try #require(URLComponents(url: attempt.authorizationURL, resolvingAgainstBaseURL: false))
        #expect(url.scheme == "https")
        #expect(url.host == "tilecast.weeklywildcat.com")
        #expect(url.port == 8443)
        #expect(url.path == "/oauth/approve")
        #expect(url.queryItems?.first(where: { $0.name == "redirect_uri" })?.value == IOSSignInRequest.redirectURI)
        #expect(url.queryItems?.first(where: { $0.name == "code_challenge_method" })?.value == "S256")
    }

    @Test func callbackNeedsTheCorrectStateAndScheme() throws {
        let address = try ServerAddressPolicy.normalize("https://tilecast.weeklywildcat.com").get()
        let attempt = try IOSSignInRequest(server: address)
        #expect(try attempt.code(from: URL(string: "tilecast-ios://oauth/callback?code=abc&state=\(attempt.state)")!) == "abc")
        #expect(throws: IOSSignInError.invalidCallback) {
            try attempt.code(from: URL(string: "tilecast-ios://oauth/callback?code=abc&state=wrong")!)
        }
        #expect(throws: IOSSignInError.invalidCallback) {
            try attempt.code(from: URL(string: "tilecast-ios://other/callback?code=abc&state=\(attempt.state)")!)
        }
    }
}
