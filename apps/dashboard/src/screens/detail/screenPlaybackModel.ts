import type { components } from "@tilecast/api-schema/generated/openapi";
import type { PlaylistAssignment } from "../../api/types";

export type PlaybackPlan = components["schemas"]["PlaybackPlan"];
export type PlaybackPlanSelection =
  components["schemas"]["PlaybackPlanSelection"];
export type PlaybackPlanCandidate =
  components["schemas"]["PlaybackPlanCandidate"];

export type PlaybackSource =
  "takeover" | "quick_present" | "schedule" | "assignment";

/** Stable precedence order for operator-facing display. Never reorders winners. */
export const PLAYBACK_SOURCE_RANK: Record<PlaybackSource, number> = {
  takeover: 0,
  quick_present: 1,
  schedule: 2,
  assignment: 3,
};

export function isPlaybackSource(value: unknown): value is PlaybackSource {
  return (
    value === "takeover" ||
    value === "quick_present" ||
    value === "schedule" ||
    value === "assignment"
  );
}

export type ExpectedNow = {
  name?: string;
  source: PlaybackSource;
  contentType: PlaybackPlanSelection["contentType"];
  contentId: string;
  /** Present when a schedule selects the content; the schedule id. */
  scheduleId?: string;
  scheduleName?: string;
  /** Active window of the winning schedule candidate, when reported. */
  window?: { start?: string; end?: string };
};

/**
 * What current configuration expects this screen to show. Returns null when
 * the plan carries no current selection (no default and nothing active).
 */
export function expectedNow(plan?: PlaybackPlan): ExpectedNow | null {
  const selected = plan?.current?.selected;
  if (!selected || !isPlaybackSource(selected.source)) return null;
  const candidate = plan?.current?.candidates.find(
    (entry) =>
      entry.source === selected.source &&
      (selected.selectionId == null || entry.id === selected.selectionId),
  );
  return {
    name: selected.name,
    source: selected.source,
    contentType: selected.contentType,
    contentId: selected.contentId,
    scheduleId:
      selected.source === "schedule" ? selected.selectionId : undefined,
    scheduleName: selected.scheduleName,
    window:
      candidate?.schedule?.start || candidate?.schedule?.end
        ? {
            start: candidate?.schedule?.start,
            end: candidate?.schedule?.end,
          }
        : undefined,
  };
}

export type DefaultContent =
  | { state: "none" }
  | {
      state: "assigned";
      kind: "playlist" | "layout";
      id: string;
      name?: string;
      revision?: number;
      group?: { id: string; name: string };
    };

/** Default content plays when no takeover, Show now, or schedule is active. */
export function defaultContent(
  assignment?: PlaylistAssignment,
): DefaultContent {
  if (!assignment) return { state: "none" };
  const group = assignment.groups?.[0];
  if (assignment.layoutId) {
    return {
      state: "assigned",
      kind: "layout",
      id: assignment.layoutId,
      name: assignment.layoutName,
      revision: assignment.layoutRevision,
      group,
    };
  }
  if (assignment.playlistId) {
    return {
      state: "assigned",
      kind: "playlist",
      id: assignment.playlistId,
      name: assignment.playlistName,
      revision: assignment.playlistRevision,
      group,
    };
  }
  return { state: "none" };
}

export type RelevantSchedule = PlaylistAssignment["relevantSchedules"][number];

/**
 * Content schedules select playback content; display-control schedules drive
 * power/input policy through a separate authority and must not appear in the
 * content precedence story.
 */
export function splitRelevantSchedules(schedules?: RelevantSchedule[]): {
  content: RelevantSchedule[];
  displayControl: RelevantSchedule[];
} {
  const content: RelevantSchedule[] = [];
  const displayControl: RelevantSchedule[] = [];
  for (const schedule of schedules ?? []) {
    if (schedule.presentationType === "display_control") {
      displayControl.push(schedule);
    } else {
      content.push(schedule);
    }
  }
  return { content, displayControl };
}

export type ActiveSchedule = {
  scheduleId: string;
  name: string;
  presentationName?: string;
  window?: { start?: string; end?: string };
};

/**
 * The schedule behind expected playback, joining the winning selection with
 * the assignment's relevant schedules for operator context. Null unless the
 * current selection comes from a schedule.
 */
export function activeSchedule(
  plan?: PlaybackPlan,
  assignment?: PlaylistAssignment,
): ActiveSchedule | null {
  const expected = expectedNow(plan);
  if (!expected || expected.source !== "schedule" || !expected.scheduleId) {
    return null;
  }
  const relevant = assignment?.relevantSchedules?.find(
    (schedule) => schedule.id === expected.scheduleId,
  );
  return {
    scheduleId: expected.scheduleId,
    name: expected.scheduleName ?? relevant?.name ?? "",
    presentationName: expected.name ?? relevant?.playlistName ?? undefined,
    window: expected.window,
  };
}

/**
 * Identity comparison for the truthful "Next" row: the same content selected
 * through the same source is not a change, even across an evaluation boundary.
 */
export function sameSelection(
  left?: Pick<
    PlaybackPlanSelection,
    "source" | "contentType" | "contentId" | "selectionId"
  >,
  right?: Pick<
    PlaybackPlanSelection,
    "source" | "contentType" | "contentId" | "selectionId"
  >,
): boolean {
  if (!left || !right) return left == null && right == null;
  if (left.source !== right.source) return false;
  if (left.source === "schedule" || left.source === "takeover") {
    // A different schedule or takeover wins: a change even when the
    // underlying presentation happens to match.
    return (left.selectionId ?? null) === (right.selectionId ?? null);
  }
  return (
    left.contentType === right.contentType && left.contentId === right.contentId
  );
}

export type NextPrediction =
  | { state: "unknown" }
  | { state: "loading" }
  | { state: "failed"; at: string }
  | { state: "unchanged"; at: string; name?: string }
  | {
      state: "changed";
      at: string;
      name?: string;
      source: PlaybackSource;
      scheduleId?: string;
      scheduleName?: string;
    };

/**
 * Truthful next-boundary summary. The boundary alone never claims a change;
 * only the playback-plan authority at that instant can.
 */
export function nextPrediction(
  current: PlaybackPlan | undefined,
  future: PlaybackPlan | undefined,
  futureState: "loading" | "error" | "ready",
): NextPrediction {
  const at = current?.current?.nextEvaluationAt;
  if (!at) return { state: "unknown" };
  if (futureState === "loading") return { state: "loading" };
  if (futureState === "error" || !future?.current)
    return { state: "failed", at };
  const now = current?.current?.selected;
  const next = future.current.selected;
  if (sameSelection(now, next)) {
    return { state: "unchanged", at, name: now?.name };
  }
  if (!next || !isPlaybackSource(next.source)) {
    return { state: "changed", at, name: undefined, source: "assignment" };
  }
  return {
    state: "changed",
    at,
    name: next.name,
    source: next.source,
    scheduleId: next.source === "schedule" ? next.selectionId : undefined,
    scheduleName: next.scheduleName,
  };
}

/** Candidates in stable precedence order; the server order is authoritative. */
export function orderedCandidates(
  candidates?: PlaybackPlanCandidate[],
): PlaybackPlanCandidate[] {
  return [...(candidates ?? [])].sort((left, right) => {
    const rank =
      (PLAYBACK_SOURCE_RANK[left.source] ?? 99) -
      (PLAYBACK_SOURCE_RANK[right.source] ?? 99);
    if (rank !== 0) return rank;
    return (left.name ?? "").localeCompare(right.name ?? "");
  });
}

export type PlaybackFault =
  | "synchronization"
  | "playback"
  | "configuration"
  | "schedule"
  | "website"
  | "clock";

/** Actionable faults the Overview must not bury. Healthy state is absent. */
export function playbackFaults(
  assignment?: PlaylistAssignment,
): { kind: PlaybackFault; message?: string }[] {
  if (!assignment) return [];
  const faults: { kind: PlaybackFault; message?: string }[] = [];
  if (assignment.lastSynchronizationError) {
    faults.push({
      kind: "synchronization",
      message: assignment.lastSynchronizationError,
    });
  }
  if (assignment.lastPlaybackError) {
    faults.push({ kind: "playback", message: assignment.lastPlaybackError });
  }
  if (assignment.configurationError) {
    faults.push({
      kind: "configuration",
      message: assignment.configurationError,
    });
  }
  if (assignment.scheduleEvaluationError) {
    faults.push({
      kind: "schedule",
      message: assignment.scheduleEvaluationError,
    });
  }
  const websiteFailed =
    assignment.websiteFailureCategory &&
    ["failed", "timed_out", "blocked", "showing_fallback"].includes(
      assignment.websiteState ?? "",
    );
  if (websiteFailed) {
    faults.push({
      kind: "website",
      message: assignment.websiteFailureCategory,
    });
  }
  const offset = Math.abs(assignment.deviceClockOffsetSeconds ?? 0);
  if (offset > (assignment.clockSkewWarningSeconds ?? 300)) {
    faults.push({ kind: "clock" });
  }
  return faults;
}
