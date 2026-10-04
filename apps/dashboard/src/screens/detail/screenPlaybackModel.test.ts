import { describe, expect, it } from "vitest";
import type { PlaylistAssignment } from "../../api/types";
import {
  activeSchedule,
  defaultContent,
  expectedNow,
  nextPrediction,
  orderedCandidates,
  playbackFaults,
  sameSelection,
  splitRelevantSchedules,
  type PlaybackPlan,
  type PlaybackPlanCandidate,
} from "./screenPlaybackModel";

const selection = (overrides = {}) => ({
  source: "schedule" as const,
  contentType: "playlist" as const,
  contentId: "playlist-1",
  name: "Lunch Menu",
  scheduleName: "Lunch Service",
  selectionId: "schedule-1",
  reason: "schedule_highest_precedence" as const,
  ...overrides,
});

const planWith = (
  selected: ReturnType<typeof selection> | undefined,
  candidates: PlaybackPlanCandidate[] = [],
  nextEvaluationAt?: string,
): PlaybackPlan => ({
  screenId: "screen-1",
  at: "2026-09-28T14:00:00Z",
  evaluatedAt: "2026-09-28T14:00:00Z",
  basis: "current_configuration",
  current: {
    selected,
    candidates,
    nextEvaluationAt,
    synchronization: { status: "current", manifestVersion: 3 },
    capabilities: {
      status: "not_applicable",
      reason: "no_widget_presentation_requirements",
    },
  },
});

const assignmentWith = (
  overrides: Partial<PlaylistAssignment> = {},
): PlaylistAssignment => ({
  screenId: "screen-1",
  manifestVersion: 3,
  synchronizationStatus: "current",
  groups: [],
  relevantSchedules: [],
  clockSkewWarningSeconds: 300,
  playbackDisabled: false,
  ...overrides,
});

describe("expectedNow", () => {
  it("summarizes a scheduled selection with its window", () => {
    const plan = planWith(selection(), [
      {
        source: "schedule",
        id: "schedule-1",
        status: "selected",
        reason: "schedule_highest_precedence",
        name: "Lunch Service",
        schedule: {
          scheduleId: "schedule-1",
          status: "selected",
          reason: "schedule_highest_precedence",
          priority: 50,
          specificity: 2,
          start: "2026-09-28T10:30:00-04:00",
          end: "2026-09-28T13:30:00-04:00",
        },
      },
    ]);
    expect(expectedNow(plan)).toMatchObject({
      name: "Lunch Menu",
      source: "schedule",
      scheduleId: "schedule-1",
      scheduleName: "Lunch Service",
      window: {
        start: "2026-09-28T10:30:00-04:00",
        end: "2026-09-28T13:30:00-04:00",
      },
    });
  });

  it("summarizes default assignment playback without a schedule", () => {
    const plan = planWith(
      selection({
        source: "assignment",
        name: "Morning Announcements",
        scheduleName: undefined,
        selectionId: undefined,
        reason: "assigned_fallback",
      }),
    );
    expect(expectedNow(plan)).toMatchObject({
      name: "Morning Announcements",
      source: "assignment",
      scheduleId: undefined,
    });
  });

  it("returns null when nothing is selected", () => {
    expect(expectedNow(planWith(undefined))).toBeNull();
    expect(expectedNow(undefined)).toBeNull();
  });
});

describe("defaultContent", () => {
  it("prefers the layout assignment", () => {
    expect(
      defaultContent(
        assignmentWith({
          layoutId: "layout-1",
          layoutName: "Lobby",
          playlistId: "playlist-1",
          playlistName: "Fallback",
        }),
      ),
    ).toMatchObject({ state: "assigned", kind: "layout", id: "layout-1" });
  });

  it("reports group-managed assignments with the owning group", () => {
    expect(
      defaultContent(
        assignmentWith({
          playlistId: "playlist-9",
          playlistName: "Morning Announcements",
          groups: [{ id: "group-1", name: "Cafeteria Displays" }],
        }),
      ),
    ).toMatchObject({
      state: "assigned",
      kind: "playlist",
      group: { id: "group-1", name: "Cafeteria Displays" },
    });
  });

  it("reports no default content", () => {
    expect(defaultContent(assignmentWith())).toEqual({ state: "none" });
    expect(defaultContent(undefined)).toEqual({ state: "none" });
  });
});

describe("splitRelevantSchedules", () => {
  it("separates display-control schedules from content selection", () => {
    const rows = [
      {
        id: "s-1",
        name: "Morning",
        playlistName: "News",
        presentationType: "playlist",
        priority: 10,
        enabled: true,
      },
      {
        id: "s-2",
        name: "Power off",
        playlistName: "",
        presentationType: "display_control",
        priority: 99,
        enabled: true,
      },
    ] as PlaylistAssignment["relevantSchedules"];
    const split = splitRelevantSchedules(rows);
    expect(split.content.map((row) => row.id)).toEqual(["s-1"]);
    expect(split.displayControl.map((row) => row.id)).toEqual(["s-2"]);
  });
});

describe("activeSchedule", () => {
  it("joins the winning selection with relevant schedule context", () => {
    const plan = planWith(selection());
    const assignment = assignmentWith({
      relevantSchedules: [
        {
          id: "schedule-1",
          name: "Lunch Service",
          playlistName: "Lunch Menu",
          presentationType: "playlist",
          priority: 50,
          enabled: true,
        },
      ],
    });
    expect(activeSchedule(plan, assignment)).toMatchObject({
      scheduleId: "schedule-1",
      name: "Lunch Service",
      presentationName: "Lunch Menu",
    });
  });

  it("is null for default playback", () => {
    const plan = planWith(
      selection({ source: "assignment", selectionId: undefined }),
    );
    expect(activeSchedule(plan, assignmentWith())).toBeNull();
  });
});

describe("sameSelection", () => {
  it("treats identical schedule wins as unchanged", () => {
    expect(sameSelection(selection(), selection())).toBe(true);
  });

  it("treats a different winning schedule as a change", () => {
    expect(
      sameSelection(selection(), selection({ selectionId: "schedule-2" })),
    ).toBe(false);
  });

  it("treats different default content as a change", () => {
    const left = selection({
      source: "assignment",
      contentId: "a",
      selectionId: undefined,
    });
    const right = selection({
      source: "assignment",
      contentId: "b",
      selectionId: undefined,
    });
    expect(sameSelection(left, right)).toBe(false);
  });

  it("treats missing selections symmetrically", () => {
    expect(sameSelection(undefined, undefined)).toBe(true);
    expect(sameSelection(selection(), undefined)).toBe(false);
  });
});

describe("nextPrediction", () => {
  const at = "2026-09-28T17:30:00Z";
  const current = planWith(selection(), [], at);

  it("reports unknown without a boundary", () => {
    expect(
      nextPrediction(planWith(selection()), planWith(selection()), "ready"),
    ).toEqual({ state: "unknown" });
  });

  it("reports unchanged when the boundary keeps the selection", () => {
    expect(
      nextPrediction(current, planWith(selection(), [], at), "ready"),
    ).toMatchObject({ state: "unchanged", at, name: "Lunch Menu" });
  });

  it("reports a change to default content at the boundary", () => {
    const future = planWith(
      selection({
        source: "assignment",
        name: "Morning Announcements",
        contentId: "playlist-2",
        selectionId: undefined,
        reason: "assigned_fallback",
      }),
    );
    expect(nextPrediction(current, future, "ready")).toMatchObject({
      state: "changed",
      at,
      name: "Morning Announcements",
      source: "assignment",
    });
  });

  it("never claims a change while the prediction loads or fails", () => {
    expect(nextPrediction(current, undefined, "loading")).toEqual({
      state: "loading",
    });
    expect(nextPrediction(current, undefined, "error")).toEqual({
      state: "failed",
      at,
    });
  });
});

describe("orderedCandidates", () => {
  it("keeps precedence order stable regardless of server order", () => {
    const candidates = [
      { source: "assignment", status: "inactive", reason: "no_assignment" },
      { source: "schedule", status: "selected", reason: "x", name: "B" },
      { source: "takeover", status: "inactive", reason: "no_active_takeover" },
      { source: "schedule", status: "inactive", reason: "y", name: "A" },
      {
        source: "quick_present",
        status: "inactive",
        reason: "no_active_quick_present",
      },
    ] as PlaybackPlanCandidate[];
    expect(orderedCandidates(candidates).map((entry) => entry.source)).toEqual([
      "takeover",
      "quick_present",
      "schedule",
      "schedule",
      "assignment",
    ]);
  });
});

describe("playbackFaults", () => {
  it("is empty for healthy playback", () => {
    expect(playbackFaults(assignmentWith())).toEqual([]);
    expect(playbackFaults(undefined)).toEqual([]);
  });

  it("collects each actionable fault once", () => {
    const faults = playbackFaults(
      assignmentWith({
        lastSynchronizationError: "stalled",
        lastPlaybackError: "decoder",
        configurationError: "rejected",
        scheduleEvaluationError: "bad window",
        websiteFailureCategory: "blocked_host",
        websiteState: "blocked",
        deviceClockOffsetSeconds: 900,
      }),
    );
    expect(faults.map((fault) => fault.kind)).toEqual([
      "synchronization",
      "playback",
      "configuration",
      "schedule",
      "website",
      "clock",
    ]);
  });

  it("ignores a healthy website report and small clock skew", () => {
    const faults = playbackFaults(
      assignmentWith({
        websiteFailureCategory: "blocked_host",
        websiteState: "loaded",
        deviceClockOffsetSeconds: 12,
      }),
    );
    expect(faults).toEqual([]);
  });
});
