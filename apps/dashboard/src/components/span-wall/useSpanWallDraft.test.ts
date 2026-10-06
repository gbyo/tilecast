// @vitest-environment jsdom

import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { ScreenGroup, SpanPanel, SpanStatus } from "../../api/types";
import { spanPresets } from "./spanWallModel";
import { useSpanWallDraft } from "./useSpanWallDraft";

const screens = [
  { id: "a", name: "A", location: "" },
  { id: "b", name: "B", location: "" },
];
const panel = (screenId: string, x: number): SpanPanel => ({
  screenId,
  order: 0,
  x,
  y: 0,
  width: 100,
  height: 100,
  rotation: 0,
  bezelLeft: 0,
  bezelTop: 0,
  bezelRight: 0,
  bezelBottom: 0,
});
const server = (width: number) =>
  ({
    geometry: {
      canvas: { width, height: 1080 },
      panels: [panel("a", 0), panel("b", 100)],
    },
  }) as unknown as SpanStatus;
const group = (displayMode: ScreenGroup["displayMode"]) => ({
  displayMode,
  screens,
});
// The hook syncs when the server object changes, as a query result does, so
// fixtures must stay referentially stable across renders.
const spanGroup = group("span");
const mirrorGroup = group("mirror");
const initial = server(3840);

describe("useSpanWallDraft", () => {
  it("follows the server without becoming dirty on a refetch", () => {
    const { result, rerender } = renderHook(
      ({ status }) => useSpanWallDraft(spanGroup, status),
      { initialProps: { status: undefined as SpanStatus | undefined } },
    );
    expect(result.current.dirty).toBe(false);
    rerender({ status: server(3840) });
    expect(result.current.canvas.width).toBe(3840);
    rerender({ status: server(4000) });
    expect(result.current.canvas.width).toBe(4000);
    expect(result.current.dirty).toBe(false);
  });

  it("keeps local edits when the server data refreshes", () => {
    const { result, rerender } = renderHook(
      ({ status }) => useSpanWallDraft(spanGroup, status),
      { initialProps: { status: initial } },
    );
    act(() => result.current.setCanvasSize("width", 5000));
    expect(result.current.dirty).toBe(true);
    rerender({ status: server(4000) });
    expect(result.current.canvas.width).toBe(5000);
  });

  it("is dirty for each kind of edit, and clean after reset or save", () => {
    const { result } = renderHook(() => useSpanWallDraft(spanGroup, initial));
    expect(result.current.dirty).toBe(false);
    act(() => result.current.setPanel("a", "rotation", 90));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.reset());
    expect(result.current.dirty).toBe(false);
    expect(result.current.panels[0]?.rotation).toBe(0);
    act(() => result.current.setPanel("a", "bezelLeft", 3));
    expect(result.current.dirty).toBe(true);
    act(() => result.current.markSaved());
    expect(result.current.dirty).toBe(false);
    act(() => result.current.applyPreset(spanPresets[1]));
    expect(result.current.dirty).toBe(true);
    expect(result.current.canvas).toEqual({ width: 1920, height: 2160 });
  });

  it("starts an unsaved wall dirty", () => {
    const { result } = renderHook(() =>
      useSpanWallDraft(mirrorGroup, undefined),
    );
    expect(result.current.dirty).toBe(true);
    expect(result.current.panels).toHaveLength(2);
  });
});
