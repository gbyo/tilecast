import Foundation
import Testing
@testable import TilecastCore

@Suite struct ServerAddressPolicyTests {
    struct FixtureCase: Decodable, CustomTestStringConvertible {
        let name: String
        let input: String
        let accepted: Bool
        let normalized: String?
        var testDescription: String { name }
    }

    struct Fixture: Decodable {
        let schemaVersion: Int
        let cases: [FixtureCase]
    }

    /// The corpus Linux, Android, and Edge Players also run.
    static func sharedFixture() throws -> Fixture {
        var directory = URL(filePath: #filePath).deletingLastPathComponent()
        while directory.path != "/" {
            let candidate = directory.appending(path: "packages/player-contracts/fixtures/server-url-policy.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: candidate))
            }
            directory.deleteLastPathComponent()
        }
        throw CocoaError(.fileNoSuchFile)
    }

    @Test func sharedFixtureVersionIsKnown() throws {
        #expect(try Self.sharedFixture().schemaVersion == 1)
    }

    @Test(arguments: try sharedFixture().cases)
    func matchesSharedServerURLPolicy(_ entry: FixtureCase) {
        let result = ServerAddressPolicy.normalize(entry.input)
        switch result {
        case .success(let address):
            #expect(entry.accepted, "\(entry.name) should be refused")
            #expect(address.url.absoluteString == entry.normalized)
        case .failure:
            #expect(!entry.accepted, "\(entry.name) should be accepted")
        }
    }

    @Test func classifiesRefusals() {
        #expect(ServerAddressPolicy.normalize("  ") == .failure(.empty))
        #expect(ServerAddressPolicy.normalize("ftp://example.org") == .failure(.unsupportedScheme))
        #expect(ServerAddressPolicy.normalize("https://example.org/studio") == .failure(.containsPath))
        #expect(ServerAddressPolicy.normalize("http://example.org") == .failure(.publicHTTP))
        #expect(ServerAddressPolicy.normalize("https://exa mple.org") == .failure(.invalid))
    }

    @Test func marksOnlyLocalHTTPAsCleartext() throws {
        let local = try ServerAddressPolicy.normalize("HTTP://Tilecast.Local:8080/").get()
        #expect(local.isLocalCleartext)
        #expect(local.url.absoluteString == "http://tilecast.local:8080")
        #expect(local.displayString == "http://tilecast.local:8080")

        let secure = try ServerAddressPolicy.normalize("signage.example.org").get()
        #expect(!secure.isLocalCleartext)
        #expect(secure.displayString == "signage.example.org")
    }

    @Test func acceptsIPv6OverHTTPSAndLoopbackOverHTTP() throws {
        #expect(try ServerAddressPolicy.normalize("https://[2001:db8::1]:8443").get().url.absoluteString
            == "https://[2001:db8::1]:8443")
        #expect(try ServerAddressPolicy.normalize("http://[::1]:8080").get().isLocalCleartext)
    }

    @Test func buildsOnlySameOriginPaths() throws {
        let address = try ServerAddressPolicy.normalize("https://signage.example.org:8443").get()
        #expect(address.url(forPath: "/screens?view=grid")?.absoluteString
            == "https://signage.example.org:8443/screens?view=grid")
        #expect(address.url(forPath: "//evil.example/steal") == nil)
        #expect(address.url(forPath: "https://evil.example/") == nil)
        #expect(address.url(forPath: "screens") == nil)
    }
}
