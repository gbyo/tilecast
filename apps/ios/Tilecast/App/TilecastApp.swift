import SwiftUI
import TilecastCore

@main
struct TilecastApp: App {
    @State private var host = StudioHost.live()
    @State private var feedback = SystemFeedback()
    @Environment(\.scenePhase) private var scenePhase

    init() {
        Typography.applyAppearance()
    }

    var body: some Scene {
        WindowGroup {
            RootView()
                .font(.geist(.body))
                .environment(host)
                .systemFeedback(feedback)
                // The bridge asks; the app decides how. Set before Studio loads.
                .task {
                    host.system.haptic = { [feedback] in feedback.perform($0) }
                    host.system.share = { SystemSharePresenter.present($0) }
                    host.system.isQRScannerAvailable = { SystemQRScanner.isAvailable }
                    host.system.scanQR = { await SystemQRScanner.scan($0) }
                    host.system.chooseFiles = { await SystemFileInputPicker.choose(allowsMultiple: $0) }
                    await host.start()
                }
                // A link that brings the person back into a configured
                // installation. The OAuth callback is the sign-in session's
                // own and is ignored here.
                .onOpenURL { url in Task { await host.open(url) } }
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
        var credentials: any NativeCredentialStore
        if arguments.contains("-TilecastEphemeralServers") {
            storage = InMemoryServerDirectoryStorage()
            credentials = InMemoryCredentialStore()
        } else if let file = try? FileServerDirectoryStorage.applicationSupport() {
            storage = file
            credentials = KeychainCredentialStore()
        } else {
            storage = InMemoryServerDirectoryStorage()
            credentials = InMemoryCredentialStore()
        }
        #if DEBUG
        if FixtureLaunch.nativeCredential { credentials = FixtureCredentialStore() }
        #endif
        return StudioHost(
            directory: ServerDirectory(storage: storage),
            dataStores: WebsiteDataStores(),
            identityClient: InstallationIdentityClient(),
            credentials: credentials,
            applicationName: applicationName
        )
    }

    /// Appended to the WebKit user agent, e.g. `TilecastiOS/0.1.0`.
    static var applicationName: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
        return "TilecastiOS/\(version)"
    }
}
