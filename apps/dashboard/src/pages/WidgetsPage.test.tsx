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
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiError } from "../api/client";
import type { Asset, WidgetDefinition } from "../api/types";
import { toast } from "../components/ui/toast";
import { WidgetsPage } from "./WidgetsPage";

const auth = vi.hoisted(() => ({ role: "administrator" }));

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: {
      csrfToken: "csrf-token",
      user: { id: "user-1", role: auth.role },
    },
  }),
}));

vi.mock("../content/WidgetSnapshotBackfill", () => ({
  WidgetSnapshotBackfill: ({ enabled }: { enabled: boolean }) => (
    <div
      data-testid="widget-snapshot-backfill"
      data-enabled={String(enabled)}
    />
  ),
}));

const COMPACT_QUERY = "(max-width: 639px)";

function stubViewport(compact: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: compact && query === COMPACT_QUERY,
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

function definition(
  id: string,
  name: string,
  extra: Partial<WidgetDefinition> = {},
) {
  return {
    id,
    name,
    category: "Essentials",
    runtime: "native",
    ...extra,
  } as unknown as WidgetDefinition;
}

const catalog = [
  definition("clock", "Clock"),
  definition("countdown", "Countdown"),
  definition("weather", "Weather", { category: "Information" }),
  definition("website", "Website", { runtime: "web", category: "Other" }),
  // Superseded providers leave new creation but stay resolvable for saved
  // Widgets, so the library filter must keep offering them.
  definition("legacy-ticker", "Legacy Ticker", {
    category: "Data display",
    deprecation: { deprecated: true },
  }),
];

type WidgetOverrides = Partial<Omit<Asset, "widget">> & {
  widget?: { provider: string };
};

function widget(id: string, name: string, extra: WidgetOverrides = {}): Asset {
  return {
    id,
    name,
    description: "",
    type: "widget",
    originalFilename: "",
    originalSize: 3_145_728,
    metadata: {},
    processingStatus: "ready",
    createdAt: "2026-10-01T12:00:00Z",
    updatedAt: "2026-10-05T21:12:00Z",
    variants: [],
    playlistUsage: 0,
    layoutUsage: [],
    tags: [],
    collectionIds: [],
    widget: { provider: "clock" },
    ...extra,
  } as unknown as Asset;
}

const lunch = widget("w-lunch", "Lunch Countdown", {
  widget: { provider: "countdown" },
  playlistUsage: 2,
  layoutUsage: [{ id: "l1", name: "Cafeteria", published: true }],
  thumbnailUrl: "/api/v1/assets/w-lunch/thumbnail",
  metadata: { widgetPreviewCaptureVersion: 4 },
});
const weather = widget("w-weather", "Weather Board", {
  widget: { provider: "weather" },
  layoutUsage: [{ id: "l2", name: "Lobby", published: false }],
});
const unused = widget("w-clock", "Lobby Clock");

type Page = { items: Asset[]; total: number; page?: number; pageSize?: number };

function mockAssets(handler?: (params: URLSearchParams) => Page) {
  return vi.spyOn(api, "assets").mockImplementation((params) => {
    const page = handler?.(params) ?? {
      items: [lunch, weather, unused],
      total: 3,
    };
    return Promise.resolve({ page: 1, pageSize: 100, ...page });
  });
}

function mockDefinitions(widgets: WidgetDefinition[] = catalog) {
  return vi.spyOn(api, "contentDefinitions").mockResolvedValue({
    revision: "1",
    compilerVersion: "1",
    fingerprint: "test",
    widgets,
    dataSources: [],
  });
}

function renderPage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Routes>
          <Route path="/" element={<WidgetsPage />} />
          <Route path="/widgets/:id" element={<p>Editing a Widget</p>} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

type User = ReturnType<typeof userEvent.setup>;

async function chooseProvider(user: User, name: string) {
  await user.click(
    await screen.findByRole("combobox", { name: "Filter by Widget type" }),
  );
  await user.click(await screen.findByRole("option", { name }));
}

describe("Widgets library", () => {
  beforeEach(() => {
    auth.role = "administrator";
    stubViewport(false);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("workspace anatomy", () => {
    it("keeps one screen-reader-only H1 and no visible page header", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      const headings = screen.getAllByRole("heading", { level: 1 });
      expect(headings).toHaveLength(1);
      expect(headings[0]).toHaveTextContent("Widgets");
      expect(headings[0]).toHaveClass("sr-only");
      expect(
        screen.queryByText(
          "Reusable visual content for playlists and Layouts.",
        ),
      ).not.toBeInTheDocument();
    });

    it("shows the server total rather than the loaded count", async () => {
      mockAssets(() => ({ items: [lunch, weather], total: 18 }));
      mockDefinitions();
      renderPage();

      expect(await screen.findByText("18 Widgets")).toBeInTheDocument();
    });

    it("pluralizes a single Widget and never shows a zero while loading", async () => {
      mockAssets(() => ({ items: [lunch], total: 1 }));
      mockDefinitions();
      renderPage();

      expect(screen.queryByText(/^\d+ Widgets?$/)).not.toBeInTheDocument();
      expect(await screen.findByText("1 Widget")).toBeInTheDocument();
    });

    it("links Create Widget to the full-page flow for managers", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();

      const create = await screen.findByRole("link", { name: "Create Widget" });
      expect(create).toHaveAttribute("href", "/widgets/new");
    });

    it("hides Create Widget from viewers", async () => {
      auth.role = "viewer";
      mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      expect(
        screen.queryByRole("link", { name: "Create Widget" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("search", () => {
    it("waits for a pause before querying the server", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.type(screen.getByRole("searchbox"), "lunch");
      expect(assets.mock.calls.some((call) => call[0].has("search"))).toBe(
        false,
      );

      await waitFor(() =>
        expect(
          assets.mock.calls.filter((call) => call[0].get("search") === "lunch"),
        ).toHaveLength(1),
      );
      // Only the settled value reached the server, never a partial one.
      expect(
        assets.mock.calls
          .map((call) => call[0].get("search"))
          .filter((value) => value !== null),
      ).toEqual(["lunch"]);
    });

    it("clears the search and queries without it", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.type(screen.getByRole("searchbox"), "lunch");
      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].get("search")).toBe("lunch"),
      );
      await user.click(
        screen.getByRole("button", { name: "Clear search widgets" }),
      );

      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].has("search")).toBe(false),
      );
      expect(screen.getByRole("searchbox")).toHaveValue("");
    });
  });

  describe("Widget type", () => {
    it("is a grouped, searchable Combobox over the catalog", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(
        await screen.findByRole("combobox", { name: "Filter by Widget type" }),
      );
      const options = await screen.findAllByRole("option");
      expect(options.map((option) => option.textContent)).toEqual([
        "All Widget types",
        "Clock",
        "Countdown",
        "Weather",
        "Legacy Ticker",
        "Website",
      ]);
      for (const group of [
        "Essentials",
        "Information",
        "Data display",
        "Integrations",
      ]) {
        expect(screen.getByText(group)).toBeInTheDocument();
      }
      // Deprecated providers stay filterable for the Widgets already saved.
      expect(
        screen.getByRole("option", { name: "Legacy Ticker" }),
      ).toBeInTheDocument();
    });

    it("filters the type list as you type", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.type(
        await screen.findByRole("combobox", { name: "Filter by Widget type" }),
        "web",
      );
      expect(
        await screen.findByRole("option", { name: "Website" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("option", { name: "Clock" }),
      ).not.toBeInTheDocument();
    });

    it("sends the exact provider ID and restarts at the first page", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await chooseProvider(user, "Countdown");

      await waitFor(() => {
        const params = assets.mock.calls.at(-1)![0];
        expect(params.get("provider")).toBe("countdown");
        expect(params.get("page")).toBe("1");
        expect(params.get("type")).toBe("widget");
      });
    });

    it("maps All Widget types back to a blank provider", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await chooseProvider(user, "Weather");
      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].get("provider")).toBe("weather"),
      );
      await chooseProvider(user, "All Widget types");

      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].has("provider")).toBe(false),
      );
    });

    it("clears the selected type from the input", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await chooseProvider(user, "Weather");
      await user.click(await screen.findByRole("button", { name: "Clear" }));

      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].has("provider")).toBe(false),
      );
    });
  });

  describe("sort", () => {
    it("defaults to recently updated, asked of the server", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      expect(assets.mock.calls[0]![0].get("sort")).toBe("updated");
      expect(
        screen.getByRole("button", { name: "Sort Widgets: Recently updated" }),
      ).toBeInTheDocument();
    });

    it("exposes the selected sort as a radio group", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(
        screen.getByRole("button", { name: "Sort Widgets: Recently updated" }),
      );
      const menu = await screen.findByRole("menu");
      expect(within(menu).getByText("Sort by")).toBeInTheDocument();
      expect(
        within(menu)
          .getAllByRole("menuitemradio")
          .map((item) => [item.textContent, item.getAttribute("aria-checked")]),
      ).toEqual([
        ["Recently updated", "true"],
        ["Newest", "false"],
        ["Oldest", "false"],
        ["Name", "false"],
      ]);
    });

    it.each([
      ["Newest", "newest"],
      ["Oldest", "oldest"],
      ["Name", "name"],
    ])("sends sort=%s to the server from page one", async (label, value) => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(
        screen.getByRole("button", { name: "Sort Widgets: Recently updated" }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: label }),
      );

      await waitFor(() => {
        const params = assets.mock.calls.at(-1)![0];
        expect(params.get("sort")).toBe(value);
        expect(params.get("page")).toBe("1");
      });
      expect(
        screen.getByRole("button", { name: `Sort Widgets: ${label}` }),
      ).toBeInTheDocument();
    });

    it("keeps the server's order instead of re-sorting loaded items", async () => {
      mockAssets(() => ({
        items: [widget("w-z", "Zeta"), widget("w-a", "Alpha")],
        total: 2,
      }));
      mockDefinitions();
      renderPage();
      await screen.findByText("Zeta");

      expect(
        screen.getAllByRole("article").map((card) => card.textContent),
      ).toEqual([
        expect.stringContaining("Zeta"),
        expect.stringContaining("Alpha"),
      ]);
    });
  });

  describe("view", () => {
    it("switches between grid cards and a Widget table without a new query", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");
      const calls = assets.mock.calls.length;

      const view = screen.getByRole("group", { name: "View" });
      expect(
        within(view).getByRole("button", { name: "Grid view" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(screen.getAllByRole("article")).toHaveLength(3);

      await user.click(within(view).getByRole("button", { name: "List view" }));

      const table = await screen.findByRole("table");
      expect(
        within(table)
          .getAllByRole("columnheader")
          .map((header) => header.textContent),
      ).toEqual(["Widget", "Type", "Used by", "Updated", "Actions"]);
      expect(screen.queryByRole("article")).not.toBeInTheDocument();
      expect(assets.mock.calls).toHaveLength(calls);
    });

    it("lists type, usage, and the localized update time per row", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(screen.getByRole("button", { name: "List view" }));
      const row = (
        await screen.findByRole("link", { name: "Lunch Countdown" })
      ).closest("tr")!;

      expect(within(row).getByText("Countdown")).toBeInTheDocument();
      expect(
        within(row).getByText("2 playlists · 1 Layout"),
      ).toBeInTheDocument();
      expect(row).toHaveTextContent(/Oct 5, 2026/);
      // Media-only concepts have no column.
      expect(
        screen.queryByText(/size|Ready|dimensions/i),
      ).not.toBeInTheDocument();
    });
  });

  describe("grid cards", () => {
    it("shows the stored preview, catalog name, and usage, with no Media metadata", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      const card = screen.getByRole("article", { name: "Lunch Countdown" });
      expect(card.querySelector("img")).toHaveAttribute(
        "src",
        "/api/v1/assets/w-lunch/thumbnail?capture=3",
      );
      expect(within(card).getByText("Countdown")).toBeInTheDocument();
      expect(within(card).queryByText("COUNTDOWN")).not.toBeInTheDocument();
      expect(
        within(card).getByText("2 playlists · 1 Layout"),
      ).toBeInTheDocument();
      expect(card).not.toHaveTextContent(/MB|KB|Ready/);
      expect(
        within(card).queryByRole("button", { name: "Duplicate" }),
      ).toBeNull();
    });

    it("keeps the explicit unavailable state when a capture is missing", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      const card = screen.getByRole("article", { name: "Weather Board" });
      expect(card).toHaveTextContent("Preview unavailable");
      expect(within(card).getByText("1 Layout")).toBeInTheDocument();
    });

    it("says so when a Widget is not used anywhere", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      expect(
        within(screen.getByRole("article", { name: "Lobby Clock" })).getByText(
          "Not used yet",
        ),
      ).toBeInTheDocument();
    });

    it("opens the editor from the title without nesting interaction", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      const card = screen.getByRole("article", { name: "Lunch Countdown" });
      const link = within(card).getByRole("link", { name: "Lunch Countdown" });
      expect(link).toHaveAttribute("href", "/widgets/w-lunch");
      // No control contains another control.
      for (const control of card.querySelectorAll("a, button")) {
        expect(control.querySelector("a, button")).toBeNull();
      }
      await user.click(link);
      expect(await screen.findByText("Editing a Widget")).toBeInTheDocument();
    });

    it("falls back to a readable name when the catalog lacks a provider", async () => {
      mockAssets(() => ({
        items: [
          widget("w-x", "Menu", {
            widget: { provider: "menu-board" },
          }),
        ],
        total: 1,
      }));
      mockDefinitions([]);
      renderPage();

      const card = await screen.findByRole("article", { name: "Menu" });
      expect(within(card).getByText("Menu Board")).toBeInTheDocument();
    });
  });

  describe("actions", () => {
    it("offers Edit Widget and Duplicate to managers", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(
        screen.getByRole("button", { name: "Actions for Lunch Countdown" }),
      );
      const menu = await screen.findByRole("menu");
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Edit Widget", "Duplicate"]);
    });

    it("lets viewers open a Widget but not duplicate it", async () => {
      auth.role = "viewer";
      mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(
        screen.getByRole("button", { name: "Actions for Lunch Countdown" }),
      );
      const menu = await screen.findByRole("menu");
      expect(
        within(menu)
          .getAllByRole("menuitem")
          .map((item) => item.textContent),
      ).toEqual(["Open Widget"]);
    });

    it("duplicates, reports success, refreshes, and opens the copy", async () => {
      const assets = mockAssets();
      mockDefinitions();
      const duplicate = vi
        .spyOn(api, "duplicateWidget")
        .mockResolvedValue({ id: "w-copy" } as Asset);
      const add = vi.spyOn(toast, "add");
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");
      const calls = assets.mock.calls.length;

      await user.click(
        screen.getByRole("button", { name: "Actions for Lunch Countdown" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Duplicate" }),
      );

      expect(await screen.findByText("Editing a Widget")).toBeInTheDocument();
      expect(duplicate).toHaveBeenCalledWith("w-lunch", "csrf-token");
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Widget duplicated.",
          type: "success",
        }),
      );
      expect(assets.mock.calls.length).toBeGreaterThanOrEqual(calls);
    });

    it("reports a failed duplicate and stays on the library", async () => {
      mockAssets();
      mockDefinitions();
      vi.spyOn(api, "duplicateWidget").mockRejectedValue(
        new ApiError("Storage is full.", 500, "internal"),
      );
      const add = vi.spyOn(toast, "add");
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(
        screen.getByRole("button", { name: "Actions for Lunch Countdown" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Duplicate" }),
      );

      await waitFor(() =>
        expect(add).toHaveBeenCalledWith(
          expect.objectContaining({
            title: "Could not duplicate the Widget.",
            description: "Storage is full.",
            type: "error",
          }),
        ),
      );
      expect(screen.queryByText("Editing a Widget")).not.toBeInTheDocument();
      expect(screen.getByText("Lunch Countdown")).toBeInTheDocument();
    });

    it("disables Duplicate while a duplicate is running", async () => {
      mockAssets();
      mockDefinitions();
      vi.spyOn(api, "duplicateWidget").mockReturnValue(new Promise(() => {}));
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(
        screen.getByRole("button", { name: "Actions for Lunch Countdown" }),
      );
      await user.click(
        await screen.findByRole("menuitem", { name: "Duplicate" }),
      );
      await user.click(
        screen.getByRole("button", { name: "Actions for Weather Board" }),
      );

      expect(
        await screen.findByRole("menuitem", { name: "Duplicate" }),
      ).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("empty and error states", () => {
    it("offers Create Widget when the library is truly empty", async () => {
      mockAssets(() => ({ items: [], total: 0 }));
      mockDefinitions();
      renderPage();

      expect(await screen.findByText("No Widgets yet")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Create reusable visual content for playlists and Layouts.",
        ),
      ).toBeInTheDocument();
      expect(
        screen.getAllByRole("link", { name: "Create Widget" }),
      ).toHaveLength(2);
    });

    it("does not offer Create Widget to viewers in an empty library", async () => {
      auth.role = "viewer";
      mockAssets(() => ({ items: [], total: 0 }));
      mockDefinitions();
      renderPage();

      expect(await screen.findByText("No Widgets yet")).toBeInTheDocument();
      expect(
        screen.queryByRole("link", { name: "Create Widget" }),
      ).not.toBeInTheDocument();
    });

    it("offers a reset, not Create, when filters match nothing", async () => {
      mockAssets((params) =>
        params.get("provider") === "weather"
          ? { items: [], total: 0 }
          : { items: [lunch], total: 1 },
      );
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await chooseProvider(user, "Weather");

      expect(
        await screen.findByText("No Widgets match your search"),
      ).toBeInTheDocument();
      expect(screen.queryByText("No Widgets yet")).not.toBeInTheDocument();
      expect(
        screen.getAllByRole("link", { name: "Create Widget" }),
      ).toHaveLength(1);
      expect(
        screen.getByRole("button", { name: "Clear search and type" }),
      ).toBeInTheDocument();
    });

    it("resets search and type but keeps sort and view", async () => {
      const assets = mockAssets((params) =>
        params.get("provider") || params.get("search")
          ? { items: [], total: 0 }
          : { items: [lunch], total: 1 },
      );
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(screen.getByRole("button", { name: "List view" }));
      await user.click(
        screen.getByRole("button", { name: "Sort Widgets: Recently updated" }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Name" }),
      );
      await chooseProvider(user, "Weather");
      await user.type(screen.getByRole("searchbox"), "nothing");
      // Let the typed search settle: the list swaps to loading and back first.
      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].get("search")).toBe("nothing"),
      );
      await screen.findByText("No Widgets match your search");
      await user.click(
        screen.getByRole("button", { name: "Clear search and type" }),
      );

      expect(await screen.findByRole("table")).toBeInTheDocument();
      const params = assets.mock.calls.at(-1)![0];
      expect(params.has("search")).toBe(false);
      expect(params.has("provider")).toBe(false);
      expect(params.get("sort")).toBe("name");
      expect(screen.getByRole("searchbox")).toHaveValue("");
      expect(
        screen.getByRole("button", { name: "Sort Widgets: Name" }),
      ).toBeInTheDocument();
    });

    it("shows only the load error when the list query fails", async () => {
      vi.spyOn(api, "assets").mockRejectedValue(
        new Error("Network unavailable"),
      );
      mockDefinitions([]);
      renderPage();

      expect(
        await screen.findByText("Widgets could not be loaded."),
      ).toBeInTheDocument();
      expect(screen.queryByText("No Widgets yet")).not.toBeInTheDocument();
      expect(
        screen.queryByText("No Widgets match your search"),
      ).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
    });

    it("keeps saved Widgets openable when the catalog fails to load", async () => {
      mockAssets();
      vi.spyOn(api, "contentDefinitions").mockRejectedValue(new Error("down"));
      renderPage();

      const card = await screen.findByRole("article", {
        name: "Lunch Countdown",
      });
      expect(within(card).getByText("Countdown")).toBeInTheDocument();
      expect(
        within(card).getByRole("link", { name: "Lunch Countdown" }),
      ).toHaveAttribute("href", "/widgets/w-lunch");
      expect(
        screen.queryByText("Widgets could not be loaded."),
      ).not.toBeInTheDocument();
    });
  });

  describe("pagination", () => {
    const pageOf = (params: URLSearchParams) =>
      params.get("page") === "2"
        ? {
            items: [widget("w2", "Second widget")],
            total: 2,
            page: 2,
            pageSize: 1,
          }
        : {
            items: [widget("w1", "First widget")],
            total: 2,
            page: 1,
            pageSize: 1,
          };

    it("loads further pages through Load more and keeps the total", async () => {
      mockAssets(pageOf);
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();

      expect(await screen.findByText("First widget")).toBeInTheDocument();
      expect(screen.getByText("2 Widgets")).toBeInTheDocument();
      expect(screen.queryByText("Second widget")).not.toBeInTheDocument();
      await user.click(
        await screen.findByRole("button", { name: "Load more" }),
      );
      expect(await screen.findByText("Second widget")).toBeInTheDocument();
      expect(screen.getByText("2 Widgets")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument();
    });

    it("restarts at the first page when sort changes", async () => {
      const assets = mockAssets(pageOf);
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await user.click(
        await screen.findByRole("button", { name: "Load more" }),
      );
      await screen.findByText("Second widget");

      await user.click(
        screen.getByRole("button", { name: "Sort Widgets: Recently updated" }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Oldest" }),
      );

      await waitFor(() => {
        const params = assets.mock.calls.at(-1)![0];
        expect(params.get("sort")).toBe("oldest");
        expect(params.get("page")).toBe("1");
      });
      await waitFor(() =>
        expect(screen.queryByText("Second widget")).not.toBeInTheDocument(),
      );
    });

    it("hides Load more when the library fits on one page", async () => {
      mockAssets(() => ({ items: [widget("w1", "Only widget")], total: 1 }));
      mockDefinitions();
      renderPage();

      expect(await screen.findByText("Only widget")).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Load more" }),
      ).not.toBeInTheDocument();
    });
  });

  describe("compact layout", () => {
    beforeEach(() => stubViewport(true));

    it("mounts only the compact controls, in reading order", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      expect(
        screen.queryByRole("button", { name: /^Sort Widgets/ }),
      ).toBeNull();
      expect(screen.queryByRole("group", { name: "View" })).toBeNull();
      const toolbar = screen.getByRole("group", {
        name: "Widget library controls",
      });
      expect(
        [
          ...toolbar.querySelectorAll<HTMLElement>(
            'input:not([aria-hidden="true"]), button',
          ),
        ].map(
          (control) =>
            control.getAttribute("aria-label") ?? control.textContent,
        ),
      ).toEqual([
        "Search Widgets",
        "Filter by Widget type",
        "Toggle options",
        "View options",
      ]);
    });

    it("keeps the type filter directly reachable", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await chooseProvider(user, "Clock");

      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].get("provider")).toBe("clock"),
      );
    });

    it("changes sort from View options", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");

      await user.click(screen.getByRole("button", { name: "View options" }));
      const menu = await screen.findByRole("menu");
      expect(
        within(menu)
          .getAllByRole("menuitemradio", { checked: true })
          .map((item) => item.textContent),
      ).toEqual(["Recently updated", "Grid"]);
      await user.click(
        within(menu).getByRole("menuitemradio", { name: "Newest" }),
      );

      await waitFor(() =>
        expect(assets.mock.calls.at(-1)![0].get("sort")).toBe("newest"),
      );
    });

    it("renders list mode as a native list, not a table", async () => {
      const assets = mockAssets();
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");
      const calls = assets.mock.calls.length;

      await user.click(screen.getByRole("button", { name: "View options" }));
      await user.click(
        await screen.findByRole("menuitemradio", { name: "List" }),
      );

      const list = await screen.findByRole("list");
      expect(list.tagName).toBe("UL");
      const items = within(list).getAllByRole("listitem");
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent("Lunch Countdown");
      expect(items[0]).toHaveTextContent("Countdown");
      expect(items[0]).toHaveTextContent(
        "2 playlists · 1 Layout · Updated Oct 5, 2026",
      );
      expect(screen.queryByRole("table")).not.toBeInTheDocument();
      expect(
        within(items[0]!).getByRole("button", {
          name: "Actions for Lunch Countdown",
        }),
      ).toBeInTheDocument();
      expect(assets.mock.calls).toHaveLength(calls);
    });

    it("shortens Create but keeps its full name", async () => {
      mockAssets();
      mockDefinitions();
      renderPage();

      const create = await screen.findByRole("link", { name: "Create Widget" });
      expect(create).toHaveTextContent(/^Create$/);
    });
  });

  describe("preview capture", () => {
    it("keeps the snapshot backfill mounted for managers, whatever the filters", async () => {
      mockAssets((params) =>
        params.get("provider")
          ? { items: [], total: 0 }
          : { items: [lunch], total: 1 },
      );
      mockDefinitions();
      renderPage();
      const user = userEvent.setup();
      await screen.findByText("Lunch Countdown");
      expect(screen.getByTestId("widget-snapshot-backfill")).toHaveAttribute(
        "data-enabled",
        "true",
      );

      await chooseProvider(user, "Weather");
      await screen.findByText("No Widgets match your search");

      expect(screen.getByTestId("widget-snapshot-backfill")).toHaveAttribute(
        "data-enabled",
        "true",
      );
    });

    it("leaves capture uploads off for viewers", async () => {
      auth.role = "viewer";
      mockAssets();
      mockDefinitions();
      renderPage();
      await screen.findByText("Lunch Countdown");

      expect(screen.getByTestId("widget-snapshot-backfill")).toHaveAttribute(
        "data-enabled",
        "false",
      );
    });
  });
});
