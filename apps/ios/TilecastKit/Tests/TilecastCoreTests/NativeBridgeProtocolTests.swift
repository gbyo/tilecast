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
        let frontendCapabilities: [String: Bool]?
        let presentation: [String: Any]?
        let alert: [String: Any]?
        let headerActionIDs: [String]?
        let headerMenuIDs: [String]?
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
                frontendCapabilities: entry["frontendCapabilities"] as? [String: Bool],
                presentation: entry["presentation"] as? [String: Any],
                alert: entry["alert"] as? [String: Any],
                headerActionIDs: entry["headerActionIds"] as? [String],
                headerMenuIDs: entry["headerMenuIds"] as? [String],
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
        if let expected = entry.frontendCapabilities {
            guard case .accept(.frontendReady(let capabilities), _) = decoded else {
                Issue.record("\(entry.name) should decode as frontend/ready")
                return
            }
            #expect(capabilities.authLifecycle == expected["authLifecycle"])
            #expect(capabilities.nativePresentations == (expected["nativePresentations"] ?? false))
            #expect(capabilities.nativeAlerts == (expected["nativeAlerts"] ?? false))
        }
        if let expected = entry.presentation {
            guard case .accept(.presentationOpen(let presentation), _) = decoded else {
                Issue.record("\(entry.name) should decode as presentation/open")
                return
            }
            #expect(presentation.id == expected["presentationId"] as? String)
            #expect(presentation.path == expected["path"] as? String)
            #expect(presentation.header.title == expected["title"] as? String)
            #expect(presentation.header.subtitle == expected["subtitle"] as? String)
            #expect(presentation.size.rawValue == expected["size"] as? String)
            #expect(presentation.isDismissible == expected["dismissible"] as? Bool)
            #expect(presentation.header.actions.isEmpty && presentation.header.menu.isEmpty)
        }
        if let expected = entry.alert {
            guard case .accept(.alertPresent(let alert), _) = decoded else {
                Issue.record("\(entry.name) should decode as alert/present")
                return
            }
            #expect(alert.id == expected["alertId"] as? String)
            #expect(alert.title == expected["title"] as? String)
            #expect(alert.message == expected["message"] as? String)
            let buttons = expected["actions"] as? [[String: Any]] ?? []
            #expect(alert.buttons.map(\.id) == buttons.compactMap { $0["id"] as? String })
            #expect(alert.buttons.map(\.label) == buttons.compactMap { $0["label"] as? String })
            #expect(alert.buttons.map(\.role) == buttons.map { .init(token: $0["role"] as? String) })
        }
        if let actions = entry.headerActionIDs {
            guard case .accept(.presentationUpdate(let update), _) = decoded, let header = update.header else {
                Issue.record("\(entry.name) should decode as presentation/update with a header")
                return
            }
            #expect(header.actions.map(\.id) == actions)
            #expect(header.menu.map(\.id) == entry.headerMenuIDs)
        }
    }

    /// Messages the app sends must match the corpus exactly, so Studio's
    /// decoder, tested against the same cases, accepts them.
    @Test(arguments: try goldens())
    func encodesLikeTheSharedCorpus(_ entry: FixtureCase) throws {
        let encoded: JSONValue = switch entry.encodes {
        case "navigationRequest": NativeBridgeProtocol.navigationRequest(destinationID: "layouts")
        case "signOutRequest": NativeBridgeProtocol.signOutRequest()
        case "configGetReply": NativeBridgeProtocol.reply(id: nil, payload: NativeBridgeProtocol.configPayload(context: .main))
        case "configGetPresentationReply": NativeBridgeProtocol.reply(id: nil, payload: NativeBridgeProtocol.configPayload(context: .presentation))
        case "forbiddenReply": NativeBridgeProtocol.reply(id: nil, error: .forbidden)
        case "unavailableReply": NativeBridgeProtocol.reply(id: nil, error: .unavailable)
        case "presentationShow": NativeBridgeProtocol.presentationShow(
            presentationID: "p-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e",
            path: "/__native/modal/live-stream/screen-1"
        )
        case "presentationAction": NativeBridgeProtocol.presentationAction(
            presentationID: "p-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e",
            actionID: "refresh"
        )
        case "presentationDismissed": NativeBridgeProtocol.presentationDismissed(
            presentationID: "p-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e"
        )
        case "presentationEnded": NativeBridgeProtocol.presentationEnded(
            presentationID: "p-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e"
        )
        case "alertAction": NativeBridgeProtocol.alertAction(
            alertID: "a-4f1c2a9e-6b1d-4c1e-8f7a-2d3e4b5c6d7e",
            actionID: "confirm"
        )
        case "openPath": NativeBridgeProtocol.openPath("/screens/screen-1?tab=activity")
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

    /// Everything the app can put on the bridge. None of it may carry a
    /// credential, whatever state the app is in.
    @Test func nativeMessagesCarryNoCredentials() throws {
        let messages: [JSONValue] = [
            NativeBridgeProtocol.signOutRequest(),
            NativeBridgeProtocol.navigationRequest(destinationID: "alpha"),
            NativeBridgeProtocol.reply(id: "c1", payload: NativeBridgeProtocol.configPayload(context: .main)),
            NativeBridgeProtocol.reply(id: nil, payload: [:]),
            NativeBridgeProtocol.reply(id: nil, error: .forbidden),
        ]
        for message in messages {
            let json = try #require(String(data: JSONSerialization.data(withJSONObject: message.foundation), encoding: .utf8))
            for forbidden in ["tca_", "tcr_", "token", "cookie", "csrf", "password", "secret", "Bearer"] {
                #expect(!json.localizedCaseInsensitiveContains(forbidden), "\(json) mentions \(forbidden)")
            }
        }
    }

    @Test func treatsOnlyTrueAsAFrontendCapability() {
        let decoded = NativeBridgeProtocol.decode(["version": 1, "type": "frontend/ready", "payload": ["capabilities": ["authLifecycle": "yes"]]])
        #expect(decoded == .accept(.frontendReady(.init(authLifecycle: false)), id: nil))
    }

    @Test func echoesAValidRequestID() {
        let decoded = NativeBridgeProtocol.decode(["version": 1, "id": "c1", "type": "clipboard/write", "payload": [:]])
        #expect(decoded == .unknownType("clipboard/write", id: "c1"))
    }
}

@Suite struct NavigationIconTests {
    @Test func mapsEveryTokenHostsRecognize() throws {
        let document = try #require(try foundationJSON(repositoryFile("packages/native-bridge-schema/icon-tokens.json")) as? [String: Any])
        let tokens = try #require(document["tokens"] as? [String])
        #expect(!tokens.isEmpty)
        for token in tokens {
            #expect(NavigationIcon.images[token] != nil, "\(token) has no icon")
        }
        #expect(Set(NavigationIcon.images.keys) == Set(tokens), "the app maps only the shared vocabulary")
    }

    @Test func showsTheGenericIconForAnUnknownToken() {
        #expect(NavigationIcon.imageName(for: "door-calendar") == NavigationIcon.generic)
        #expect(NavigationIcon.imageName(for: "") == NavigationIcon.generic)
        #expect(NavigationIcon.imageName(for: "settings") != NavigationIcon.generic)
    }

    @Test func everyIconIsInTheAssetCatalog() throws {
        for name in Set(NavigationIcon.images.values).union([NavigationIcon.generic]) {
            let contents = try repositoryFile("apps/ios/Tilecast/Resources/Assets.xcassets/\(name).imageset/Contents.json")
            #expect(!contents.isEmpty, "\(name) has no asset")
        }
    }
}
