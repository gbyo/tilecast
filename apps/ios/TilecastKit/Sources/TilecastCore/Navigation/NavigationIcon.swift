/// SF Symbols for the semantic navigation icon tokens in
/// `packages/native-bridge-schema/icon-tokens.json`.
///
/// A token is a visual hint, not a destination: it says nothing about where a
/// destination leads. Any token not listed here, such as one a newer Studio
/// introduces, shows the generic symbol, so a new Studio destination never
/// needs an app change to appear.
public enum NavigationIcon {
    public static let generic = "square.dashed"

    static let symbols: [String: String] = [
        "home": "house",
        "screens": "tv",
        "groups": "rectangle.3.group",
        "media": "photo.on.rectangle",
        "widgets": "square.grid.2x2",
        "data": "cylinder.split.1x2",
        "playlists": "list.and.film",
        "layouts": "rectangle.split.3x1",
        "campaigns": "megaphone",
        "schedules": "calendar.badge.clock",
        "plugins": "puzzlepiece.extension",
        "activity": "waveform.path.ecg",
        "settings": "gearshape",
        "plugin": "puzzlepiece",
    ]

    public static func systemImage(for token: String) -> String {
        symbols[token] ?? generic
    }
}
