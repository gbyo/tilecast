import Foundation
import WebKit

/// Where a script message came from, as WebKit reports it.
public struct BridgeSender: Equatable, Sendable {
    public var isMainFrame: Bool
    public var isPageWorld: Bool
    /// Nil when the frame's origin is not HTTP(S), for example an opaque
    /// `about:srcdoc` or `data:` frame.
    public var origin: WebOrigin?

    public init(isMainFrame: Bool, isPageWorld: Bool, origin: WebOrigin?) {
        self.isMainFrame = isMainFrame
        self.isPageWorld = isPageWorld
        self.origin = origin
    }
}

/// A message from the presentation page to the app.
public enum PresentationPageMessage: Equatable, Sendable {
    case ready
    case update(PresentationUpdate)
    case close(presentationID: String)
    case navigate(presentationID: String, path: String)
}

/// The versioned native bridge for one privileged Studio page.
///
/// This is the only code in the app that touches page scripting. Studio
/// calls the one message handler, `tilecastNative`; the app answers every
/// message and delivers its own messages through one Studio receiver
/// function, passing the message as an argument, never as script source.
///
/// The bridge is privileged, so it is narrow. It carries presentation,
/// navigation, and credential-free sign-out coordination only: never a
/// password, token, cookie, Keychain value, CSRF token, or file access. It
/// answers only the main frame of the configured server's origin, in the
/// page's own content world.
///
/// Each bridge belongs to one page and has that page's context. The main
/// Studio page's bridge publishes navigation, follows the auth lifecycle,
/// and opens presentations. The presentation page's bridge has its own
/// instance, handles only the presentation lifecycle, and is refused
/// everything else. The auxiliary page has no bridge.
@MainActor
public final class StudioBridge {
    public static let handlerName = "tilecastNative"

    public let context: NativeBridgeProtocol.Context
    /// The navigation Studio publishes, and the selection the app shows.
    /// A presentation bridge's model stays empty.
    public let navigation: NativeNavigationModel
    /// Studio finished its host integration in the current document.
    public private(set) var isFrontendReady = false
    /// What the current document's Studio reported it supports.
    public private(set) var frontendCapabilities = NativeBridgeProtocol.FrontendCapabilities()
    /// Called when Studio reports that it signed out. The message carries
    /// nothing; the owner decides what signing out means for the app.
    public var onSignedOut: (@MainActor () -> Void)?
    /// Main page: Studio asks for a presentation. Returns whether the app
    /// accepted it; Studio shows its own dialog when it did not.
    var onPresentationOpen: (@MainActor (NativePresentation) -> Bool)?
    /// Presentation page: its lifecycle and chrome messages.
    var onPresentationMessage: (@MainActor (PresentationPageMessage) -> Void)?
    /// Readiness, capabilities, or navigation availability changed.
    var onStateChange: (@MainActor () -> Void)?
    /// Where this page's alerts show. Both kinds of page may ask for one.
    weak var alerts: NativeAlertCenter?

    let origin: WebOrigin
    private weak var page: WebPage?
    private var controller: WKUserContentController?
    /// Whether the current document negotiated since the last main-frame
    /// navigation started. A document that did not (an older Studio, or a
    /// page with no bridge support) must not inherit the previous
    /// document's navigation.
    private var negotiatedSinceNavigationStarted = true
    private var signOutWaiters: [UUID: CheckedContinuation<Bool, Never>] = [:]
    private var signOutTimeouts: [UUID: Task<Void, Never>] = [:]

    /// Studio's receiver. Static source; the message is an argument.
    static let receiverScript = """
        const receive = window.tilecastNativeReceiver;
        return typeof receive === "function" && receive(message) === true;
        """

    public init(origin: WebOrigin, context: NativeBridgeProtocol.Context = .main) {
        self.origin = origin
        self.context = context
        navigation = NativeNavigationModel()
        navigation.requestNavigation = { [weak self] id in
            Task { await self?.send(NativeBridgeProtocol.navigationRequest(destinationID: id)) }
        }
        navigation.requestBack = { [weak self] in
            Task { await self?.send(NativeBridgeProtocol.navigationBack()) }
        }
    }

    /// Registers the message handler on a configuration for the main Studio
    /// page. The controller holds the handler strongly; the handler holds
    /// the bridge weakly, so neither keeps the page alive.
    func install(into configuration: inout WebPage.Configuration) {
        let controller = WKUserContentController()
        controller.addScriptMessageHandler(StudioBridgeMessageHandler(bridge: self), contentWorld: .page, name: Self.handlerName)
        configuration.userContentController = controller
        self.controller = controller
    }

    func attach(to page: WebPage) {
        self.page = page
    }

    /// Removes the handler and forgets Studio's navigation. Call when the
    /// page closes or the server changes.
    func uninstall() {
        controller?.removeScriptMessageHandler(forName: Self.handlerName, contentWorld: .page)
        controller = nil
        page = nil
        onSignedOut = nil
        onPresentationOpen = nil
        onPresentationMessage = nil
        reset()
        onStateChange = nil
    }

    func mainFrameNavigationStarted() {
        negotiatedSinceNavigationStarted = false
        // An alert belongs to the document that asked for it.
        alerts?.withdraw(from: self)
    }

    /// A new document replaced the old one.
    func mainFrameCommitted() {
        if !negotiatedSinceNavigationStarted { reset() }
    }

    private func reset() {
        alerts?.withdraw(from: self)
        isFrontendReady = false
        frontendCapabilities = .init()
        navigation.reset()
        finishSignOut(false)
        onStateChange?()
    }

    /// Asks Studio to sign out with its own logout and waits until Studio
    /// reports that it did. Returns false at once when the current Studio
    /// does not support the request, and false after `timeout`, for
    /// example when the server cannot be reached.
    public func requestSignOut(timeout: Duration = .seconds(5)) async -> Bool {
        guard context == .main, isFrontendReady, frontendCapabilities.authLifecycle else { return false }
        let id = UUID()
        return await withCheckedContinuation { continuation in
            signOutWaiters[id] = continuation
            // Holds the bridge until this waiter resolves, so a send
            // failure or timeout here never resolves another caller.
            signOutTimeouts[id] = Task { @MainActor in
                if await !self.send(NativeBridgeProtocol.signOutRequest()) {
                    self.resolveSignOut(id, false)
                    return
                }
                try? await Task.sleep(for: timeout)
                self.resolveSignOut(id, false)
            }
        }
    }

    /// Resolves one waiter and stops its timeout. Resolving twice, or
    /// after finishSignOut, does nothing.
    private func resolveSignOut(_ id: UUID, _ signedOut: Bool) {
        guard let waiter = signOutWaiters.removeValue(forKey: id) else { return }
        signOutTimeouts.removeValue(forKey: id)?.cancel()
        waiter.resume(returning: signedOut)
    }

    private func finishSignOut(_ signedOut: Bool) {
        let waiters = signOutWaiters
        signOutWaiters.removeAll()
        let timeouts = signOutTimeouts
        signOutTimeouts.removeAll()
        for task in timeouts.values { task.cancel() }
        for waiter in waiters.values { waiter.resume(returning: signedOut) }
    }

    /// Answers one message from the page. Public for tests; WebKit calls it
    /// through the registered handler.
    public func reply(to body: Any?, from sender: BridgeSender) -> Any {
        replyValue(to: body, from: sender).foundation
    }

    func replyValue(to body: Any?, from sender: BridgeSender) -> JSONValue {
        guard sender.isMainFrame, sender.isPageWorld, sender.origin == origin else {
            return NativeBridgeProtocol.reply(id: nil, error: .forbidden)
        }
        switch NativeBridgeProtocol.decode(body) {
        case .unsupportedVersion:
            return NativeBridgeProtocol.reply(id: nil, error: .unsupportedVersion)
        case .unknownType(_, let id):
            return NativeBridgeProtocol.reply(id: id, error: .unknownType)
        case .malformed(let type, let id):
            // Studio falls back to its own sidebar when its catalog is
            // refused, so the app must stop showing the old one too.
            if type == "navigation/catalog", context == .main {
                navigation.apply(NavigationCatalog(groups: []))
                onStateChange?()
            }
            return NativeBridgeProtocol.reply(id: id, error: .malformed)
        case .accept(let message, let id):
            // Each page may send only its own context's messages: the
            // presentation page never publishes navigation or owns the auth
            // lifecycle, and the main page never drives a presentation.
            if let required = message.context, required != context {
                return NativeBridgeProtocol.reply(id: id, error: .forbidden)
            }
            switch message {
            case .configGet:
                negotiatedSinceNavigationStarted = true
                return NativeBridgeProtocol.reply(id: id, payload: NativeBridgeProtocol.configPayload(context: context))
            case .frontendReady(let capabilities):
                isFrontendReady = true
                frontendCapabilities = capabilities
                onStateChange?()
            case .authSignedOut:
                finishSignOut(true)
                onSignedOut?()
            case .navigationCatalog(let catalog):
                navigation.apply(catalog)
                onStateChange?()
            case .navigationState(let state):
                navigation.apply(state)
            case .navigationChrome(let chrome):
                navigation.apply(chrome)
            case .presentationOpen(let presentation):
                guard isFrontendReady, frontendCapabilities.nativePresentations,
                      onPresentationOpen?(presentation) == true else {
                    return NativeBridgeProtocol.reply(id: id, error: .unavailable)
                }
            case .alertPresent(let alert):
                guard isFrontendReady, frontendCapabilities.nativeAlerts,
                      alerts?.present(alert, from: self) == true else {
                    return NativeBridgeProtocol.reply(id: id, error: .unavailable)
                }
            case .alertCancel(let alertID):
                alerts?.withdraw(alertID: alertID, from: self)
            case .presentationReady:
                onPresentationMessage?(.ready)
            case .presentationUpdate(let update):
                onPresentationMessage?(.update(update))
            case .presentationClose(let presentationID):
                onPresentationMessage?(.close(presentationID: presentationID))
            case .presentationNavigate(let presentationID, let path):
                onPresentationMessage?(.navigate(presentationID: presentationID, path: path))
            }
            return NativeBridgeProtocol.reply(id: id, payload: [:])
        }
    }

    /// Delivers a message to Studio's receiver. Returns whether Studio
    /// accepted it.
    @discardableResult
    func send(_ message: JSONValue) async -> Bool {
        guard isFrontendReady, let page else { return false }
        do {
            let result = try await page.callJavaScript(Self.receiverScript, arguments: ["message": message.foundation])
            return (result as? Bool) ?? false
        } catch {
            return false
        }
    }
}

/// The one script message handler. It resolves the sender and hands the
/// message to the bridge, which it references weakly.
final class StudioBridgeMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    private weak var bridge: StudioBridge?

    @MainActor init(bridge: StudioBridge) {
        self.bridge = bridge
    }

    @MainActor
    func userContentController(
        _ userContentController: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor @Sendable (Any?, String?) -> Void
    ) {
        guard let bridge else {
            replyHandler(NativeBridgeProtocol.reply(id: nil, error: .unavailable).foundation, nil)
            return
        }
        let frame = message.frameInfo
        let origin = frame.securityOrigin
        let sender = BridgeSender(
            isMainFrame: frame.isMainFrame,
            isPageWorld: message.world == .page,
            origin: WebOrigin(scheme: origin.protocol, host: origin.host, port: origin.port)
        )
        replyHandler(bridge.reply(to: message.body, from: sender), nil)
    }
}
