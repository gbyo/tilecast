import type { PlayerFamily, PlayerPlatform } from "./api/types";

export type ScreenPlatformFamily = "android" | "linux" | "windows" | "browser";

/**
 * Narrow an open API family/platform string to the values Studio knows.
 * Unknown values arrive as absent: the contract sets grow with new players,
 * and a release or deployment Studio cannot place on a tab is left out of
 * the lists rather than miscategorized. The server stays authoritative.
 */
export const normalizePlayerPlatform = (
  platform: string,
): PlayerPlatform | undefined =>
  platform === "android" || platform === "linux" || platform === "windows"
    ? platform
    : undefined;

export const normalizePlayerFamily = (
  family: string | undefined,
): PlayerFamily | undefined =>
  family === "android" ||
  family === "electron-linux" ||
  family === "edge" ||
  family === "windows"
    ? family
    : undefined;

// Screens report a specific platform string ("fire-tv", "android-tv",
// "linux", "windows", "browser", …). Legacy unknown native platforms retain
// their Android mapping. Browser screens never participate in native updates.
export const screenPlatformFamily = (platform: string): ScreenPlatformFamily =>
  platform === "browser"
    ? "browser"
    : platform === "linux"
      ? "linux"
      : platform === "windows"
        ? "windows"
        : "android";

export const isAndroidScreen = (platform: string) =>
  screenPlatformFamily(platform) === "android";

/**
 * The Player Updates tabs: one per release family. `linux` is the Electron
 * Linux Player (its URL value predates Tilecast Edge), `edge` is Tilecast
 * Edge and `windows` is the Windows Player. A screen belongs to the family
 * its player reported, and otherwise to the one its platform always meant —
 * the server applies the same rule when it resolves deployment targets.
 */
export type UpdateFamilyTab = "android" | "linux" | "edge" | "windows";

const tabOfFamily = (family?: string): UpdateFamilyTab | undefined =>
  family === "edge"
    ? "edge"
    : family === "windows"
      ? "windows"
      : family === "electron-linux"
        ? "linux"
        : family === "android"
          ? "android"
          : undefined;

export const screenUpdateTab = (screen: {
  platform: string;
  playerFamily?: string;
}): UpdateFamilyTab | undefined => {
  if (screen.platform === "browser" || screen.playerFamily === "browser")
    return undefined;
  const family = screenPlatformFamily(screen.platform);
  return (
    tabOfFamily(screen.playerFamily) ??
    (family === "browser" ? undefined : family)
  );
};

export const releaseUpdateTab = (release: {
  platform: string;
  playerFamily?: string;
}): UpdateFamilyTab =>
  tabOfFamily(release.playerFamily) ??
  (release.platform === "linux"
    ? "linux"
    : release.platform === "windows"
      ? "windows"
      : "android");
