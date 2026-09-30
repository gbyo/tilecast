import { describe, expect, it } from "vitest";
import {
  initialPreviewTime,
  parsePreviewTimeInput,
  previewTimeInputValue,
  resolvePreviewDate,
  resolvePreviewNow,
} from "./previewTime";

describe("preview time override", () => {
  it("round-trips a local instant through the datetime-local value", () => {
    const local = new Date(2026, 7, 24, 13, 30);
    const value = previewTimeInputValue(local);
    expect(value).toBe("2026-08-24T13:30");
    expect(parsePreviewTimeInput(value)?.getTime()).toBe(local.getTime());
  });

  it("reads a seconds-bearing value and rejects malformed input", () => {
    expect(parsePreviewTimeInput("2026-08-24T13:30:45")?.getSeconds()).toBe(45);
    expect(parsePreviewTimeInput("")).toBeNull();
    expect(parsePreviewTimeInput("2026-08-24")).toBeNull();
    expect(parsePreviewTimeInput("not-a-date")).toBeNull();
  });

  it("keeps the preview live unless a valid fixed instant is chosen", () => {
    expect(resolvePreviewNow(initialPreviewTime())).toBeUndefined();
    expect(
      resolvePreviewNow({ mode: "live", value: "2026-08-24T13:30" }),
    ).toBeUndefined();
    // A half-typed date must not freeze the preview on an invalid instant.
    expect(
      resolvePreviewNow({ mode: "fixed", value: "2026-08" }),
    ).toBeUndefined();
    expect(
      resolvePreviewNow({
        mode: "fixed",
        value: "2026-08-24T13:30",
      })?.getTime(),
    ).toBe(new Date(2026, 7, 24, 13, 30).getTime());
  });

  it("selects source records by the fixed instant's local calendar date", () => {
    expect(
      resolvePreviewDate({ mode: "live", value: "2026-08-24T13:30" }),
    ).toBeUndefined();
    expect(
      resolvePreviewDate({ mode: "fixed", value: "2026-08" }),
    ).toBeUndefined();
    expect(
      resolvePreviewDate({ mode: "fixed", value: "2026-08-24T13:30" }),
    ).toBe("2026-08-24");
  });
});
