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
            Button {
                Task { await host.activate(server.id) }
            } label: {
                if server.id == host.directory.activeServerID {
                    Label(server.displayName, image: AppIcon.current)
                } else {
                    Text(server.displayName)
                }
            }
        }
        Divider()
        Button(action: actions.add) { Label("Add Server…", image: AppIcon.add) }
        Button(action: actions.manage) { Label("Manage Servers…", image: AppIcon.server) }
    }
}

/// Signs the app out of the active server: Studio's session and the native
/// credential together. Shown only while Studio is signed in.
struct SignOutButton: View {
    @Environment(StudioHost.self) private var host
    let page: StudioPage

    var body: some View {
        if !page.signInRequired {
            Button("Sign Out", systemImage: "rectangle.portrait.and.arrow.right") {
                Task { await host.signOut() }
            }
            .accessibilityIdentifier("server.signOut")
        }
    }
}
