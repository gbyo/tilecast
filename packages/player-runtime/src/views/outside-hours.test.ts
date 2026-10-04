// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import finishRuntime from "../../scripts/finish-runtime.mjs?raw";
import castLogo from "../../static/tilecast-logo-cast-white.svg?raw";
import pulseLogo from "../../static/tilecast-logo-pulse-white.svg?raw";
import type { OutsideHoursLogoV1, RuntimePresentation } from "../host/contract";
import type { OutsideHours } from "./outside-hours";
import "./outside-hours";

type Sleep = Extract<RuntimePresentation, { state: "sleep" }>;

async function logoSource(
  logo: OutsideHoursLogoV1 | undefined,
): Promise<string | null> {
  const view = document.createElement("tc-outside-hours") as OutsideHours;
  view.presentation = {
    state: "sleep",
    display: "bouncing_logo",
  } as Sleep;
  view.logo = logo;
  document.body.append(view);
  await view.updateComplete;
  const source = view.querySelector("img")?.getAttribute("src") ?? null;
  view.remove();
  return source;
}

describe("outside-hours bouncing logo", () => {
  it("shows the Cast logo unless the host asks for another", async () => {
    expect(await logoSource(undefined)).toBe("tilecast-logo-cast-white.svg");
    expect(await logoSource("cast")).toBe("tilecast-logo-cast-white.svg");
  });

  it("shows the pulse logo when the host asks for it", async () => {
    expect(await logoSource("pulse")).toBe("tilecast-logo-pulse-white.svg");
  });

  it("ignores a logo name it does not know", async () => {
    expect(await logoSource("spin" as OutsideHoursLogoV1)).toBe(
      "tilecast-logo-cast-white.svg",
    );
  });

  it("ships every logo the view can show", () => {
    expect(castLogo).toContain("<svg");
    expect(pulseLogo).toContain("<svg");
    for (const name of [
      "tilecast-logo-cast-white.svg",
      "tilecast-logo-pulse-white.svg",
    ]) {
      expect(finishRuntime).toContain(`"${name}"`);
    }
  });
});
