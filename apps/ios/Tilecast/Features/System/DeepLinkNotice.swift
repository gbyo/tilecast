import SwiftUI
import TilecastCore

/// Tells the person when a link cannot be opened. The notice never names a
/// host: the link named none, and the app contacted no one for it.
private struct DeepLinkNoticeModifier: ViewModifier {
    @Environment(StudioHost.self) private var host

    private var isShowing: Binding<Bool> {
        Binding(get: { host.deepLinkNotice != nil }, set: { if !$0 { host.dismissDeepLinkNotice() } })
    }

    func body(content: Content) -> some View {
        content.alert(title, isPresented: isShowing) {
            Button("OK", role: .cancel) {}
        } message: {
            Text(message)
        }
    }

    private var title: String {
        String(localized: "Can’t Open Link")
    }

    private var message: String {
        switch host.deepLinkNotice {
        case .notConfigured?:
            String(localized: "This link is for a Tilecast server that isn’t set up on this device. Add the server first, then open the link again.")
        case .unopenable?, nil:
            String(localized: "This link can’t be opened.")
        }
    }
}

extension View {
    func deepLinkNotice() -> some View {
        modifier(DeepLinkNoticeModifier())
    }
}
