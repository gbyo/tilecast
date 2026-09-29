import SwiftUI
import TilecastCore

/// Where the one Studio web view appears.
///
/// A `WebPage` can be shown by only one `WebView`, and SwiftUI may build a
/// new view before it removes an old one, for example when a tab changes.
/// So the shell creates exactly one `WebView` for the page's whole life, at
/// its root, and never moves it between containers. Each layout (the
/// fallback chrome, a tab, More, or the iPad detail column) marks where
/// Studio belongs with a `StudioSlotView`, and the root places the web view
/// over the active slot.
@MainActor
@Observable
final class StudioSlot {
    /// The active slot, in global coordinates. Nil hides Studio, for
    /// example while the More list covers it.
    private(set) var frame: CGRect?
    /// The last known frame, so a hidden web view keeps its size and does
    /// not relayout Studio.
    private(set) var lastFrame: CGRect = .zero
    @ObservationIgnored private var owner: UUID?

    func show(_ frame: CGRect, for slot: UUID) {
        owner = slot
        self.frame = frame
        lastFrame = frame
    }

    func hide(for slot: UUID) {
        guard owner == slot else { return }
        owner = nil
        frame = nil
    }
}

/// Marks where Studio appears in a layout. Show at most one at a time.
struct StudioSlotView: View {
    @Environment(StudioSlot.self) private var slot
    @State private var id = UUID()

    var body: some View {
        Color.clear
            // WKWebView handles the keyboard itself, as it does in Safari.
            .ignoresSafeArea(.keyboard)
            .onGeometryChange(for: CGRect.self) { $0.frame(in: .global) } action: { frame in
                slot.show(frame, for: id)
            }
            .onDisappear { slot.hide(for: id) }
    }
}

/// The one Studio web view, placed over the active slot.
struct StudioOverlay: View {
    @Environment(StudioHost.self) private var host
    @Environment(StudioSlot.self) private var slot

    var body: some View {
        GeometryReader { proxy in
            if let page = host.page {
                let origin = proxy.frame(in: .global).origin
                let frame = slot.frame ?? slot.lastFrame
                let visible = slot.frame != nil
                StudioPageView(page: page)
                    .id(ObjectIdentifier(page))
                    .frame(width: frame.width, height: frame.height)
                    .offset(x: frame.minX - origin.x, y: frame.minY - origin.y)
                    .opacity(visible ? 1 : 0)
                    .allowsHitTesting(visible)
                    .accessibilityHidden(!visible)
            }
        }
        .ignoresSafeArea()
    }
}
