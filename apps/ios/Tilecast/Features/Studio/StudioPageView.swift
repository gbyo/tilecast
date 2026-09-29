import SwiftUI
import TilecastCore
import WebKit

/// Displays the main Studio page and carries out what its navigation policy
/// asks of the system.
struct StudioPageView: View {
    @Environment(StudioHost.self) private var host
    let page: StudioPage
    @Environment(\.openURL) private var openURL
    @State private var showingDownloadNotice = false

    var body: some View {
        WebView(page.webPage)
            // React Router owns history. Native history gestures stay off
            // until native navigation coordinates with it.
            .webViewBackForwardNavigationGestures(.disabled)
            // Link previews load pages outside the navigation policy.
            .webViewLinkPreviews(.disabled)
            .ignoresSafeArea(edges: .bottom)
            .overlay { phaseOverlay }
            .onChange(of: page.pendingEvents, initial: true) { perform(page.takeEvents()) }
            // Route changes are infrequent; saving each one means a killed
            // app still reopens where the user was.
            .onChange(of: page.webPage.url) { host.recordState() }
            .sheet(isPresented: auxiliaryPresented) {
                if let auxiliary = page.auxiliaryPage {
                    AuxiliaryPageView(page: auxiliary) { page.closeAuxiliaryPage() }
                }
            }
            .alert("Downloads Aren’t Available Yet", isPresented: $showingDownloadNotice) {
                Button("OK", role: .cancel) {}
            } message: {
                Text("To download this file, open Tilecast Studio in Safari.")
            }
    }

    @ViewBuilder private var phaseOverlay: some View {
        switch page.phase {
        case .ready:
            EmptyView()
        case .loading:
            ProgressView()
                .controlSize(.large)
                .frame(maxWidth: .infinity, maxHeight: .infinity)
                .background(.background)
        case .failed(let failure):
            ContentUnavailableView {
                Label(failure.title, systemImage: failure.systemImage)
            } description: {
                Text(failure.message)
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
            case .openExternally(let url): openURL(url)
            case .unsupportedDownload: showingDownloadNotice = true
            }
        }
    }
}

/// A same-origin page Studio opened in a new window, shown in a sheet so the
/// main Studio page keeps its state.
struct AuxiliaryPageView: View {
    let page: WebPage
    let close: () -> Void

    var body: some View {
        NavigationStack {
            WebView(page)
                .webViewLinkPreviews(.disabled)
                .ignoresSafeArea(edges: .bottom)
                .navigationTitle(page.title)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Done", action: close)
                    }
                }
        }
    }
}
