import { describe, expect, it } from "vitest";
import { decideRest, policyFromConfig } from "./policy";
import type { SelectionFacts } from "@tilecast/player-runtime/projection";

const weekdays = {
  activeHoursEnabled: true,
  activeHoursTimezone: "America/Chicago",
  activeHoursDays: [1, 2, 3, 4, 5],
  activeHoursStart: "07:30",
  activeHoursEnd: "17:00",
  outsideActiveHoursDisplay: "custom_text",
  outsideActiveHoursText: "Open at 7:30",
  unrelated: "dropped",
};
const selection = (source: string): SelectionFacts => ({
  source,
  contentType: "playlist",
  contentId: "playlist-1",
  selectionId: null,
  playlistId: "playlist-1",
  layoutId: null,
  scheduleId: null,
  takeoverId: null,
  nextTransitionAt: null,
});
const policy = (source: string | null = "schedule", offset = 0) =>
  policyFromConfig(
    {
      configRevision: 4,
      power: weekdays,
      branding: { textColor: "#112233", logo: "x" },
    },
    source ? selection(source) : null,
    7,
    offset,
  );
const at = (iso: string) => Date.parse(iso);

describe("rest policy without the server", () => {
  it("keeps only the values the policy reads", () => {
    const snapshot = policy();
    expect(snapshot.power).not.toHaveProperty("unrelated");
    expect(snapshot.branding).toEqual({ textColor: "#112233" });
  });

  it("rests outside active hours and shows the configured surface", () => {
    const decision = decideRest(policy(), at("2026-09-24T12:00:00Z"));
    expect(decision).toMatchObject({
      resting: true,
      state: "off_hours",
      presentation: {
        state: "sleep",
        display: "custom_text",
        text: "Open at 7:30",
        textColor: "#112233",
      },
    });
    expect(decision.reevaluateInMs).toBe(30 * 60_000);
  });

  it("wakes inside active hours", () => {
    expect(decideRest(policy(), at("2026-09-24T13:00:00Z"))).toMatchObject({
      resting: false,
      state: "active",
    });
  });

  it("lets a Takeover or Quick Present outrank rest, but not a schedule or direct assignment", () => {
    const night = at("2026-09-24T03:00:00Z");
    expect(decideRest(policy("takeover"), night).resting).toBe(false);
    expect(decideRest(policy("quick_present"), night).resting).toBe(false);
    expect(decideRest(policy("schedule"), night).resting).toBe(true);
    expect(decideRest(policy("direct"), night).resting).toBe(true);
    // Rest is still reported honestly while the override shows content.
    expect(decideRest(policy("takeover"), night).state).toBe("off_hours");
  });

  it("uses the server-corrected clock", () => {
    // The device is an hour behind. At 12:30Z device time the server says 13:30Z.
    expect(
      decideRest(policy("schedule", 0), at("2026-09-24T12:00:00Z")).resting,
    ).toBe(true);
    expect(
      decideRest(policy("schedule", 3_600_000), at("2026-09-24T12:00:00Z"))
        .resting,
    ).toBe(false);
  });

  it("never rests without a policy or with active hours off", () => {
    expect(decideRest(undefined, at("2026-09-24T03:00:00Z")).resting).toBe(
      false,
    );
    const off = policyFromConfig(
      { configRevision: 1, power: { activeHoursEnabled: false } },
      null,
      undefined,
      0,
    );
    expect(decideRest(off, at("2026-09-24T03:00:00Z"))).toMatchObject({
      resting: false,
      state: "active",
    });
  });
});
