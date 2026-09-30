import SwiftUI
import TilecastCore

/// Standard system feedback for what Studio asks with `system/haptic`.
///
/// Studio names the meaning of a state change (selection, success, warning,
/// error, start, stop). The app maps that meaning onto Apple's own
/// `SensoryFeedback`, so the effect suits the device and the person's
/// settings. There is no custom pattern and no page-specific vocabulary.
///
/// `sensoryFeedback(trigger:)` plays feedback when a value changes, so each
/// request is a new value with a counter. The same bridge message from the
/// main page and from the presentation page reaches this one object.
@MainActor
@Observable
final class SystemFeedback {
    struct Request: Equatable {
        let id: Int
        let feedback: HapticFeedback
    }

    private(set) var request: Request?

    func perform(_ feedback: HapticFeedback) {
        request = Request(id: (request?.id ?? 0) + 1, feedback: feedback)
    }
}

extension HapticFeedback {
    /// The standard feedback for a semantic request.
    var sensoryFeedback: SensoryFeedback {
        switch self {
        case .selection: .selection
        case .success: .success
        case .warning: .warning
        case .error: .error
        case .start: .start
        case .stop: .stop
        }
    }
}

extension View {
    /// Performs the feedback Studio requests while this view is on screen.
    func systemFeedback(_ feedback: SystemFeedback) -> some View {
        sensoryFeedback(trigger: feedback.request) { _, request in request?.feedback.sensoryFeedback }
    }
}
