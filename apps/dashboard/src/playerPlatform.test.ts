import { describe, expect, it } from "vitest";
import {
  isAndroidScreen,
  normalizePlayerFamily,
  normalizePlayerPlatform,
  screenPlatformFamily,
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
