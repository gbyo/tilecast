import Foundation

/// A JSON value, converted from what WebKit delivers for a script message
/// (`NSDictionary`, `NSArray`, `NSString`, `NSNumber`, `NSNull`).
enum JSONValue: Equatable, Sendable {
    case null
    case bool(Bool)
    case number(Double)
    case string(String)
    case array([JSONValue])
    case object([String: JSONValue])

    /// Nil for anything that is not JSON, or nested deeper than any version 1
    /// message needs.
    init?(foundation value: Any?, depth: Int = 0) {
        guard depth < 8 else { return nil }
        switch value {
        case nil, is NSNull:
            self = .null
        case let number as NSNumber:
            if CFGetTypeID(number) == CFBooleanGetTypeID() {
                self = .bool(number.boolValue)
            } else if number.doubleValue.isFinite {
                self = .number(number.doubleValue)
            } else {
                return nil
            }
        case let string as String:
            self = .string(string)
        case let array as [Any]:
            var values: [JSONValue] = []
            for element in array {
                guard let converted = JSONValue(foundation: element, depth: depth + 1) else { return nil }
                values.append(converted)
            }
            self = .array(values)
        case let dictionary as [String: Any]:
            var object: [String: JSONValue] = [:]
            for (key, element) in dictionary {
                guard let converted = JSONValue(foundation: element, depth: depth + 1) else { return nil }
                object[key] = converted
            }
            self = .object(object)
        default:
            return nil
        }
    }

    /// The Foundation form WebKit accepts as a reply or a script argument.
    var foundation: Any {
        switch self {
        case .null: NSNull()
        case .bool(let value): value
        case .number(let value): value.rounded() == value && abs(value) < 1e15 ? Int(value) as Any : value
        case .string(let value): value
        case .array(let values): values.map(\.foundation)
        case .object(let object): object.mapValues(\.foundation)
        }
    }

    var object: [String: JSONValue]? {
        if case .object(let object) = self { object } else { nil }
    }

    var string: String? {
        if case .string(let string) = self { string } else { nil }
    }

    /// An integral number, as JavaScript sends integers.
    var integer: Int? {
        guard case .number(let value) = self, value.rounded() == value, abs(value) < 1e15 else { return nil }
        return Int(value)
    }
}

/// Native bridge protocol version 1, as `packages/native-bridge-schema`
/// defines it. The shared fixtures in that package run against this code.
public enum NativeBridgeProtocol {
    public static let version = 1

    /// A message Studio sends to the app.
    public enum FrontendMessage: Equatable, Sendable {
        case configGet
        case frontendReady
        case navigationCatalog(NavigationCatalog)
        case navigationState(NavigationState)
    }

    public enum Decoded: Equatable, Sendable {
        case accept(FrontendMessage, id: String?)
        /// `type` is set when the envelope was valid and only its payload
        /// was not.
        case malformed(type: String?, id: String?)
        case unknownType(String, id: String?)
        case unsupportedVersion(Int)
    }

    public enum ErrorCode: String, Sendable {
        case malformed
        case unknownType = "unknown_type"
        case unsupportedVersion = "unsupported_version"
        case forbidden
        case unavailable
    }

    static let maximumDestinations = 128

    /// Decodes a message body as WebKit delivers it.
    public static func decode(_ body: Any?) -> Decoded {
        guard let value = JSONValue(foundation: body), let envelope = value.object else {
            return .malformed(type: nil, id: nil)
        }
        // The version is read first: another version may use another shape.
        guard let version = envelope["version"]?.integer, version >= 1 else {
            return .malformed(type: nil, id: nil)
        }
        guard version == Self.version else { return .unsupportedVersion(version) }

        let id = envelope["id"].map { $0.string.flatMap { isBounded($0, 64) ? $0 : nil } }
        guard Set(envelope.keys).isSubset(of: ["version", "id", "type", "payload"]),
              id != .some(nil),
              let type = envelope["type"]?.string, isMessageType(type),
              let payload = envelope["payload"]?.object else {
            return .malformed(type: nil, id: id ?? nil)
        }
        let requestID = id ?? nil

        let message: FrontendMessage?
        switch type {
        case "config/get": message = .configGet
        case "frontend/ready": message = .frontendReady
        case "navigation/catalog": message = catalog(payload).map(FrontendMessage.navigationCatalog)
        case "navigation/state": message = state(payload).map(FrontendMessage.navigationState)
        default: return .unknownType(type, id: requestID)
        }
        guard let message else { return .malformed(type: type, id: requestID) }
        return .accept(message, id: requestID)
    }

    // MARK: Replies and native messages

    static func reply(id: String?, payload: [String: JSONValue]) -> JSONValue {
        var reply: [String: JSONValue] = ["version": .number(Double(version)), "ok": .bool(true), "payload": .object(payload)]
        if let id { reply["id"] = .string(id) }
        return .object(reply)
    }

    static func reply(id: String?, error: ErrorCode) -> JSONValue {
        var details: [String: JSONValue] = ["code": .string(error.rawValue)]
        if error == .unsupportedVersion { details["supportedVersions"] = .array([.number(Double(version))]) }
        var reply: [String: JSONValue] = ["version": .number(Double(version)), "ok": .bool(false), "error": .object(details)]
        if let id { reply["id"] = .string(id) }
        return .object(reply)
    }

    static func configPayload(nativeNavigation: Bool) -> [String: JSONValue] {
        [
            "protocolVersion": .number(Double(version)),
            "capabilities": .object(["nativeNavigation": .bool(nativeNavigation)]),
        ]
    }

    static func navigationRequest(destinationID: String) -> JSONValue {
        .object([
            "version": .number(Double(version)),
            "type": .string("navigation/request"),
            "payload": .object(["destinationId": .string(destinationID)]),
        ])
    }

    // MARK: Payloads

    private static func catalog(_ payload: [String: JSONValue]) -> NavigationCatalog? {
        guard case .array(let rawGroups)? = payload["groups"], rawGroups.count <= 32 else { return nil }
        var seen = Set<String>()
        var groups: [NavigationCatalog.Group] = []
        for rawGroup in rawGroups {
            guard let group = rawGroup.object,
                  let id = group["id"]?.string, isIdentifier(id, maximumLength: 64),
                  case .array(let rawItems)? = group["items"], (1...64).contains(rawItems.count) else { return nil }
            let title: String?
            switch group["title"] {
            case nil: title = nil
            case .string(let value)? where isBounded(value, 200): title = value
            default: return nil
            }
            var destinations: [NavigationCatalog.Destination] = []
            for rawItem in rawItems {
                guard let item = rawItem.object,
                      let itemID = item["id"]?.string, isIdentifier(itemID, maximumLength: 128),
                      seen.insert(itemID).inserted,
                      let itemTitle = item["title"]?.string, isBounded(itemTitle, 200),
                      let icon = item["icon"]?.string, isIconToken(icon) else { return nil }
                let placement: NavigationCatalog.Placement
                switch item["mobilePlacement"] {
                case nil: placement = .more
                case .string(let value)?:
                    guard let parsed = NavigationCatalog.Placement(rawValue: value) else { return nil }
                    placement = parsed
                default: return nil
                }
                destinations.append(.init(id: itemID, title: itemTitle, icon: icon, placement: placement))
            }
            groups.append(.init(id: id, title: title, destinations: destinations))
        }
        guard seen.count <= maximumDestinations else { return nil }
        return NavigationCatalog(groups: groups)
    }

    private static func state(_ payload: [String: JSONValue]) -> NavigationState? {
        let active: String?
        switch payload["activeDestinationId"] {
        case .null?: active = nil
        case .string(let id)? where isIdentifier(id, maximumLength: 128): active = id
        default: return nil
        }
        let path: String?
        switch payload["path"] {
        case nil: path = nil
        case .string(let value)? where value.hasPrefix("/") && value.count <= 2048: path = value
        default: return nil
        }
        return NavigationState(activeDestinationID: active, path: path)
    }

    // MARK: Lexical rules

    private static func isBounded(_ value: String, _ maximum: Int) -> Bool {
        !value.isEmpty && value.count <= maximum
    }

    /// `^[a-z][a-z0-9-]*(/[a-z][a-z0-9-]*)+$`, at most 64 characters.
    private static func isMessageType(_ value: String) -> Bool {
        guard (3...64).contains(value.count) else { return false }
        let segments = value.split(separator: "/", omittingEmptySubsequences: false)
        return segments.count >= 2 && segments.allSatisfy { segment in
            guard let first = segment.unicodeScalars.first, ("a"..."z").contains(first) else { return false }
            return segment.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
        }
    }

    /// `^[a-z0-9][a-z0-9._:-]*$`.
    private static func isIdentifier(_ value: String, maximumLength: Int) -> Bool {
        guard isBounded(value, maximumLength), let first = value.unicodeScalars.first,
              ("a"..."z").contains(first) || ("0"..."9").contains(first) else { return false }
        return value.unicodeScalars.allSatisfy {
            ("a"..."z").contains($0) || ("0"..."9").contains($0) || ".:_-".unicodeScalars.contains($0)
        }
    }

    /// `^[a-z][a-z0-9-]*$`, at most 40 characters.
    private static func isIconToken(_ value: String) -> Bool {
        guard isBounded(value, 40), let first = value.unicodeScalars.first, ("a"..."z").contains(first) else { return false }
        return value.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }
}
