import SwiftUI
import UIKit

// Native chrome uses Geist, the typeface of Tilecast Studio, so the app and
// the Studio page inside it read as one interface. The variable font files
// are listed in UIAppFonts; every size follows Dynamic Type.

extension Font {
    /// Geist at the size and default weight of a system text style.
    static func geist(_ style: Font.TextStyle) -> Font {
        let font = Font.custom(Typography.family, size: Typography.pointSize(for: style), relativeTo: style)
        return Typography.isEmphasized(style) ? font.weight(.semibold) : font
    }
}

enum Typography {
    static let family = "Geist"

    /// Applies Geist to the UIKit chrome that SwiftUI font environment values
    /// do not reach: navigation bars, bar buttons, tab bars, and search fields.
    @MainActor
    static func applyAppearance() {
        let title = uiFont(.headline, weight: .semibold)
        let largeTitle = uiFont(.largeTitle, weight: .bold)

        // Set on the proxy, not through a replacement UINavigationBarAppearance,
        // so the system bar background is unchanged.
        let navigationBar = UINavigationBar.appearance()
        navigationBar.titleTextAttributes = [.font: title]
        navigationBar.largeTitleTextAttributes = [.font: largeTitle]

        let barButton = uiFont(.body, weight: .regular)
        for state in [UIControl.State.normal, .highlighted, .disabled, .focused] {
            UIBarButtonItem.appearance().setTitleTextAttributes([.font: barButton], for: state)
        }

        // The iOS 26 tab bar reads item fonts only from UITabBarAppearance,
        // not from UITabBarItem appearance.
        let tabItem = uiFont(.caption2, weight: .medium)
        let tabBar = UITabBarAppearance()
        for layout in [tabBar.stackedLayoutAppearance, tabBar.inlineLayoutAppearance, tabBar.compactInlineLayoutAppearance] {
            for state in [layout.normal, layout.selected, layout.focused, layout.disabled] {
                state.titleTextAttributes[.font] = tabItem
            }
        }
        UITabBar.appearance().standardAppearance = tabBar
        UITabBar.appearance().scrollEdgeAppearance = tabBar

        UISegmentedControl.appearance().setTitleTextAttributes([.font: uiFont(.subheadline, weight: .medium)], for: .normal)
        UITextField.appearance(whenContainedInInstancesOf: [UISearchBar.self]).font = uiFont(.body, weight: .regular)
    }

    /// A Dynamic Type Geist `UIFont` for a text style. Falls back to the
    /// system font if the bundled font failed to register.
    static func uiFont(_ style: UIFont.TextStyle, weight: UIFont.Weight) -> UIFont {
        let base = UIFont.preferredFont(forTextStyle: style, compatibleWith: UITraitCollection(preferredContentSizeCategory: .large))
        guard let font = UIFont(name: postScriptName(for: weight), size: base.pointSize) else {
            return UIFont.preferredFont(forTextStyle: style)
        }
        return UIFontMetrics(forTextStyle: style).scaledFont(for: font)
    }

    /// Named instances of the variable font, so UIKit gets an exact weight.
    private static func postScriptName(for weight: UIFont.Weight) -> String {
        switch weight {
        case .medium: "Geist-Medium"
        case .semibold: "Geist-SemiBold"
        case .bold: "Geist-Bold"
        default: "Geist-Regular"
        }
    }

    static func pointSize(for style: Font.TextStyle) -> CGFloat {
        UIFont.preferredFont(forTextStyle: uiTextStyle(style), compatibleWith: UITraitCollection(preferredContentSizeCategory: .large)).pointSize
    }

    static func isEmphasized(_ style: Font.TextStyle) -> Bool {
        style == .headline
    }

    private static func uiTextStyle(_ style: Font.TextStyle) -> UIFont.TextStyle {
        switch style {
        case .extraLargeTitle: .extraLargeTitle
        case .extraLargeTitle2: .extraLargeTitle2
        case .largeTitle: .largeTitle
        case .title: .title1
        case .title2: .title2
        case .title3: .title3
        case .headline: .headline
        case .subheadline: .subheadline
        case .callout: .callout
        case .footnote: .footnote
        case .caption: .caption1
        case .caption2: .caption2
        default: .body
        }
    }
}
