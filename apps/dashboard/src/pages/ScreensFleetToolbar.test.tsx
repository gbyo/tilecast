// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Location, Screen } from "../api/types";
import {
  ScreenListContent,
  ScreensPage,
  ScreensWorkspacePage,
} from "./ScreensPage";

let authRole = "owner";
vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { role: authRole } },
  }),
}));
// The map needs WebGL. Its own suite covers it; here it only has to appear.
vi.mock("../components/ScreenFleetMap", () => ({
  ScreenFleetMap: ({ screens }: { screens: Screen[] }) => (
    <div data-testid="fleet-map">{screens.length} on map</div>
  ),
}));

function stubViewport({ desktop = false, compact = false } = {}) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches:
      query === "(min-width: 1024px)"
        ? desktop
        : query === "(max-width: 639px)"
          ? compact
          : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

beforeEach(() => {
  authRole = "owner";
  window.localStorage.clear();
  window.sessionStorage.clear();
  stubViewport();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const base = {
  description: "",
  enabled: true,
  hasActiveCredential: true,
  screenWidth: 1920,
  screenHeight: 1080,
};

const screens = [
  {
    ...base,
    id: "s1",
    name: "Lobby",
    location: "North Campus",
    locationId: "loc-n",
    platform: "android-tv",
    status: "online",
    nowPlayingType: "playlist",
    nowPlayingName: "Welcome",
    syncGroupId: "grp-1",
    syncGroupName: "Hallway Wall",
  },
  {
    ...base,
    id: "s2",
    name: "Cafeteria",
    location: "North Campus",
    locationId: "loc-n",
    platform: "linux",
    status: "offline",
  },
  {
    ...base,
    id: "s3",
    name: "Gym",
    location: "South Campus",
    locationId: "loc-s",
    platform: "fire-tv",
    status: "stale",
    screenWidth: 1080,
    screenHeight: 1920,
  },
  {
    ...base,
    id: "s4",
    name: "Library",
    location: "South Campus",
    locationId: "loc-s",
    platform: "linux",
    status: "online",
    nowPlayingType: "presentation",
    nowPlayingName: "Reading Hour",
    updateState: "downloading",
  },
] as Screen[];

const locations = [
  { id: "loc-n", name: "North Campus" },
  { id: "loc-s", name: "South Campus" },
] as Location[];

function queryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

function renderList(overrides: Partial<{ canManage: boolean }> = {}) {
  return render(
    <QueryClientProvider client={queryClient()}>
      <MemoryRouter>
        <ScreenListContent
          screens={screens}
          loading={false}
          canManage={overrides.canManage ?? true}
          locations={locations}
        />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

function mockFleetApi(items: Screen[] = screens) {
  vi.spyOn(api, "screens").mockResolvedValue({
    items,
    total: items.length,
  });
  vi.spyOn(api, "pendingPairings").mockResolvedValue({ items: [], total: 0 });
  vi.spyOn(api, "locations").mockResolvedValue({
    items: locations,
    total: locations.length,
  });
  vi.spyOn(api, "takeovers").mockResolvedValue({ items: [], total: 0 });
}

function renderWorkspace() {
  mockFleetApi();
  return render(
    <QueryClientProvider client={queryClient()}>
      <MemoryRouter initialEntries={["/screens"]}>
        <Routes>
          <Route path="/screens" element={<ScreensWorkspacePage />}>
            <Route index element={<ScreensPage />} />
          </Route>
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const rowNames = () =>
  screen
    .queryAllByRole("link")
    .map((link) => link.textContent)
    .filter((text) => screens.some((item) => item.name === text));

/** A radio by option label, inside the named facet so shared labels stay unambiguous. */
function facetRadio(dialog: HTMLElement, facet: string, option: string) {
  return within(
    within(dialog).getByRole("radiogroup", { name: facet }),
  ).getByRole("radio", { name: option });
}

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
  return screen.findByRole("dialog", { name: "Filter screens" });
}

describe("Screens fleet summary", () => {
  it("states inventory, locations, online, and attention counts", async () => {
    renderWorkspace();

    expect(
      await screen.findByText("4 players across 2 locations"),
    ).toBeInTheDocument();
    const status = screen.getByRole("group", { name: "Fleet summary" });
    expect(
      within(status).getByRole("button", { name: "2 online" }),
    ).toBeInTheDocument();
    expect(
      within(status).getByRole("button", { name: "2 need attention" }),
    ).toBeInTheDocument();
  });

  it("turns the needs-attention count into a toggleable quick filter", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    const quick = await screen.findByRole("button", {
      name: "2 need attention",
    });
    expect(quick).toHaveAttribute("aria-pressed", "false");
    await user.click(quick);

    expect(quick).toHaveAttribute("aria-pressed", "true");
    expect(window.localStorage.getItem("tilecast.screens.status")).toBe(
      "attention",
    );
    // The list below follows the same state, and shows the chip for it.
    expect(
      await screen.findByText("Status: Needs attention"),
    ).toBeInTheDocument();
    expect(screen.getByText("2 of 4 screens")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Lobby" })).toBeNull();
    expect(screen.getByRole("link", { name: "Gym" })).toBeInTheDocument();

    await user.click(quick);
    expect(quick).toHaveAttribute("aria-pressed", "false");
    expect(screen.queryByText("Status: Needs attention")).toBeNull();
  });

  it("offers the online count as a quick filter too", async () => {
    const user = userEvent.setup();
    renderWorkspace();

    await user.click(await screen.findByRole("button", { name: "2 online" }));
    expect(await screen.findByText("Status: Online")).toBeInTheDocument();
    expect(screen.getByText("2 of 4 screens")).toBeInTheDocument();
  });

  it("hides write actions from a viewer but keeps the fleet", async () => {
    authRole = "viewer";
    renderWorkspace();

    expect(
      await screen.findByText("4 players across 2 locations"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Pair screen" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "More screen actions" }),
    ).toBeNull();
  });
});

describe("Fleet filters", () => {
  it("opens a Popover on wider screens with every facet", async () => {
    const user = userEvent.setup();
    renderList();

    const dialog = await openFilters(user);
    expect(dialog).toHaveAttribute("data-slot", "popover-content");
    for (const name of [
      "Status",
      "Now playing",
      "Orientation",
      "Software update",
    ]) {
      expect(
        within(dialog).getByRole("radiogroup", { name }),
      ).toBeInTheDocument();
    }
    expect(
      within(dialog).getByRole("combobox", { name: "Location" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("combobox", { name: "Platform" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("combobox", { name: "Display Group" }),
    ).toBeInTheDocument();
    // Status keeps every value it had, as one exclusive choice.
    const status = within(dialog).getByRole("radiogroup", { name: "Status" });
    expect(
      within(status)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-labelledby"))
        .map((id) => document.getElementById(id ?? "")?.textContent),
    ).toEqual([
      "Any",
      "Online",
      "Needs attention",
      "Offline",
      "Updating",
      "Syncing",
    ]);
  });

  it("opens a Drawer on a phone, over the same form", async () => {
    stubViewport({ compact: true });
    const user = userEvent.setup();
    renderList();

    const dialog = await openFilters(user);
    expect(dialog.closest('[data-slot="popover-content"]')).toBeNull();
    expect(
      document.querySelector('[data-slot="drawer-popup"]'),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("radiogroup", { name: "Status" }),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByRole("combobox", { name: "Location" }),
    ).toBeInTheDocument();
  });

  it("counts active facets on the trigger and chips each one", async () => {
    const user = userEvent.setup();
    renderList();
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();

    const dialog = await openFilters(user);
    await user.click(facetRadio(dialog, "Status", "Needs attention"));
    await user.click(facetRadio(dialog, "Orientation", "Portrait"));

    const trigger = screen.getByRole("button", { name: "Filters, 2 active" });
    expect(trigger).toHaveTextContent("Filters2");
    const chips = screen.getByRole("group", { name: "Active filters" });
    expect(within(chips).getByText("Status: Needs attention")).toBeVisible();
    expect(within(chips).getByText("Orientation: Portrait")).toBeVisible();
    expect(within(chips).getByText("1 of 4 screens")).toBeInTheDocument();
    expect(rowNames()).toEqual(["Gym"]);
  });

  it("filters by location with the Combobox", async () => {
    const user = userEvent.setup();
    renderList();

    const dialog = await openFilters(user);
    await user.click(
      within(dialog).getByRole("combobox", { name: "Location" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "South Campus" }),
    );

    expect(
      await screen.findByText("Location: South Campus"),
    ).toBeInTheDocument();
    expect(rowNames().sort()).toEqual(["Gym", "Library"]);
  });

  it("filters by platform with the Select", async () => {
    const user = userEvent.setup();
    renderList();

    const dialog = await openFilters(user);
    await user.click(
      within(dialog).getByRole("combobox", { name: "Platform" }),
    );
    await user.click(await screen.findByRole("option", { name: "Fire TV" }));

    expect(await screen.findByText("Platform: Fire TV")).toBeInTheDocument();
    expect(rowNames()).toEqual(["Gym"]);
  });

  it("filters by Display Group with the Combobox", async () => {
    const user = userEvent.setup();
    renderList();

    const dialog = await openFilters(user);
    await user.click(
      within(dialog).getByRole("combobox", { name: "Display Group" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "Hallway Wall" }),
    );

    expect(
      await screen.findByText("Display Group: Hallway Wall"),
    ).toBeInTheDocument();
    expect(rowNames()).toEqual(["Lobby"]);
  });

  it("filters by what is playing and by software update state", async () => {
    const user = userEvent.setup();
    renderList();

    const dialog = await openFilters(user);
    await user.click(facetRadio(dialog, "Now playing", "Presentation"));
    expect(rowNames()).toEqual(["Library"]);
    await user.click(facetRadio(dialog, "Now playing", "Anything"));
    await user.click(facetRadio(dialog, "Software update", "Downloading"));
    expect(rowNames()).toEqual(["Library"]);
    expect(
      screen.getByText("Software update: Downloading"),
    ).toBeInTheDocument();
  });

  it("removes one facet from its chip, and Clear all clears the rest", async () => {
    const user = userEvent.setup();
    renderList();
    const dialog = await openFilters(user);
    await user.click(facetRadio(dialog, "Status", "Needs attention"));
    await user.click(facetRadio(dialog, "Orientation", "Landscape"));
    await user.click(within(dialog).getByRole("button", { name: "Done" }));

    await user.click(
      screen.getByRole("button", {
        name: "Remove filter Orientation: Landscape",
      }),
    );
    expect(screen.queryByText("Orientation: Landscape")).toBeNull();
    expect(screen.getByText("Status: Needs attention")).toBeInTheDocument();
    expect(window.localStorage.getItem("tilecast.screens.orientation")).toBe(
      "",
    );

    // Sorting and grouping are not filters, so they survive Clear all.
    window.localStorage.setItem("tilecast.screens.sort", "name-desc");
    await user.click(screen.getByRole("button", { name: "Clear all" }));
    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    expect(window.localStorage.getItem("tilecast.screens.status")).toBe("");
    expect(window.localStorage.getItem("tilecast.screens.sort")).toBe(
      "name-desc",
    );
  });

  it("resets every facet from the Filters surface", async () => {
    const user = userEvent.setup();
    renderList();
    const dialog = await openFilters(user);
    await user.click(facetRadio(dialog, "Status", "Offline"));
    await user.click(within(dialog).getByRole("button", { name: "Reset" }));

    expect(screen.queryByRole("group", { name: "Active filters" })).toBeNull();
    expect(rowNames()).toHaveLength(4);
  });

  it("shows the empty state when nothing matches", async () => {
    const user = userEvent.setup();
    renderList();
    await user.type(
      screen.getByRole("searchbox", { name: "Search screens" }),
      "zzzz",
    );

    expect(
      await screen.findByText("No screens match these filters"),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(rowNames()).toHaveLength(4);
  });
});

describe("Fleet toolbar", () => {
  it("exposes the current group and sort in the control names", () => {
    renderList();

    expect(
      screen.getByRole("combobox", { name: "Group screens by: Location" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Sort screens: Name · A–Z" }),
    ).toBeInTheDocument();
  });

  it("groups with a visible Select", async () => {
    const user = userEvent.setup();
    renderList();
    expect(screen.getAllByText("North Campus").length).toBeGreaterThan(0);

    await user.click(
      screen.getByRole("combobox", { name: "Group screens by: Location" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "No grouping" }),
    );

    expect(
      screen.getByRole("combobox", { name: "Group screens by: No grouping" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Collapse / }),
    ).not.toBeInTheDocument();
  });

  it("sorts from a radio menu and shows the choice in the trigger", async () => {
    const user = userEvent.setup();
    renderList();
    await user.click(
      screen.getByRole("combobox", { name: "Group screens by: Location" }),
    );
    await user.click(
      await screen.findByRole("option", { name: "No grouping" }),
    );
    expect(rowNames()).toEqual(["Cafeteria", "Gym", "Library", "Lobby"]);

    await user.click(
      screen.getByRole("button", { name: "Sort screens: Name · A–Z" }),
    );
    const menu = await screen.findByRole("menu");
    expect(
      within(menu)
        .getAllByRole("menuitemradio")
        .map((item) => item.textContent),
    ).toEqual([
      "Name · A–Z",
      "Name · Z–A",
      "Location · A–Z",
      "Status",
      "Last contact · newest",
      "Last contact · oldest",
      "Date added · newest",
      "Platform",
    ]);
    expect(
      within(menu).getByRole("menuitemradio", { name: "Name · A–Z" }),
    ).toBeChecked();
    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Name · Z–A" }),
    );

    expect(
      screen.getByRole("button", { name: "Sort screens: Name · Z–A" }),
    ).toBeInTheDocument();
    expect(rowNames()).toEqual(["Lobby", "Library", "Gym", "Cafeteria"]);
  });

  it("switches between table, grid, and map views", async () => {
    stubViewport({ desktop: true });
    const user = userEvent.setup();
    renderList();

    const views = screen.getByRole("group", { name: "Screen view" });
    const table = within(views).getByRole("button", { name: "Table view" });
    const grid = within(views).getByRole("button", {
      name: "Preview grid view",
    });
    const map = within(views).getByRole("button", { name: "Map view" });
    expect(table).toHaveAttribute("aria-pressed", "true");
    expect(screen.getAllByRole("table").length).toBeGreaterThan(0);

    await user.click(grid);
    expect(grid).toHaveAttribute("aria-pressed", "true");
    expect(screen.queryByRole("table")).toBeNull();

    await user.click(map);
    expect(await screen.findByTestId("fleet-map")).toHaveTextContent(
      "4 on map",
    );
    // Map has no groups or order, so those controls step aside.
    expect(
      screen.queryByRole("combobox", { name: /^Group screens by/ }),
    ).toBeNull();
    expect(window.localStorage.getItem("tilecast.screens.view")).toBe("map");
  });

  it("collapses a group without losing the others", async () => {
    stubViewport({ desktop: true });
    const user = userEvent.setup();
    renderList();
    expect(screen.getAllByRole("table")).toHaveLength(2);

    await user.click(
      screen.getByRole("button", { name: "Collapse North Campus" }),
    );
    await waitFor(() =>
      expect(
        screen.getByRole("button", { name: "Expand North Campus" }),
      ).toBeInTheDocument(),
    );
    expect(rowNames()).toEqual(["Gym", "Library"]);
  });

  it("moves group and sort into one View options menu on a phone", async () => {
    stubViewport({ compact: true });
    const user = userEvent.setup();
    renderList();

    expect(
      screen.queryByRole("combobox", { name: /^Group screens by/ }),
    ).toBeNull();
    await user.click(screen.getByRole("button", { name: "View options" }));
    const menu = await screen.findByRole("menu");
    expect(
      within(menu).getByRole("menuitemradio", { name: "Location" }),
    ).toBeChecked();
    expect(
      within(menu).getByRole("menuitemradio", { name: "Name · A–Z" }),
    ).toBeChecked();

    await user.click(
      within(menu).getByRole("menuitemradio", { name: "Date added · newest" }),
    );
    expect(window.localStorage.getItem("tilecast.screens.sort")).toBe(
      "added-desc",
    );
  });

  it("offers only preview grid and map below the desktop width", () => {
    renderList();
    const views = screen.getByRole("group", { name: "Screen view" });
    expect(
      within(views).queryByRole("button", { name: "Table view" }),
    ).toBeNull();
    expect(
      within(views).getByRole("button", { name: "Preview grid view" }),
    ).toHaveAttribute("aria-pressed", "true");
  });
});

describe("Fleet states", () => {
  it("shows a skeleton while loading", () => {
    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <ScreenListContent screens={[]} loading canManage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(screen.getByLabelText("Loading screens")).toBeInTheDocument();
  });

  it("shows a failed load as an alert", async () => {
    vi.spyOn(api, "screens").mockRejectedValue(new Error("boom"));
    vi.spyOn(api, "pendingPairings").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "locations").mockResolvedValue({ items: [], total: 0 });
    vi.spyOn(api, "takeovers").mockResolvedValue({ items: [], total: 0 });
    render(
      <QueryClientProvider client={queryClient()}>
        <MemoryRouter>
          <ScreensPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(await screen.findByRole("alert")).toBeInTheDocument();
  });

  it("keeps bulk selection available above the fleet", async () => {
    stubViewport({ desktop: true });
    const user = userEvent.setup();
    renderList();
    await user.click(screen.getByRole("checkbox", { name: /^Select Lobby/ }));

    expect(screen.getByText("1 selected")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Restart" })).toBeInTheDocument();
    expect(
      screen.getByRole("combobox", {
        name: "Move selected screens to location",
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Move to location" }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Clear selection" }));
    expect(screen.queryByText("1 selected")).toBeNull();
  });
});
