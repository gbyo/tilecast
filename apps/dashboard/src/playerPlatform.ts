import type { TFunction } from "i18next";
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

type ScreensT = TFunction<"screens", undefined>;

export function platformLabel(value: string, t: ScreensT): string {
  const normalized = value.toLowerCase();
  if (normalized === "browser") return t("platform.browser");
  if (normalized === "linux") return t("platform.linux");
  if (normalized === "windows") return t("platform.windows");
  if (normalized.includes("fire")) return t("platform.fireTv");
  if (normalized.includes("google")) return t("platform.googleTv");
  if (normalized.includes("android")) return t("platform.androidTv");
  return value || t("platform.unknown");
}

/**
 * Human-facing Player label for a paired Screen. The OS platform alone cannot
 * distinguish the legacy Electron Linux Player from Tilecast Edge, so prefer
 * the reported Player family. Linux screens that predate Player-family
 * reporting are legacy Electron by definition.
 */
export function screenPlayerLabel(
  screen: { platform: string; playerFamily?: string },
  t: ScreensT,
): string {
  if (screen.playerFamily === "edge") return t("platform.edge");
  if (screen.playerFamily === "electron-linux")
    return t("platform.legacyLinux");
  if (screen.playerFamily === "windows") return t("platform.windows");

  const normalized = screen.platform.toLowerCase();
  if (normalized === "linux") return t("platform.legacyLinux");
  return platformLabel(screen.platform, t);
}

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
