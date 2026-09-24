import { describe, expect, it } from "vitest";
import { parseCountdownFormat, resolveCountdownTarget } from "./countdown";

describe("resolveCountdownTarget", () => {
  const now = new Date("2026-07-21T12:00:00Z");

  it("rolls a daily local countdown to today's occurrence", () => {
    expect(
      resolveCountdownTarget("2026-07-20T14:00:00", "UTC", "daily", now),
    ).toBe(Date.parse("2026-07-21T14:00:00Z"));
  });

  it("rolls a weekly countdown forward at the exact occurrence", () => {
    expect(
      resolveCountdownTarget("2026-07-14T12:00:00", "UTC", "weekly", now),
    ).toBe(Date.parse("2026-07-28T12:00:00Z"));
  });

  it("clamps a recurring month to its last day", () => {
    expect(
      resolveCountdownTarget(
        "2026-01-31T09:00:00",
        "UTC",
        "monthly",
        new Date("2026-02-01T12:00:00Z"),
      ),
    ).toBe(Date.parse("2026-02-28T09:00:00Z"));
  });

  it("preserves local wall time across daylight-saving changes", () => {
    expect(
      resolveCountdownTarget(
        "2026-03-01T09:00:00",
        "America/New_York",
        "weekly",
        new Date("2026-03-07T20:00:00Z"),
      ),
    ).toBe(Date.parse("2026-03-08T13:00:00Z"));
  });
});

describe("parseCountdownFormat", () => {
  it("decodes the v2 typed format", () => {
    expect(
      parseCountdownFormat(
        "countdown:v2:2026-12-01T09%3A00:America%2FNew_York:countdown:weekly:hide:0110:Board+meeting",
      ),
    ).toEqual({
      target: "2026-12-01T09:00",
      timezone: "America/New_York",
      mode: "countdown",
      recurrence: "weekly",
      completionAction: "hide",
      visibleUnits: "0110",
      completionText: "Board meeting",
    });
  });
});
