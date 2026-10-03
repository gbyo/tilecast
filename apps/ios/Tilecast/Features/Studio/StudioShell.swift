import SwiftUI
import TilecastCore

/// Native chrome around the single main Studio page.
///
/// When Studio has sent a navigation catalog, the app shows native
/// navigation (tabs, or an iPad sidebar) and Studio hides its own sidebar.
/// Otherwise, for example on the sign-in page, with an older Studio, or
/// after a bridge failure, the app keeps its fallback chrome: a server
/// switcher above the page, with Studio's own navigation inside it.
struct StudioShell: View {
    @Environment(StudioHost.self) private var host
    @State private var managingServers = false
    @State private var addingServer = false
    @State private var slot = StudioSlot()
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass

    private var actions: ServerActions {
        ServerActions(add: { addingServer = true }, manage: { managingServers = true })
    }

    var body: some View {
        // The one web view is a sibling of the shell, never a child of a
        // layout, so changing the order does not rebuild it. It is above the
        // shell in every layout but the tabs. In the tabs it is behind a
        // transparent tab container, so the floating tab bar shows the page
        // through its glass instead of being covered by it.
        ZStack {
            shell.zIndex(webViewBehindTabs ? 1 : 0)
            StudioOverlay().zIndex(webViewBehindTabs ? 0 : 1)
        }
        .environment(slot)
        .mediaIntake(host.mediaIntake)
        .nativeAlert(from: host.page?.alerts, for: .main)
        .sheet(isPresented: $managingServers) { ServerListView() }
        .sheet(isPresented: $addingServer) { AddServerView(directory: host.directory) }
        .sheet(item: presentation) { presentation in
            if let coordinator = host.page?.presentations {
                PresentationSheet(coordinator: coordinator, presentation: presentation)
            }
        }
        // The cached presentation page is a whole second Studio: the first
        // thing to give up when memory is short. It survives while shown.
        .onReceive(NotificationCenter.default.publisher(for: UIApplication.didReceiveMemoryWarningNotification)) { _ in
            host.page?.presentations.handleMemoryWarning()
        }
    }

    private var shell: some View {
        ZStack {
            if let page = host.page, page.bridge.navigation.isAvailable {
                NativeNavigationShell(page: page, actions: actions)
                    .id(ObjectIdentifier(page))
            } else {
                fallbackShell
            }
        }
    }

    /// True while native tabs show Studio.
    private var webViewBehindTabs: Bool {
        host.page?.bridge.navigation.isAvailable == true
            && NativeNavigationShell.usesTabs(horizontalSizeClass: horizontalSizeClass)
    }

    /// The native presentation Studio asked for. Dismissing the sheet in
    /// any way ends it.
    private var presentation: Binding<NativePresentation?> {
        Binding(
            get: { host.page?.presentations.presentation },
            set: { if $0 == nil { host.page?.presentations.dismiss() } }
        )
    }

    private var fallbackShell: some View {
        NavigationStack {
            content
                .navigationTitle(host.directory.activeServer?.displayName ?? String(localized: "Tilecast"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbarTitleMenu { ServerMenuItems(actions: actions) }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { moreMenu }
                }
        }
    }

    @ViewBuilder private var content: some View {
        switch host.connection {
        case .noServer:
            ContentUnavailableView {
                Label("Choose a Server", systemImage: "server.rack")
                    .font(.geist(.title2).weight(.bold))
            }
        case .starting:
            TilecastLoadingMark()
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .verifying(let server):
            VStack(spacing: 16) {
                TilecastLoadingMark().accessibilityHidden(true)
                Text("Connecting to \(server.displayName)…")
                    .font(.geist(.body))
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("studio.connecting")
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable(let server, let error):
            ServerUnavailableView(server: server, error: error)
        case .identityChanged(let server, let found):
            IdentityChangedView(server: server, found: found)
        case .connected:
            StudioSlotView()
                .ignoresSafeArea(edges: .bottom)
        }
    }

    private var moreMenu: some View {
        Menu {
            if let page = host.page {
                Button { page.reload() } label: { Label("Reload", image: AppIcon.reload) }
                SignOutButton(page: page)
            }
            Button { managingServers = true } label: { Label("Manage Servers…", image: AppIcon.manage) }
        } label: {
            Label("More", systemImage: "ellipsis")
        }
        .accessibilityIdentifier("studio.more")
    }
}

/// The identity check failed, so Studio was not loaded.
struct ServerUnavailableView: View {
    @Environment(StudioHost.self) private var host
    @Environment(\.openURL) private var openURL
    let server: ServerProfile
    let error: InstallationIdentityError

    var body: some View {
        ContentUnavailableView {
            Label(error.title, systemImage: error.systemImage)
                .font(.geist(.title2).weight(.bold))
        } description: {
            VStack(spacing: 8) {
                Text(error.message(for: server.address))
                    .font(.geist(.body))
                Text(server.address.displayString)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.secondary)
            }
        } actions: {
            Button("Try Again") { Task { await host.retry() } }
                .buttonStyle(.borderedProminent)
            if error == .unreachable, server.address.isLocalNetwork {
                Button("Open Settings") {
                    if let url = URL(string: UIApplication.openSettingsURLString) { openURL(url) }
                }
            }
        }
    }
}

/// A different installation now answers at this server's address.
struct IdentityChangedView: View {
    @Environment(StudioHost.self) private var host
    let server: ServerProfile
    let found: InstallationIdentity
    @State private var confirmingTrust = false
    @State private var confirmingRemoval = false

    var body: some View {
        ContentUnavailableView {
            Label("Different Tilecast Server", systemImage: "exclamationmark.shield")
                .font(.geist(.title2).weight(.bold))
        } description: {
            Text("\(server.address.displayString) now belongs to a different Tilecast installation (\(found.organizationName)). Tilecast didn’t open it, so your sign-in for \(server.displayName) wasn’t sent to it.")
                .font(.geist(.body))
        } actions: {
            Button("Use New Server…") { confirmingTrust = true }
                .buttonStyle(.borderedProminent)
            Button("Remove Server…", role: .destructive) { confirmingRemoval = true }
        }
        .confirmationDialog("Use the new server at this address?", isPresented: $confirmingTrust, titleVisibility: .visible) {
            Button("Use New Server") {
                Task { try? await host.trustNewInstallation(server.id, identity: found) }
            }
        } message: {
            Text("Website data for \(server.displayName) on this device, including your sign-in, is deleted. Continue only if the server was reinstalled or restored intentionally.")
        }
        .confirmationDialog("Remove \(server.displayName)?", isPresented: $confirmingRemoval, titleVisibility: .visible) {
            Button("Remove Server", role: .destructive) { Task { await host.remove(server.id) } }
        } message: {
            Text("Its website data on this device, including your sign-in, is deleted.")
        }
    }
}
