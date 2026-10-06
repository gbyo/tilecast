/**
 * Shared fixtures and rendering for the Schedule editor tests: the API
 * mocked at its boundary, a router that includes the pages the editor leaves
 * to, and the viewport the layout hooks read.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { Link, RouterProvider, createMemoryRouter } from "react-router";
import { afterEach, vi } from "vitest";
import { api } from "../api/client";
import type {
  Schedule,
  SchedulePreflight,
  Screen,
  ScreenGroup,
} from "../api/types";
import * as authModule from "../auth/AuthProvider";
import { ScheduleEditorPage } from "./ScheduleEditorPage";

export class RequestWithoutSignal extends globalThis.Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const rest = { ...init };
    delete (rest as { signal?: unknown }).signal;
    super(input, rest);
  }
}

export function installEditorTestEnvironment() {
  globalThis.Request = RequestWithoutSignal;
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    setViewport("tablet");
  });
}

export function mockAuth(role = "owner") {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      user: { id: "u1", name: "Op", username: "op", role },
      csrfToken: "tok",
    },
    isLoading: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
}

export type Viewport = "desktop" | "tablet" | "phone";

/** What the layout hooks read: desktop is min-width 1024, phone is max-width 639. */
export function setViewport(viewport: Viewport) {
  window.matchMedia = (query: string) => ({
    matches:
      (query.includes("min-width: 1024px") && viewport === "desktop") ||
      (query.includes("max-width: 639px") && viewport === "phone"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

export const morning: Schedule = {
  id: "s1",
  name: "Morning Broadcast",
  description: "",
  playlistId: "p1",
  playlistName: "Morning Announcements",
  presentationType: "playlist",
  type: "weekly",
  timezone: "America/Chicago",
  priority: 0,
  specificity: 0,
  enabled: true,
  dailyStart: "07:15",
  dailyEnd: "08:15",
  daysOfWeek: [1, 2, 3, 4, 5],
  targets: [{ type: "group", id: "g1", name: "Libraries" }],
  createdAt: "2026-10-01T00:00:00Z",
  updatedAt: "2026-10-01T00:00:00Z",
};

export const lobby = {
  id: "screen-1",
  name: "Lobby",
  location: "First floor",
} as unknown as Screen;
export const libraries = {
  id: "g1",
  name: "Libraries",
  membershipCount: 4,
  screens: [
    { id: "screen-2", name: "Reading Room", location: "" },
    { id: "screen-3", name: "Stacks", location: "" },
  ],
} as unknown as ScreenGroup;

export const playlistRow = {
  id: "p1",
  name: "Morning Announcements",
  description: "",
  itemCount: 8,
  items: [],
  previewItems: [],
  layoutUsage: [],
  warnings: [],
} as never;

export function preflightResult(
  changes: Partial<SchedulePreflight> = {},
): SchedulePreflight {
  return {
    draftEnabled: true,
    checkedAt: "2026-10-06T12:15:00Z",
    running: false,
    targetScreenCount: 8,
    winningScreenCount: 8,
    losingScreenCount: 0,
    unsupportedScreenCount: 0,
    competitors: [],
    competitorsTruncated: false,
    screens: [],
    screensTruncated: false,
    issues: [],
    ...changes,
  };
}

/** Every request the editor can make, answered with ordinary data. */
export function mockEditorApi() {
  const empty = { items: [], total: 0, page: 1, pageSize: 100 };
  return {
    schedule: vi.spyOn(api, "schedule").mockResolvedValue(morning),
    scheduleDefaults: vi
      .spyOn(api, "scheduleDefaults")
      .mockResolvedValue({ defaultTimezone: "America/Chicago" }),
    preflight: vi
      .spyOn(api, "preflightSchedule")
      .mockResolvedValue(preflightResult()),
    createSchedule: vi.spyOn(api, "createSchedule"),
    updateSchedule: vi.spyOn(api, "updateSchedule"),
    deleteSchedule: vi.spyOn(api, "deleteSchedule").mockResolvedValue(),
    playlist: vi.spyOn(api, "playlist").mockResolvedValue(playlistRow),
    playlistPage: vi.spyOn(api, "playlistPage").mockResolvedValue({
      ...empty,
      items: [playlistRow],
      total: 1,
    }),
    layoutPage: vi.spyOn(api, "layoutPage").mockResolvedValue(empty),
    screens: vi
      .spyOn(api, "screens")
      .mockResolvedValue({ items: [lobby], total: 1 }),
    screenGroups: vi.spyOn(api, "screenGroups").mockResolvedValue({
      items: [libraries],
      total: 1,
      page: 1,
      pageSize: 100,
    }),
    screen: vi.spyOn(api, "screen"),
    screenGroup: vi.spyOn(api, "screenGroup"),
  };
}

// i18n-ignore: router fixtures for tests, never shown to a person
const away = <Link to="/elsewhere">away</Link>;
// i18n-ignore: router fixtures for tests, never shown to a person
const listPage = <p>Schedule list</p>;
// i18n-ignore: router fixtures for tests, never shown to a person
const elsewherePage = <p>Elsewhere</p>;

export function renderEditor(initialEntry: string) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const editor = (
    <>
      <ScheduleEditorPage />
      {away}
    </>
  );
  const router = createMemoryRouter(
    [
      { path: "/schedules/new", element: editor },
      { path: "/schedules/:id", element: editor },
      { path: "/schedules", element: listPage },
      { path: "/elsewhere", element: elsewherePage },
    ],
    { initialEntries: [initialEntry] },
  );
  const view = render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
  return { ...view, client, router };
}
