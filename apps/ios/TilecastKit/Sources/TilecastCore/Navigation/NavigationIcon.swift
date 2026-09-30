/// Studio's Lucide icons for the semantic navigation icon tokens in
/// `packages/native-bridge-schema/icon-tokens.json`.
///
/// A token is a visual hint, not a destination: it says nothing about where a
/// destination leads. Any token not listed here, such as one a newer Studio
/// introduces, shows the generic icon, so a new Studio destination never
/// needs an app change to appear. `images` and `generic` are generated from
/// Studio's own mapping; see `NavigationIconImages.gen.swift`.
public enum NavigationIcon {
    /// The asset name of the icon for a token, in the app's asset catalog.
    public static func imageName(for token: String) -> String {
        images[token] ?? generic
    }
}
