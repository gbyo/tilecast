import { expect, type APIRequestContext } from "@playwright/test";

// Stable IDs from apps/server/internal/demo/ids.go. A reset recreates every
// record under the same ID.
export const ids = {
  owner: "de300001-0000-4000-8000-000000000001",
  highSchool: "de300002-0000-4000-8000-000000000001",
  cafeteriaEast: "de300003-0000-4000-8000-000000000001",
  boardRoom: "de300003-0000-4000-8000-000000000006",
  library: "de300003-0000-4000-8000-000000000004",
  middleSchoolHallway: "de300003-0000-4000-8000-000000000009",
  stadiumConcourse: "de300003-0000-4000-8000-00000000000b",
  staffLounge: "de300003-0000-4000-8000-00000000000d",
  cafeteriaDisplays: "de300004-0000-4000-8000-000000000001",
  morningAnnouncements: "de300005-0000-4000-8000-000000000001",
  generalInformation: "de300005-0000-4000-8000-000000000004",
} as const;

type Envelope<T> = { data: T };

export type PlayerStatus = {
  screenId: string;
  screenName: string;
  transport: "socket" | "heartbeat";
  connected: boolean;
  manifestVersion: number;
  manifestFetches: number;
  commandsHandled: number;
  lastCommand?: string;
};

export type ScreenSummary = { id: string; name: string; status: string };

/** Signs in the way Studio does and returns the session's CSRF token. */
export async function csrfToken(api: APIRequestContext): Promise<string> {
  const response = await api.get("/api/v1/auth/status");
  expect(response.ok()).toBe(true);
  const body = (await response.json()) as Envelope<{
    authenticated: boolean;
    csrfToken: string;
  }>;
  expect(body.data.authenticated).toBe(true);
  return body.data.csrfToken;
}

/**
 * Restores a scenario. The server answers once the data is seeded and every
 * simulated player has connected, so no test needs to wait further.
 */
export async function resetDemo(
  api: APIRequestContext,
  scenario = "kitchen-sink",
): Promise<void> {
  const response = await api.post("/api/v1/demo/reset", {
    headers: { "X-CSRF-Token": await csrfToken(api) },
    data: { scenario },
  });
  expect(response.status(), await response.text()).toBe(200);
}

export async function players(api: APIRequestContext): Promise<PlayerStatus[]> {
  const response = await api.get("/api/v1/demo");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as Envelope<{ players: PlayerStatus[] }>).data
    .players;
}

export async function player(
  api: APIRequestContext,
  screenId: string,
): Promise<PlayerStatus> {
  const found = (await players(api)).find((item) => item.screenId === screenId);
  if (!found) throw new Error(`screen ${screenId} has no simulated player`);
  return found;
}

export async function screens(
  api: APIRequestContext,
): Promise<ScreenSummary[]> {
  const response = await api.get("/api/v1/screens");
  expect(response.ok()).toBe(true);
  return ((await response.json()) as Envelope<{ items: ScreenSummary[] }>).data
    .items;
}
