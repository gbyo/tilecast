import { describe, expect, it } from "vitest";
import type { Screen } from "../api/types";
import type { WireScreenPreview as ScreenPreview } from "../api/domains/screens";
import {
  livePreviewState,
  previewAge,
  previewRailPhase,
  previewRailState,
} from "./livePreviewState";

const screen = { status: "online" } as Screen;
const preview = {
  status: "available",
  imageAvailable: true,
  capturedAt: "2026-07-13T20:00:00Z",
  updatedAt: "2026-07-13T20:00:00Z",
} as ScreenPreview;

describe("livePreviewState", () => {
  it("does not wait for a stale player without a capture, but preserves its cached image", () => {
    const staleScreen = { ...screen, status: "stale" } as Screen;
    expect(
      livePreviewState(staleScreen, {
        ...preview,
        status: "loading",
        imageAvailable: false,
      }),
    ).toBe("offline");
    expect(livePreviewState(staleScreen, preview)).toBe("stale");
  });
  it("shows a recent image as live", () => {
    expect(
      livePreviewState(screen, preview, Date.parse("2026-07-13T20:00:20Z")),
    ).toBe("live");
  });

  it("marks old captures as stale", () => {
    expect(
      livePreviewState(screen, preview, Date.parse("2026-07-13T20:01:00Z")),
    ).toBe("stale");
  });

  it("prioritizes player connectivity and capture errors", () => {
    expect(livePreviewState({ ...screen, status: "offline" }, preview)).toBe(
      "offline",
    );
    expect(
      livePreviewState(screen, { ...preview, status: "capture_error" }),
    ).toBe("capture-error");
  });
});

describe("previewAge", () => {
  const capturedAt = "2026-07-13T20:00:00Z";

  it("formats seconds, minutes, hours, and days", () => {
    expect(
      previewAge(capturedAt, Date.parse("2026-07-13T20:00:50Z"))?.label,
    ).toBe("50s ago");
    expect(
      previewAge(capturedAt, Date.parse("2026-07-13T20:03:00Z"))?.label,
    ).toBe("3m ago");
    expect(
      previewAge(capturedAt, Date.parse("2026-07-13T22:00:00Z"))?.label,
    ).toBe("2h ago");
    expect(
      previewAge(capturedAt, Date.parse("2026-07-15T20:00:00Z"))?.label,
    ).toBe("2d ago");
  });

  it("changes tone as the capture ages", () => {
    expect(
      previewAge(capturedAt, Date.parse("2026-07-13T20:00:30Z"))?.tone,
    ).toBe("fresh");
    expect(
      previewAge(capturedAt, Date.parse("2026-07-13T20:00:50Z"))?.tone,
    ).toBe("aging");
    expect(
      previewAge(capturedAt, Date.parse("2026-07-13T20:03:00Z"))?.tone,
    ).toBe("old");
  });

  it("handles future and invalid timestamps safely", () => {
    expect(previewAge(capturedAt, Date.parse("2026-07-13T19:59:50Z"))).toEqual({
      label: "0s ago",
      tone: "fresh",
    });
    expect(previewAge("not-a-date")).toBeNull();
  });
});

describe("previewRailState", () => {
  const capturedAt = "2026-07-13T20:00:00Z";
  const at = (seconds: number) => Date.parse(capturedAt) + seconds * 1_000;

  it("follows the shared previewAge thresholds for stale previews", () => {
    expect(previewRailState("stale", capturedAt, at(45))).toBe("none");
    expect(previewRailState("stale", capturedAt, at(46))).toBe("aging");
    expect(previewRailState("stale", capturedAt, at(120))).toBe("aging");
    expect(previewRailState("stale", capturedAt, at(121))).toBe("overdue");
  });

  it("treats a capture error as an immediate failure", () => {
    expect(previewRailState("capture-error", capturedAt, at(5))).toBe("error");
    expect(previewRailState("capture-error", undefined, at(5))).toBe("error");
  });

  it("stays quiet for healthy and separately explained states", () => {
    for (const state of ["live", "loading", "offline", "unavailable"] as const)
      expect(previewRailState(state, capturedAt, at(600))).toBe("none");
    expect(previewRailState("stale", undefined, at(600))).toBe("none");
  });
});

describe("previewRailPhase", () => {
  it("is deterministic, within one cycle, and varies between screens", () => {
    expect(previewRailPhase("screen-1")).toBe(previewRailPhase("screen-1"));
    const phases = ["a", "b", "c", "d", "e"].map(previewRailPhase);
    for (const phase of phases) {
      expect(phase).toBeGreaterThanOrEqual(0);
      expect(phase).toBeLessThan(1);
    }
    expect(new Set(phases).size).toBe(phases.length);
  });
});
