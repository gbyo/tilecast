// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider, createMemoryRouter } from "react-router";
import { ScheduleEditorPage } from "./ScheduleBuilder";
import { api } from "../api/client";
import * as authModule from "../auth/AuthProvider";
import type { Playlist, Screen, ScreenGroup } from "../api/types";

class RequestWithoutSignal extends globalThis.Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const rest = { ...init };
    delete (rest as { signal?: unknown }).signal;
    super(input, rest);
  }
}
globalThis.Request = RequestWithoutSignal;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

function mockAuth() {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      user: { id: "u1", name: "Op", username: "op", role: "owner" },
      csrfToken: "tok",
    },
    isLoading: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
}

const lobby = {
  id: "s1",
  name: "Lobby",
  location: "First floor",
} as unknown as Screen;
const hall = {
  id: "s2",
  name: "Hall",
  location: "Second floor",
} as unknown as Screen;
const westWing = {
  id: "g1",
  name: "West Wing",
  membershipCount: 1,
  screens: [{ id: "s1" }],
} as unknown as ScreenGroup;

function mockLists() {
  vi.spyOn(api, "playlists").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "layouts").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "screens").mockResolvedValue({
    items: [lobby, hall],
    total: 2,
  });
  vi.spyOn(api, "screenGroups").mockResolvedValue({
    items: [westWing],
    total: 1,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "schedules").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
    defaultTimezone: "UTC",
  });
}

function renderEditor() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const router = createMemoryRouter(
    [{ path: "/schedules/new", element: <ScheduleEditorPage /> }],
    { initialEntries: ["/schedules/new"] },
  );
  render(
    <QueryClientProvider client={client}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

describe("ScheduleBuilder targets", () => {
  it("adds and removes a screen target through the picker", async () => {
    mockAuth();
    mockLists();
    const user = userEvent.setup();
    renderEditor();

    const search = await screen.findByLabelText("Search screens");
    await user.click(search);
    const option = await screen.findByRole("option", { name: /Hall/ });
    await user.click(option);
    expect(await screen.findByLabelText("Remove Hall")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Remove Hall"));
    expect(screen.queryByLabelText("Remove Hall")).toBeNull();
  });

  it("switches between screens and Display Groups", async () => {
    mockAuth();
    mockLists();
    const user = userEvent.setup();
    renderEditor();

    await screen.findByLabelText("Search screens");
    await user.click(screen.getByRole("button", { name: "Display Groups" }));
    expect(
      await screen.findByLabelText("Search Display Groups"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Screens" }));
    expect(await screen.findByLabelText("Search screens")).toBeInTheDocument();
  });

  it("schedules a grouped screen as its Display Group", async () => {
    mockAuth();
    mockLists();
    const user = userEvent.setup();
    renderEditor();

    const search = await screen.findByLabelText("Search screens");
    await user.click(search);
    // The grouped Lobby screen is offered as its Display Group, while the
    // ungrouped Hall screen is offered directly.
    const option = await screen.findByRole("option", { name: /West Wing/ });
    await user.click(option);
    expect(
      await screen.findByLabelText("Remove West Wing"),
    ).toBeInTheDocument();
  });
});

describe("ScheduleBuilder mode switches", () => {
  it("toggles display control and schedule type", async () => {
    mockAuth();
    mockLists();
    const user = userEvent.setup();
    renderEditor();

    await user.click(
      await screen.findByRole("button", { name: "Display Control" }),
    );
    const action = await screen.findByRole("combobox", { name: "Action" });
    expect(action).toHaveTextContent("Power on");

    await user.click(
      await screen.findByRole("button", { name: "One-time event" }),
    );
    expect(await screen.findByText("One-time event")).toBeInTheDocument();
  });

  it("toggles weekdays without dropping the rest of the week", async () => {
    mockAuth();
    mockLists();
    const user = userEvent.setup();
    renderEditor();

    const saturday = await screen.findByRole("button", { name: "Saturday" });
    expect(saturday).toHaveAttribute("aria-pressed", "false");
    await user.click(saturday);
    expect(
      await screen.findByRole("button", { name: "Saturday" }),
    ).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Monday" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("shows the full timezone list before searching", async () => {
    mockAuth();
    mockLists();
    const user = userEvent.setup();
    renderEditor();

    const timezone = await screen.findByRole("combobox", { name: "Timezone" });
    await user.click(timezone);
    expect(
      await screen.findByRole("option", {
        name: "Auckland (Pacific/Auckland)",
      }),
    ).toBeInTheDocument();
  });
});

describe("ScheduleBuilder presentation picker", () => {
  it("keeps the picker mounted through close and reopens it", async () => {
    mockAuth();
    mockLists();
    const morning = {
      id: "p1",
      name: "Morning loop",
      itemCount: 2,
      sourceType: "manual",
      items: [],
    } as unknown as Playlist;
    const playlists = vi.spyOn(api, "playlists").mockResolvedValue({
      items: [morning],
      total: 1,
      page: 1,
      pageSize: 100,
    });
    const user = userEvent.setup();
    renderEditor();

    await user.click(
      await screen.findByRole("button", { name: "Choose presentation" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Choose presentation",
    });
    expect(dialog).toBeInTheDocument();
    await user.type(screen.getByLabelText("Search presentations"), "Morn");

    await user.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    await user.click(
      screen.getByRole("button", { name: "Choose presentation" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Choose presentation" }),
    ).toBeInTheDocument();
    // The picker stays mounted while closed, so its state survives reopening.
    expect(screen.getByLabelText("Search presentations")).toHaveValue("Morn");
    await user.click(
      await screen.findByRole("button", { name: /Morning loop/ }),
    );
    await user.click(
      screen.getByRole("button", { name: "Use this presentation" }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByText("Morning loop")).toBeInTheDocument();
    expect(playlists).toHaveBeenCalled();
  });
});
