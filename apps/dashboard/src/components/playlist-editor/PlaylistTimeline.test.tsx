// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import type { PlaylistItem } from "../../api/types";
import { PlaylistTimeline } from "./PlaylistTimeline";

afterEach(cleanup);

function item(
  id: string,
  name: string,
  overrides: Partial<PlaylistItem> = {},
): PlaylistItem {
  return {
    id,
    assetId: `asset-${id}`,
    position: 0,
    durationMs: 10000,
    fitMode: "contain",
    transition: "none",
    audioEnabled: false,
    volume: 1,
    deliveryPolicy: "download",
    assetName: name,
    assetType: "image",
    assetStatus: "ready",
    thumbnailUrl: "https://example.com/thumb.png",
    ...overrides,
  };
}

const items = () => [item("a", "Alpha"), item("b", "Beta"), item("c", "Gamma")];

function renderTimeline(
  overrides: Partial<Parameters<typeof PlaylistTimeline>[0]> = {},
) {
  const handlers = {
    onSelect: vi.fn(),
    onMove: vi.fn(),
    onMoveToEdge: vi.fn(),
    onRemove: vi.fn(),
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onDrop: vi.fn(),
  };
  render(
    <PlaylistTimeline
      items={items()}
      sourceType="static"
      canManage
      playlistTransition="none"
      {...handlers}
      {...overrides}
    />,
  );
  return handlers;
}

const row = (name: string) =>
  screen
    .getByRole("button", { name: `Inspect ${name}` })
    .closest("[data-playlist-item]") as HTMLElement;

const menuLabels = () =>
  screen
    .getAllByRole("menuitem")
    .map((entry) => [entry.textContent, entry.hasAttribute("data-disabled")]);

describe("PlaylistTimeline rows", () => {
  it("renders each entry as a list item with quiet one-line metadata", () => {
    renderTimeline({
      items: [
        item("a", "Alpha"),
        item("v", "Announcements", {
          assetType: "video",
          audioEnabled: true,
          transition: "fade",
          assetDurationSeconds: 32,
        }),
      ],
    });
    const list = screen.getByRole("list", {
      name: "Playlist content timeline",
    });
    expect(within(list).getAllByRole("listitem")).toHaveLength(2);
    expect(row("Announcements")).toHaveTextContent("Video · Fade · Audio");
    expect(row("Announcements")).toHaveTextContent("0:32");
    // Ordinary metadata is text, not a badge; only the override is flagged.
    expect(within(row("Alpha")).queryByText("Image")).toBeNull();
    expect(within(row("Announcements")).getByText("Override")).toBeVisible();
  });

  it("does not show always-visible step buttons", () => {
    renderTimeline();
    expect(
      screen.queryByRole("button", { name: /Move .* up/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Move .* down/ }),
    ).not.toBeInTheDocument();
  });

  it("flags unavailable media with a status badge", () => {
    renderTimeline({
      items: [item("f", "Broken", { assetStatus: "failed" })],
    });
    expect(within(row("Broken")).getByText("Failed")).toBeInTheDocument();
  });

  it("selects the row from its inspect control", () => {
    const handlers = renderTimeline();
    fireEvent.click(screen.getByRole("button", { name: "Inspect Beta" }));
    expect(handlers.onSelect).toHaveBeenCalledWith("b");
  });
});

describe("PlaylistTimeline row actions", () => {
  it("offers the same commands from the overflow menu and the context menu", async () => {
    const handlers = renderTimeline();

    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await screen.findByRole("menuitem", { name: /Move to bottom/ });
    const dropdown = menuLabels();
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: "Escape",
    });
    await vi.waitFor(() =>
      expect(screen.queryByRole("menuitem")).not.toBeInTheDocument(),
    );

    fireEvent.contextMenu(row("Alpha"));
    await screen.findByRole("menuitem", { name: /Move to bottom/ });
    expect(menuLabels()).toEqual(dropdown);
    // The first row cannot move further up.
    expect(screen.getByRole("menuitem", { name: /Move up/ })).toHaveAttribute(
      "data-disabled",
    );

    fireEvent.click(screen.getByRole("menuitem", { name: /Move to bottom/ }));
    expect(handlers.onMoveToEdge).toHaveBeenCalledWith("a", "bottom");
  });

  it("moves and removes from the visible overflow menu", async () => {
    const handlers = renderTimeline();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Beta" }));
    fireEvent.click(await screen.findByRole("menuitem", { name: /Move up/ }));
    expect(handlers.onMove).toHaveBeenCalledWith("b", -1);

    fireEvent.click(screen.getByRole("button", { name: "Actions for Beta" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Remove from playlist/ }),
    );
    expect(handlers.onRemove).toHaveBeenCalledWith("b");
  });

  it("only offers Inspect when the timeline cannot be edited", async () => {
    renderTimeline({ canManage: false });
    expect(
      screen.queryByRole("button", { name: "Reorder Alpha" }),
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Actions for Alpha" }));
    await screen.findByRole("menuitem", { name: /Inspect/ });
    expect(screen.getAllByRole("menuitem")).toHaveLength(1);
  });

  it("moves with Alt+Arrow and Alt+Home/End from the keyboard", () => {
    const handlers = renderTimeline();
    fireEvent.keyDown(screen.getByRole("button", { name: "Inspect Beta" }), {
      key: "ArrowUp",
      altKey: true,
    });
    expect(handlers.onMove).toHaveBeenCalledWith("b", -1);
    fireEvent.keyDown(row("Beta"), { key: "ArrowDown", altKey: true });
    expect(handlers.onMove).toHaveBeenCalledWith("b", 1);
    fireEvent.keyDown(row("Beta"), { key: "Home", altKey: true });
    expect(handlers.onMoveToEdge).toHaveBeenCalledWith("b", "top");
    fireEvent.keyDown(row("Beta"), { key: "End", altKey: true });
    expect(handlers.onMoveToEdge).toHaveBeenCalledWith("b", "bottom");
  });

  it("leaves plain arrow keys alone so rows keep scrolling", () => {
    const handlers = renderTimeline();
    fireEvent.keyDown(row("Beta"), { key: "ArrowUp" });
    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onMoveToEdge).not.toHaveBeenCalled();
  });

  it("reorders by dragging the handle onto another row", () => {
    const handlers = renderTimeline();
    const data = new Map<string, string>();
    const dataTransfer = {
      setData: (type: string, value: string) => data.set(type, value),
      getData: (type: string) => data.get(type) ?? "",
      effectAllowed: "",
    };
    fireEvent.dragStart(screen.getByRole("button", { name: "Reorder Gamma" }), {
      dataTransfer,
    });
    expect(handlers.onDragStart).toHaveBeenCalledWith("c");
    fireEvent.drop(row("Alpha"), { dataTransfer });
    expect(handlers.onDrop).toHaveBeenCalledWith(expect.anything(), "a");
  });
});

describe("PlaylistTimeline empty state", () => {
  it("shows the provided add action inside Empty", () => {
    renderTimeline({
      items: [],
      emptyAction: <button type="button">Add content</button>,
    });
    expect(screen.getByText("This playlist is empty")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Add content" })).toHaveLength(
      1,
    );
  });
});
