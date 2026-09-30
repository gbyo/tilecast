import SwiftUI
import TilecastCore

/// Chooses between first-run setup and the Studio shell.
struct RootView: View {
    @Environment(StudioHost.self) private var host

    var body: some View {
        Group {
            if host.directory.servers.isEmpty {
                WelcomeView()
            } else {
                StudioShell()
            }
        }
        .deepLinkNotice()
    }
}

/// First run: no servers are configured yet.
struct WelcomeView: View {
    @State private var addingServer = false

    var body: some View {
        NavigationStack {
            ContentUnavailableView {
                Label("Welcome to Tilecast", systemImage: "rectangle.3.group")
                    .font(.geist(.title2).weight(.bold))
            } description: {
                Text("Connect to your organization’s Tilecast server to manage screens, content, and schedules.")
                    .font(.geist(.body))
            } actions: {
                Button("Add Server") { addingServer = true }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.large)
                    .accessibilityIdentifier("welcome.addServer")
            }
        }
        .sheet(isPresented: $addingServer) {
            AddServerView()
        }
    }
}
