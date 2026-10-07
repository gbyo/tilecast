import { describe, expect, it } from "vitest";
import { BROWSER_COMMANDS } from "./browser/browserCapabilities.gen";
import {
  screenRunsBrowserPlayer,
  screenSupportsCommand,
} from "./commandApplicability";

describe("command applicability", () => {
  it("offers a Browser Screen only the commands its matrix lists", () => {
    const browser = { platform: "browser" };
    for (const command of BROWSER_COMMANDS)
      expect(screenSupportsCommand(browser, command.type)).toBe(true);
    for (const type of [
      "restart_player_process",
      "clear_media_cache",
      "clear_website_data",
      "display_power_off",
      "install_player_update",
      "install_autostart",
      "recreate_renderer",
      "run_player_self_test",
      "power_assist_sleep",
    ])
      expect(screenSupportsCommand(browser, type), type).toBe(false);
  });

  it("recognizes a Browser Player by its reported family too", () => {
    expect(
      screenRunsBrowserPlayer({ platform: "linux", playerFamily: "browser" }),
    ).toBe(true);
    expect(
      screenSupportsCommand(
        { platform: "linux", playerFamily: "browser" },
        "display_power_off",
      ),
    ).toBe(false);
  });

  it("leaves every other player's commands to the server", () => {
    for (const platform of ["android", "fire-tv", "linux", "windows"])
      expect(
        screenSupportsCommand({ platform }, "restart_player_process"),
      ).toBe(true);
  });
});
