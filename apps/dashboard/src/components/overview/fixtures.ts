import type { Schedule, Screen, UpdateDeployment } from "../../api/types";
import type { Incident } from "../../pages/ActivityIncidentShared";

/** Test builders. Every field a screen must carry, with neutral defaults. */
export function screen(overrides: Partial<Screen> = {}): Screen {
  return {
    id: "screen-1",
    name: "Lobby",
    description: "",
    location: "Main Office",
    platform: "android",
    deviceManufacturer: "Amazon",
    deviceModel: "Fire TV",
    androidVersion: "11",
    playerVersion: "1.0.0",
    screenWidth: 1920,
    screenHeight: 1080,
    density: 1,
    locale: "en-US",
    timezone: "UTC",
    enabled: true,
    pairedAt: "2026-01-01T00:00:00Z",
    lastContactAt: "2026-09-29T11:59:00Z",
    status: "online",
    hasActiveCredential: true,
    ...overrides,
  };
}

export function incident(overrides: Partial<Incident> = {}): Incident {
  return {
    id: "incident-1",
    incidentType: "playback",
    severity: "error",
    status: "open",
    title: "Playback failed",
    description: "",
    openedAt: "2026-09-29T10:00:00Z",
    lastSeenAt: "2026-09-29T11:00:00Z",
    primaryScreenId: "screen-1",
    affectedScreens: 1,
    occurrenceCount: 1,
    ...overrides,
  };
}

export function deployment(
  overrides: Partial<UpdateDeployment> = {},
): UpdateDeployment {
  return {
    id: "deployment-1",
    name: "Spring rollout",
    mode: "all",
    status: "completed",
    createdAt: "2026-09-20T00:00:00Z",
    platform: "android",
    versionCode: 10,
    versionName: "1.2.0",
    targetCount: 4,
    succeededCount: 4,
    failedCount: 0,
    waitingForUserCount: 0,
    ...overrides,
  };
}

export function schedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: "schedule-1",
    name: "Lunch menu",
    description: "",
    playlistId: "playlist-1",
    playlistName: "Lunch loop",
    presentationType: "playlist",
    type: "weekly",
    timezone: "UTC",
    priority: 1,
    specificity: 1,
    enabled: true,
    dailyStart: "11:00",
    dailyEnd: "13:00",
    daysOfWeek: [0, 1, 2, 3, 4, 5, 6],
    targets: [{ type: "screen", id: "screen-1", name: "Lobby" }],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}
