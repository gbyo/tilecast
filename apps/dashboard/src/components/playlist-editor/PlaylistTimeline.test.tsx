// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { PlaylistItem } from "../../api/types";
import { PlaylistTimeline } from "./PlaylistTimeline";

// The timeline list renders inside a Base UI ScrollArea, whose viewport
// probes Element.getAnimations — absent in jsdom. This file-local stub
// reports no running animations; it stays out of the shared setup because
// the global behavior change alters menu/modal timing in unrelated suites.
if (typeof Element.prototype.getAnimations !== "function") {
  Element.prototype.getAnimations = () => [];
}

afterEach(cleanup);

function item(id: string, name: string): PlaylistItem {
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
    onDragStart: vi.fn(),
    onDragEnd: vi.fn(),
    onDrop: vi.fn(),
    onAddContent: vi.fn(),
    onAddLayout: vi.fn(),
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

describe("PlaylistTimeline reorder actions", () => {
  it("disables the step buttons at the timeline edges", () => {
    renderTimeline();
    expect(
      screen.getByRole("button", { name: "Move Alpha up" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move Gamma down" }),
    ).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Move Beta up" }),
    ).not.toBeDisabled();
  });

  it("moves to an edge from the row context menu", async () => {
    const handlers = renderTimeline();
    const row = screen
      .getByRole("button", { name: "Inspect Beta" })
      .closest("article")!;
    fireEvent.contextMenu(row);
    await screen.findByRole("menuitem", { name: /Move to top/ });
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to top/ }));
    expect(handlers.onMoveToEdge).toHaveBeenCalledWith("b", "top");

    fireEvent.contextMenu(row);
    await screen.findByRole("menuitem", { name: /Move to bottom/ });
    fireEvent.click(screen.getByRole("menuitem", { name: /Move to bottom/ }));
    expect(handlers.onMoveToEdge).toHaveBeenCalledWith("b", "bottom");
  });

  it("moves with Alt+Arrow and Alt+Home/End from the keyboard", () => {
    const handlers = renderTimeline();
    const row = screen
      .getByRole("button", { name: "Inspect Beta" })
      .closest("article")!;
    fireEvent.keyDown(row, { key: "ArrowUp", altKey: true });
    expect(handlers.onMove).toHaveBeenCalledWith("b", -1);
    fireEvent.keyDown(row, { key: "Home", altKey: true });
    expect(handlers.onMoveToEdge).toHaveBeenCalledWith("b", "top");
    fireEvent.keyDown(row, { key: "End", altKey: true });
    expect(handlers.onMoveToEdge).toHaveBeenCalledWith("b", "bottom");
  });

  it("leaves plain arrow keys alone so rows keep scrolling", () => {
    const handlers = renderTimeline();
    const row = screen
      .getByRole("button", { name: "Inspect Beta" })
      .closest("article")!;
    fireEvent.keyDown(row, { key: "ArrowUp" });
    expect(handlers.onMove).not.toHaveBeenCalled();
    expect(handlers.onMoveToEdge).not.toHaveBeenCalled();
  });
});
