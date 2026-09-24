// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../api/client";
import * as authModule from "../auth/AuthProvider";
import type { Asset, Layout, LayoutDocument } from "../api/types";
import * as previewCapture from "../content/widgetPreviewCapture";
import { createPrimitivePlacement, LayoutEditorPage } from "./LayoutEditorPage";

// These tests exercise the pointer-drag move handler inside LayoutEditorPage,
// specifically the "snap first, then clamp" ordering used when dragging a
// placement: clamping must run last so an edge-placed item can never be
// snapped back outside the canvas (see LayoutEditorPage.tsx beginMove/move).

const canvas: LayoutDocument["canvas"] = {
  width: 1920,
  height: 1080,
  orientation: "landscape",
  backgroundColor: "#101820",
  safeAreaPercent: 5,
};
const defaultMatchMedia = window.matchMedia.bind(window);

// A width/height that is not a multiple of 10 so `canvas.width - width` and
// `canvas.height - height` are not multiples of 10 either. This is what
// exposes the bug: snapping the clamped edge position rounds it back out of
// bounds.
function buildLayout(): Layout {
  const placement = {
    ...createPrimitivePlacement("text", canvas),
    x: 100,
    y: 100,
    width: 105,
    height: 155,
  };
  return {
    id: "layout-1",
    name: "Lobby",
    description: "",
    orientation: "landscape",
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
    draft: { schemaVersion: 2, canvas, placements: [placement] },
    draftRevision: 1,
    hasUnpublishedChanges: false,
    dependencies: [],
    usage: { screens: [], schedules: [], campaigns: [] },
    createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z",
  };
}

function mockAuth() {
  vi.spyOn(authModule, "useAuth").mockReturnValue({
    status: {
      authenticated: true,
      user: { id: "u1", name: "User", username: "user", role: "owner" },
      csrfToken: "tok",
    },
    isLoading: false,
  } as unknown as ReturnType<typeof authModule.useAuth>);
}

function renderLayoutEditor(assets: Asset[] = []) {
  const layout = buildLayout();
  vi.spyOn(api, "layout").mockResolvedValue(layout);
  vi.spyOn(api, "assets").mockResolvedValue({
    items: assets,
    total: assets.length,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "playlists").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "listDataSources").mockResolvedValue({
    items: [],
    total: 0,
    page: 1,
    pageSize: 100,
  });
  vi.spyOn(api, "saveLayoutDraft").mockResolvedValue({
    draftRevision: 2,
  } as never);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={["/layouts/layout-1"]}>
        <Routes>
          <Route path="/layouts/:id" element={<LayoutEditorPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

// Drags the placement by an absolute pixel delta. The stage bounds are
// mocked to exactly match the canvas size, so a `bounds` delta of 1 client
// pixel maps to exactly 1 canvas pixel, keeping the arithmetic simple.
function dragBy(placementEl: Element, dx: number, dy: number) {
  fireEvent.pointerDown(placementEl, { clientX: 0, clientY: 0, pointerId: 1 });
  fireEvent.pointerMove(window, { clientX: dx, clientY: dy, pointerId: 1 });
  fireEvent.pointerUp(window, { clientX: dx, clientY: dy, pointerId: 1 });
}

function pctOfWidth(value: number) {
  return (value / canvas.width) * 100;
}
function pctOfHeight(value: number) {
  return (value / canvas.height) * 100;
}

beforeEach(() => {
  // jsdom reports all zeroes for layout geometry; give the stage a concrete
  // size equal to the canvas so drag deltas translate 1:1 into canvas pixels.
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: canvas.width,
    height: canvas.height,
    top: 0,
    left: 0,
    right: canvas.width,
    bottom: canvas.height,
    x: 0,
    y: 0,
    toJSON: () => "",
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.matchMedia = defaultMatchMedia;
});

function mockDesktop() {
  if (!("ResizeObserver" in window)) {
    (window as unknown as Record<string, unknown>).ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  }
  window.matchMedia = (query) => ({
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

describe("Layout editor drag: snap-then-clamp", () => {
  it("keeps a dragged item fully inside the canvas even when snapping would push it out of bounds", async () => {
    mockAuth();
    renderLayoutEditor();
    const placement = await screen.findByText("New text");
    const placementEl = placement.closest(".layout-placement")!;

    // Drag far past the bottom-right edge. Both axes overshoot by an amount
    // that is already a multiple of 10, so snapping is a no-op here — the
    // bug this guards against is clamp running *before* snap, which would
    // round the already-clamped edge position (1815, 925 — neither a
    // multiple of 10, since width/height are not multiples of 10) back out
    // of bounds to (1820, 930).
    dragBy(placementEl, 5000, 5000);

    const style = (placementEl as HTMLElement).style;
    expect(parseFloat(style.left)).toBeCloseTo(pctOfWidth(1815), 5);
    expect(parseFloat(style.top)).toBeCloseTo(pctOfHeight(925), 5);
    // Size is untouched by a plain move.
    expect(parseFloat(style.width)).toBeCloseTo(pctOfWidth(105), 5);
    expect(parseFloat(style.height)).toBeCloseTo(pctOfHeight(155), 5);

    // Explicitly assert the invariant the fix restores: the item's right and
    // bottom edges never exceed the canvas.
    expect(
      parseFloat(style.left) + parseFloat(style.width),
    ).toBeLessThanOrEqual(100.000001);
    expect(
      parseFloat(style.top) + parseFloat(style.height),
    ).toBeLessThanOrEqual(100.000001);
  });

  it("still snaps to the nearest 10px grid away from the canvas edges", async () => {
    mockAuth();
    renderLayoutEditor();
    const placement = await screen.findByText("New text");
    const placementEl = placement.closest(".layout-placement")!;

    // 100 + 23 -> snaps to 120; 100 + 27 -> snaps to 130. Neither clamps.
    dragBy(placementEl, 23, 27);

    const style = (placementEl as HTMLElement).style;
    expect(parseFloat(style.left)).toBeCloseTo(pctOfWidth(120), 5);
    expect(parseFloat(style.top)).toBeCloseTo(pctOfHeight(130), 5);
  });

  it("moves by the raw unsnapped delta (still clamped) when snapping is disabled", async () => {
    mockAuth();
    renderLayoutEditor();
    const placement = await screen.findByText("New text");
    const placementEl = placement.closest(".layout-placement")!;

    fireEvent.click(screen.getByRole("checkbox", { name: "Snap" }));

    // Same delta as the snapping test, but now expect the exact unrounded
    // position: 100 + 23 = 123, 100 + 27 = 127.
    dragBy(placementEl, 23, 27);

    const style = (placementEl as HTMLElement).style;
    expect(parseFloat(style.left)).toBeCloseTo(pctOfWidth(123), 5);
    expect(parseFloat(style.top)).toBeCloseTo(pctOfHeight(127), 5);
  });

  it("does not create an unsaved change when a placement is only selected", async () => {
    mockAuth();
    renderLayoutEditor();
    const placement = await screen.findByText("New text");
    const placementEl = placement.closest(".layout-placement")!;

    fireEvent.pointerDown(placementEl, {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });
    fireEvent.pointerUp(window, {
      clientX: 100,
      clientY: 100,
      pointerId: 1,
    });

    expect(screen.getByText("Saved")).toBeInTheDocument();
    expect(api.saveLayoutDraft).not.toHaveBeenCalled();
  });

  it("keeps the draft saved when optional thumbnail capture fails", async () => {
    mockAuth();
    vi.spyOn(previewCapture, "captureLayoutPreview").mockRejectedValue(
      new Error("Canvas capture unavailable"),
    );
    renderLayoutEditor();
    const placement = await screen.findByText("New text");
    const placementEl = placement.closest(".layout-placement")!;

    dragBy(placementEl, 20, 20);

    await waitFor(() => expect(api.saveLayoutDraft).toHaveBeenCalledTimes(1), {
      timeout: 2_000,
    });
    await waitFor(() => expect(screen.getByText("Saved")).toBeInTheDocument());
    expect(screen.queryByText("Retry save")).not.toBeInTheDocument();
  });

  it("prevents a shelf thumbnail from taking over the library drag", async () => {
    mockAuth();
    renderLayoutEditor([
      {
        id: "poster",
        name: "Poster",
        type: "image",
        thumbnailUrl: "/poster.jpg",
        createdAt: "2026-07-28T12:00:00Z",
      } as Asset,
    ]);

    const addButton = await screen.findByTitle("Add Poster");
    expect(addButton.querySelector("img")).toHaveAttribute(
      "draggable",
      "false",
    );
  });
});

describe("Layout editor layers and zoom controls", () => {
  it("uses generated preview and history dialogs with Escape focus return", async () => {
    mockAuth();
    vi.spyOn(api, "layoutRevisions").mockResolvedValue({
      items: [],
      total: 0,
      page: 1,
      pageSize: 100,
    });
    renderLayoutEditor();
    await screen.findByText("New text");

    const user = userEvent.setup();
    const preview = screen.getByRole("button", { name: "Preview" });
    await user.click(preview);
    expect(
      await screen.findByRole("dialog", { name: "Preview Lobby" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Preview Lobby" }),
      ).not.toBeInTheDocument(),
    );
    expect(preview).toHaveFocus();

    const history = screen.getByRole("button", { name: "History" });
    await user.click(history);
    expect(
      await screen.findByRole("dialog", { name: "Published revisions" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Published revisions" }),
      ).not.toBeInTheDocument(),
    );
    expect(history).toHaveFocus();
  });

  it("offers the desktop editor command families without hiding the primary toolbar", async () => {
    mockAuth();
    mockDesktop();
    renderLayoutEditor();

    expect(
      await screen.findByRole("menubar", { name: "Layout editor commands" }),
    ).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Undo" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Preview" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("menuitem", { name: "Edit" }));
    fireEvent.click(
      await screen.findByRole("menuitem", { name: /Select all/ }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));

    expect(screen.getAllByRole("button", { name: "Text" })[0]).toHaveAttribute(
      "aria-pressed",
      "true",
    );
  });

  it("toggles layer visibility with real buttons, by mouse and keyboard", async () => {
    mockAuth();
    renderLayoutEditor();
    await screen.findByText("New text");
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));

    const hide = await screen.findByRole("button", {
      name: "Hide Text",
    });
    expect(hide.tagName).toBe("BUTTON");

    const user = userEvent.setup();
    hide.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("button", { name: "Show Text" }),
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Show Text" }));
    expect(
      await screen.findByRole("button", { name: "Hide Text" }),
    ).toBeInTheDocument();
  });

  it("exposes the visibility menu on layer rows", async () => {
    mockAuth();
    renderLayoutEditor();
    await screen.findByText("New text");
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));

    const row = screen
      .getByRole("button", { name: "Text" })
      .closest(".layout-layer-row")!;
    fireEvent.contextMenu(row);
    expect(
      await screen.findByRole("menuitem", { name: "Hide" }),
    ).toBeInTheDocument();
  });

  it("groups zoom as minus, percent, plus, and fit", async () => {
    mockAuth();
    renderLayoutEditor();
    await screen.findByText("New text");

    expect(
      screen.getByRole("group", { name: "Canvas zoom" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Fit canvas to view" }),
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Zoom in" }));
    expect(await screen.findByText("110%")).toBeInTheDocument();
  });

  it("keeps related inspector sections independently expandable", async () => {
    mockAuth();
    renderLayoutEditor();
    await screen.findByText("New text");
    fireEvent.click(screen.getByRole("button", { name: "Layers" }));
    fireEvent.click(screen.getByRole("button", { name: "Text" }));

    expect(await screen.findByText("Position & size")).toBeInTheDocument();
    expect(screen.getByText("Appearance")).toBeInTheDocument();
    expect(screen.getByLabelText("Layer opacity")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Appearance" }));
    expect(screen.queryByLabelText("Layer opacity")).not.toBeInTheDocument();
    expect(screen.getByLabelText("Layer name")).toBeInTheDocument();
  });
});
