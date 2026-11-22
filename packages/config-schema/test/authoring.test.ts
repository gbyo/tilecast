import { describe, expect, it } from "vitest";
import { authoringUiOf } from "../src/index.ts";

describe("authoring hints", () => {
  it("reads the minutes input unit and ignores others", () => {
    expect(authoringUiOf({ key: "a", ui: { inputUnit: "minutes" } })).toEqual({
      inputUnit: "minutes",
    });
    expect(authoringUiOf({ key: "a", ui: { inputUnit: "hours" } })).toEqual({});
  });
});
