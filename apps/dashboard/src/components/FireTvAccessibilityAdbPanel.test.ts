import { describe, expect, it } from "vitest";
import {
  fireTvAccessibilityCommands,
  fireTvAdbTarget,
  isFireTvScreen,
} from "./FireTvAccessibilityAdbPanel";

describe("Fire TV accessibility ADB commands", () => {
  it("uses the screen address and preserves existing services", () => {
    const commands = fireTvAccessibilityCommands("192.168.1.44");
    expect(commands.connect).toBe("adb connect 192.168.1.44:5555");
    expect(commands.enable).toContain("enabled_accessibility_services");
    expect(commands.enable).toContain(
      'current="${current:+$current:}$component"',
    );
  });

  it("does not append a second port to an explicit ADB endpoint", () => {
    expect(fireTvAdbTarget("192.168.1.44:5556")).toBe("192.168.1.44:5556");
    expect(fireTvAccessibilityCommands("192.168.1.44:5556").connect).toBe(
      "adb connect 192.168.1.44:5556",
    );
  });

  it("formats IPv6 endpoints without double-bracketing them", () => {
    expect(fireTvAdbTarget("2001:db8::44")).toBe("[2001:db8::44]:5555");
    expect(fireTvAdbTarget("[2001:db8::44]:5556")).toBe(
      "[2001:db8::44]:5556",
    );
  });

  it("falls back to a clear placeholder when no address was reported", () => {
    expect(fireTvAccessibilityCommands().connect).toBe(
      "adb connect FIRE_TV_IP:5555",
    );
  });

  it("does not throw when older screen data omits the manufacturer", () => {
    expect(
      isFireTvScreen({ platform: "android-tv", deviceManufacturer: undefined }),
    ).toBe(false);
  });

  it("recognizes Fire TV by manufacturer regardless of casing", () => {
    expect(
      isFireTvScreen({ platform: "android-tv", deviceManufacturer: "Amazon" }),
    ).toBe(true);
  });
});
