import Foundation
import Testing
@testable import TilecastCore

/// A file from the repository, found by walking up from this source file.
/// Tests read shared contracts in place, so Studio and the app cannot test
/// against different copies.
func repositoryFile(_ path: String) throws -> Data {
    var directory = URL(filePath: #filePath).deletingLastPathComponent()
    while directory.path != "/" {
        let candidate = directory.appending(path: path)
        if FileManager.default.fileExists(atPath: candidate.path) { return try Data(contentsOf: candidate) }
        directory.deleteLastPathComponent()
    }
    throw CocoaError(.fileNoSuchFile)
}

/// Parses JSON into the Foundation objects WebKit delivers for a message.
func foundationJSON(_ data: Data) throws -> Any {
    try JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
}

@Suite struct NativeBridgeProtocolTests {
    struct FixtureCase: CustomTestStringConvertible, @unchecked Sendable {
        let name: String
        let direction: String
        let outcome: String
        let destinationIDs: [String]?
        let encodes: String?
        let message: Any
        var testDescription: String { name }
    }

    /// `packages/native-bridge-schema/fixtures/messages-v1.json`, which
    /// Studio's tests also run.
    static func corpus() throws -> [FixtureCase] {
        let root = try foundationJSON(repositoryFile("packages/native-bridge-schema/fixtures/messages-v1.json"))
        let document = try #require(root as? [String: Any])
        #expect(document["schemaVersion"] as? Int == 1)
        let cases = try #require(document["cases"] as? [[String: Any]])
        return cases.map { entry in
            FixtureCase(
                name: entry["name"] as? String ?? "",
                direction: entry["direction"] as? String ?? "",
                outcome: entry["outcome"] as? String ?? "",
                destinationIDs: entry["destinationIds"] as? [String],
                encodes: entry["encodes"] as? String,
                message: entry["message"] ?? NSNull()
            )
        }
    }

    static func nativeDecodes() throws -> [FixtureCase] {
        try corpus().filter { $0.direction == "frontendToNative" }
    }

    static func goldens() throws -> [FixtureCase] {
        try corpus().filter { $0.encodes != nil }
    }

    static func outcome(_ decoded: NativeBridgeProtocol.Decoded) -> String {
        switch decoded {
        case .accept: "accept"
        case .malformed: "malformed"
        case .unknownType: "unknownType"
        case .unsupportedVersion: "unsupportedVersion"
        }
    }

    @Test(arguments: try nativeDecodes())
    func decodesTheSharedCorpus(_ entry: FixtureCase) {
        let decoded = NativeBridgeProtocol.decode(entry.message)
        #expect(Self.outcome(decoded) == entry.outcome)
        if let expected = entry.destinationIDs {
            guard case .accept(.navigationCatalog(let catalog), _) = decoded else {
                Issue.record("\(entry.name) should decode as a catalog")
                return
            }
            #expect(catalog.destinations.map(\.id) == expected)
        }
    }

    /// Messages the app sends must match the corpus exactly, so Studio's
    /// decoder, tested against the same cases, accepts them.
    @Test(arguments: try goldens())
    func encodesLikeTheSharedCorpus(_ entry: FixtureCase) throws {
        let encoded: JSONValue = switch entry.encodes {
        case "navigationRequest": NativeBridgeProtocol.navigationRequest(destinationID: "layouts")
        case "configGetReply": NativeBridgeProtocol.reply(id: nil, payload: NativeBridgeProtocol.configPayload(nativeNavigation: true))
        case "okReplyWithId": NativeBridgeProtocol.reply(id: "c1", payload: [:])
        case "unknownTypeReply": NativeBridgeProtocol.reply(id: nil, error: .unknownType)
        case "unsupportedVersionReply": NativeBridgeProtocol.reply(id: nil, error: .unsupportedVersion)
        default: throw CocoaError(.featureUnsupported)
        }
        #expect(encoded == JSONValue(foundation: entry.message))
        // And the Foundation form WebKit serializes is the same JSON.
        let data = try JSONSerialization.data(withJSONObject: encoded.foundation)
        #expect(JSONValue(foundation: try foundationJSON(data)) == encoded)
    }

    @Test func keepsCatalogOrderTitlesAndPlacements() throws {
        let body: [String: Any] = [
            "version": 1, "type": "navigation/catalog",
            "payload": ["groups": [
                ["id": "one", "items": [
                    ["id": "bravo", "title": "Bravo", "icon": "home", "mobilePlacement": "primary"],
                    ["id": "alpha", "title": "Alpha", "icon": "door-calendar"],
                ]],
                ["id": "two", "title": "Two", "items": [["id": "charlie", "title": "Charlie", "icon": "plugin"]]],
            ]],
        ]
        guard case .accept(.navigationCatalog(let catalog), nil) = NativeBridgeProtocol.decode(body) else {
            Issue.record("catalog refused")
            return
        }
        #expect(catalog.groups.map(\.title) == [nil, "Two"])
        #expect(catalog.destinations.map(\.id) == ["bravo", "alpha", "charlie"])
        #expect(catalog.destinations.map(\.placement) == [.primary, .more, .more])
    }

    @Test func refusesACatalogWithTooManyDestinations() {
        let groups = (0..<3).map { group in
            ["id": "g\(group)", "items": (0..<50).map { ["id": "d\(group)-\($0)", "title": "D", "icon": "home"] }] as [String: Any]
        }
        let decoded = NativeBridgeProtocol.decode(["version": 1, "type": "navigation/catalog", "payload": ["groups": groups]])
        #expect(decoded == .malformed(type: "navigation/catalog", id: nil))
    }

    @Test func refusesValuesThatAreNotJSON() {
        #expect(NativeBridgeProtocol.decode(["version": 1, "type": "config/get", "payload": ["when": Date()]]) == .malformed(type: nil, id: nil))
        #expect(NativeBridgeProtocol.decode(["version": Double.nan, "type": "config/get", "payload": [:]]) == .malformed(type: nil, id: nil))
    }

    @Test func echoesAValidRequestID() {
        let decoded = NativeBridgeProtocol.decode(["version": 1, "id": "c1", "type": "presentation/open", "payload": [:]])
        #expect(decoded == .unknownType("presentation/open", id: "c1"))
    }
}

@Suite struct NavigationIconTests {
    @Test func mapsEveryTokenHostsRecognize() throws {
        let document = try #require(try foundationJSON(repositoryFile("packages/native-bridge-schema/icon-tokens.json")) as? [String: Any])
        let tokens = try #require(document["tokens"] as? [String])
        #expect(!tokens.isEmpty)
        for token in tokens {
            #expect(NavigationIcon.symbols[token] != nil, "\(token) has no symbol")
        }
        #expect(Set(NavigationIcon.symbols.keys) == Set(tokens), "the app maps only the shared vocabulary")
    }

    @Test func showsTheGenericSymbolForAnUnknownToken() {
        #expect(NavigationIcon.systemImage(for: "door-calendar") == NavigationIcon.generic)
        #expect(NavigationIcon.systemImage(for: "") == NavigationIcon.generic)
        #expect(NavigationIcon.systemImage(for: "settings") != NavigationIcon.generic)
    }
}
