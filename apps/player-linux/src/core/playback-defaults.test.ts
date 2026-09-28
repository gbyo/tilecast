import { describe, expect, it } from "vitest";
import { resolvePlaybackItemSettings } from "./player";
import { fallbackDurationMsFor } from "@tilecast/player-runtime/projection";

describe("fallback item durations", () => {
  it("leaves video without an invented duration", () => {
    // A display group reserves exactly this much of the shared timeline for
    // the item, so a fallback here truncates or freezes every grouped video.
    expect(fallbackDurationMsFor("video", 8_000)).toBeNull();
  });

  it("keeps the configured default for images and the fixed ones elsewhere", () => {
    expect(fallbackDurationMsFor("image", 8_000)).toBe(8_000);
    expect(fallbackDurationMsFor("website", 8_000)).toBe(60_000);
    expect(fallbackDurationMsFor("widget", 8_000)).toBe(30_000);
    expect(fallbackDurationMsFor("layout", 8_000)).toBe(30_000);
  });

  it("delegates a video item to its own length", () => {
    const item = {
      id: "item",
      assetId: "asset",
      assetType: "video",
      fitMode: "contain",
      transition: "none",
      audioEnabled: true,
      volume: 1,
      deliveryPolicy: "download",
      usePlayerDefaults: true,
    };
    expect(
      resolvePlaybackItemSettings(
        item,
        { defaultImageDurationSeconds: 8 },
        fallbackDurationMsFor(item.assetType, 8_000),
      ).durationMs,
    ).toBeNull();
  });
});

describe("authoritative playback defaults", () => {
  it("overrides authored media values only when the item delegates", () => {
    const item = {
      id: "item",
      assetId: "asset",
      assetType: "image",
      durationMs: 10_000,
      fitMode: "contain",
      transition: "none",
      audioEnabled: true,
      volume: 1,
      deliveryPolicy: "download",
      usePlayerDefaults: true,
    };
    expect(
      resolvePlaybackItemSettings(
        item,
        {
          defaultFitMode: "cover",
          defaultTransition: "fade",
          defaultAudioEnabled: false,
          defaultVolume: 0.25,
        },
        22_000,
      ),
    ).toMatchObject({
      durationMs: 22_000,
      fitMode: "cover",
      transition: "fade",
      audioEnabled: false,
      volume: 0.25,
    });
  });

  it("preserves authored values when delegation is disabled", () => {
    const item = {
      id: "item",
      assetId: "asset",
      assetType: "image",
      durationMs: 10_000,
      fitMode: "stretch",
      transition: "crossfade",
      audioEnabled: true,
      volume: 0.9,
      deliveryPolicy: "download",
      usePlayerDefaults: false,
    };
    expect(
      resolvePlaybackItemSettings(item, { defaultFitMode: "cover" }, 22_000),
    ).toMatchObject({
      durationMs: 10_000,
      fitMode: "stretch",
      transition: "crossfade",
      audioEnabled: true,
      volume: 0.9,
    });
  });
});
