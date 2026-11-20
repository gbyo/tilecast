import { describe, expect, it } from "vitest";
import { livePreviewFrameStyle } from "./livePreviewFrameStyle";

describe("livePreviewFrameStyle", () => {
  it("fits portrait frames into the viewport without turning them into 16:9", () => {
    expect(livePreviewFrameStyle(360, 640)).toEqual({
      aspectRatio: "360 / 640",
      width: "min(100%, 39.38dvh)",
    });
  });

  it("accepts landscape and square frames", () => {
    expect(livePreviewFrameStyle(960, 540).aspectRatio).toBe("960 / 540");
    expect(livePreviewFrameStyle(640, 640)).toEqual({
      aspectRatio: "640 / 640",
      width: "min(100%, 70dvh)",
    });
  });

  it("uses a safe fallback for missing or invalid dimensions", () => {
    expect(livePreviewFrameStyle(null, undefined).aspectRatio).toBe("16 / 9");
    expect(livePreviewFrameStyle(0, 640).aspectRatio).toBe("16 / 9");
    expect(livePreviewFrameStyle(Infinity, 640).aspectRatio).toBe("16 / 9");
  });
});
