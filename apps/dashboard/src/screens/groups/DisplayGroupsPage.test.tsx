// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Screen, ScreenGroup } from "../../api/types";
import { DisplayGroupsPage } from "./DisplayGroupsPage";

const mocks = vi.hoisted(() => ({ confirm: vi.fn(), toastAdd: vi.fn() }));
const role = vi.hoisted(() => ({ current: "owner" }));

vi.mock("../../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf-token", user: { role: role.current } },
  }),
}));

vi.mock("../../api/client", () => ({
  ApiError: class ApiError extends Error {},
  api: {
    screenGroupPage: vi.fn(),
    screens: vi.fn(),
    createScreenGroup: vi.fn(),
    updateScreenGroup: vi.fn(),
    deleteScreenGroup: vi.fn(),
  },
}));

vi.mock("../../components/ConfirmDialog", () => ({
  useConfirm: () => ({ confirm: mocks.confirm, dialog: null }),
}));

vi.mock("../../components/ui/toast", () => ({
  toast: { add: mocks.toastAdd },
}));

function screenFixture(id: string, status: Screen["status"]): Screen {
  return {
    id,
    name: id,
    location: "",
    status,
    enabled: true,
    syncGroupId: "g",
  } as Screen;
}

function groupFixture(
  over: Partial<ScreenGroup> & { id: string },
): ScreenGroup {
  return {
    name: over.id,
    description: "",
    displayMode: "mirror",
    playbackEpoch: "e",
    membershipCount: 0,
    screens: [],
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  };
}

const cafeteria = groupFixture({
  id: "cafeteria",
  name: "Cafeteria Displays",
  description: "Lunch room TVs",
  membershipCount: 2,
  screens: [
    { id: "c1", name: "c1", location: "" },
    { id: "c2", name: "c2", location: "" },
  ],
  playlistId: "p1",
  playlistName: "Lunch rotation",
});
const entrance = groupFixture({
  id: "entrance",
  name: "Main Entrance",
  membershipCount: 2,
  screens: [
    { id: "e1", name: "e1", location: "" },
    { id: "e2", name: "e2", location: "" },
  ],
  layoutId: "l1",
  layoutName: "Lobby layout",
});
const wall = groupFixture({
  id: "wall",
  name: "Lobby Video Wall",
  displayMode: "span",
});

function page(
  items: ScreenGroup[],
  extra: Partial<{ total: number; page: number; pageSize: number }> = {},
) {
  return {
    items,
    total: items.length,
    page: 1,
    pageSize: 100,
    ...extra,
  } as never;
}

function LocationProbe() {
  const location = useLocation();
  return (
    <output data-testid="location">
      {location.pathname + location.search}
    </output>
  );
}

function renderPage(entry = "/groups") {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/groups" element={<DisplayGroupsPage />} />
          <Route path="/groups/:id" element={<p>Group detail</p>} />
        </Routes>
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function stubCompact(compact: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: compact && query.includes("max-width"),
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  }));
}

beforeEach(() => {
  role.current = "owner";
  stubCompact(false);
  mocks.confirm.mockResolvedValue(true);
  vi.mocked(api.screenGroupPage).mockResolvedValue(
    page([cafeteria, entrance, wall]),
  );
  vi.mocked(api.screens).mockResolvedValue({
    items: [
      screenFixture("c1", "online"),
      screenFixture("c2", "online"),
      screenFixture("e1", "online"),
      screenFixture("e2", "offline"),
      { ...screenFixture("loose", "online"), syncGroupId: undefined },
    ],
    total: 5,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});

describe("Display Groups index", () => {
  it("keeps the title for assistive technology and summarizes the fleet", async () => {
    renderPage();
    expect(
      await screen.findByRole("heading", { level: 1, name: "Display Groups" }),
    ).toHaveClass("sr-only");
    expect(
      await screen.findByText("3 groups · 4 screens grouped"),
    ).toBeInTheDocument();
  });

  it("compares groups in a table with health, mode, and fallback", async () => {
    renderPage();
    const link = await screen.findByRole("link", {
      name: /Cafeteria Displays/,
    });
    expect(link).toHaveAttribute("href", "/groups/cafeteria");
    const headers = screen
      .getAllByRole("columnheader")
      .map((header) => header.textContent?.trim());
    expect(headers).toEqual([
      "Display Group",
      "Screens",
      "Mode",
      "Fallback",
      "Actions",
    ]);
    expect(screen.queryByText(/Updated|Last updated/)).not.toBeInTheDocument();

    const rows = screen.getAllByRole("row");
    const cafeteriaRow = rows.find((row) =>
      within(row).queryByText("Cafeteria Displays"),
    );
    expect(cafeteriaRow).toBeDefined();
    expect(
      within(cafeteriaRow as HTMLElement).getByText("Lunch room TVs"),
    ).toBeInTheDocument();
    expect(
      within(cafeteriaRow as HTMLElement).getByText("2 screens · all online"),
    ).toBeInTheDocument();
    expect(
      within(cafeteriaRow as HTMLElement).getByText("Mirror"),
    ).toBeInTheDocument();
    expect(
      within(cafeteriaRow as HTMLElement).getByText("Lunch rotation"),
    ).toBeInTheDocument();

    const entranceRow = rows.find((row) =>
      within(row).queryByText("Main Entrance"),
    ) as HTMLElement;
    expect(
      within(entranceRow).getByText("1 needs attention"),
    ).toBeInTheDocument();
    expect(within(entranceRow).getByText("Lobby layout")).toBeInTheDocument();

    const wallRow = rows.find((row) =>
      within(row).queryByText("Lobby Video Wall"),
    ) as HTMLElement;
    expect(within(wallRow).getByText("No screens")).toBeInTheDocument();
    expect(within(wallRow).getByText("Span")).toBeInTheDocument();
    expect(within(wallRow).getByText("Unassigned")).toBeInTheDocument();
  });

  it("renders item rows instead of a table on compact layouts", async () => {
    stubCompact(true);
    renderPage();
    await screen.findByRole("link", { name: "Cafeteria Displays" });
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    expect(screen.getByText("2 screens · all online")).toBeInTheDocument();
    expect(
      screen.getByText("Mirror · Playlist: Lunch rotation"),
    ).toBeInTheDocument();
  });

  it("searches on the server after the typing pause", async () => {
    const user = userEvent.setup();
    renderPage();
    await screen.findByRole("link", { name: /Cafeteria Displays/ });
    vi.mocked(api.screenGroupPage).mockResolvedValue(page([cafeteria]));

    await user.type(
      screen.getByRole("searchbox", { name: "Search Display Groups" }),
      "cafe",
    );
    await waitFor(() =>
      expect(api.screenGroupPage).toHaveBeenCalledWith("cafe", 1),
    );
    expect(screen.getByTestId("location")).toHaveTextContent("/groups?q=cafe");
    expect(await screen.findByText("1 matching group")).toBeInTheDocument();
  });

  it("distinguishes an empty installation from an empty search", async () => {
    vi.mocked(api.screenGroupPage).mockResolvedValue(page([]));
    const { unmount } = renderPage();
    expect(
      await screen.findByText("No Display Groups yet"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Create one for screens that should share playback."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Create Display Group" }),
    ).toBeInTheDocument();
    unmount();

    renderPage("/groups?q=cafeteria");
    expect(
      await screen.findByText("No Display Groups match “cafeteria”"),
    ).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Clear search" }));
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(/^\/groups$/),
    );
  });

  it("keeps load more for the paginated API", async () => {
    const user = userEvent.setup();
    vi.mocked(api.screenGroupPage).mockImplementation((_search, pageNumber) =>
      Promise.resolve(
        pageNumber === 1
          ? page([cafeteria], { total: 2, pageSize: 1 })
          : page([entrance], { total: 2, page: 2, pageSize: 1 }),
      ),
    );
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Load more Display Groups" }),
    );
    expect(
      await screen.findByRole("link", { name: /Main Entrance/ }),
    ).toBeInTheDocument();
  });

  it("creates a group and continues into its Screens tab", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createScreenGroup).mockResolvedValue(
      groupFixture({ id: "new-group", name: "West Wing" }),
    );
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Create group" }),
    );
    const dialog = await screen.findByRole("dialog");
    expect(
      within(dialog).getByRole("heading", { name: "Create Display Group" }),
    ).toBeInTheDocument();
    const description = within(dialog).getByRole("textbox", {
      name: "Description",
    });
    expect(description.tagName).toBe("TEXTAREA");
    await user.type(
      within(dialog).getByRole("textbox", { name: "Name" }),
      "West Wing",
    );
    await user.type(description, "North side");
    await user.click(
      within(dialog).getByRole("button", { name: "Create group" }),
    );

    await waitFor(() =>
      expect(api.createScreenGroup).toHaveBeenCalledWith(
        { name: "West Wing", description: "North side" },
        "csrf-token",
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("location")).toHaveTextContent(
        "/groups/new-group",
      ),
    );
    expect(await screen.findByText("Group detail")).toBeInTheDocument();
  });

  it("keeps the create dialog and values after a failure", async () => {
    const user = userEvent.setup();
    vi.mocked(api.createScreenGroup).mockRejectedValueOnce(new Error("down"));
    renderPage();
    await user.click(
      await screen.findByRole("button", { name: "Create group" }),
    );
    const dialog = await screen.findByRole("dialog");
    const name = within(dialog).getByRole("textbox", { name: "Name" });
    await user.type(name, "West Wing");
    await user.click(
      within(dialog).getByRole("button", { name: "Create group" }),
    );
    await waitFor(() =>
      expect(mocks.toastAdd).toHaveBeenCalledWith({
        title: "Could not create the Display Group.",
        type: "error",
      }),
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(name).toHaveValue("West Wing");
  });

  it("offers edit and delete in the row menu after confirmation", async () => {
    const user = userEvent.setup();
    vi.mocked(api.deleteScreenGroup).mockResolvedValue(undefined);
    renderPage();
    await user.click(
      await screen.findByRole("button", {
        name: "Actions for Cafeteria Displays",
      }),
    );
    expect(
      await screen.findByRole("menuitem", { name: "Edit details" }),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole("menuitem", { name: "Delete Display Group" }),
    );
    await waitFor(() =>
      expect(api.deleteScreenGroup).toHaveBeenCalledWith(
        "cafeteria",
        "csrf-token",
      ),
    );
    expect(mocks.confirm).toHaveBeenCalledWith(
      expect.objectContaining({
        body: "Screens will not be deleted.",
        destructive: true,
      }),
    );
  });

  it("hides management controls from viewers", async () => {
    role.current = "viewer";
    renderPage();
    await screen.findByRole("link", { name: /Cafeteria Displays/ });
    expect(
      screen.queryByRole("button", { name: "Create group" }),
    ).not.toBeInTheDocument();
    await userEvent
      .setup()
      .click(
        screen.getByRole("button", { name: "Actions for Cafeteria Displays" }),
      );
    expect(
      await screen.findByRole("menuitem", { name: "Open Display Group" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("menuitem", { name: "Delete Display Group" }),
    ).not.toBeInTheDocument();
  });

  it("offers a retry when the list cannot load", async () => {
    vi.mocked(api.screenGroupPage).mockRejectedValueOnce(new Error("down"));
    renderPage();
    expect(
      await screen.findByText(
        "Display Groups could not be loaded. Try refreshing the page.",
      ),
    ).toBeInTheDocument();
    vi.mocked(api.screenGroupPage).mockResolvedValue(page([cafeteria]));
    await userEvent
      .setup()
      .click(screen.getByRole("button", { name: "Retry" }));
    expect(
      await screen.findByRole("link", { name: /Cafeteria Displays/ }),
    ).toBeInTheDocument();
  });
});
