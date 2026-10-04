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

    var number: Double? {
        if case .number(let value) = self { value } else { nil }
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
        /// Studio handles `alert/action`, so the app may show its alert.
        public var nativeAlerts: Bool
        /// Studio handles `system/media-intake-completed`.
        public var nativeMediaIntake: Bool
        /// Studio handles the result of a generic native map action.
        public var systemMap: Bool
        /// Studio navigates for a deep link's `navigation/open-path`, and
        /// validates the path again.
        public var deepLinks: Bool

        public init(
            authLifecycle: Bool = false,
            nativePresentations: Bool = false,
            nativeAlerts: Bool = false,
            nativeMediaIntake: Bool = false,
            systemMap: Bool = false,
            deepLinks: Bool = false
        ) {
            self.authLifecycle = authLifecycle
            self.nativePresentations = nativePresentations
            self.nativeAlerts = nativeAlerts
            self.nativeMediaIntake = nativeMediaIntake
            self.systemMap = systemMap
            self.deepLinks = deepLinks
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
        /// Standard system feedback. Nil when Studio named a value this app
        /// does not know: the request is accepted and performs nothing.
        case systemHaptic(HapticFeedback?)
        case systemShare(SystemShare)
        /// The main page asks whether native media intake can start now.
        case mediaIntakeStatus
        case mediaIntake(MediaIntakeRequest)
        /// Main page: the chrome of the page Studio shows.
        case navigationChrome(NavigationChrome)
        /// Either page asks for a native alert.
        case alertPresent(NativeAlert)
        /// Either page withdraws an alert it presented.
        case alertCancel(alertID: String)
        /// Either page asks to scan one QR code.
        case systemScanQR(QRScanRequest)
        /// Main page asks to show or update a generic native map.
        case systemMapPresent(SystemMapPresentation)
        /// Main page withdraws the matching native map.
        case systemMapDismiss(mapID: String)

        /// The bridge context allowed to send this message.
        var context: Context? {
            switch self {
            case .configGet, .frontendReady, .systemHaptic, .systemShare, .alertPresent, .alertCancel, .systemScanQR: nil
            case .navigationCatalog, .navigationState, .navigationChrome, .authSignedOut, .presentationOpen,
                 .mediaIntakeStatus, .mediaIntake, .systemMapPresent, .systemMapDismiss: .main
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
        case "system/haptic": message = hapticFeedback(payload).map(FrontendMessage.systemHaptic)
        case "system/share": message = SystemShare.decode(payload).map(FrontendMessage.systemShare)
        case "system/media-intake-status": message = .mediaIntakeStatus
        case "system/media-intake": message = mediaIntake(payload).map(FrontendMessage.mediaIntake)
        case "presentation/ready": message = .presentationReady
        case "presentation/update": message = presentationUpdate(payload).map(FrontendMessage.presentationUpdate)
        case "presentation/close": message = opaqueID(payload["presentationId"]).map { .presentationClose(presentationID: $0) }
        case "presentation/navigate":
            guard let presentationID = opaqueID(payload["presentationId"]),
                  let path = payload["path"]?.string, PresentationPaths.isStudioPath(path) else { message = nil; break }
            message = .presentationNavigate(presentationID: presentationID, path: path)
        case "navigation/chrome": message = navigationChrome(payload).map(FrontendMessage.navigationChrome)
        case "alert/present": message = alertPresent(payload).map(FrontendMessage.alertPresent)
        case "alert/cancel": message = opaqueID(payload["alertId"]).map { .alertCancel(alertID: $0) }
        case "system/scan-qr": message = scanQR(payload).map(FrontendMessage.systemScanQR)
        case "system/map-present": message = systemMap(payload).map(FrontendMessage.systemMapPresent)
        case "system/map-dismiss":
            guard Set(payload.keys).isSubset(of: ["mapId"]) else { message = nil; break }
            message = opaqueID(payload["mapId"]).map { .systemMapDismiss(mapID: $0) }
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
    /// navigation and follows the auth lifecycle. The scanner is offered to
    /// both pages when the hardware can scan; Studio keeps manual entry
    /// otherwise.
    static func configPayload(context: Context, scannerAvailable: Bool = false) -> [String: JSONValue] {
        [
            "protocolVersion": .number(Double(version)),
            "context": .string(context.rawValue),
            "capabilities": .object([
                "nativeNavigation": .bool(context == .main),
                "authLifecycle": .bool(context == .main),
                "nativePresentations": .bool(true),
                "systemShare": .bool(true),
                "systemHaptics": .bool(true),
                "systemQrScanner": .bool(scannerAvailable),
                "systemMap": .bool(context == .main),
                "nativeMediaIntake": .bool(context == .main),
                "deepLinks": .bool(context == .main),
                "nativeAlerts": .bool(true),
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

    /// Tells Studio how native media intake ended. It carries only the
    /// request id, the outcome, and a count: never file data or the assets.
    static func mediaIntakeCompleted(requestID: String, outcome: MediaIntakeOutcome, uploadedCount: Int) -> JSONValue {
        message("system/media-intake-completed", [
            "requestId": .string(requestID),
            "outcome": .string(outcome.rawValue),
            "uploadedCount": .number(Double(max(0, min(uploadedCount, 1000)))),
        ])
    }

    /// The user tapped the native back button. It carries no path: Studio's
    /// router decides where back goes.
    static func navigationBack() -> JSONValue {
        message("navigation/back", [:])
    }

    /// The user chose a button of an alert. `actionID` is one of the ids
    /// Studio sent.
    static func alertAction(alertID: String, actionID: String) -> JSONValue {
        message("alert/action", ["alertId": .string(alertID), "actionId": .string(actionID)])
    }

    /// Tells the page that asked how its QR scan ended. Only a scan
    /// carries a value, and only a bounded one: the center normalizes
    /// before this encodes.
    static func systemMapAction(mapID: String, actionID: String) -> JSONValue {
        message("system/map-action", [
            "mapId": .string(mapID),
            "actionId": .string(actionID),
        ])
    }

    static func systemMapDismissed(mapID: String) -> JSONValue {
        message("system/map-dismissed", ["mapId": .string(mapID)])
    }

    static func qrScanResult(requestID: String, outcome: QRScanOutcome) -> JSONValue {
        var payload: [String: JSONValue] = ["requestId": .string(requestID)]
        switch outcome {
        case .scanned(let value):
            payload["outcome"] = .string("scanned")
            payload["value"] = .string(value)
        case .cancelled:
            payload["outcome"] = .string("cancelled")
        case .unavailable:
            payload["outcome"] = .string("unavailable")
        }
        return message("system/qr-scan-result", payload)
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
                nativePresentations: capabilities["nativePresentations"] == .bool(true),
                nativeAlerts: capabilities["nativeAlerts"] == .bool(true),
                nativeMediaIntake: capabilities["nativeMediaIntake"] == .bool(true),
                systemMap: capabilities["systemMap"] == .bool(true),
                deepLinks: capabilities["deepLinks"] == .bool(true)
            )
        default: return nil
        }
    }

    /// A well-formed feedback token maps to a known feedback, or to nil for
    /// a value this app does not know. Only a malformed value is refused.
    private static func hapticFeedback(_ payload: [String: JSONValue]) -> HapticFeedback?? {
        guard let token = payload["feedback"]?.string, isToken(token, 32) else { return nil }
        return .some(HapticFeedback(rawValue: token))
    }

    static let maximumSystemMapPoints = 500

    private static func systemMap(_ payload: [String: JSONValue]) -> SystemMapPresentation? {
        guard Set(payload.keys).isSubset(of: ["mapId", "title", "points"]),
              let mapID = opaqueID(payload["mapId"]),
              let title = payload["title"]?.string, isBounded(title, 200),
              case .array(let values)? = payload["points"],
              !values.isEmpty, values.count <= maximumSystemMapPoints else { return nil }

        var ids = Set<String>()
        var points: [SystemMapPoint] = []
        points.reserveCapacity(values.count)
        for value in values {
            guard let point = value.object,
                  Set(point.keys).isSubset(of: ["id", "title", "subtitle", "latitude", "longitude", "tone", "actionId"]),
                  let id = opaqueID(point["id"]), ids.insert(id).inserted,
                  let title = point["title"]?.string, isBounded(title, 200),
                  let latitude = point["latitude"]?.number, (-90...90).contains(latitude),
                  let longitude = point["longitude"]?.number, (-180...180).contains(longitude) else { return nil }

            let subtitle: String?
            switch point["subtitle"] {
            case nil: subtitle = nil
            case .string(let value)? where isBounded(value, 200): subtitle = value
            default: return nil
            }

            let tone: SystemMapTone
            switch point["tone"] {
            case nil: tone = .default
            case .string(let value)?:
                guard let decoded = SystemMapTone(rawValue: value) else { return nil }
                tone = decoded
            default: return nil
            }

            let actionID: String?
            switch point["actionId"] {
            case nil: actionID = nil
            case let value?: actionID = opaqueID(value)
            }
            if point["actionId"] != nil && actionID == nil { return nil }

            points.append(SystemMapPoint(
                id: id,
                title: title,
                subtitle: subtitle,
                latitude: latitude,
                longitude: longitude,
                tone: tone,
                actionID: actionID
            ))
        }
        return SystemMapPresentation(id: mapID, title: title, points: points)
    }

    /// A scan request carries only its id, at the longer bound the
    /// schema sets. Anything else in the payload refuses it.
    private static func scanQR(_ payload: [String: JSONValue]) -> QRScanRequest? {
        guard Set(payload.keys).isSubset(of: ["requestId"]),
              let id = payload["requestId"]?.string, isIdentifier(id, maximumLength: QRScanRequest.maximumIDLength) else { return nil }
        return QRScanRequest(requestID: id)
    }

    static let maximumMediaKinds = 4

    private static func mediaIntake(_ payload: [String: JSONValue]) -> MediaIntakeRequest? {
        guard let id = opaqueID(payload["requestId"]) else { return nil }
        var kinds: [MediaIntakeKind] = []
        switch payload["accept"] {
        case nil: break
        case .array(let items)? where items.count <= maximumMediaKinds:
            for item in items {
                // A kind this app does not know is a hint it ignores.
                guard let token = item.string, isToken(token, 16) else { return nil }
                if let kind = MediaIntakeKind(rawValue: token), !kinds.contains(kind) { kinds.append(kind) }
            }
        default: return nil
        }
        guard let multiple = optionalBool(payload["multiple"]) else { return nil }
        return MediaIntakeRequest(
            requestID: id,
            kinds: kinds.isEmpty ? MediaIntakeKind.allCases : kinds,
            allowsMultiple: multiple ?? true
        )
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

    private static func navigationChrome(_ payload: [String: JSONValue]) -> NavigationChrome? {
        guard Set(payload.keys).isSubset(of: ["title", "back"]) else { return nil }
        let title: String?
        switch payload["title"] {
        case nil: title = nil
        case .string(let text)? where isBounded(text, 200): title = text
        default: return nil
        }
        let backLabel: String?
        switch payload["back"] {
        case nil: backLabel = nil
        case .object(let back)? where Set(back.keys) == ["label"]:
            guard let label = back["label"]?.string, isBounded(label, 200) else { return nil }
            backLabel = label
        default: return nil
        }
        return NavigationChrome(title: title, backLabel: backLabel)
    }

    private static func alertPresent(_ payload: [String: JSONValue]) -> NativeAlert? {
        guard Set(payload.keys).isSubset(of: ["alertId", "title", "message", "actions"]),
              let id = opaqueID(payload["alertId"]),
              let title = payload["title"]?.string, isBounded(title, 200),
              case .array(let rawButtons)? = payload["actions"],
              (1...NativeAlert.maximumButtons).contains(rawButtons.count) else { return nil }
        let message: String?
        switch payload["message"] {
        case nil: message = nil
        case .string(let text)? where isBounded(text, 1000): message = text
        default: return nil
        }
        var seen = Set<String>()
        var buttons: [NativeAlert.Button] = []
        for raw in rawButtons {
            guard let button = raw.object, Set(button.keys).isSubset(of: ["id", "label", "role"]),
                  let buttonID = opaqueID(button["id"]), seen.insert(buttonID).inserted,
                  let label = button["label"]?.string, isBounded(label, 60) else { return nil }
            let role: String?
            switch button["role"] {
            case nil: role = nil
            case .string(let token)? where ["default", "cancel", "destructive"].contains(token): role = token
            default: return nil
            }
            buttons.append(NativeAlert.Button(id: buttonID, label: label, role: .init(token: role)))
        }
        return NativeAlert(id: id, title: title, message: message, buttons: buttons)
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
