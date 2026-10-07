import { describe, expect, it } from "vitest";
import { i18n } from "./i18n";
import {
  isAndroidScreen,
  normalizePlayerFamily,
  normalizePlayerPlatform,
  screenPlatformFamily,
  screenPlayerLabel,
  screenUpdateTab,
} from "./playerPlatform";

describe("Browser Player platform boundary", () => {
  it("recognizes Browser screens without falling back to Android", () => {
    expect(screenPlatformFamily("browser")).toBe("browser");
    expect(isAndroidScreen("browser")).toBe(false);
  });

  it("excludes Browser screens from all native update tabs", () => {
    expect(screenUpdateTab({ platform: "browser" })).toBeUndefined();
    expect(
      screenUpdateTab({ platform: "browser", playerFamily: "android" }),
    ).toBeUndefined();
    expect(
      screenUpdateTab({ platform: "android", playerFamily: "browser" }),
    ).toBeUndefined();
    expect(screenUpdateTab({ platform: "fire-tv" })).toBe("android");
    expect(screenUpdateTab({ platform: "linux", playerFamily: "edge" })).toBe(
      "edge",
    );
  });

  it("does not admit Browser into native release contracts", () => {
    expect(normalizePlayerPlatform("browser")).toBeUndefined();
    expect(normalizePlayerFamily("browser")).toBeUndefined();
  });
});

describe("Player display labels", () => {
  const t = i18n.getFixedT("en", "screens");

  it("distinguishes Tilecast Edge from the legacy Electron Linux Player", () => {
    expect(
      screenPlayerLabel({ platform: "linux", playerFamily: "edge" }, t),
    ).toBe("Tilecast Edge");
    expect(
      screenPlayerLabel(
        { platform: "linux", playerFamily: "electron-linux" },
        t,
      ),
    ).toBe("Linux Player (Legacy)");
  });

  it("treats Linux Players without a reported family as legacy", () => {
    expect(screenPlayerLabel({ platform: "linux" }, t)).toBe(
      "Linux Player (Legacy)",
    );
  });
});
