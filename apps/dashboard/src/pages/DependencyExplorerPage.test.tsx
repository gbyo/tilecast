// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useLocation, useNavigate } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import type { DependencyGraph } from "../api/types";
import { TooltipProvider } from "../components/ui/tooltip";
import { TERMINAL_FANOUT_THRESHOLD } from "../dependency-graph/graphModel";
import { chainGraph, fanoutGraph } from "../dependency-graph/testGraphs";
import { i18n } from "../i18n";
import { DependencyExplorerPage } from "./DependencyExplorerPage";

const defaultMatchMedia = window.matchMedia.bind(window);

// Base UI ScrollArea reads animations that jsdom does not implement.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

function mockDesktop() {
  if (!("ResizeObserver" in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  // Only the layout breakpoint: Base UI reads pointer queries too.
  window.matchMedia = (query: string) => ({
    matches: query === "(min-width: 1024px)",
    media: query,
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

afterEach(async () => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = defaultMatchMedia;
  await i18n.changeLanguage("en");
});

function Probe() {
  const location = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <output aria-label="search">{location.search}</output>
      <button type="button" onClick={() => void navigate(-1)}>
        History back
      </button>
    </>
  );
}

/**
 * `desktop` renders the resizable inspector pane. jsdom measures every
 * element as 0×0, so that pane's handle claims every pointerdown there;
 * tests that open a Select or Combobox use the narrow layout instead.
 */
function renderExplorer(
  graph: DependencyGraph,
  search = "",
  { desktop = false } = {},
) {
  if (desktop) mockDesktop();
  vi.spyOn(api, "dependencyGraph").mockResolvedValue(graph);
  return render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <TooltipProvider>
        <MemoryRouter initialEntries={[`/settings/dependency-graph${search}`]}>
          <DependencyExplorerPage />
          <Probe />
        </MemoryRouter>
      </TooltipProvider>
    </QueryClientProvider>,
  );
}

const canvas = () => screen.findByRole("region", { name: "Dependency graph" });
const inspector = () =>
  screen.getByRole("complementary", { name: "Resource details" });
const search = () =>
  decodeURIComponent(screen.getByLabelText("search").textContent ?? "");
const nodeNames = async () =>
  within(await canvas())
    .getAllByRole("button")
    .map((button) => button.textContent);

describe("DependencyExplorerPage overview", () => {
  it("aggregates resources by type instead of drawing every resource", async () => {
    renderExplorer(fanoutGraph(30));
    const graph = await canvas();
    const buttons = within(graph).getAllByRole("button");
    expect(buttons).toHaveLength(9);
    expect(within(graph).getByRole("button", { name: "Screens 30" })).toBe(
      buttons[8],
    );
    expect(within(graph).queryByText("s01")).not.toBeInTheDocument();
    expect(within(graph).getByText("Sources")).toBeInTheDocument();
    expect(within(graph).getByText("Delivery")).toBeInTheDocument();
  });

  it("browses one type in the inspector without expanding the graph", async () => {
    const user = userEvent.setup();
    renderExplorer(fanoutGraph(30), "", { desktop: true });
    await user.click(
      within(await canvas()).getByRole("button", { name: "Screens 30" }),
    );
    expect(search()).toBe("?type=screen");
    expect(await nodeNames()).toHaveLength(9);
    const detail = inspector();
    expect(
      within(detail).getByRole("heading", { name: "Screens" }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByRole("link", { name: /Layouts/ }),
    ).toHaveAttribute("href", "/settings/dependency-graph?type=layout");
    await user.click(within(detail).getByRole("link", { name: /^s07/ }));
    expect(search()).toBe("?node=screen:s07");
  });

  it("falls back to the overview for a node the graph does not contain", async () => {
    renderExplorer(chainGraph, "?node=layout:missing&depth=3");
    expect(await nodeNames()).toHaveLength(9);
    expect(
      screen.queryByRole("group", { name: "Direction" }),
    ).not.toBeInTheDocument();
    expect(
      within(screen.getByRole("navigation", { name: "breadcrumb" })).getByText(
        "Overview",
      ),
    ).toHaveAttribute("aria-current", "page");
  });

  it("falls back to the overview for a malformed node", async () => {
    renderExplorer(chainGraph, "?node=nonsense");
    expect(await nodeNames()).toHaveLength(9);
  });
});

describe("DependencyExplorerPage focus mode", () => {
  it("enters focus mode from a grouped search result", async () => {
    const user = userEvent.setup();
    renderExplorer(chainGraph);
    await canvas();
    await user.type(
      screen.getByRole("combobox", { name: "Search resources" }),
      "lunch",
    );
    const listbox = await screen.findByRole("listbox");
    expect(within(listbox).getByText("Data Sources")).toBeInTheDocument();
    expect(within(listbox).getByText("Playlists")).toBeInTheDocument();
    await user.click(
      within(listbox).getByRole("option", { name: /Lunch loop/ }),
    );
    expect(search()).toBe("?node=playlist:lunch");
    const graph = await canvas();
    expect(
      within(graph).getByRole("button", { current: true }),
    ).toHaveTextContent("Lunch loop");
    // Two hops each way, not the whole installation.
    expect(await nodeNames()).toHaveLength(5);
    expect(
      screen.getByRole("combobox", { name: "Search resources" }),
    ).toHaveValue("");
  });

  it("restores the root, direction, and depth from the URL", async () => {
    renderExplorer(
      chainGraph,
      "?node=layout:cafe&direction=dependencies&depth=1",
    );
    const graph = await canvas();
    expect(within(graph).getAllByRole("button")).toHaveLength(2);
    expect(within(graph).getByText("Menu board")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Dependencies", pressed: true }),
    ).toBeInTheDocument();
    expect(screen.getByRole("combobox", { name: "Depth" })).toHaveTextContent(
      "1 hop",
    );
  });

  it("re-derives the graph when the direction and depth change", async () => {
    const user = userEvent.setup();
    renderExplorer(chainGraph, "?node=layout:cafe");
    const graph = await canvas();
    expect(within(graph).getByText("Menu board")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Consumers" }));
    expect(search()).toBe("?node=layout:cafe&direction=consumers");
    expect(within(graph).queryByText("Menu board")).not.toBeInTheDocument();
    expect(within(graph).queryByText("Lunch menu")).not.toBeInTheDocument();
    expect(within(graph).getAllByRole("button")).toHaveLength(3);

    await user.click(screen.getByRole("combobox", { name: "Depth" }));
    await user.click(await screen.findByRole("option", { name: "All" }));
    expect(search()).toBe("?node=layout:cafe&direction=consumers&depth=all");
    expect(within(graph).getAllByRole("button")).toHaveLength(5);
  });

  it("shows direct dependencies and consumers in the inspector", async () => {
    const user = userEvent.setup();
    renderExplorer(chainGraph, "?node=layout:cafe&depth=3", { desktop: true });
    await canvas();
    const detail = inspector();
    expect(
      within(detail).getByRole("heading", { name: "Cafeteria layout" }),
    ).toBeInTheDocument();
    expect(
      within(detail).getByRole("link", { name: "Open resource" }),
    ).toHaveAttribute("href", "/layouts/cafe");
    const dependencies = within(detail)
      .getByRole("heading", { name: /Direct dependencies/ })
      .closest("section")!;
    const dependency = within(dependencies).getByRole("link", {
      name: /Menu board/,
    });
    expect(dependency).toHaveTextContent("Widget · used by");
    // Selecting a row keeps the non-default depth.
    expect(decodeURIComponent(dependency.getAttribute("href")!)).toBe(
      "/settings/dependency-graph?node=widget:board&depth=3",
    );
    const consumers = within(detail)
      .getByRole("heading", { name: /Direct consumers/ })
      .closest("section")!;
    expect(
      within(consumers).getByRole("link", { name: /Lunch loop/ }),
    ).toHaveTextContent("Playlist · included in");

    await user.click(dependency);
    expect(
      within(await canvas()).getByRole("button", { current: true }),
    ).toHaveTextContent("Menu board");
  });

  it("supports browser Back to the previous view", async () => {
    const user = userEvent.setup();
    renderExplorer(chainGraph, "?node=layout:cafe");
    const graph = await canvas();
    await user.click(within(graph).getByRole("button", { name: /Lunch loop/ }));
    expect(search()).toBe("?node=playlist:lunch");
    await user.click(screen.getByRole("button", { name: "History back" }));
    expect(search()).toBe("?node=layout:cafe");
    expect(
      within(graph).getByRole("button", { current: true }),
    ).toHaveTextContent("Cafeteria layout");
  });
});

describe("DependencyExplorerPage fan-out", () => {
  it("collapses many terminal screens and expands them on request", async () => {
    const user = userEvent.setup();
    renderExplorer(fanoutGraph(30), "?node=layout:lobby", { desktop: true });
    const graph = await canvas();
    expect(within(graph).getAllByRole("button")).toHaveLength(3);
    const group = within(graph).getByRole("button", {
      name: "30 screens View screens",
    });
    await user.click(group);
    expect(group).toHaveAttribute("aria-pressed", "true");
    const detail = inspector();
    expect(
      within(detail).getByRole("heading", { name: "30 screens" }),
    ).toBeInTheDocument();
    expect(
      within(detail).getAllByRole("link", { name: /^s\d\d/ }),
    ).toHaveLength(30);
    await user.click(
      within(detail).getByRole("button", { name: "Show on graph" }),
    );
    expect(within(graph).getAllByRole("button")).toHaveLength(32);
    expect(TERMINAL_FANOUT_THRESHOLD).toBeLessThanOrEqual(30);
  });
});

describe("DependencyExplorerPage narrow layout", () => {
  it("opens the inspector in a Sheet", async () => {
    const user = userEvent.setup();
    renderExplorer(chainGraph, "?node=layout:cafe");
    await canvas();
    expect(
      screen.queryByRole("complementary", { name: "Resource details" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Details" }));
    const sheet = await screen.findByRole("dialog", {
      name: "Resource details",
    });
    expect(
      within(sheet).getByRole("heading", { name: "Cafeteria layout" }),
    ).toBeInTheDocument();
  });
});

describe("DependencyExplorerPage localization", () => {
  it("names the controls in the active language", async () => {
    await i18n.changeLanguage("es");
    renderExplorer(chainGraph, "?node=layout:cafe");
    await screen.findByRole("region", {
      name: i18n.t("content:graph.canvasLabel"),
    });
    for (const key of [
      "graph.toolbar.searchLabel",
      "graph.toolbar.depth",
    ] as const)
      expect(
        screen.getByRole("combobox", { name: i18n.t(`content:${key}`) }),
      ).toBeInTheDocument();
    expect(
      screen.getByRole("group", {
        name: i18n.t("content:graph.toolbar.direction"),
      }),
    ).toBeInTheDocument();
    for (const key of [
      "graph.toolbar.zoomIn",
      "graph.toolbar.zoomOut",
      "graph.toolbar.fitGraph",
      "graph.toolbar.consumers",
    ] as const)
      expect(
        screen.getByRole("button", { name: i18n.t(`content:${key}`) }),
      ).toBeInTheDocument();
    expect(i18n.t("content:graph.toolbar.zoomIn")).not.toBe("Zoom in");
  });
});

describe("DependencyExplorerPage states", () => {
  it("shows a retryable error when the graph fails to load", async () => {
    vi.spyOn(api, "dependencyGraph").mockRejectedValue(new Error("offline"));
    render(
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <MemoryRouter>
          <DependencyExplorerPage />
        </MemoryRouter>
      </QueryClientProvider>,
    );
    expect(
      await screen.findByText("The dependency graph could not be loaded."),
    ).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Retry" })).toBeEnabled(),
    );
  });

  it("explains an empty installation", async () => {
    renderExplorer({ nodes: [], edges: [] });
    expect(await screen.findByText("Nothing to map yet")).toBeInTheDocument();
  });
});
