import { describe, expect, it } from "vitest";
import scheduleFixtures from "../../../../packages/manifest-schema/schedule-fixtures.json";
import {
  presentationOverrideActive,
  resolveDisplayPolicy,
  resolveSelection,
  scheduleApplies,
} from "./schedule";
import type { Manifest, ManifestSchedule } from "./types";

function baseManifest(overrides: Partial<Manifest> = {}): Manifest {
  return {
    schemaVersion: 11,
    manifestVersion: 1,
    screenId: "screen-1",
    generatedAt: "2026-07-17T00:00:00Z",
    mode: "presentation",
    playlist: { id: "direct", revision: 1, name: "Direct", items: [] },
    playlists: [{ id: "scheduled", revision: 1, name: "Scheduled", items: [] }],
    schedules: [],
    assets: [],
    serverTime: "2026-07-17T00:00:00Z",
    prefetchHorizonDays: 7,
    activationGraceSeconds: 30,
    websites: [],
    ...overrides,
  };
}

function weekly(overrides: Partial<ManifestSchedule> = {}): ManifestSchedule {
  return {
    id: "sched-1",
    playlistId: "scheduled",
    type: "weekly",
    timezone: "America/New_York",
    priority: 10,
    specificity: 1,
    dailyStart: "09:00",
    dailyEnd: "17:00",
    daysOfWeek: [1, 2, 3, 4, 5], // Mon-Fri
    ...overrides,
  };
}

it.each(scheduleFixtures)(
  "matches the shared schedule case $name",
  (fixture) => {
    const manifest = baseManifest({
      playlist: {
        id: fixture.fallbackPlaylistId,
        revision: 1,
        name: "Fallback",
        items: [],
      },
      schedules: fixture.schedules as ManifestSchedule[],
    });
    const selection = resolveSelection(manifest, new Date(fixture.now));
    expect(selection.playlistId).toBe(fixture.expectedPlaylistId);
    expect(selection.scheduleId).toBe(fixture.expectedScheduleId ?? null);
    expect(selection.source).toBe(
      fixture.expectedSource === "direct_fallback"
        ? "direct"
        : fixture.expectedSource,
    );
    if (fixture.expectedNextTransitionAt) {
      expect(selection.nextTransitionAt).toBe(
        new Date(fixture.expectedNextTransitionAt).toISOString(),
      );
    }
  },
);

describe("scheduleApplies", () => {
  // 2026-07-17 is a Friday. 15:00 UTC = 11:00 in New York (EDT).
  const fridayMorningNY = new Date("2026-07-17T15:00:00Z");
  // 02:00 in New York on Friday.
  const fridayNightNY = new Date("2026-07-17T06:00:00Z");

  it("matches inside a weekday window in the schedule timezone", () => {
    expect(scheduleApplies(weekly(), fridayMorningNY)).toBe(true);
  });

  it("does not match outside hours", () => {
    expect(scheduleApplies(weekly(), fridayNightNY)).toBe(false);
  });

  it("does not match on unselected days", () => {
    // Sunday 2026-07-19, 11:00 NY.
    const sunday = new Date("2026-07-19T15:00:00Z");
    expect(scheduleApplies(weekly(), sunday)).toBe(false);
  });

  it("half-open end: exactly the end minute is excluded", () => {
    // 17:00 NY on Friday = 21:00 UTC.
    const atEnd = new Date("2026-07-17T21:00:00Z");
    expect(scheduleApplies(weekly(), atEnd)).toBe(false);
    const justBefore = new Date("2026-07-17T20:59:00Z");
    expect(scheduleApplies(weekly(), justBefore)).toBe(true);
  });

  it("overnight window belongs to the start day", () => {
    const overnight = weekly({
      dailyStart: "22:00",
      dailyEnd: "06:00",
      daysOfWeek: [5], // Friday nights
    });
    // Friday 23:00 NY = Sat 03:00 UTC.
    expect(scheduleApplies(overnight, new Date("2026-07-18T03:00:00Z"))).toBe(
      true,
    );
    // Saturday 02:00 NY (early morning after Friday) = Sat 06:00 UTC.
    expect(scheduleApplies(overnight, new Date("2026-07-18T06:00:00Z"))).toBe(
      true,
    );
    // Saturday 07:00 NY — past the end.
    expect(scheduleApplies(overnight, new Date("2026-07-18T11:00:00Z"))).toBe(
      false,
    );
    // Thursday 23:00 NY — wrong start day.
    expect(scheduleApplies(overnight, new Date("2026-07-17T03:00:00Z"))).toBe(
      false,
    );
  });

  it("respects start and end dates in the schedule timezone", () => {
    const bounded = weekly({ startDate: "2026-07-20", endDate: "2026-07-25" });
    expect(scheduleApplies(bounded, new Date("2026-07-17T15:00:00Z"))).toBe(
      false,
    );
  });

  it("keeps the after-midnight portion of the final bounded day", () => {
    const bounded = weekly({
      dailyStart: "22:00",
      dailyEnd: "06:00",
      daysOfWeek: [5],
      startDate: "2026-07-17",
      endDate: "2026-07-17",
    });
    // Saturday 02:00 belongs to the Friday window whose start day is allowed.
    expect(scheduleApplies(bounded, new Date("2026-07-18T06:00:00Z"))).toBe(
      true,
    );
  });

  it("uses the shared DST gap and repeated-time policies", () => {
    const spring = weekly({
      dailyStart: "02:30:15",
      dailyEnd: "04:00",
      daysOfWeek: [0],
    });
    expect(scheduleApplies(spring, new Date("2026-03-08T07:00:00Z"))).toBe(
      true,
    );
    const fall = weekly({
      dailyStart: "01:30:10",
      dailyEnd: "01:45:25",
      daysOfWeek: [0],
    });
    // The repeated window spans earlier start through later end.
    expect(scheduleApplies(fall, new Date("2026-11-01T06:35:00Z"))).toBe(true);
  });

  it("one-time schedules use half-open UTC instants", () => {
    const oneTime: ManifestSchedule = {
      id: "ot",
      playlistId: "scheduled",
      type: "one_time",
      timezone: "UTC",
      priority: 5,
      specificity: 2,
      oneTimeStart: "2026-07-17T10:00:00Z",
      oneTimeEnd: "2026-07-17T12:00:00Z",
    };
    expect(scheduleApplies(oneTime, new Date("2026-07-17T10:00:00Z"))).toBe(
      true,
    );
    expect(scheduleApplies(oneTime, new Date("2026-07-17T12:00:00Z"))).toBe(
      false,
    );
  });

  it("an unknown timezone never applies rather than throwing", () => {
    expect(
      scheduleApplies(weekly({ timezone: "Not/AZone" }), fridayMorningNY),
    ).toBe(false);
  });
});

describe("resolveDisplayPolicy", () => {
  it("uses schedule precedence and marks a power-off policy", () => {
    const result = resolveDisplayPolicy(
      baseManifest({
        schedules: [
          weekly({
            id: "power-on",
            priority: 10,
            displayAction: { type: "display_power_on" },
            playlistId: null,
          }),
          weekly({
            id: "power-off",
            priority: 20,
            displayAction: { type: "display_power_off" },
            playlistId: null,
          }),
        ],
      }),
      new Date("2026-07-17T15:00:00Z"),
    );
    expect(result.scheduleId).toBe("power-off");
    expect(result.policyState).toBe("powered_off_by_policy");
  });
});

describe("resolveSelection", () => {
  const inWindow = new Date("2026-07-17T15:00:00Z");

  it("falls back to the direct assignment with no schedules", () => {
    const selection = resolveSelection(baseManifest(), inWindow);
    expect(selection).toMatchObject({ playlistId: "direct", source: "direct" });
  });

  it("an applicable schedule beats the direct assignment", () => {
    const manifest = baseManifest({ schedules: [weekly()] });
    const selection = resolveSelection(manifest, inWindow);
    expect(selection).toMatchObject({
      playlistId: "scheduled",
      scheduleId: "sched-1",
      source: "schedule",
    });
  });

  it("higher priority wins; specificity breaks ties", () => {
    const manifest = baseManifest({
      playlists: [
        { id: "a", revision: 1, name: "A", items: [] },
        { id: "b", revision: 1, name: "B", items: [] },
      ],
      schedules: [
        weekly({ id: "low", playlistId: "a", priority: 1, specificity: 9 }),
        weekly({ id: "high", playlistId: "b", priority: 2, specificity: 0 }),
      ],
    });
    expect(resolveSelection(manifest, inWindow).playlistId).toBe("b");
  });

  it("later effective start then stable ID break full precedence ties", () => {
    const manifest = baseManifest({
      playlists: [
        { id: "early", revision: 1, name: "Early", items: [] },
        { id: "late", revision: 1, name: "Late", items: [] },
      ],
      schedules: [
        weekly({ id: "a", playlistId: "early", dailyStart: "08:00" }),
        weekly({ id: "z", playlistId: "late", dailyStart: "10:00" }),
      ],
    });
    expect(resolveSelection(manifest, inWindow).playlistId).toBe("late");

    manifest.schedules = [
      weekly({ id: "z", playlistId: "late" }),
      weekly({ id: "a", playlistId: "early" }),
    ];
    expect(resolveSelection(manifest, inWindow).playlistId).toBe("early");
  });

  it("reports the exact next transition for an unattended wakeup", () => {
    const selection = resolveSelection(
      baseManifest({ schedules: [weekly()] }),
      new Date("2026-07-17T12:59:00Z"),
    );
    expect(selection.nextTransitionAt).toBe("2026-07-17T13:00:00.000Z");
  });

  it("an active takeover overrides everything, honoring [start, end)", () => {
    const manifest = baseManifest({
      schedules: [weekly()],
      takeover: {
        id: "em-1",
        playlistId: "takeover-pl",
        activatedAt: "2026-07-17T14:00:00Z",
        expiresAt: "2026-07-17T16:00:00Z",
      },
    });
    expect(resolveSelection(manifest, inWindow)).toMatchObject({
      playlistId: "takeover-pl",
      takeoverId: "em-1",
      source: "takeover",
    });
    // After expiry the schedule returns.
    expect(
      resolveSelection(manifest, new Date("2026-07-17T16:00:00Z")).source,
    ).toBe("schedule");
  });

  it("schedules the activation of a future takeover", () => {
    const manifest = baseManifest({
      takeover: {
        id: "future-takeover",
        playlistId: "takeover-pl",
        activatedAt: "2026-07-17T16:00:00Z",
        expiresAt: "2026-07-17T17:00:00Z",
      },
    });
    expect(
      resolveSelection(manifest, new Date("2026-07-17T15:00:00Z")),
    ).toMatchObject({
      playlistId: "direct",
      source: "direct",
      nextTransitionAt: "2026-07-17T16:00:00.000Z",
    });
  });

  it("accepts the legacy emergency manifest key during staggered upgrades", () => {
    const manifest = baseManifest({
      emergency: {
        id: "legacy-1",
        playlistId: "takeover-pl",
        activatedAt: "2026-07-17T14:00:00Z",
        expiresAt: "2026-07-17T16:00:00Z",
      },
    });
    expect(resolveSelection(manifest, inWindow)).toMatchObject({
      playlistId: "takeover-pl",
      takeoverId: "legacy-1",
      source: "takeover",
    });
  });

  it("restores the direct assignment when no schedule is active", () => {
    const manifest = baseManifest({ schedules: [weekly()] });
    const nightSelection = resolveSelection(
      manifest,
      new Date("2026-07-17T06:00:00Z"),
    );
    expect(nightSelection).toMatchObject({
      playlistId: "direct",
      source: "direct",
    });
  });

  it("selects Quick Present above schedules and returns to current scheduling after expiry", () => {
    const manifest = baseManifest({
      schedules: [weekly()],
      playlist: { id: "direct", revision: 1, name: "Direct", items: [] },
      presentationOverride: {
        id: "present-1",
        contentType: "playlist",
        contentId: "quick-playlist",
        contentName: "Open house",
        startedAt: "2026-07-17T14:30:00Z",
        expiresAt: "2026-07-17T15:30:00Z",
        playlistId: "quick-playlist",
      },
    });
    expect(presentationOverrideActive(manifest, inWindow)).toBe(true);
    expect(resolveSelection(manifest, inWindow)).toMatchObject({
      playlistId: "quick-playlist",
      source: "quick_present",
      playbackAnchor: "2026-07-17T14:30:00Z",
    });
    expect(
      resolveSelection(manifest, new Date("2026-07-17T15:30:00Z")).source,
    ).toBe("schedule");
  });

  it("lets an Emergency Takeover preempt Quick Present", () => {
    const manifest = baseManifest({
      presentationOverride: {
        id: "present-1",
        contentType: "playlist",
        contentId: "quick-playlist",
        contentName: "Open house",
        startedAt: "2026-07-17T14:30:00Z",
        expiresAt: "2026-07-17T15:30:00Z",
        playlistId: "quick-playlist",
      },
      takeover: {
        id: "takeover-1",
        playlistId: "emergency-playlist",
        activatedAt: "2026-07-17T14:45:00Z",
        expiresAt: "2026-07-17T15:30:00Z",
      },
    });
    expect(resolveSelection(manifest, inWindow)).toMatchObject({
      playlistId: "emergency-playlist",
      source: "takeover",
    });
  });

  it("supports an until-stopped Quick Present session", () => {
    const manifest = baseManifest({
      presentationOverride: {
        id: "present-forever",
        contentType: "asset",
        contentId: "virtual-present-forever",
        contentName: "Welcome",
        startedAt: "2026-07-17T14:30:00Z",
        expiresAt: null,
        playlistId: "virtual-present-forever",
      },
    });
    expect(
      presentationOverrideActive(manifest, new Date("2030-01-01T00:00:00Z")),
    ).toBe(true);
    expect(
      resolveSelection(manifest, new Date("2030-01-01T00:00:00Z")),
    ).toMatchObject({
      playlistId: "virtual-present-forever",
      source: "quick_present",
    });
  });
});
