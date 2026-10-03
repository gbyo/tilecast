import SwiftUI
import TilecastCore

private extension NativeActionMenu.Item.Role {
    var swiftUI: ButtonRole? {
        switch self {
        case .default: nil
        case .destructive: .destructive
        }
    }
}

/// Invisible native Menu controls positioned exactly over Studio's visible
/// HTML action buttons. Studio owns the button's appearance; SwiftUI owns
/// the hit target and menu presentation.
///
/// The trigger rectangles are normalized to the WebView viewport, so this
/// layer never needs to know a Studio route, resource type, or scroll offset.
struct NativeActionMenuAnchorLayer: View {
    let center: NativeActionMenuCenter?
    let context: NativeBridgeProtocol.Context

    var body: some View {
        GeometryReader { proxy in
            ForEach(center?.triggers(for: context) ?? []) { trigger in
                nativeMenu(trigger)
                    .frame(
                        width: max(1, proxy.size.width * trigger.rect.width),
                        height: max(1, proxy.size.height * trigger.rect.height)
                    )
                    .position(
                        x: proxy.size.width * (trigger.rect.x + trigger.rect.width / 2),
                        y: proxy.size.height * (trigger.rect.y + trigger.rect.height / 2)
                    )
            }
        }
    }

    private func nativeMenu(_ trigger: NativeActionMenuCenter.Trigger) -> some View {
        Menu {
            ForEach(Array(trigger.menu.groups.enumerated()), id: \.offset) { _, group in
                Section {
                    ForEach(group.items) { item in
                        Button(role: item.role.swiftUI) {
                            center?.chooseTrigger(actionID: item.id, menuID: trigger.menu.id)
                        } label: {
                            if let icon = item.icon,
                               let image = NavigationIcon.imageNameIfKnown(for: icon) {
                                Label {
                                    Text(verbatim: item.label)
                                } icon: {
                                    Image(image)
                                }
                            } else {
                                Text(verbatim: item.label)
                            }
                        }
                        .disabled(item.isDisabled)
                        .accessibilityIdentifier("actionMenu.action.\(item.id)")
                    }
                }
            }
        } label: {
            // Studio still draws the visible ellipsis. This rectangle exists
            // only to give the system a native anchor and hit target.
            Color.clear
                .contentShape(Rectangle())
        }
        .accessibilityLabel(Text(verbatim: trigger.menu.label))
        .accessibilityIdentifier("actionMenu.trigger.\(trigger.menu.id)")
    }
}

/// The context menu a long press builds from the menu Studio armed. This is
/// SwiftUI's supported iOS contextMenu(menuItems:) path; it does not use
/// WebKit's macOS-only webViewContextMenu API.
struct NativeActionMenuContextContent: View {
    let center: NativeActionMenuCenter?
    let context: NativeBridgeProtocol.Context

    var body: some View {
        if let menu = center?.consumeArmed(for: context) {
            ForEach(Array(menu.groups.enumerated()), id: \.offset) { _, group in
                Section {
                    ForEach(group.items) { item in
                        Button(role: item.role.swiftUI) {
                            center?.chooseShowing(actionID: item.id, menuID: menu.id)
                        } label: {
                            if let icon = item.icon,
                               let image = NavigationIcon.imageNameIfKnown(for: icon) {
                                Label {
                                    Text(verbatim: item.label)
                                } icon: {
                                    Image(image)
                                }
                            } else {
                                Text(verbatim: item.label)
                            }
                        }
                        .disabled(item.isDisabled)
                        .accessibilityIdentifier("actionMenu.action.\(item.id)")
                    }
                }
            }
        }
    }
}
