import SwiftUI
import TilecastCore

/// The native navigation bar for a page Studio says is a drill-in: a back
/// button named for the page it leads to, and the page's title. Both come
/// from Studio's `navigation/chrome`. Studio's top-level pages get no bar,
/// so the tab bar and Studio's own page header stay as they were. The back
/// button only tells Studio; its router decides where to go.
struct StudioBackBar: ViewModifier {
    let navigation: NativeNavigationModel

    func body(content: Content) -> some View {
        let chrome = navigation.chrome
        content
            .navigationTitle(chrome.title ?? "")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar(chrome.showsBackBar ? .visible : .hidden, for: .navigationBar)
            .toolbar {
                if let label = chrome.backLabel {
                    ToolbarItem(placement: .topBarLeading) {
                        Button {
                            navigation.goBack()
                        } label: {
                            Label {
                                Text(verbatim: label)
                            } icon: {
                                Image(systemName: "chevron.backward")
                            }
                        }
                        .accessibilityIdentifier("native.back")
                    }
                }
            }
    }
}

extension View {
    func studioBackBar(_ navigation: NativeNavigationModel) -> some View {
        modifier(StudioBackBar(navigation: navigation))
    }
}
