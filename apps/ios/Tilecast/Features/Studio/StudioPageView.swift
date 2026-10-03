import SwiftUI
import TilecastCore
import WebKit
import AuthenticationServices

/// Displays the main Studio page and carries out what its navigation policy
/// asks of the system. `StudioOverlay` creates the only instance; layouts
/// place it with `StudioSlotView`.
struct StudioPageView: View {
    @Environment(StudioHost.self) private var host
    let page: StudioPage
    @Environment(\.openURL) private var openURL
    @State private var showingDownloadNotice = false
    @State private var systemSignIn = SystemSignIn()
    @State private var signingIn = false
    @State private var signInFailed = false

    var body: some View {
        WebView(page.webPage)
            // React Router owns history, so native history gestures stay
            // off; native navigation goes through the bridge instead.
            .webViewBackForwardNavigationGestures(.disabled)
            // Link previews load pages outside the navigation policy.
            .webViewLinkPreviews(.disabled)
            .overlay { phaseOverlay }
            .overlay {
                if page.signInRequired {
                    ContentUnavailableView {
                        Label("Sign In to Tilecast", systemImage: "person.crop.circle")
                            .font(.geist(.title2).weight(.bold))
                    } description: {
                        Text("Sign in securely to \(page.address.host) using the system browser.")
                            .font(.geist(.body))
                    } actions: {
                        if signingIn {
                            ProgressView("Signing In…")
                                .accessibilityIdentifier("studio.signingIn")
                        } else {
                            Button("Sign In") { beginSignIn() }
                                .buttonStyle(.borderedProminent)
                                .accessibilityIdentifier("studio.signIn")
                        }
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
            .onChange(of: page.pendingEvents, initial: true) { perform(page.takeEvents()) }
            // Route changes are infrequent; saving each one means a killed
            // app still reopens where the user was.
            .onChange(of: page.webPage.url, initial: true) {
                host.recordState()
                page.requireSignInIfNeeded(at: page.webPage.url)
            }
            .onDisappear { systemSignIn.cancel() }
            .sheet(isPresented: auxiliaryPresented) {
                if let auxiliary = page.auxiliaryPage {
                    AuxiliaryPageView(owner: page, page: auxiliary)
                }
            }
            .alert("Downloads Aren’t Available Yet", isPresented: $showingDownloadNotice) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("To download this file, open Tilecast Studio in Safari.")
            }
            .alert("Couldn’t Sign In", isPresented: $signInFailed) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("Try signing in again.")
            }
    }

    @ViewBuilder private var phaseOverlay: some View {
        switch page.phase {
        case .ready:
            EmptyView()
        case .loading:
            TilecastLoadingMark()
                .accessibilityIdentifier("studio.loading")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
        case .failed(let failure):
            ContentUnavailableView {
                Label(failure.title, systemImage: failure.systemImage)
                    .font(.geist(.title2).weight(.bold))
            } description: {
                Text(failure.message)
                    .font(.geist(.body))
            } actions: {
                Button("Try Again") { page.reload() }
                    .buttonStyle(.borderedProminent)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .background(.background)
        }
    }

    private var auxiliaryPresented: Binding<Bool> {
        Binding(
            get: { page.auxiliaryPage != nil },
            set: { if !$0 { page.closeAuxiliaryPage() } }
        )
    }

    private func perform(_ events: [StudioPageEvent]) {
        for event in events {
            switch event {
            case .signIn: resumeSession()
            case .openExternally(let url): openURL(url)
            case .unsupportedDownload: showingDownloadNotice = true
            }
        }
    }

    /// Studio needs a session. The host renews it from the native credential
    /// when it can, and waits for the user after an explicit sign-out.
    private func resumeSession() {
        guard !signingIn else { return }
        signingIn = true
        Task {
            let step = await host.resumeSession(for: page)
            signingIn = false
            if step == .presentBrowser { beginSignIn() }
        }
    }

    private func beginSignIn() {
        guard !signingIn else { return }
        signingIn = true
        Task {
            defer { signingIn = false }
            do {
                try await systemSignIn.authenticate(page: page, host: host)
            } catch {
                let nsError = error as NSError
                let cancelled = nsError.domain == ASWebAuthenticationSessionError.errorDomain &&
                    nsError.code == ASWebAuthenticationSessionError.canceledLogin.rawValue
                if !cancelled && (error as? IOSSignInError) != .accessDenied {
                    signInFailed = true
                }
            }
        }
    }
}

/// A same-origin page Studio opened in a new window, shown in a sheet so the
/// main Studio page keeps its state.
struct AuxiliaryPageView: View {
    let owner: StudioPage
    let page: WebPage

    var body: some View {
        NavigationStack {
            ZStack {
                WebView(page)
                    .webViewLinkPreviews(.disabled)
                    .ignoresSafeArea(edges: .bottom)
                    .accessibilityHidden(owner.auxiliaryPhase != .ready)

                switch owner.auxiliaryPhase {
                case .ready:
                    EmptyView()
                case .loading:
                    TilecastLoadingMark()
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                        .background(.background)
                        .accessibilityIdentifier("auxiliary.loading")
                case .failed(let failure):
                    ContentUnavailableView {
                        Label(failure.title, systemImage: failure.systemImage)
                            .font(.geist(.title2).weight(.bold))
                    } description: {
                        Text(failure.message)
                            .font(.geist(.body))
                    } actions: {
                        Button("Try Again") { owner.retryAuxiliaryPage() }
                            .buttonStyle(.borderedProminent)
                            .accessibilityIdentifier("auxiliary.retry")
                    }
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
                    .background(.background)
                }
            }
            .navigationTitle(page.title.isEmpty ? String(localized: "Tilecast") : page.title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { owner.closeAuxiliaryPage() }
                }
            }
        }
    }
}
