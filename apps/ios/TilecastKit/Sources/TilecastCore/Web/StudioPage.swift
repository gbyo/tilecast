import Foundation
import Observation
import WebKit

/// Why a Studio page could not be shown.
public enum StudioLoadFailure: Equatable, Sendable {
    case unreachable
    case untrustedCertificate
    /// The web content process ended repeatedly; reloading did not help.
    case contentProcessEnded
    case other(domain: String, code: Int)
}

/// Side effects the navigation policy asks the host UI to perform.
public enum StudioPageEvent: Equatable, Sendable {
    case signIn
    case openExternally(URL)
    case unsupportedDownload
}

/// Receives policy decisions that need UI. A page is created before its
/// owner finishes initializing, so the decider reaches the owner through
/// this box, which the owner fills with a weak reference to itself.
@MainActor
final class StudioNavigationSink {
    var handler: (@MainActor (StudioNavigationDecision) -> Void)?

    func handle(_ decision: StudioNavigationDecision) {
        handler?(decision)
    }
}

/// Adapts `StudioNavigationPolicy` to WebKit. Decisions that need UI are
/// forwarded to the owning page.
struct StudioNavigationDecider: WebPage.NavigationDeciding {
    let policy: StudioNavigationPolicy
    let sink: StudioNavigationSink

    mutating func decidePolicy(
        for action: WebPage.NavigationAction,
        preferences: inout WebPage.NavigationPreferences
    ) async -> WKNavigationActionPolicy {
        let decision = policy.decide(
            url: action.request.url,
            isMainFrame: action.target?.isMainFrame ?? true,
            opensNewWindow: action.target == nil,
            shouldDownload: action.shouldPerformDownload
        )
        if decision == .allow { return .allow }
        sink.handle(decision)
        return .cancel
    }

    mutating func decidePolicy(for response: WebPage.NavigationResponse) async -> WKNavigationResponsePolicy {
        let decision = policy.decide(response: response.response, canShowMIMEType: response.canShowMimeType)
        if decision == .allow { return .allow }
        sink.handle(decision)
        return .cancel
    }
}

/// One Studio `WebPage` bound to one server's origin and data store.
///
/// The app keeps exactly one main `StudioPage` for the active server; Studio
/// owns routing inside it. Native code loads a URL only to boot the page or
/// to recover it after a failure, never for routine route changes: native
/// navigation sends a request through `bridge`, and React Router decides.
@MainActor
@Observable
public final class StudioPage {
    public enum Phase: Equatable, Sendable {
        case loading
        case ready
        case failed(StudioLoadFailure)
    }

    public let serverID: UUID
    public let address: ServerAddress
    public let webPage: WebPage
    public let websiteDataStore: WKWebsiteDataStore
    /// The main page's native bridge. The presentation page has a bridge
    /// of its own; the auxiliary page has none.
    public let bridge: StudioBridge
    /// Native presentations of Studio routes, with the one reusable
    /// presentation page they share.
    public let presentations: PresentationCoordinator
    public private(set) var phase: Phase = .loading
    public private(set) var signInRequired = false
    public private(set) var isClosed = false
    /// A same-origin page Studio asked to open in a new window. At most one
    /// exists; it shares this server's data store and navigation policy.
    public private(set) var auxiliaryPage: WebPage?
    /// Events for the host UI, delivered in order.
    public private(set) var pendingEvents: [StudioPageEvent] = []

    @ObservationIgnored private var monitor: Task<Void, Never>?
    @ObservationIgnored private var recentTerminations: [Date] = []
    @ObservationIgnored private let initialURL: URL
    @ObservationIgnored private let applicationName: String
    @ObservationIgnored private let policy: StudioNavigationPolicy

    /// Builds the page for `profile` using its isolated data store.
    public init(profile: ServerProfile, dataStore: WKWebsiteDataStore, applicationName: String) {
        serverID = profile.id
        address = profile.address
        websiteDataStore = dataStore
        let restored = profile.lastStudioPath.flatMap { profile.address.url(forPath: $0) }
        initialURL = restored?.path == "/login" ? profile.address.url : (restored ?? profile.address.url)

        let bridge = StudioBridge(origin: profile.address.origin)
        var configuration = Self.configuration(dataStore: dataStore, applicationName: applicationName)
        bridge.install(into: &configuration)

        let policy = StudioNavigationPolicy(origin: profile.address.origin)
        let sink = StudioNavigationSink()
        self.applicationName = applicationName
        self.policy = policy
        self.bridge = bridge
        webPage = WebPage(
            configuration: configuration,
            navigationDecider: StudioNavigationDecider(policy: policy, sink: sink)
        )
        let address = profile.address
        presentations = PresentationCoordinator(mainBridge: bridge) {
            PresentationPage(address: address, dataStore: dataStore, applicationName: applicationName, policy: policy)
        }
        bridge.attach(to: webPage)
        sink.handler = { [weak self] in self?.handle($0) }
    }

    /// Settings every page for this server shares. Each call returns a new
    /// configuration with its own user content controller, so a page built
    /// from it has no bridge unless one is installed.
    static func configuration(dataStore: WKWebsiteDataStore, applicationName: String) -> WebPage.Configuration {
        var configuration = WebPage.Configuration()
        configuration.websiteDataStore = dataStore
        // Informational only (server logs and session lists). Studio detects
        // native features through bridge capabilities, never the user agent.
        configuration.applicationNameForUserAgent = applicationName
        #if os(iOS)
        // Studio previews play video inside the page, like Safari.
        configuration.mediaPlaybackBehavior = .allowsInlinePlayback
        #endif
        return configuration
    }

    /// Loads Studio and starts watching navigation results.
    public func start() {
        guard monitor == nil else { return }
        monitor = Task { [weak self] in await self?.watchNavigations() }
        webPage.load(initialURL)
    }

    /// Retries after a failure, or reloads the current Studio page.
    public func reload() {
        phase = .loading
        if currentStudioPath != nil {
            webPage.reload()
        } else {
            webPage.load(initialURL)
        }
    }

    public func resumeAfterSignIn() {
        presentations.discard()
        signInRequired = false
        phase = .loading
        webPage.load(initialURL)
    }

    /// React Router can reach /login with history.pushState, which does not
    /// create a WebKit navigation action for the decider to intercept.
    public func requireSignInIfNeeded(at url: URL?) {
        guard let url, WebOrigin(url) == address.origin, url.path == "/login", !signInRequired else { return }
        signInRequired = true
        presentations.discard()
        pendingEvents.append(.signIn)
    }

    /// Stops loading and releases WebKit work. Call before the data store is
    /// deleted or when the server stops being active.
    public func close() {
        isClosed = true
        monitor?.cancel()
        monitor = nil
        webPage.stopLoading()
        closeAuxiliaryPage()
        presentations.close()
        bridge.uninstall()
    }

    public func closeAuxiliaryPage() {
        auxiliaryPage?.stopLoading()
        auxiliaryPage = nil
    }

    /// The current same-origin path with query, for state restoration.
    public var currentStudioPath: String? {
        guard let url = webPage.url, WebOrigin(url) == address.origin else { return nil }
        guard let components = URLComponents(url: url, resolvingAgainstBaseURL: false) else { return nil }
        let path = components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath
        return components.percentEncodedQuery.map { "\(path)?\($0)" } ?? path
    }

    public func takeEvents() -> [StudioPageEvent] {
        defer { pendingEvents.removeAll() }
        return pendingEvents
    }

    func handle(_ decision: StudioNavigationDecision) {
        switch decision {
        case .allow, .cancel: break
        case .signIn:
            signInRequired = true
            presentations.discard()
            pendingEvents.append(.signIn)
        case .openExternally(let url): pendingEvents.append(.openExternally(url))
        case .openAuxiliary(let url): openAuxiliaryPage(url)
        case .unsupportedDownload: pendingEvents.append(.unsupportedDownload)
        }
    }

    /// A new-window request from the auxiliary page itself loads in place,
    /// so there is never more than one auxiliary page.
    private func openAuxiliaryPage(_ url: URL) {
        if let auxiliaryPage {
            auxiliaryPage.load(url)
            return
        }
        // Same data store and policy, but a configuration of its own: the
        // privileged bridge belongs to the main page only.
        let sink = StudioNavigationSink()
        let page = WebPage(
            configuration: Self.configuration(dataStore: websiteDataStore, applicationName: applicationName),
            navigationDecider: StudioNavigationDecider(policy: policy, sink: sink)
        )
        sink.handler = { [weak self] in self?.handle($0) }
        auxiliaryPage = page
        page.load(url)
    }

    private func watchNavigations() async {
        while !Task.isCancelled {
            do {
                for try await event in webPage.navigations {
                    switch event {
                    case .startedProvisionalNavigation:
                        bridge.mainFrameNavigationStarted()
                    case .committed:
                        bridge.mainFrameCommitted()
                        phase = .ready
                    case .finished:
                        phase = .ready
                    default:
                        break
                    }
                }
                return
            } catch {
                if Task.isCancelled { return }
                handle(navigationError: error)
            }
        }
    }

    func handle(navigationError error: any Error) {
        guard let navigationError = error as? WebPage.NavigationError else {
            phase = .failed(.other(domain: (error as NSError).domain, code: (error as NSError).code))
            return
        }
        switch navigationError {
        case .webContentProcessTerminated:
            // iOS may end a background page's content process. Reload once;
            // repeated terminations in a short window become a visible error.
            let now = Date.now
            recentTerminations = recentTerminations.filter { now.timeIntervalSince($0) < 30 } + [now]
            if recentTerminations.count > 2 {
                phase = .failed(.contentProcessEnded)
            } else {
                phase = .loading
                webPage.reload()
            }
        case .failedProvisionalNavigation(let underlying):
            if let failure = Self.failure(for: underlying) { phase = .failed(failure) }
        case .pageClosed:
            break
        case .invalidURL:
            phase = .failed(.other(domain: "WebPage", code: 0))
        @unknown default:
            phase = .failed(.other(domain: "WebPage", code: -1))
        }
    }

    /// Maps a failed load to a failure, or nil for errors that only mean a
    /// navigation was superseded or refused by policy.
    static func failure(for error: any Error) -> StudioLoadFailure? {
        let error = error as NSError
        if error.domain == NSURLErrorDomain, error.code == NSURLErrorCancelled { return nil }
        // WebKitErrorFrameLoadInterruptedByPolicyChange: our own refusal.
        if error.domain == "WebKitErrorDomain", error.code == 102 { return nil }
        if error.domain == NSURLErrorDomain {
            switch error.code {
            case NSURLErrorServerCertificateUntrusted, NSURLErrorServerCertificateHasBadDate,
                 NSURLErrorServerCertificateNotYetValid, NSURLErrorServerCertificateHasUnknownRoot,
                 NSURLErrorSecureConnectionFailed, NSURLErrorClientCertificateRejected,
                 NSURLErrorClientCertificateRequired:
                return .untrustedCertificate
            case NSURLErrorNotConnectedToInternet, NSURLErrorCannotFindHost, NSURLErrorCannotConnectToHost,
                 NSURLErrorTimedOut, NSURLErrorNetworkConnectionLost, NSURLErrorDNSLookupFailed,
                 NSURLErrorInternationalRoamingOff, NSURLErrorDataNotAllowed:
                return .unreachable
            default:
                break
            }
        }
        return .other(domain: error.domain, code: error.code)
    }
}
