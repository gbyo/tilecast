import Foundation

/// The one QR scan the app runs for the active server, and the page that
/// asked for it.
///
/// A scan belongs to the document that requested it, so the main Studio
/// page and the presentation page can each ask for one, but only one runs
/// at a time; a second request is refused, and Studio keeps manual entry.
/// The scan ends with its page: a new document, a closed page, a
/// presentation that ended, a server switch, or a sign-out all withdraw
/// it. A late result resolves nothing: only the outcome of the active
/// request reaches its page, and never another one.
@MainActor
public final class QRScanCenter {
    public struct Active: Equatable, Sendable {
        public let request: QRScanRequest
        public let context: NativeBridgeProtocol.Context
    }

    public private(set) var current: Active?
    private weak var owner: StudioBridge?
    private var task: Task<Void, Never>?
    /// The scanner itself, through the shared system handlers. The app
    /// target provides it; without one every scan is refused.
    public weak var system: SystemIntegrationHandlers?

    public init() {}

    /// Begins a scan for `bridge`. Returns false when another scan is
    /// active, no scanner was provided, or the scanner is unavailable,
    /// so the bridge refuses with `unavailable` and Studio keeps manual
    /// entry.
    func begin(_ request: QRScanRequest, from bridge: StudioBridge) -> Bool {
        guard current == nil, system?.scanQR != nil, system?.isQRScannerAvailable?() == true else { return false }
        current = Active(request: request, context: bridge.context)
        owner = bridge
        task = Task { [weak self] in await self?.run(request) }
        return true
    }

    /// Studio's page went away. The scan ends as cancelled, so a pending
    /// Studio request resolves instead of hanging on a dead document.
    func withdraw(from bridge: StudioBridge) {
        guard owner === bridge else { return }
        cancelActive()
    }

    /// The presentation ended, so its scan cannot outlive it.
    func withdraw(context: NativeBridgeProtocol.Context) {
        guard current?.context == context else { return }
        cancelActive()
    }

    /// Signing out ends whatever scan runs. It belongs to the session.
    func withdrawAll() {
        guard current != nil else { return }
        cancelActive()
    }

    private func run(_ request: QRScanRequest) async {
        let outcome = await system?.scanQR?(request) ?? .unavailable
        finish(requestID: request.requestID, outcome: outcome)
    }

    /// The driver finished. Only the outcome of the active request is
    /// delivered; anything late, or for another request, is ignored.
    private func finish(requestID: String, outcome: QRScanOutcome) {
        guard current?.request.requestID == requestID else { return }
        let owner = owner
        clear()
        let normalized = Self.normalize(outcome)
        Task { await owner?.sendQRScanResult(requestID: requestID, outcome: normalized) }
    }

    private func cancelActive() {
        guard let active = current else { return }
        let owner = owner
        task?.cancel()
        clear()
        Task { await owner?.sendQRScanResult(requestID: active.request.requestID, outcome: .cancelled) }
    }

    private func clear() {
        current = nil
        owner = nil
        task = nil
    }

    /// What crosses the bridge. An empty payload is no result, and a
    /// payload past the bound cannot cross: Studio falls back to manual
    /// entry either way. The scanner never emits an over-bound value.
    static func normalize(_ outcome: QRScanOutcome) -> QRScanOutcome {
        switch outcome {
        case .scanned(let value) where value.isEmpty: .cancelled
        case .scanned(let value) where value.count > QRScanOutcome.maximumValueLength: .unavailable
        default: outcome
        }
    }
}
