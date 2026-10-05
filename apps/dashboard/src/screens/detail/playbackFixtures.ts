import type { PlaylistAssignment, Schedule } from "../../api/types";
import type {
  PlaybackPlan,
  PlaybackPlanCandidate,
  PlaybackPlanSelection,
} from "./screenPlaybackModel";

export const selectionFixture = (
  overrides: Partial<PlaybackPlanSelection> = {},
): PlaybackPlanSelection => ({
  source: "schedule",
  contentType: "playlist",
  contentId: "playlist-1",
  name: "Lunch Menu",
  scheduleName: "Lunch Service",
  selectionId: "schedule-1",
  reason: "schedule_highest_precedence",
  ...overrides,
});

export const candidateFixture = (
  overrides: Partial<PlaybackPlanCandidate> = {},
): PlaybackPlanCandidate => ({
  source: "schedule",
  status: "inactive",
  reason: "schedule_not_active",
  ...overrides,
});

export const planFixture = (
  overrides: {
    selected?: PlaybackPlanSelection | null;
    candidates?: PlaybackPlanCandidate[];
    nextEvaluationAt?: string;
  } = {},
): PlaybackPlan => ({
  screenId: "screen-1",
  at: "2026-09-28T14:00:00Z",
  evaluatedAt: "2026-09-28T14:00:00Z",
  basis: "current_configuration",
  current: {
    ...(overrides.selected === null ? {} : { selected: selectionFixture() }),
    ...(overrides.selected
      ? { selected: selectionFixture(overrides.selected) }
      : {}),
    candidates: overrides.candidates ?? [
      candidateFixture({
        source: "takeover",
        reason: "no_active_takeover",
      }),
      candidateFixture({
        source: "quick_present",
        reason: "no_active_quick_present",
      }),
      candidateFixture({
        source: "schedule",
        id: "schedule-1",
        name: "Lunch Service",
        status: "selected",
        reason: "schedule_highest_precedence",
        schedule: {
          scheduleId: "schedule-1",
          status: "selected",
          reason: "schedule_highest_precedence",
          priority: 50,
          specificity: 2,
          start: "2026-09-28T10:30:00-04:00",
          end: "2026-09-28T13:30:00-04:00",
        },
      }),
      candidateFixture({
        source: "assignment",
        status: "superseded",
        reason: "schedule_highest_precedence",
      }),
    ],
    nextEvaluationAt: overrides.nextEvaluationAt,
    synchronization: { status: "current", manifestVersion: 3 },
    capabilities: {
      status: "not_applicable",
      reason: "no_widget_presentation_requirements",
    },
  },
});

export const relevantScheduleFixture = (
  overrides: Partial<PlaylistAssignment["relevantSchedules"][number]> = {},
): PlaylistAssignment["relevantSchedules"][number] => ({
  id: "schedule-1",
  name: "Lunch Service",
  playlistName: "Lunch Menu",
  presentationType: "playlist",
  priority: 50,
  enabled: true,
  ...overrides,
});

export const assignmentFixture = (
  overrides: Partial<PlaylistAssignment> = {},
): PlaylistAssignment => ({
  screenId: "screen-1",
  manifestVersion: 3,
  synchronizationStatus: "current",
  playbackState: "playing",
  groups: [],
  relevantSchedules: [],
  clockSkewWarningSeconds: 300,
  playbackDisabled: false,
  ...overrides,
});

export const scheduleFixture = (
  overrides: Partial<Schedule> = {},
): Schedule => ({
  id: "schedule-1",
  name: "Lunch Service",
  description: "",
  playlistId: "playlist-1",
  playlistName: "Lunch Menu",
  presentationType: "playlist",
  type: "weekly",
  timezone: "America/New_York",
  priority: 50,
  specificity: 2,
  enabled: true,
  dailyStart: "10:30",
  dailyEnd: "13:30",
  daysOfWeek: [1, 2, 3, 4, 5],
  targets: [],
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  ...overrides,
});
