/// Studio's Lucide icons for the semantic icon tokens in
/// `packages/native-bridge-schema/icon-tokens.json`.
///
/// A token is a visual hint. A navigation token says nothing about where a
/// destination leads, and an action token says nothing about what the action
/// does. Any token not listed here, such as one a newer Studio introduces,
/// shows the generic icon in navigation and no icon in an action menu, so a
/// new Studio destination or action never needs an app change to appear.
/// `images` and `generic` are generated from Studio's own mappings; see
/// `NavigationIconImages.gen.swift`.
public enum NavigationIcon {
    /// The asset name of the icon for a token, in the app's asset catalog.
    public static func imageName(for token: String) -> String {
        images[token] ?? generic
    }

    /// The asset name for a token the app knows, or nil. Action menus
    /// show no icon for an unknown token rather than a generic symbol.
    public static func imageNameIfKnown(for token: String) -> String? {
        images[token]
    }
}
