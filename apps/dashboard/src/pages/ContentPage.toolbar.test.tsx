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
import { MemoryRouter } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { Asset } from "../api/types";
import { ContentPage } from "./ContentPage";

vi.mock("../auth/AuthProvider", () => ({
  useAuth: () => ({
    status: { csrfToken: "csrf", user: { id: "u1", role: "owner" } },
  }),
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

function asset(id: string): Asset {
  return {
    id,
    name: id,
    description: "",
    type: "image",
    originalFilename: `${id}.png`,
    declaredMimeType: "image/png",
    detectedMimeType: "image/png",
    sha256: "aabbcc",
    originalSize: 2048,
    width: 1920,
    height: 1080,
    metadata: {},
    processingStatus: "ready",
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    variants: [],
    playlistUsage: 0,
    layoutUsage: [],
    tags: [],
    collectionIds: [],
  };
}

let assets: ReturnType<typeof mockLibrary>;

function mockLibrary() {
  vi.spyOn(api, "contentFolders").mockResolvedValue([
    {
      id: "folder-1",
      name: "Campus A",
      description: "",
      assetCount: 2,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
  vi.spyOn(api, "contentCollections").mockResolvedValue([
    {
      id: "collection-1",
      name: "Homecoming",
      description: "",
      assetCount: 3,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ] as never);
  vi.spyOn(api, "contentTags").mockResolvedValue([
    { id: "tag-1", name: "Announcements", color: "#3b82f6", assetCount: 5 },
  ] as never);
  return vi.spyOn(api, "assets").mockResolvedValue({
    items: [asset("Poster-1"), asset("Poster-2")],
    total: 2,
    page: 1,
    pageSize: 48,
  });
}

function renderPage() {
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <MemoryRouter>
        <ContentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

const lastParams = () => assets.mock.calls.at(-1)![0];

async function ready() {
  expect(await screen.findByText("Poster-1")).toBeInTheDocument();
}

async function openFilters(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /^Filters/ }));
}

async function pickFacet(
  user: ReturnType<typeof userEvent.setup>,
  facet: string,
  typed: string,
  option: string,
) {
  await user.click(screen.getByRole("combobox", { name: facet }));
  await user.keyboard(typed);
  await user.click(await screen.findByRole("option", { name: option }));
}

beforeEach(() => {
  stubViewport(false);
  assets = mockLibrary();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("Media library toolbar", () => {
  it("fits Search, Filters, type, sort and view in one desktop group", async () => {
    renderPage();
    await ready();

    const toolbar = screen.getByRole("group", {
      name: "Search and filter media",
    });
    expect(
      within(toolbar).getByRole("searchbox", { name: "Search media" }),
    ).toBeInTheDocument();
    expect(
      within(toolbar).getAllByRole("button", { name: /^Filters/ }),
    ).toHaveLength(1);
    expect(
      within(toolbar).getByRole("group", { name: "Media type" }),
    ).toBeVisible();
    expect(
      within(toolbar).getByRole("button", {
        name: "Sort media: Recently updated",
      }),
    ).toBeInTheDocument();
    expect(within(toolbar).getByRole("group", { name: "View" })).toBeVisible();
    // The four facet Selects no longer take permanent toolbar space.
    for (const name of ["Status", "Folder", "Collection", "Tag"]) {
      expect(within(toolbar).queryByRole("combobox", { name })).toBeNull();
    }
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
  });

  describe("search", () => {
    it("debounces typing instead of querying on every keystroke", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await user.type(
        screen.getByRole("searchbox", { name: "Search media" }),
        "poster",
      );
      expect(
        screen.getByRole("searchbox", { name: "Search media" }),
      ).toHaveValue("poster");
      await waitFor(() => expect(lastParams().get("search")).toBe("poster"));
      const searches = assets.mock.calls.map(([params]) =>
        params.get("search"),
      );
      expect(new Set(searches)).toEqual(new Set([null, "poster"]));
    });

    it("commits immediately when the field loses focus", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await user.type(
        screen.getByRole("searchbox", { name: "Search media" }),
        "abc",
      );
      await user.click(screen.getByRole("button", { name: /^Filters/ }));
      expect(
        assets.mock.calls.some(([params]) => params.get("search") === "abc"),
      ).toBe(true);
    });

    it("clears itself without touching facets, type, sort or view", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await openFilters(user);
      await user.click(screen.getByRole("radio", { name: "Ready" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      await user.click(screen.getByRole("button", { name: "Images" }));
      await user.type(
        screen.getByRole("searchbox", { name: "Search media" }),
        "poster",
      );
      await waitFor(() => expect(lastParams().get("search")).toBe("poster"));

      await user.click(
        screen.getByRole("button", { name: "Clear search media" }),
      );
      await waitFor(() => expect(lastParams().get("search")).toBeNull());
      expect(lastParams().get("status")).toBe("ready");
      expect(lastParams().get("type")).toBe("image");
    });
  });

  describe("Filters", () => {
    it("counts only status, folder, collection and tag", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      // Search, type, sort and view are not filters.
      await user.type(
        screen.getByRole("searchbox", { name: "Search media" }),
        "poster",
      );
      await user.click(screen.getByRole("button", { name: "Videos" }));
      await waitFor(() => expect(lastParams().get("search")).toBe("poster"));
      expect(
        screen.getByRole("button", { name: "Filters" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("group", { name: "Active filters" }),
      ).toBeNull();

      await openFilters(user);
      await user.click(screen.getByRole("radio", { name: "Failed" }));
      await pickFacet(user, "Folder", "Camp", "Campus A (2)");
      expect(
        screen.getByRole("button", { name: "Filters, 2 active" }),
      ).toHaveTextContent("2");
    });

    it("opens a Popover on desktop and no Drawer", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await openFilters(user);
      const popover = await screen.findByRole("dialog", {
        name: "Filter media",
      });
      expect(popover).toHaveAttribute("data-slot", "popover-content");
      expect(document.querySelector('[data-slot="drawer-popup"]')).toBeNull();
    });

    it("groups the form semantically", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await openFilters(user);
      const status = await screen.findByRole("radiogroup", { name: "Status" });
      const labels = within(status)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("aria-labelledby"))
        .map((id) => document.getElementById(id!)?.textContent);
      expect(labels).toEqual([
        "Any",
        "Ready",
        "Waiting",
        "Inspecting",
        "Processing",
        "Failed",
      ]);
      expect(screen.getByRole("radio", { name: "Any" })).toBeChecked();
      for (const name of ["Folder", "Collection", "Tag"]) {
        expect(screen.getByRole("combobox", { name })).toBeInTheDocument();
      }
    });

    it("filters by status through the RadioGroup and resets with Any", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await openFilters(user);
      await user.click(screen.getByRole("radio", { name: "Failed" }));
      await waitFor(() => expect(lastParams().get("status")).toBe("failed"));
      expect(screen.getByRole("radio", { name: "Failed" })).toBeChecked();

      await user.click(screen.getByRole("radio", { name: "Any" }));
      await waitFor(() => expect(lastParams().get("status")).toBeNull());
    });

    it.each([
      ["Folder", "Camp", "Campus A (2)", "folderId", "folder-1"],
      ["Collection", "Home", "Homecoming (3)", "collectionId", "collection-1"],
      ["Tag", "Announ", "Announcements (5)", "tagId", "tag-1"],
    ])(
      "sets and clears %s through its Combobox",
      async (facet, typed, option, param, id) => {
        const user = userEvent.setup();
        renderPage();
        await ready();

        await openFilters(user);
        await pickFacet(user, facet, typed, option);
        await waitFor(() => expect(lastParams().get(param)).toBe(id));
        expect(screen.getByRole("combobox", { name: facet })).toHaveValue(
          option,
        );

        const field = screen
          .getByRole("combobox", { name: facet })
          .closest('[data-slot="input-group"]') as HTMLElement;
        await user.click(within(field).getByRole("button", { name: "Clear" }));
        await waitFor(() => expect(lastParams().get(param)).toBeNull());
      },
    );

    it("explains a search that matches no folder", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await openFilters(user);
      await user.click(screen.getByRole("combobox", { name: "Folder" }));
      await user.keyboard("zzz");
      expect(
        await screen.findByText("No matching folders"),
      ).toBeInTheDocument();
    });
  });

  describe("active facet chips", () => {
    async function activateAll(user: ReturnType<typeof userEvent.setup>) {
      await openFilters(user);
      await user.click(screen.getByRole("radio", { name: "Ready" }));
      await pickFacet(user, "Folder", "Camp", "Campus A (2)");
      await pickFacet(user, "Collection", "Home", "Homecoming (3)");
      await pickFacet(user, "Tag", "Announ", "Announcements (5)");
      await user.click(screen.getByRole("button", { name: "Done" }));
    }

    it("appear only once a facet is active and name each facet and value", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      expect(
        screen.queryByRole("group", { name: "Active filters" }),
      ).toBeNull();

      await activateAll(user);
      const chips = screen.getByRole("group", { name: "Active filters" });
      for (const name of [
        "Remove filter Status: Ready",
        "Remove filter Folder: Campus A",
        "Remove filter Collection: Homecoming",
        "Remove filter Tag: Announcements",
      ]) {
        expect(within(chips).getByRole("button", { name })).toBeInTheDocument();
      }
    });

    it("each chip removes exactly one facet", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      await activateAll(user);

      await user.click(
        screen.getByRole("button", { name: "Remove filter Folder: Campus A" }),
      );
      await waitFor(() => expect(lastParams().get("folderId")).toBeNull());
      expect(lastParams().get("status")).toBe("ready");
      expect(lastParams().get("collectionId")).toBe("collection-1");
      expect(lastParams().get("tagId")).toBe("tag-1");
      expect(
        screen.getByRole("button", { name: "Filters, 3 active" }),
      ).toBeInTheDocument();
    });

    it("Clear filters clears only the facets", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await user.type(
        screen.getByRole("searchbox", { name: "Search media" }),
        "poster",
      );
      await user.click(screen.getByRole("button", { name: "Images" }));
      await user.click(
        screen.getByRole("button", { name: "Sort media: Recently updated" }),
      );
      await user.click(
        await screen.findByRole("menuitemradio", { name: "Name" }),
      );
      await user.click(screen.getByRole("button", { name: "List view" }));
      await activateAll(user);
      await waitFor(() => expect(lastParams().get("tagId")).toBe("tag-1"));

      await user.click(screen.getByRole("button", { name: "Clear filters" }));
      await waitFor(() => expect(lastParams().get("status")).toBeNull());
      const params = lastParams();
      for (const key of ["folderId", "collectionId", "tagId"]) {
        expect(params.get(key)).toBeNull();
      }
      expect(params.get("search")).toBe("poster");
      expect(params.get("type")).toBe("image");
      expect(params.get("sort")).toBe("name");
      expect(
        screen.getByRole("searchbox", { name: "Search media" }),
      ).toHaveValue("poster");
      expect(screen.getByRole("button", { name: "Images" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(screen.getByRole("button", { name: "List view" })).toHaveAttribute(
        "aria-pressed",
        "true",
      );
      expect(
        screen.queryByRole("group", { name: "Active filters" }),
      ).toBeNull();
    });

    it("Reset inside the Filters form clears only the facets too", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await user.click(screen.getByRole("button", { name: "Videos" }));
      await openFilters(user);
      await user.click(screen.getByRole("radio", { name: "Ready" }));
      await user.click(screen.getByRole("button", { name: "Reset" }));
      await waitFor(() => expect(lastParams().get("status")).toBeNull());
      expect(lastParams().get("type")).toBe("video");
    });
  });

  describe("media type", () => {
    it("reads All / Images / Videos while All keeps the media scope", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      const group = screen.getByRole("group", { name: "Media type" });
      expect(
        within(group)
          .getAllByRole("button")
          .map((button) => button.textContent),
      ).toEqual(["All", "Images", "Videos"]);
      expect(within(group).queryByRole("button", { name: "Media" })).toBeNull();
      expect(lastParams().get("type")).toBe("media");
      expect(
        within(group).getByRole("button", { name: "All" }),
      ).toHaveAttribute("aria-pressed", "true");

      await user.click(within(group).getByRole("button", { name: "Videos" }));
      await waitFor(() => expect(lastParams().get("type")).toBe("video"));
      expect(
        within(group).getAllByRole("button", { pressed: true }),
      ).toHaveLength(1);

      await user.click(within(group).getByRole("button", { name: "All" }));
      await waitFor(() => expect(lastParams().get("type")).toBe("media"));
    });
  });

  describe("sort", () => {
    it("is a mutually exclusive menu that names the current sort", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await user.click(
        screen.getByRole("button", { name: "Sort media: Recently updated" }),
      );
      const menu = await screen.findByRole("menu");
      const items = within(menu).getAllByRole("menuitemradio");
      expect(items.map((item) => item.textContent)).toEqual([
        "Recently updated",
        "Newest",
        "Oldest",
        "Name",
      ]);
      expect(
        items.filter((item) => item.getAttribute("aria-checked") === "true"),
      ).toHaveLength(1);
      expect(
        within(menu).getByRole("menuitemradio", { name: "Recently updated" }),
      ).toHaveAttribute("aria-checked", "true");

      await user.click(
        within(menu).getByRole("menuitemradio", { name: "Oldest" }),
      );
      await waitFor(() => expect(lastParams().get("sort")).toBe("oldest"));
      await waitFor(() => expect(screen.queryByRole("menu")).toBeNull());
      expect(
        screen.getByRole("button", { name: "Sort media: Oldest" }),
      ).toBeInTheDocument();
    });
  });

  describe("view", () => {
    it("switches between grid and list without changing the query", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      const group = screen.getByRole("group", { name: "View" });
      expect(group).toHaveAttribute("data-slot", "toggle-group");
      expect(
        within(group).getByRole("button", { name: "Grid view" }),
      ).toHaveAttribute("aria-pressed", "true");
      const calls = assets.mock.calls.length;

      await user.click(
        within(group).getByRole("button", { name: "List view" }),
      );
      expect(
        within(group).getByRole("button", { name: "List view" }),
      ).toHaveAttribute("aria-pressed", "true");
      expect(
        within(group).getByRole("button", { name: "Grid view" }),
      ).toHaveAttribute("aria-pressed", "false");
      expect(assets.mock.calls.length).toBe(calls);
    });
  });

  describe("compact layout", () => {
    beforeEach(() => stubViewport(true));

    it("mounts only Filters and View options, not the desktop controls", async () => {
      renderPage();
      await ready();

      expect(
        screen.getByRole("button", { name: /^Filters/ }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "View options" }),
      ).toBeInTheDocument();
      expect(screen.queryByRole("group", { name: "Media type" })).toBeNull();
      expect(screen.queryByRole("group", { name: "View" })).toBeNull();
      expect(screen.queryByRole("button", { name: /^Sort media/ })).toBeNull();
    });

    it("keeps visual order equal to tab order", async () => {
      renderPage();
      await ready();

      const toolbar = screen.getByRole("group", {
        name: "Search and filter media",
      });
      const controls = [
        ...toolbar.querySelectorAll<HTMLElement>("input, button"),
      ];
      expect(
        controls.map(
          (control) =>
            control.getAttribute("aria-label") ?? control.textContent,
        ),
      ).toEqual(["Search media", "Filters", "View options"]);
    });

    it("opens Filters in a Drawer over the same form", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await openFilters(user);
      const drawer = await screen.findByRole("dialog", {
        name: "Filter media",
      });
      expect(drawer).toHaveAttribute("data-slot", "drawer-popup");
      expect(
        document.querySelector('[data-slot="popover-content"]'),
      ).toBeNull();
      await user.click(
        within(drawer).getByRole("radio", { name: "Processing" }),
      );
      await waitFor(() =>
        expect(lastParams().get("status")).toBe("processing"),
      );
      expect(
        screen.getByRole("button", { name: "Filters, 1 active", hidden: true }),
      ).toBeInTheDocument();
    });

    async function openViewOptions(user: ReturnType<typeof userEvent.setup>) {
      await user.click(screen.getByRole("button", { name: "View options" }));
      return screen.findByRole("menu");
    }

    it("labels distinct Media type, Sort by and View sections", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      const menu = await openViewOptions(user);
      for (const label of ["Media type", "Sort by", "View"]) {
        expect(within(menu).getByText(label)).toBeInTheDocument();
      }
      const checked = within(menu)
        .getAllByRole("menuitemradio", { checked: true })
        .map((item) => item.textContent);
      expect(checked).toEqual(["All", "Recently updated", "Grid"]);
    });

    it("changes media type from View options", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      const menu = await openViewOptions(user);
      await user.click(
        within(menu).getByRole("menuitemradio", { name: "Images" }),
      );
      await waitFor(() => expect(lastParams().get("type")).toBe("image"));
    });

    it("changes sort from View options", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      const menu = await openViewOptions(user);
      await user.click(
        within(menu).getByRole("menuitemradio", { name: "Newest" }),
      );
      await waitFor(() => expect(lastParams().get("sort")).toBe("newest"));
    });

    it("changes grid/list from View options", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();
      expect(screen.getAllByRole("article")).toHaveLength(2);
      const calls = assets.mock.calls.length;

      const menu = await openViewOptions(user);
      await user.click(
        within(menu).getByRole("menuitemradio", { name: "List" }),
      );
      await waitFor(() =>
        expect(screen.queryAllByRole("article")).toHaveLength(0),
      );
      expect(screen.getByText("Poster-1")).toBeInTheDocument();
      expect(assets.mock.calls.length).toBe(calls);
    });

    it("shows facet chips below the toolbar when a facet is active", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await openFilters(user);
      await user.click(await screen.findByRole("radio", { name: "Failed" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      expect(
        await screen.findByRole("button", {
          name: "Remove filter Status: Failed",
        }),
      ).toBeInTheDocument();
    });
  });

  describe("archive", () => {
    it("keeps the same toolbar and carries its state across", async () => {
      const user = userEvent.setup();
      renderPage();
      await ready();

      await user.click(screen.getByRole("button", { name: "Images" }));
      await openFilters(user);
      await user.click(screen.getByRole("radio", { name: "Ready" }));
      await user.click(screen.getByRole("button", { name: "Done" }));
      await user.click(screen.getByRole("button", { name: "Archive" }));

      await waitFor(() => expect(lastParams().get("archived")).toBe("true"));
      expect(lastParams().get("type")).toBe("image");
      expect(lastParams().get("status")).toBe("ready");
      expect(
        screen.getByRole("group", { name: "Search and filter media" }),
      ).toBeVisible();
      expect(
        screen.getByRole("button", { name: "Remove filter Status: Ready" }),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: "Upload assets" }),
      ).toBeNull();
    });
  });
});
