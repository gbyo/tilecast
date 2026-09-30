import Foundation
import Observation

/// An alert Studio asked the app to show, with Studio's own localized text.
/// The app never knows what the alert is about: a confirmation, a warning,
/// and a plugin's prompt all look the same here.
public struct NativeAlert: Equatable, Sendable, Identifiable {
    public struct Button: Equatable, Sendable, Identifiable {
        public enum Role: Equatable, Sendable {
            case `default`, cancel, destructive

            /// An unknown role is a default button, so Studio can name a new
            /// role without a Swift change.
            init(token: String?) {
                switch token {
                case "cancel": self = .cancel
                case "destructive": self = .destructive
                default: self = .default
                }
            }
        }

        public let id: String
        public let label: String
        public let role: Role
    }

    public let id: String
    public let title: String
    public let message: String?
    public let buttons: [Button]

    static let maximumButtons = 3
}

/// The one alert the app shows for the active server, and the page that
/// asked for it.
///
/// An alert belongs to the page that presented it, so the main Studio page
/// and the presentation page can each ask for one. Only one shows at a
/// time; a second request is refused, and Studio then shows its own
/// dialog. The alert goes away with its page: a new document, a closed page,
/// or a presentation that ended.
@MainActor
@Observable
public final class NativeAlertCenter {
    public struct Presented: Equatable, Sendable {
        public let alert: NativeAlert
        public let context: NativeBridgeProtocol.Context
    }

    public private(set) var current: Presented?
    @ObservationIgnored private weak var owner: StudioBridge?

    public init() {}

    /// The alert to show over the page of `context`, or nil. The main page
    /// and a presentation sheet each show only their own.
    public func alert(for context: NativeBridgeProtocol.Context) -> NativeAlert? {
        current?.context == context ? current?.alert : nil
    }

    func present(_ alert: NativeAlert, from bridge: StudioBridge) -> Bool {
        guard current == nil else { return false }
        current = Presented(alert: alert, context: bridge.context)
        owner = bridge
        return true
    }

    /// Studio withdrew the alert, or its page went away.
    func withdraw(alertID: String? = nil, from bridge: StudioBridge) {
        guard owner === bridge, alertID == nil || alertID == current?.alert.id else { return }
        clear()
    }

    /// The presentation ended, so its alert cannot outlive it.
    func withdraw(context: NativeBridgeProtocol.Context) {
        guard current?.context == context else { return }
        clear()
    }

    /// The user chose a button. Studio hears which one.
    public func choose(buttonID: String) {
        guard let presented = current, presented.alert.buttons.contains(where: { $0.id == buttonID }) else { return }
        let owner = owner
        clear()
        Task { await owner?.send(NativeBridgeProtocol.alertAction(alertID: presented.alert.id, actionID: buttonID)) }
    }

    private func clear() {
        current = nil
        owner = nil
    }
}
