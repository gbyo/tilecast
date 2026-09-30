import Foundation
import Observation
import WebKit

/// Why the presentation page cannot show a presentation.
public enum PresentationFailure: Equatable, Sendable {
    case unreachable
    case untrustedCertificate
    /// The web content process ended while a presentation was on screen.
    case contentProcessEnded
    /// The page loaded, but its Studio never reported that it could show
    /// presentations, for example because its session ended.
    case unavailable
    /// Studio refused the presentation route.
    case refused
    case other(domain: String, code: Int)
}

/// The one reusable Studio page that renders native presentations for the
/// active server.
///
/// It is a second Studio frontend, so booting it costs about as much as
/// booting Studio. It loads the empty presentation root once, and each
/// presentation then changes its route through the bridge; it is never
/// loaded again for a route.
///
/// It shares the server's persistent data store, so it has the same Studio
/// session cookie as the main page. Its configuration is its own, as is its
/// bridge, which has the presentation context: it cannot publish
/// navigation, follow the auth lifecycle, or open presentations, and it
/// never sees a native credential. It uses the main page's navigation
/// policy, so its main frame shows only the server's origin.
@MainActor
@Observable
public final class PresentationPage {
    public enum Phase: Equatable, Sendable {
        case booting
        /// Studio in this page is signed in and receives presentations.
        case ready
        case failed(PresentationFailure)
    }

    public let webPage: WebPage
    public let websiteDataStore: WKWebsiteDataStore
    public let bridge: StudioBridge
    public private(set) var phase: Phase = .booting
    public private(set) var isClosed = false

    /// How long Studio may take to report ready after the page loaded.
    @ObservationIgnored var readyTimeout: Duration = .seconds(20)
    /// Loads a URL. Tests replace it to load a fixture.
    @ObservationIgnored var loader: @MainActor (WebPage, URL) -> Void = { page, url in page.load(url) }
    /// Lifecycle and policy events for the owner.
    @ObservationIgnored var onEvent: (@MainActor (PresentationPageEvent) -> Void)?

    @ObservationIgnored private let rootURL: URL?
    @ObservationIgnored private var monitor: Task<Void, Never>?
    @ObservationIgnored private var readyDeadline: Task<Void, Never>?

    public init(
        address: ServerAddress,
        dataStore: WKWebsiteDataStore,
        applicationName: String,
        policy: StudioNavigationPolicy,
        system: SystemIntegrationHandlers = SystemIntegrationHandlers()
    ) {
        websiteDataStore = dataStore
        rootURL = address.url(forPath: PresentationPaths.root)
        let bridge = StudioBridge(origin: address.origin, context: .presentation)
        // A new configuration, never the main or the auxiliary page's: its
        // user content controller holds only this page's bridge.
        var configuration = StudioPage.configuration(dataStore: dataStore, applicationName: applicationName)
        bridge.install(into: &configuration)
        let sink = StudioNavigationSink()
        self.bridge = bridge
        webPage = WebPage(
            configuration: configuration,
            navigationDecider: StudioNavigationDecider(policy: policy, sink: sink),
            dialogPresenter: StudioDialogPresenter(origin: address.origin, system: system)
        )
        bridge.attach(to: webPage)
        sink.handler = { [weak self] in self?.handle($0) }
        bridge.onPresentationMessage = { [weak self] message in self?.receive(message) }
        system.install(on: bridge)
    }

    /// Loads the presentation root. A `WebPage` loads without a view, so
    /// this can run before any sheet exists.
    func start() {
        guard monitor == nil, !isClosed, let rootURL else { return }
        monitor = Task { [weak self] in await self?.watchNavigations() }
        loader(webPage, rootURL)
    }

    /// Stops the page and releases its bridge.
    func close() {
        isClosed = true
        monitor?.cancel()
        monitor = nil
        readyDeadline?.cancel()
        readyDeadline = nil
        onEvent = nil
        webPage.stopLoading()
        bridge.uninstall()
    }

    private func receive(_ message: PresentationPageMessage) {
        if message == .ready {
            readyDeadline?.cancel()
            phase = .ready
        }
        onEvent?(.message(message))
    }

    private func handle(_ decision: StudioNavigationDecision) {
        switch decision {
        case .allow, .cancel:
            break
        case .signIn:
            // The main page owns sign-in. Here it means the session ended.
            fail(.unavailable)
        case .openExternally(let url):
            onEvent?(.pageEvent(.openExternally(url)))
        case .openAuxiliary:
            // Presentations do not stack pages; see docs/ios-app.md.
            break
        case .unsupportedDownload:
            onEvent?(.pageEvent(.unsupportedDownload))
        }
    }

    private func fail(_ failure: PresentationFailure) {
        readyDeadline?.cancel()
        phase = .failed(failure)
        onEvent?(.failed)
    }

    private func watchNavigations() async {
        while !Task.isCancelled {
            do {
                // Readiness comes only from the bridge. Navigation events
                // arrive asynchronously, so they may trail the page's own
                // presentation/ready and must not reset it.
                for try await event in webPage.navigations where event == .finished {
                    if phase == .booting { armReadyDeadline() }
                }
                return
            } catch {
                if Task.isCancelled { return }
                handle(navigationError: error)
            }
        }
    }

    private func armReadyDeadline() {
        readyDeadline?.cancel()
        readyDeadline = Task { [weak self, readyTimeout] in
            try? await Task.sleep(for: readyTimeout)
            guard !Task.isCancelled, let self, self.phase == .booting else { return }
            self.fail(.unavailable)
        }
    }

    func handle(navigationError error: any Error) {
        guard let navigationError = error as? WebPage.NavigationError else {
            fail(.other(domain: (error as NSError).domain, code: (error as NSError).code))
            return
        }
        switch navigationError {
        case .webContentProcessTerminated:
            readyDeadline?.cancel()
            phase = .failed(.contentProcessEnded)
            onEvent?(.contentProcessTerminated)
        case .failedProvisionalNavigation(let underlying):
            guard let failure = StudioPage.failure(for: underlying) else { return }
            switch failure {
            case .unreachable: fail(.unreachable)
            case .untrustedCertificate: fail(.untrustedCertificate)
            case .contentProcessEnded: fail(.contentProcessEnded)
            case .other(let domain, let code): fail(.other(domain: domain, code: code))
            }
        case .pageClosed:
            break
        case .invalidURL:
            fail(.other(domain: "WebPage", code: 0))
        @unknown default:
            fail(.other(domain: "WebPage", code: -1))
        }
    }
}

enum PresentationPageEvent: Equatable {
    case message(PresentationPageMessage)
    /// Something the host UI carries out, such as opening a link in the
    /// system browser.
    case pageEvent(StudioPageEvent)
    case failed
    case contentProcessTerminated
}
