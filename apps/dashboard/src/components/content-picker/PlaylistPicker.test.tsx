// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { api } from "../../api/client";
import type { LayoutSummary, Playlist } from "../../api/types";
import { PlaylistPicker } from "./PlaylistPicker";

const playlist = (id: string, name: string, over: Partial<Playlist> = {}) =>
  ({
    id,
    name,
    description: "",
    revision: 1,
    itemCount: 3,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
    ...over,
  }) as Playlist;

const items = [
  playlist("lobby", "Lobby loop"),
  playlist("promos", "Promos", { sourceType: "tag", itemCount: 1 }),
];

function list(found = items) {
  return vi.spyOn(api, "playlists").mockResolvedValue({
    items: found,
    total: found.length,
    page: 1,
    pageSize: 100,
  });
}

const layout = (
  id: string,
  name: string,
  publishedRevision: number,
): LayoutSummary =>
  ({
    id,
    name,
    description: "",
    draftRevision: publishedRevision + 1,
    publishedRevision,
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  }) as LayoutSummary;

function listLayouts(found: LayoutSummary[]) {
  return vi.spyOn(api, "layouts").mockResolvedValue({
    items: found,
    total: found.length,
    page: 1,
    pageSize: 100,
  });
}

function picker(onConfirm = vi.fn(), includeLayouts = false) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PlaylistPicker
        open
        includeLayouts={includeLayouts}
        onConfirm={onConfirm}
        onClose={vi.fn()}
      />
    </QueryClientProvider>,
  );
}

beforeAll(() => {
  // jsdom does not implement the native dialog methods the shared Dialog calls.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.open = true;
  };
  HTMLDialogElement.prototype.close = function close() {
    this.open = false;
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("PlaylistPicker", () => {
  it("confirms the highlighted playlist rather than the first one listed", async () => {
    list();
    const confirm = vi.fn();
    picker(confirm);
    const user = userEvent.setup();

    await user.click(await screen.findByRole("button", { name: /Promos/ }));
    await user.click(screen.getByRole("button", { name: "Add playlist" }));
    expect(confirm).toHaveBeenCalledWith({
      kind: "playlist",
      playlist: items[1],
    });
  });

  it("keeps confirm unavailable until something is chosen", async () => {
    list();
    picker();
    await screen.findByRole("button", { name: /Lobby loop/ });
    expect(screen.getByRole("button", { name: "Add playlist" })).toBeDisabled();
  });

  it("searches server-side so playlists past the first page stay reachable", async () => {
    const playlists = list();
    picker();
    const user = userEvent.setup();

    await screen.findByRole("button", { name: /Lobby loop/ });
    await user.type(screen.getByPlaceholderText("Search playlists"), "promo");
    await waitFor(() => expect(playlists).toHaveBeenCalledWith("promo"));
  });

  it("marks a tag-driven playlist so it is not mistaken for a static one", async () => {
    list();
    picker();
    expect(
      await screen.findByRole("button", { name: /Promos.*tag-driven/s }),
    ).toBeInTheDocument();
  });

  it("shows the same preview thumbnail data as the playlist library", async () => {
    list([
      playlist("lobby", "Lobby loop", {
        previewItems: [
          {
            id: "welcome",
            name: "Welcome",
            type: "image",
            thumbnailUrl: "/api/v1/assets/welcome/thumbnail",
          },
        ],
      }),
    ]);
    picker();

    await screen.findByRole("button", { name: /Lobby loop/ });
    expect(
      document.body.querySelector(
        'img[src="/api/v1/assets/welcome/thumbnail"]',
      ),
    ).toBeInTheDocument();
  });

  it("leaves Layouts out unless the caller can target one", async () => {
    list();
    const layouts = listLayouts([layout("hero", "Hero wall", 3)]);
    picker();
    await screen.findByRole("button", { name: /Lobby loop/ });
    expect(screen.queryByText("Hero wall")).not.toBeInTheDocument();
    expect(layouts).not.toHaveBeenCalled();
  });

  it("offers published Layouts alongside playlists for schedules", async () => {
    list();
    const hero = {
      ...layout("hero", "Hero wall", 3),
      orientation: "landscape" as const,
      previewImageUrl: "/api/v1/layouts/hero/preview-image",
    };
    listLayouts([hero, layout("wip", "Draft only", 0)]);
    const confirm = vi.fn();
    picker(confirm, true);
    const user = userEvent.setup();

    // An unpublished Layout has no revision a player could show.
    expect(await screen.findByText("Hero wall")).toBeInTheDocument();
    expect(screen.queryByText("Draft only")).not.toBeInTheDocument();
    expect(
      document.body.querySelector(
        'img[src="/api/v1/layouts/hero/preview-image"]',
      ),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: /Hero wall/ }));
    await user.click(screen.getByRole("button", { name: "Add playlist" }));
    expect(confirm).toHaveBeenCalledWith({ kind: "layout", layout: hero });
  });
});
