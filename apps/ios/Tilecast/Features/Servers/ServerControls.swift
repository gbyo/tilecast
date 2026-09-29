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
                    Label(server.displayName, systemImage: "checkmark")
                } else {
                    Text(server.displayName)
                }
            }
        }
        Divider()
        Button("Add Server…", systemImage: "plus", action: actions.add)
        Button("Manage Servers…", systemImage: "server.rack", action: actions.manage)
    }
}
