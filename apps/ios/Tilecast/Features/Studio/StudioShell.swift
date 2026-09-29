import SwiftUI
import TilecastCore

/// Native chrome around the single main Studio page: the server switcher,
/// server management, and connection states. Studio renders everything
/// inside the page, including its own navigation, until the native
/// navigation bridge replaces the primary sidebar.
struct StudioShell: View {
    @Environment(StudioHost.self) private var host
    @State private var managingServers = false
    @State private var addingServer = false

    var body: some View {
        NavigationStack {
            content
                .navigationTitle(host.directory.activeServer?.displayName ?? String(localized: "Tilecast"))
                .navigationBarTitleDisplayMode(.inline)
                .toolbarTitleMenu { serverMenu }
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) { moreMenu }
                }
        }
        .sheet(isPresented: $managingServers) { ServerListView() }
        .sheet(isPresented: $addingServer) { AddServerView() }
    }

    @ViewBuilder private var content: some View {
        switch host.connection {
        case .noServer:
            ContentUnavailableView("Choose a Server", systemImage: "server.rack")
        case .verifying(let server):
            ProgressView("Connecting to \(server.displayName)…")
                .frame(maxWidth: .infinity, maxHeight: .infinity)
        case .unavailable(let server, let error):
            ServerUnavailableView(server: server, error: error)
        case .identityChanged(let server, let found):
            IdentityChangedView(server: server, found: found)
        case .connected(let page):
            StudioPageView(page: page)
                .id(ObjectIdentifier(page))
        }
    }

    @ViewBuilder private var serverMenu: some View {
        ForEach(host.directory.servers) { server in
            Button {
                Task { await host.activate(server.id) }
            } label: {
                if server.id == host.directory.activeServerID {
                    Label(server.displayName, systemImage: "checkmark")
                } else {
                    Text(server.displayName)
                }
            }
        }
        Divider()
        Button("Add Server…", systemImage: "plus") { addingServer = true }
        Button("Manage Servers…", systemImage: "server.rack") { managingServers = true }
    }

    private var moreMenu: some View {
        Menu {
            if let page = host.page {
                Button("Reload", systemImage: "arrow.clockwise") { page.reload() }
            }
            Button("Manage Servers…", systemImage: "server.rack") { managingServers = true }
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
        } description: {
            VStack(spacing: 8) {
                Text(error.message(for: server.address))
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
        } description: {
            Text("\(server.address.displayString) now belongs to a different Tilecast installation (\(found.organizationName)). Tilecast didn’t open it, so your sign-in for \(server.displayName) wasn’t sent to it.")
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
