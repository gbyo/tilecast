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
    /// How much of the slot's bottom edge floating chrome (the tab bar)
    /// covers. Studio is drawn beneath it, so the web view treats this
    /// height as a bottom safe area: content can scroll under the bar and
    /// still stop above it.
    private(set) var coveredBottom: CGFloat = 0
    @ObservationIgnored private var owner: UUID?

    func show(_ frame: CGRect, coveredBottom: CGFloat, for slot: UUID) {
        owner = slot
        self.frame = frame
        lastFrame = frame
        self.coveredBottom = coveredBottom
    }

    func hide(for slot: UUID) {
        guard owner == slot else { return }
        owner = nil
        frame = nil
    }
}

nonisolated private struct SlotMeasure: Equatable, Sendable {
    var frame: CGRect
    var coveredBottom: CGFloat
}

/// Marks where Studio appears in a layout. Show at most one at a time.
struct StudioSlotView: View {
    /// Extend beneath the tab bar. The iOS 26 tab bar floats over its
    /// content, so Studio must be what shows through the glass.
    var extendsBelowTabBar = false
    @Environment(StudioSlot.self) private var slot
    @State private var id = UUID()

    var body: some View {
        Color.clear
            // WKWebView handles the keyboard itself, as it does in Safari.
            .ignoresSafeArea(.keyboard)
            .onGeometryChange(for: SlotMeasure.self) {
                let covered = extendsBelowTabBar ? $0.safeAreaInsets.bottom : 0
                var frame = $0.frame(in: .global)
                frame.size.height += covered
                return SlotMeasure(frame: frame, coveredBottom: covered)
            } action: { measure in
                slot.show(measure.frame, coveredBottom: measure.coveredBottom, for: id)
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
                    .safeAreaPadding(.bottom, slot.coveredBottom)
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
