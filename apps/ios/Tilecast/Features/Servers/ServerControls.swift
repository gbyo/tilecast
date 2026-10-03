import SwiftUI
import TilecastCore

/// Opens the app's server sheets. The shell owns the sheets, so every place
/// that offers server controls presents the same ones.
struct ServerActions {
    var add: () -> Void
    var manage: () -> Void
}

/// Server switching and management, for menus.
struct ServerMenuItems: View {
    @Environment(StudioHost.self) private var host
    let actions: ServerActions

    var body: some View {
        ForEach(host.directory.servers) { server in
            let title = menuTitle(for: server)
            Button {
                Task { await host.activate(server.id) }
            } label: {
                if server.id == host.directory.activeServerID {
                    Label(title, image: AppIcon.current)
                } else {
                    Text(verbatim: title)
                }
            }
        }
        Divider()
        Button(action: actions.add) { Label("Add Server…", image: AppIcon.add) }
        Button(action: actions.manage) { Label("Manage Servers…", image: AppIcon.manage) }
    }

    private func menuTitle(for server: ServerProfile) -> String {
        let duplicates = host.directory.servers.filter { $0.displayName == server.displayName }.count
        return duplicates > 1
            ? "\(server.displayName) — \(server.address.displayString)"
            : server.displayName
    }
}

/// Signs the app out of the active server: Studio's session and the native
/// credential together. Shown only while Studio is signed in.
struct SignOutButton: View {
    @Environment(StudioHost.self) private var host
    let page: StudioPage

    var body: some View {
        if !page.signInRequired {
            Button {
                Task { await host.signOut() }
            } label: {
                Label("Sign Out", image: AppIcon.signOut)
            }
            .accessibilityIdentifier("server.signOut")
        }
    }
}
