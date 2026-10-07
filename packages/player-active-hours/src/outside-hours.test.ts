import { describe, expect, it } from "vitest";
import { buildOutsideActiveHoursPresentation } from "./outside-hours";

function config(
  power: Record<string, unknown>,
  branding: Record<string, unknown> = {},
) {
  return { power, branding };
}

describe("buildOutsideActiveHoursPresentation", () => {
  it("preserves the bouncing-logo mode", () => {
    expect(
      buildOutsideActiveHoursPresentation(
        config({ outsideActiveHoursDisplay: "bouncing_logo" }),
      ),
    ).toMatchObject({
      state: "sleep",
      display: "bouncing_logo",
      text: "Powered by Tilecast",
      textColor: "#F5F7FA",
    });
  });

  it("uses configured custom text and branding color", () => {
    expect(
      buildOutsideActiveHoursPresentation(
        config(
          {
            outsideActiveHoursDisplay: "custom_text",
            outsideActiveHoursText: "School reopens at 7 a.m.",
          },
          { textColor: "#ABCDEF" },
        ),
      ),
    ).toMatchObject({
      display: "custom_text",
      text: "School reopens at 7 a.m.",
      textColor: "#ABCDEF",
    });
  });

  it("falls back to branding footer text", () => {
    expect(
      buildOutsideActiveHoursPresentation(
        config(
          {
            outsideActiveHoursDisplay: "custom_text",
            outsideActiveHoursText: "   ",
          },
          { footerText: "Weekly Wildcat" },
        ),
      ).text,
    ).toBe("Weekly Wildcat");
  });

  it("fails unknown modes safely to black", () => {
    expect(
      buildOutsideActiveHoursPresentation(
        config({ outsideActiveHoursDisplay: "not-a-mode" }),
      ).display,
    ).toBe("black");
    expect(buildOutsideActiveHoursPresentation(null).display).toBe("black");
  });
});
