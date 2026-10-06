import { describe, expect, it } from "vitest";
import {
  clampFrameSide,
  initialFrameChoice,
  offersRecommendedFrame,
  resolveFrame,
} from "./previewFrames";

describe("where the preview opens", () => {
  it("is Landscape at 960 x 540 for a Widget with no recommendation", () => {
    expect(initialFrameChoice(null)).toEqual({
      key: "landscape",
      custom: { width: 960, height: 540 },
    });
    expect(
      resolveFrame("landscape", { width: 1, height: 1 }, null),
    ).toMatchObject({ width: 960, height: 540 });
  });

  it("is the Widget's own frame when it matches no named preset", () => {
    const strip = { width: 1920, height: 200 };
    expect(initialFrameChoice(strip)).toEqual({
      key: "recommended",
      custom: strip,
    });
    expect(resolveFrame("recommended", strip, strip)).toEqual(strip);
    expect(offersRecommendedFrame(strip)).toBe(true);
  });

  it("selects the preset a recommendation equals, instead of listing it twice", () => {
    const portrait = { width: 540, height: 960 };
    expect(initialFrameChoice(portrait).key).toBe("portrait");
    expect(offersRecommendedFrame(portrait)).toBe(false);
    expect(offersRecommendedFrame(null)).toBe(false);
  });

  it("never rounds a recommendation into a nearby preset", () => {
    expect(initialFrameChoice({ width: 960, height: 241 }).key).toBe(
      "recommended",
    );
  });
});

describe("custom frame sizes", () => {
  it("stay inside the 32 to 3840 pixel range", () => {
    expect(clampFrameSide(1)).toBe(32);
    expect(clampFrameSide(100000)).toBe(3840);
    expect(clampFrameSide(100.6)).toBe(101);
    expect(clampFrameSide(Number.NaN)).toBe(32);
  });
});
