export type ScreenPlatformFamily = "android" | "linux";

// Screens report a specific platform string ("fire-tv", "android-tv",
// "linux", …); anything that is not Linux belongs to the Android family, the
// same mapping the server applies when resolving deployment targets.
export const screenPlatformFamily = (platform: string): ScreenPlatformFamily =>
  platform === "linux" ? "linux" : "android";

export const isAndroidScreen = (platform: string) =>
  screenPlatformFamily(platform) === "android";

/**
 * The Player Updates tabs: one per release family. `linux` is the Electron
 * Linux Player (its URL value predates Tilecast Edge) and `edge` is Tilecast
 * Edge. A screen belongs to the family its player reported, and otherwise to
 * the one its platform always meant — the server applies the same rule when it
 * resolves deployment targets.
 */
export type UpdateFamilyTab = "android" | "linux" | "edge";

const tabOfFamily = (family?: string): UpdateFamilyTab | undefined =>
  family === "edge"
    ? "edge"
    : family === "electron-linux"
      ? "linux"
      : family === "android"
        ? "android"
        : undefined;

export const screenUpdateTab = (screen: {
  platform: string;
  playerFamily?: string;
}): UpdateFamilyTab =>
  tabOfFamily(screen.playerFamily) ?? screenPlatformFamily(screen.platform);

export const releaseUpdateTab = (release: {
  platform: string;
  playerFamily?: string;
}): UpdateFamilyTab =>
  tabOfFamily(release.playerFamily) ??
  (release.platform === "linux" ? "linux" : "android");
