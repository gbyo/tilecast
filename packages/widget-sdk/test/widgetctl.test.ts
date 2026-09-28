import { describe, expect, it } from "vitest";
import { authoringUiProblem } from "../tools/widgetctl/main.ts";

const keys = new Set(["style", "title"]);

describe("authoringUiProblem visibleWhen", () => {
  it("accepts a rule naming a known configuration field", () => {
    expect(
      authoringUiProblem(
        "showDate",
        "toggle",
        {
          section: "appearance",
          visibleWhen: { key: "style", notEquals: "minimal" },
        },
        keys,
      ),
    ).toBeNull();
  });

  it("rejects a rule naming an unknown configuration field", () => {
    expect(
      authoringUiProblem(
        "showDate",
        "toggle",
        {
          section: "appearance",
          visibleWhen: { key: "styel", notEquals: "minimal" },
        },
        keys,
      ),
    ).toBe("field showDate has a visibility rule on unknown field styel");
  });

  it("keeps validating rule shape when no field set is given", () => {
    expect(
      authoringUiProblem("showDate", "toggle", {
        visibleWhen: { key: "anything", equals: 1 },
      }),
    ).toBeNull();
    expect(
      authoringUiProblem("showDate", "toggle", {
        visibleWhen: { key: "style" },
      }),
    ).toBe("field showDate has a visibility rule with nothing to compare");
  });
});
