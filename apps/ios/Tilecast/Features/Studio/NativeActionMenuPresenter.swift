import SwiftUI
import TilecastCore

/// Shows the menu Studio asked for, over the page that asked. The label
/// and actions are Studio's own, already localized, so the app carries no
/// copy for any menu. A three-dot button lives inside the page, so the
/// menu shows as a system dialog: an action sheet on compact iPhone, a
/// popover on regular-width iPad.
private struct NativeActionMenuPresenter: ViewModifier {
    let center: NativeActionMenuCenter?
    let context: NativeBridgeProtocol.Context

    func body(content: Content) -> some View {
        let menu = center?.menu(for: context)
        content.confirmationDialog(
            menu?.label ?? "",
            // Choosing an action or withdrawing the menu clears it, so the
            // binding only answers for a user dismissal.
            isPresented: Binding(get: { menu != nil }, set: { if !$0 { center?.dismissImmediate() } }),
            titleVisibility: .visible,
            presenting: menu
        ) { menu in
            ForEach(Array(menu.groups.enumerated()), id: \.offset) { _, group in
                Section {
                    ForEach(group.items) { item in
                        Button(role: item.role.swiftUI) {
                            center?.choose(actionID: item.id)
                        } label: {
                            Text(verbatim: item.label)
                        }
                        .disabled(item.isDisabled)
                        .accessibilityIdentifier("actionMenu.action.\(item.id)")
                    }
                }
            }
        } message: { _ in
            EmptyView()
        }
    }
}

private extension NativeActionMenu.Item.Role {
    var swiftUI: ButtonRole? {
        switch self {
        case .default: nil
        case .destructive: .destructive
        }
    }
}

/// The context menu a long press builds from the menu Studio armed. When
/// nothing is armed for this page the default menu shows instead, so
/// ordinary long presses keep working.
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
                            if let icon = item.icon, let image = NavigationIcon.imageNameIfKnown(for: icon) {
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

extension View {
    /// Presents the immediate menu of `context` from `center`. The main
    /// page and a presentation sheet each attach their own, so a menu
    /// shows over the sheet when the sheet asked for it.
    func nativeActionMenu(from center: NativeActionMenuCenter?, for context: NativeBridgeProtocol.Context) -> some View {
        modifier(NativeActionMenuPresenter(center: center, context: context))
    }
}
