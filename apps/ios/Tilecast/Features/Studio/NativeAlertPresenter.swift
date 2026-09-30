import SwiftUI
import TilecastCore

/// Shows the alert Studio asked for, over the page that asked. The text and
/// buttons are Studio's own, already localized, so the app carries no copy
/// for any confirmation.
private struct NativeAlertPresenter: ViewModifier {
    let center: NativeAlertCenter?
    let context: NativeBridgeProtocol.Context

    func body(content: Content) -> some View {
        let alert = center?.alert(for: context)
        content.alert(
            Text(verbatim: alert?.title ?? ""),
            // Only a button dismisses an alert, and choosing one clears it,
            // so the binding never has to answer for a dismissal.
            isPresented: Binding(get: { alert != nil }, set: { _ in }),
            presenting: alert
        ) { alert in
            ForEach(alert.buttons) { button in
                Button(role: button.role.swiftUI) {
                    center?.choose(buttonID: button.id)
                } label: {
                    Text(verbatim: button.label)
                }
            }
        } message: { alert in
            if let message = alert.message { Text(verbatim: message) }
        }
    }
}

private extension NativeAlert.Button.Role {
    var swiftUI: ButtonRole? {
        switch self {
        case .default: nil
        case .cancel: .cancel
        case .destructive: .destructive
        }
    }
}

extension View {
    /// Presents the alert of `context` from `center`. The main page and a
    /// presentation sheet each attach their own, so an alert shows over the
    /// sheet when the sheet asked for it.
    func nativeAlert(from center: NativeAlertCenter?, for context: NativeBridgeProtocol.Context) -> some View {
        modifier(NativeAlertPresenter(center: center, context: context))
    }
}
