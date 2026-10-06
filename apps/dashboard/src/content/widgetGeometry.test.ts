import { describe, expect, it } from "vitest";
import type { Asset, ContentDefinitionCatalog } from "@/api/types";
import { repositoryCatalog } from "@/components/content/widget-editor/testing";
import {
  DEFAULT_WIDGET_FRAME,
  FRAME_BOUNDS,
  placementSizeForFrame,
  recommendedFrameForAsset,
  recommendedFrameForProvider,
  recommendedFrameOf,
} from "./widgetGeometry";
import { RECOMMENDED_FRAME_BOUNDS } from "../../../../packages/widget-sdk/src/manifest";

const withFrame = (frame: unknown) =>
  ({ authoring: { preview: { recommendedFrame: frame } } }) as never;

describe("recommendedFrameOf", () => {
  it("reads a declared frame", () => {
    expect(recommendedFrameOf(withFrame({ width: 1920, height: 200 }))).toEqual(
      { width: 1920, height: 200 },
    );
  });

  it("is null without one, so the editor keeps the 960 x 540 default", () => {
    expect(DEFAULT_WIDGET_FRAME).toEqual({ width: 960, height: 540 });
    expect(recommendedFrameOf(undefined)).toBeNull();
    expect(recommendedFrameOf({})).toBeNull();
    expect(recommendedFrameOf({ authoring: { preview: {} } })).toBeNull();
  });

  it("ignores an invalid frame rather than rendering nonsense", () => {
    for (const frame of [
      { width: 0, height: 100 },
      { width: 31, height: 100 },
      { width: 3841, height: 100 },
      { width: 100.5, height: 100 },
      { width: "100", height: 100 },
      { width: 100 },
    ])
      expect(recommendedFrameOf(withFrame(frame))).toBeNull();
  });

  it("uses the same bounds as the Widget manifest schema", () => {
    expect(FRAME_BOUNDS).toEqual(RECOMMENDED_FRAME_BOUNDS);
  });
});

describe("recommendedFrameForProvider", () => {
  const catalog = repositoryCatalog();

  it("finds the Ticker's strip through the real catalog", () => {
    expect(recommendedFrameForProvider(catalog, "ticker")).toEqual({
      width: 1920,
      height: 200,
    });
  });

  it("is null for Widgets that declare nothing and for unknown providers", () => {
    expect(recommendedFrameForProvider(catalog, "clock")).toBeNull();
    expect(recommendedFrameForProvider(catalog, "nope")).toBeNull();
    expect(recommendedFrameForProvider(catalog, undefined)).toBeNull();
    expect(
      recommendedFrameForProvider(
        undefined as ContentDefinitionCatalog | undefined,
        "ticker",
      ),
    ).toBeNull();
  });

  it("is only consulted for Widget assets", () => {
    const widget = { type: "widget", widget: { provider: "ticker" } } as Asset;
    expect(recommendedFrameForAsset(catalog, widget)).toEqual({
      width: 1920,
      height: 200,
    });
    expect(recommendedFrameForAsset(catalog, { type: "image" })).toBeNull();
  });
});

describe("placementSizeForFrame", () => {
  const canvas = { width: 1920, height: 1080 };

  it("turns a 1920 x 160 strip into a wide, shallow placement", () => {
    const size = placementSizeForFrame({ width: 1920, height: 160 }, canvas);
    expect(size).toEqual({ width: 1536, height: 128 });
    expect(size.width / size.height).toBeCloseTo(12, 5);
  });

  it("leaves a 16:9 frame at the 40% default", () => {
    expect(placementSizeForFrame({ width: 1280, height: 720 }, canvas)).toEqual(
      {
        width: 768,
        height: 432,
      },
    );
  });

  it("keeps the frame's area when the shape fits", () => {
    const size = placementSizeForFrame({ width: 1000, height: 500 }, canvas);
    expect(size.width / size.height).toBeCloseTo(2, 1);
    expect(size.width * size.height).toBeCloseTo(768 * 432, -3);
  });

  it("never exceeds 80% of the canvas on either side", () => {
    for (const frame of [
      { width: 3840, height: 200 },
      { width: 200, height: 3840 },
      { width: 100, height: 100 },
    ]) {
      const size = placementSizeForFrame(frame, canvas);
      expect(size.width).toBeLessThanOrEqual(1536);
      expect(size.height).toBeLessThanOrEqual(864);
      const ratio = size.width / size.height;
      expect(ratio / (frame.width / frame.height)).toBeGreaterThan(0.95);
      expect(ratio / (frame.width / frame.height)).toBeLessThan(1.05);
    }
  });

  it("never draws a placement below the layout editor's 16 pixel minimum", () => {
    const size = placementSizeForFrame({ width: 3840, height: 32 }, canvas);
    expect(size).toEqual({ width: 1536, height: 16 });
  });
});
