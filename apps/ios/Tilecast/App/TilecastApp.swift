import SwiftUI
import TilecastCore

@main
struct TilecastApp: App {
    @State private var host = StudioHost.live()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Typography.applyAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .font(.geist(.body))
                .environment(host)
                .task { await host.start() }
        }
        .onChange(of: scenePhase) { _, phase in
            if phase != .active { host.recordState() }
        }
    }
}

extension StudioHost {
    /// The production host. UI tests pass `-TilecastEphemeralServers` so each
    /// run starts with no servers and writes nothing to disk.
    static func live(arguments: [String] = ProcessInfo.processInfo.arguments) -> StudioHost {
        let storage: any ServerDirectoryStorage
        if arguments.contains("-TilecastEphemeralServers") {
            storage = InMemoryServerDirectoryStorage()
        } else if let file = try? FileServerDirectoryStorage.applicationSupport() {
            storage = file
        } else {
            storage = InMemoryServerDirectoryStorage()
        }
        return StudioHost(
            directory: ServerDirectory(storage: storage),
            dataStores: WebsiteDataStores(),
            identityClient: InstallationIdentityClient(),
            applicationName: applicationName
        )
    }

    /// Appended to the WebKit user agent, e.g. `TilecastiOS/0.1.0`.
    static var applicationName: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return "TilecastiOS/\(version)"
    }
}
