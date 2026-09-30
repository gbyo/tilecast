import Foundation
import Observation

/// Native presentations for one main Studio page.
///
/// Studio owns the content; the app owns the presentation. The main page
/// asks for a presentation with `presentation/open`. The coordinator shows
/// it in the one cached `PresentationPage` and publishes `presentation`,
/// which the app target presents as a native sheet whose chrome comes only
/// from Studio's descriptor. Nothing here knows what a presentation shows.
///
/// Booting a second Studio frontend is the expensive part, so:
/// - the page is prewarmed as soon as signed-in Studio that supports
///   presentations is running in the main page;
/// - it is reused: each presentation changes its route through the bridge,
///   and the presentation id gives each one fresh content and chrome;
/// - it is the first thing given up under memory pressure, and only while
///   no sheet shows it.
///
/// It lives and dies with its main page, so a presentation page from one
/// server can never serve another. Sign-out discards it too.
@MainActor
@Observable
public final class PresentationCoordinator {
    public enum ContentState: Equatable, Sendable {
        /// The page is booting, or has not shown this presentation yet.
        case loading
        case ready
        case failed(PresentationFailure)
    }

    /// The presentation on screen, or nil. Its chrome starts from the
    /// request alone, so nothing from an earlier presentation carries over.
    public private(set) var presentation: NativePresentation?
    public private(set) var contentState: ContentState = .loading
    /// The one cached presentation page, when one exists.
    public private(set) var page: PresentationPage?
    /// Events for the sheet, delivered in order.
    public private(set) var pendingEvents: [StudioPageEvent] = []

    @ObservationIgnored var makePage: @MainActor () -> PresentationPage
    /// How many pages this coordinator built.
    @ObservationIgnored private(set) var pagesBuilt = 0
    @ObservationIgnored private weak var mainBridge: StudioBridge?
    @ObservationIgnored private var isClosed = false

    /// Where a presentation page's alerts show.
    @ObservationIgnored public let alerts: NativeAlertCenter

    init(mainBridge: StudioBridge, alerts: NativeAlertCenter, makePage: @escaping @MainActor () -> PresentationPage) {
        self.mainBridge = mainBridge
        self.alerts = alerts
        self.makePage = makePage
        mainBridge.onPresentationOpen = { [weak self] request in self?.open(request) ?? false }
        mainBridge.onStateChange = { [weak self] in self?.mainStudioChanged() }
    }

    /// The main page's Studio negotiated presentations.
    private var mainStudioSupportsPresentations: Bool {
        guard !isClosed, let mainBridge else { return false }
        return mainBridge.isFrontendReady && mainBridge.frontendCapabilities.nativePresentations
    }

    /// Studio publishes navigation only from its signed-in chrome, so a
    /// catalog means the session is healthy.
    private var canPrewarm: Bool {
        mainStudioSupportsPresentations && mainBridge?.navigation.isAvailable == true
    }

    private func mainStudioChanged() {
        if canPrewarm {
            prewarm()
        } else if presentation == nil {
            // Signed out, a new document, or an older Studio.
            discardPage()
        }
    }

    /// Boots the presentation page before anything asks for it.
    public func prewarm() {
        guard canPrewarm, page == nil else { return }
        buildPage()
    }

    @discardableResult
    private func buildPage() -> PresentationPage {
        let page = makePage()
        page.bridge.alerts = alerts
        pagesBuilt += 1
        page.onEvent = { [weak self, weak page] event in
            guard let self, let page else { return }
            self.handle(event, from: page)
        }
        self.page = page
        page.start()
        return page
    }

    /// Accepts a presentation when Studio in the main page supports them and
    /// none is showing. Studio shows its own dialog when this refuses.
    func open(_ request: NativePresentation) -> Bool {
        guard mainStudioSupportsPresentations, presentation == nil,
              PresentationPaths.isPresentationPath(request.path) else { return false }
        presentation = request
        contentState = .loading
        pendingEvents.removeAll()
        let page: PresentationPage
        if let existing = self.page, !existing.isFailed {
            page = existing
        } else {
            discardPage()
            page = buildPage()
        }
        // A booting page shows the request when it reports ready.
        if page.phase == .ready { show(request, in: page) }
        return true
    }

    private func show(_ request: NativePresentation, in page: PresentationPage) {
        Task { [weak self] in
            let accepted = await page.bridge.send(
                NativeBridgeProtocol.presentationShow(presentationID: request.id, path: request.path)
            )
            guard let self, self.presentation?.id == request.id, page === self.page else { return }
            self.contentState = accepted ? .ready : .failed(.refused)
        }
    }

    private func handle(_ event: PresentationPageEvent, from page: PresentationPage) {
        guard page === self.page else { return }
        switch event {
        case .message(.ready):
            // The first ready of a booting page, or a new document after
            // Studio reloaded itself: either way it shows nothing yet.
            if let presentation { show(presentation, in: page) }
        case .message(.update(let update)):
            // A late update from an earlier presentation changes nothing.
            guard var current = presentation, current.id == update.presentationID else { return }
            if let header = update.header { current.header = header }
            if let size = update.size { current.size = size }
            if let isDismissible = update.isDismissible { current.isDismissible = isDismissible }
            presentation = current
        case .message(.close(let id)):
            guard presentation?.id == id else { return }
            end()
        case .message(.navigate(let id, let path)):
            guard presentation?.id == id, PresentationPaths.isStudioPath(path) else { return }
            end()
            relayNavigation(to: path)
        case .pageEvent(let pageEvent):
            if presentation != nil { pendingEvents.append(pageEvent) }
        case .failed:
            guard case .failed(let failure) = page.phase else { return }
            if presentation == nil { discardPage() } else { contentState = .failed(failure) }
        case .contentProcessTerminated:
            // A hidden page is simply rebuilt next time. A visible one
            // shows an error; the main Studio page is not affected.
            if presentation == nil { discardPage() } else { contentState = .failed(.contentProcessEnded) }
        }
    }

    /// The main page's router performs the navigation, so unsaved-change
    /// blockers apply. The app never loads a URL in the main page for it.
    private func relayNavigation(to path: String) {
        guard let mainBridge, mainStudioSupportsPresentations else { return }
        Task { await mainBridge.send(NativeBridgeProtocol.openPath(path)) }
    }

    private func relayEnded(_ presentationID: String) {
        guard let mainBridge, mainStudioSupportsPresentations else { return }
        Task { await mainBridge.send(NativeBridgeProtocol.presentationEnded(presentationID: presentationID)) }
    }

    /// The user chose a header action. The id is Studio's own.
    public func perform(actionID: String) {
        guard let presentation, let page, page.phase == .ready, contentState == .ready else { return }
        Task {
            await page.bridge.send(NativeBridgeProtocol.presentationAction(presentationID: presentation.id, actionID: actionID))
        }
    }

    /// The sheet went away, however it was dismissed. Pass the id the sheet
    /// showed, so a late dismissal cannot end a newer presentation.
    public func dismiss(presentationID: String? = nil) {
        guard presentationID == nil || presentationID == presentation?.id else { return }
        end()
    }

    private func end() {
        guard let ended = presentation else { return }
        // contentState stays until the next open resets it, so the sheet
        // does not change its content while it animates away.
        presentation = nil
        pendingEvents.removeAll()
        // The presentation had its own query cache, so whatever it saved is
        // stale in the main page until Studio refetches. This is generic: the
        // app never knows what a presentation changed.
        relayEnded(ended.id)
        // An alert the presentation asked for goes with it.
        alerts.withdraw(context: .presentation)
        guard let page else { return }
        if page.phase == .ready {
            // Transient work in the page, such as a stream lease, ends now.
            Task { await page.bridge.send(NativeBridgeProtocol.presentationDismissed(presentationID: ended.id)) }
        } else if page.isFailed {
            discardPage()
        }
    }

    /// Rebuilds the page after a failure. The main page is untouched.
    public func retry() {
        guard let presentation else { return }
        discardPage()
        contentState = .loading
        let page = buildPage()
        if page.phase == .ready { show(presentation, in: page) }
    }

    /// Gives up the cached page to free memory, unless a sheet shows it.
    public func handleMemoryWarning() {
        guard presentation == nil else { return }
        discardPage()
    }

    /// Ends any presentation and discards the page: sign-out, a new
    /// sign-in, or a closing main page.
    public func discard() {
        presentation = nil
        contentState = .loading
        pendingEvents.removeAll()
        discardPage()
    }

    func close() {
        isClosed = true
        discard()
    }

    public func takeEvents() -> [StudioPageEvent] {
        defer { pendingEvents.removeAll() }
        return pendingEvents
    }

    private func discardPage() {
        page?.close()
        page = nil
    }
}

extension PresentationPage {
    var isFailed: Bool {
        if case .failed = phase { true } else { false }
    }
}
