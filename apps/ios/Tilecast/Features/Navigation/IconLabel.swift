import SwiftUI

/// A list row label with a Lucide icon from the asset catalog. Unlike
/// `Label(_:image:)`, the icon scales with Dynamic Type, as a symbol does.
struct IconLabel<Title: View>: View {
    let image: String
    @ViewBuilder let title: Title
    @ScaledMetric(relativeTo: .body) private var size = 20

    var body: some View {
        Label {
            title
        } icon: {
            Image(image)
                .resizable()
                .scaledToFit()
                .frame(width: size, height: size)
        }
    }
}

extension IconLabel where Title == Text {
    init(_ title: LocalizedStringKey, image: String) {
        self.init(image: image) { Text(title) }
    }

    init(verbatim title: String, image: String) {
        self.init(image: image) { Text(verbatim: title) }
    }
}
