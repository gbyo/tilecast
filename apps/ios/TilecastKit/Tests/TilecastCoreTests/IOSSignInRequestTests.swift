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

    func callback(_ attempt: IOSSignInRequest, _ query: String) -> URL {
        URL(string: "tilecast-ios://oauth/callback?state=\(attempt.state)&\(query)")!
    }

    /// RFC 9207: a code from another authorization server is refused before
    /// it is sent anywhere.
    @Test func callbackIssuerMustBeTheServerThatStartedTheAttempt() throws {
        let attempt = try IOSSignInRequest(server: try ServerAddressPolicy.normalize("https://signage.example.org").get())
        #expect(try attempt.code(from: callback(attempt, "code=abc&iss=https%3A%2F%2Fsignage.example.org")) == "abc")
        #expect(try attempt.code(from: callback(attempt, "code=abc&iss=https%3A%2F%2FSIGNAGE.example.org%3A443")) == "abc")
        for issuer in [
            "https%3A%2F%2Fevil.example",
            "http%3A%2F%2Fsignage.example.org",
            "https%3A%2F%2Fsignage.example.org%3A8443",
            "https%3A%2F%2Fsignage.example.org%2Foauth",
            "https%3A%2F%2Fsignage.example.org%3Fx%3D1",
            "",
        ] {
            #expect(throws: IOSSignInError.issuerMismatch, "\(issuer)") {
                try attempt.code(from: callback(attempt, "code=abc&iss=\(issuer)"))
            }
        }
        #expect(throws: IOSSignInError.issuerMismatch) {
            try attempt.code(from: callback(attempt, "code=abc&iss=https%3A%2F%2Fsignage.example.org&iss=https%3A%2F%2Fevil.example"))
        }
        // The issuer is checked before an error is believed.
        #expect(throws: IOSSignInError.issuerMismatch) {
            try attempt.code(from: callback(attempt, "error=access_denied&iss=https%3A%2F%2Fevil.example"))
        }
        #expect(throws: IOSSignInError.accessDenied) {
            try attempt.code(from: callback(attempt, "error=access_denied&iss=https%3A%2F%2Fsignage.example.org"))
        }
    }

    @Test func acceptsACallbackWithoutAnIssuerFromAnOlderServer() throws {
        let attempt = try IOSSignInRequest(server: try ServerAddressPolicy.normalize("http://192.168.1.50:8080").get())
        #expect(try attempt.code(from: callback(attempt, "code=abc")) == "abc")
        #expect(try attempt.code(from: callback(attempt, "code=abc&iss=http%3A%2F%2F192.168.1.50%3A8080")) == "abc")
    }

    @Test func refusesARepeatedStateOrCode() throws {
        let attempt = try IOSSignInRequest(server: try ServerAddressPolicy.normalize("https://signage.example.org").get())
        #expect(throws: IOSSignInError.invalidCallback) {
            try attempt.code(from: callback(attempt, "state=\(attempt.state)&code=abc"))
        }
        #expect(throws: IOSSignInError.invalidCallback) {
            try attempt.code(from: callback(attempt, "code=abc&code=def"))
        }
    }
}
