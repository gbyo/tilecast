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

    /// The kind of page a bridge belongs to. It decides which messages the
    /// bridge accepts, and Studio reads it from the `config/get` reply.
    public enum Context: String, Equatable, Sendable {
        /// The one main Studio page: native navigation, the auth
        /// lifecycle, and opening presentations.
        case main
        /// The reusable presentation page: presentation lifecycle and
        /// chrome only.
        case presentation
    }

    /// What Studio reports it supports in `frontend/ready`. A capability
    /// that is absent or not `true` is unavailable, so the app never sends a
    /// message that an older Studio would not understand.
    public struct FrontendCapabilities: Equatable, Sendable {
        /// Studio handles `auth/sign-out-request` and reports `auth/signed-out`.
        public var authLifecycle: Bool
        /// Studio has the presentation routes and messages, and handles
        /// `navigation/open-path`.
        public var nativePresentations: Bool

        public init(authLifecycle: Bool = false, nativePresentations: Bool = false) {
            self.authLifecycle = authLifecycle
            self.nativePresentations = nativePresentations
        }
    }

    /// A message Studio sends to the app.
    public enum FrontendMessage: Equatable, Sendable {
        case configGet
        case frontendReady(FrontendCapabilities)
        case navigationCatalog(NavigationCatalog)
        case navigationState(NavigationState)
        /// Studio completed its own sign-out. It carries no credential.
        case authSignedOut
        /// The main page asks for a presentation.
        case presentationOpen(NativePresentation)
        /// The presentation page is signed in and receives `presentation/show`.
        case presentationReady
        case presentationUpdate(PresentationUpdate)
        case presentationClose(presentationID: String)
        /// Dismiss, then have the main page navigate to `path`.
        case presentationNavigate(presentationID: String, path: String)

        /// The bridge context allowed to send this message.
        var context: Context? {
            switch self {
            case .configGet, .frontendReady: nil
            case .navigationCatalog, .navigationState, .authSignedOut, .presentationOpen: .main
            case .presentationReady, .presentationUpdate, .presentationClose, .presentationNavigate: .presentation
            }
        }
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
        case "frontend/ready": message = frontendCapabilities(payload).map(FrontendMessage.frontendReady)
        case "auth/signed-out": message = .authSignedOut
        case "navigation/catalog": message = catalog(payload).map(FrontendMessage.navigationCatalog)
        case "navigation/state": message = state(payload).map(FrontendMessage.navigationState)
        case "presentation/open": message = presentationOpen(payload).map(FrontendMessage.presentationOpen)
        case "presentation/ready": message = .presentationReady
        case "presentation/update": message = presentationUpdate(payload).map(FrontendMessage.presentationUpdate)
        case "presentation/close": message = opaqueID(payload["presentationId"]).map { .presentationClose(presentationID: $0) }
        case "presentation/navigate":
            guard let presentationID = opaqueID(payload["presentationId"]),
                  let path = payload["path"]?.string, PresentationPaths.isStudioPath(path) else { message = nil; break }
            message = .presentationNavigate(presentationID: presentationID, path: path)
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

    /// What the app offers each kind of page. Only the main page publishes
    /// navigation and follows the auth lifecycle.
    static func configPayload(context: Context) -> [String: JSONValue] {
        [
            "protocolVersion": .number(Double(version)),
            "context": .string(context.rawValue),
            "capabilities": .object([
                "nativeNavigation": .bool(context == .main),
                "authLifecycle": .bool(context == .main),
                "nativePresentations": .bool(true),
            ]),
        ]
    }

    private static func message(_ type: String, _ payload: [String: JSONValue]) -> JSONValue {
        .object(["version": .number(Double(version)), "type": .string(type), "payload": .object(payload)])
    }

    /// Tells the presentation page which route to show, without a load.
    static func presentationShow(presentationID: String, path: String) -> JSONValue {
        message("presentation/show", ["presentationId": .string(presentationID), "path": .string(path)])
    }

    static func presentationAction(presentationID: String, actionID: String) -> JSONValue {
        message("presentation/action", ["presentationId": .string(presentationID), "actionId": .string(actionID)])
    }

    static func presentationDismissed(presentationID: String) -> JSONValue {
        message("presentation/dismissed", ["presentationId": .string(presentationID)])
    }

    /// Tells the main page a presentation ended, so it can refetch what the
    /// presentation may have changed. The presentation had its own query cache.
    static func presentationEnded(presentationID: String) -> JSONValue {
        message("presentation/ended", ["presentationId": .string(presentationID)])
    }

    /// Relays a presentation's navigation to the main page's router.
    static func openPath(_ path: String) -> JSONValue {
        message("navigation/open-path", ["path": .string(path)])
    }

    /// Asks Studio to sign out with its own logout. Like every message the
    /// app sends, it carries no credential.
    static func signOutRequest() -> JSONValue {
        .object([
            "version": .number(Double(version)),
            "type": .string("auth/sign-out-request"),
            "payload": .object([:]),
        ])
    }

    static func navigationRequest(destinationID: String) -> JSONValue {
        .object([
            "version": .number(Double(version)),
            "type": .string("navigation/request"),
            "payload": .object(["destinationId": .string(destinationID)]),
        ])
    }

    // MARK: Payloads

    private static func frontendCapabilities(_ payload: [String: JSONValue]) -> FrontendCapabilities? {
        switch payload["capabilities"] {
        case nil: return FrontendCapabilities()
        case .object(let capabilities)?:
            return FrontendCapabilities(
                authLifecycle: capabilities["authLifecycle"] == .bool(true),
                nativePresentations: capabilities["nativePresentations"] == .bool(true)
            )
        default: return nil
        }
    }

    static let maximumHeaderActions = 4
    static let maximumMenuItems = 16

    private static func presentationOpen(_ payload: [String: JSONValue]) -> NativePresentation? {
        guard let id = opaqueID(payload["presentationId"]),
              let path = payload["path"]?.string, PresentationPaths.isPresentationPath(path),
              let title = payload["title"]?.string, isBounded(title, 200),
              let subtitle = optionalText(payload["subtitle"]),
              let size = optionalSize(payload["size"]),
              let dismissible = optionalBool(payload["dismissible"]) else { return nil }
        return NativePresentation(
            id: id,
            path: path,
            header: PresentationHeader(title: title, subtitle: subtitle ?? nil),
            size: size ?? .full,
            isDismissible: dismissible ?? true
        )
    }

    private static func presentationUpdate(_ payload: [String: JSONValue]) -> PresentationUpdate? {
        guard let id = opaqueID(payload["presentationId"]),
              let size = optionalSize(payload["size"]),
              let dismissible = optionalBool(payload["dismissible"]) else { return nil }
        let header: PresentationHeader?
        switch payload["header"] {
        case nil: header = nil
        case .object(let object)?:
            guard let decoded = presentationHeader(object) else { return nil }
            header = decoded
        default: return nil
        }
        return PresentationUpdate(presentationID: id, header: header, size: size, isDismissible: dismissible)
    }

    private static func presentationHeader(_ header: [String: JSONValue]) -> PresentationHeader? {
        guard let title = header["title"]?.string, isBounded(title, 200),
              let subtitle = optionalText(header["subtitle"]),
              let navigationLabel = optionalText(header["navigationLabel"]),
              let menuLabel = optionalText(header["menuLabel"]) else { return nil }
        let navigation: PresentationHeader.Navigation
        switch header["navigation"] {
        case nil: navigation = .close
        case .string(let value)? where isToken(value, 32): navigation = value == "back" ? .back : .close
        default: return nil
        }
        var seen = Set<String>()
        var actions: [PresentationHeader.Action] = []
        switch header["actions"] {
        case nil: break
        case .array(let items)? where items.count <= maximumHeaderActions:
            for item in items {
                guard let item = item.object,
                      let id = opaqueID(item["id"]), seen.insert(id).inserted,
                      let label = item["label"]?.string, isBounded(label, 200),
                      let icon = item["icon"]?.string, isIconToken(icon) else { return nil }
                actions.append(.init(id: id, label: label, icon: icon))
            }
        default: return nil
        }
        var menu: [PresentationHeader.MenuItem] = []
        switch header["menu"] {
        case nil: break
        case .array(let items)? where items.count <= maximumMenuItems:
            for item in items {
                guard let item = item.object,
                      let id = opaqueID(item["id"]), seen.insert(id).inserted,
                      let label = item["label"]?.string, isBounded(label, 200),
                      let disabled = optionalBool(item["disabled"]) else { return nil }
                let icon: String?
                switch item["icon"] {
                case nil: icon = nil
                case .string(let value)? where isIconToken(value): icon = value
                default: return nil
                }
                menu.append(.init(id: id, label: label, icon: icon, isDisabled: disabled ?? false))
            }
        default: return nil
        }
        return PresentationHeader(
            title: title,
            subtitle: subtitle ?? nil,
            navigation: navigation,
            navigationLabel: navigationLabel ?? nil,
            menuLabel: menuLabel ?? nil,
            actions: actions,
            menu: menu
        )
    }

    // Optional values decode to `.some(nil)` when absent and to nil when
    // present but invalid, so a guard refuses only invalid values.

    private static func optionalText(_ value: JSONValue?) -> String?? {
        switch value {
        case nil: .some(nil)
        case .string(let text)? where isBounded(text, 200): .some(text)
        default: nil
        }
    }

    private static func optionalBool(_ value: JSONValue?) -> Bool?? {
        switch value {
        case nil: .some(nil)
        case .bool(let flag)?: .some(flag)
        default: nil
        }
    }

    private static func optionalSize(_ value: JSONValue?) -> PresentationSize?? {
        switch value {
        case nil: .some(nil)
        case .string(let token)? where isToken(token, 32): .some(PresentationSize(token: token))
        default: nil
        }
    }

    /// Presentation and action ids: the destination id pattern, at most 64.
    private static func opaqueID(_ value: JSONValue?) -> String? {
        guard let id = value?.string, isIdentifier(id, maximumLength: 64) else { return nil }
        return id
    }

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
        isToken(value, 40)
    }

    /// `^[a-z][a-z0-9-]*$`.
    private static func isToken(_ value: String, _ maximum: Int) -> Bool {
        guard isBounded(value, maximum), let first = value.unicodeScalars.first, ("a"..."z").contains(first) else { return false }
        return value.unicodeScalars.allSatisfy { ("a"..."z").contains($0) || ("0"..."9").contains($0) || $0 == "-" }
    }
}
