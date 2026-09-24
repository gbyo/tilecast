// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { Playlist } from "../../api/types";
import * as authModule from "../../auth/AuthProvider";
import { toast } from "../ui/toast";
import { PlaylistEditorPage } from "./PlaylistEditor";

const defaultMatchMedia = window.matchMedia.bind(window);

// The desktop sequence and inspector panes render inside Base UI ScrollAreas,
// whose viewport probes this jsdom-missing API. It stays scoped to this file
// so other suites keep their menu and modal timing.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = defaultMatchMedia;
});

function playlist(): Playlist {
  const items = [
    {
      id: "item-a",
      assetId: "asset-a",
      position: 0,
      durationMs: 10_000,
      fitMode: "contain" as const,
      transition: "none" as const,
      audioEnabled: false,
      volume: 1,
      deliveryPolicy: "download" as const,
      assetName: "Alpha",
      assetType: "image" as const,
      assetStatus: "ready" as const,
      thumbnailUrl: "https://example.com/a.png",
    },
    {
      id: "item-b",
      assetId: "asset-b",
      position: 1,
      durationMs: 10_000,
      fitMode: "contain" as const,
      transition: "none" as const,
      audioEnabled: false,
      volume: 1,
      deliveryPolicy: "download" as const,
      assetName: "Beta",
      assetType: "image" as const,
      assetStatus: "ready" as const,
      thumbnailUrl: "https://example.com/b.png",
    },
  ];
  return {
    id: "p1",
    name: "Lobby loop",
    description: "",
    revision: 3,
    draftRevision: 3,
    publishedRevision: 2,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    items,
    itemCount: 2,
    warnings: [],
    layoutUsage: [{ id: "l1", name: "Lobby Split", published: true }],
    usage: { screens: [], schedules: [], campaigns: [] },
    sourceType: "static",
  };
}

function mockServer(overrides: Partial<Playlist> = {}) {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      setupRequired: false,
      user: { id: "u1", name: "Owner", username: "owner", role: "owner" },
      csrfToken: "token",
    },
    isLoading: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
  vi.spyOn(api, "playlist").mockResolvedValue({ ...playlist(), ...overrides });
  vi.spyOn(api, "layouts").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "contentTags").mockResolvedValue([]);
}

function renderEditor() {
  const router = createMemoryRouter(
    [{ path: "/playlists/:id", element: <PlaylistEditorPage /> }],
    { initialEntries: ["/playlists/p1"] },
  );
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

function mockDesktop() {
  if (!("ResizeObserver" in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  window.matchMedia = () => ({
    matches: true,
    media: "(min-width: 1024px)",
    onchange: null,
    addListener: () => undefined,
    removeListener: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,
  });
}

function openMore() {
  fireEvent.click(
    screen.getByRole("button", { name: "More playlist actions" }),
  );
}

describe("PlaylistEditor panes", () => {
  it("gives the timeline the full width until an item is selected", async () => {
    mockDesktop();
    mockServer();
    renderEditor();

    const group = await screen.findByRole("group", {
      name: "Playlist sequence and inspector",
    });
    // No placeholder inspector pane is reserved while nothing is selected.
    expect(group.querySelectorAll("[data-panel]")).toHaveLength(1);
    expect(
      screen.queryByRole("complementary", { name: "Item inspector" }),
    ).not.toBeInTheDocument();
    expect(screen.queryByText(/Nothing is selected/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect Alpha" }));
    expect(
      await screen.findByRole("complementary", { name: "Item inspector" }),
    ).toBeInTheDocument();
    expect(group.querySelectorAll("[data-panel]")).toHaveLength(2);
    // Inline on desktop: no dialog takes over the screen.
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

    // Switching the selection keeps the same pane open for the new item.
    fireEvent.click(screen.getByRole("button", { name: "Inspect Beta" }));
    expect(
      await screen.findByRole("heading", { name: "Beta" }),
    ).toBeInTheDocument();
    expect(group.querySelectorAll("[data-panel]")).toHaveLength(2);

    fireEvent.click(
      screen.getByRole("button", { name: "Close item inspector" }),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("complementary", { name: "Item inspector" }),
      ).not.toBeInTheDocument(),
    );
    expect(group.querySelectorAll("[data-panel]")).toHaveLength(1);
  });

  it("keeps a compact header without duplicating the Studio breadcrumb", async () => {
    mockDesktop();
    mockServer();
    renderEditor();

    expect(
      await screen.findByRole("heading", { level: 1, name: "Lobby loop" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "Playlists" }),
    ).not.toBeInTheDocument();
    // One publication state, never "Draft" beside "Unpublished changes".
    expect(screen.getByText("Unpublished changes")).toBeInTheDocument();
    expect(screen.queryByText("Draft")).not.toBeInTheDocument();
    expect(screen.getByText("2 items · 0:20")).toBeInTheDocument();
  });

  it("puts playback defaults in a compact authoring bar and reports bulk changes with a toast", async () => {
    mockDesktop();
    mockServer();
    const add = vi.spyOn(toast, "add");
    const bulk = vi
      .spyOn(api, "bulkUpdatePlaylistItems")
      .mockResolvedValue(playlist());
    renderEditor();

    const bar = await screen.findByRole("toolbar", {
      name: "Playlist authoring",
    });
    expect(
      within(bar).getByRole("button", { name: "Add content" }),
    ).toBeInTheDocument();
    expect(
      within(bar).getByRole("combobox", { name: "Playlist transition" }),
    ).toBeInTheDocument();
    const duration = within(bar).getByLabelText(
      "Playlist image duration in seconds",
    );
    expect(duration).toHaveValue(10);
    expect(
      screen.queryByRole("heading", { name: "Playback defaults" }),
    ).not.toBeInTheDocument();

    fireEvent.change(duration, { target: { value: "12" } });
    fireEvent.blur(duration);
    await waitFor(() =>
      expect(bulk).toHaveBeenCalledWith("p1", { durationMs: 12_000 }, "token"),
    );
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({
          title: "Image durations set to 12 seconds.",
        }),
      ),
    );
    // The result is transient: nothing is inserted above the timeline.
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("offers Layouts beside the primary add action", async () => {
    mockDesktop();
    mockServer();
    renderEditor();

    fireEvent.click(
      await screen.findByRole("button", { name: "More ways to add" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Published Layout" }),
    );
    expect(
      await screen.findByRole("dialog", { name: "Add published Layout" }),
    ).toBeInTheDocument();
  });

  it("confirms before removing an item from the row menu", async () => {
    mockDesktop();
    mockServer();
    const remove = vi
      .spyOn(api, "deletePlaylistItem")
      .mockResolvedValue(playlist());
    renderEditor();

    fireEvent.click(
      await screen.findByRole("button", { name: "Actions for Beta" }),
    );
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove from playlist/ }),
    );
    expect(
      await screen.findByRole("alertdialog", {
        name: "Remove Beta from this playlist?",
      }),
    ).toBeInTheDocument();
    expect(remove).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Remove item" }));
    await waitFor(() =>
      expect(remove).toHaveBeenCalledWith("p1", "item-b", "token"),
    );
  });

  it("shows tag-driven playlists as read-only sequences with a path to their rule", async () => {
    mockDesktop();
    mockServer({ sourceType: "tag" });
    renderEditor();

    const bar = await screen.findByRole("toolbar", {
      name: "Playlist authoring",
    });
    expect(
      within(bar).queryByRole("button", { name: "Add content" }),
    ).not.toBeInTheDocument();
    expect(
      within(bar).getByRole("combobox", { name: "Playlist transition" }),
    ).toHaveAttribute("data-disabled");
    expect(
      screen.queryByRole("button", { name: "Reorder Alpha" }),
    ).not.toBeInTheDocument();

    fireEvent.click(
      within(bar).getByRole("button", { name: "Edit content source" }),
    );
    expect(
      await screen.findByRole("tab", { name: "Content source" }),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("organizes playlist details into General, Content source, and Usage tabs", async () => {
    mockDesktop();
    mockServer();
    vi.spyOn(api, "playlistRevisions").mockResolvedValue({
      items: [],
      kept: 0,
    });
    renderEditor();

    await screen.findByRole("heading", { level: 1, name: "Lobby loop" });
    // Used By belongs to the details surface, not the authoring flow.
    expect(screen.queryByText("Lobby Split")).not.toBeInTheDocument();

    openMore();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Playlist details" }),
    );
    const details = await screen.findByRole("dialog");
    expect(details).toHaveAccessibleName("Playlist details");
    expect(
      within(details).getByRole("tab", { name: "General" }),
    ).toHaveAttribute("aria-selected", "true");

    fireEvent.change(screen.getByLabelText("Name"), {
      target: { value: "Updated lobby loop" },
    });
    fireEvent.click(within(details).getByRole("tab", { name: "Usage" }));
    expect(await within(details).findByText("Lobby Split")).toBeInTheDocument();
    fireEvent.click(
      within(details).getByRole("tab", { name: "Content source" }),
    );
    expect(
      await within(details).findByRole("combobox", { name: "Source" }),
    ).toBeInTheDocument();

    fireEvent.click(within(details).getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    openMore();
    fireEvent.click(
      await screen.findByRole("menuitem", { name: "Playlist details" }),
    );
    expect(await screen.findByLabelText("Name")).toHaveValue(
      "Updated lobby loop",
    );
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );

    openMore();
    fireEvent.click(await screen.findByRole("menuitem", { name: "History" }));
    expect(
      await screen.findByRole("heading", { name: "History" }),
    ).toBeInTheDocument();
    // History stays its own surface, not a details tab.
    expect(screen.queryByRole("tab", { name: "History" })).toBeNull();
  });

  it("reports publishing with a toast instead of an inline success alert", async () => {
    mockDesktop();
    mockServer();
    const add = vi.spyOn(toast, "add");
    vi.spyOn(api, "publishPlaylist").mockResolvedValue(undefined);
    renderEditor();

    fireEvent.click(await screen.findByRole("button", { name: "Publish" }));
    await waitFor(() =>
      expect(add).toHaveBeenCalledWith(
        expect.objectContaining({ title: "Playlist published." }),
      ),
    );
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.queryByText(/was submitted or published/)).toBeNull();
  });

  it("uses the swipeable inspector on narrow screens", async () => {
    mockServer();
    renderEditor();

    await screen.findByRole("button", { name: "Inspect Alpha" });
    expect(
      screen.queryByRole("group", {
        name: "Playlist sequence and inspector",
      }),
    ).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Inspect Alpha" }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByText("Alpha")).toBeInTheDocument();
    fireEvent.click(within(drawer).getByRole("button", { name: "Done" }));
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
  });
});
