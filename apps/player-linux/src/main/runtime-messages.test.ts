import { describe, expect, it } from "vitest";
import type { StoredManifest } from "../core/manifest";
import type { Presentation } from "../core/player";
import { presentationMessage } from "./runtime-messages";

const item = (id: string) => ({
  id,
  kind: "image" as const,
  src: `tcmedia://variant/a/${id}`,
  durationMs: 10_000,
  fitMode: "contain",
  audioEnabled: false,
  volume: 1,
  videoStartOffsetMs: null,
  videoEndOffsetMs: null,
});

describe("runtime presentation messages", () => {
  it("passes status surfaces through unchanged", () => {
    const presentation = {
      state: "idle",
      title: "Tilecast",
      message: "No content assigned.",
    } as Presentation;
    expect(presentationMessage(presentation, null)).toEqual({
      type: "presentation",
      presentation,
    });
  });

  it("sends an ungrouped playlist without timing", () => {
    const presentation = {
      state: "playing",
      items: [item("one")],
      generation: 4,
      takeover: false,
    } as unknown as Presentation;
    const message = presentationMessage(presentation, null);
    expect(message.timing).toBeUndefined();
    expect(message.presentation).toEqual(presentation);
  });

  it("anchors a synchronized group's timeline in the main process", () => {
    const presentation = {
      state: "playing",
      items: [item("one"), item("two")],
      generation: 4,
      takeover: false,
    } as unknown as Presentation;
    const stored = {
      manifest: {
        syncGroup: { id: "group-1", playbackEpoch: "2026-09-01T12:00:00Z" },
        playlist: {
          id: "p",
          items: [
            { id: "one", durationMs: 5_000 },
            { id: "two", durationMs: 7_000 },
          ],
        },
        playlists: [],
        schedules: [],
        assets: [],
      },
    } as unknown as StoredManifest;
    const message = presentationMessage(
      presentation,
      stored,
      Date.parse("2026-09-01T12:00:30Z"),
    );
    expect(message.presentation).toMatchObject({ synchronized: true });
    expect(message.presentation).not.toHaveProperty("synchronizedPlayback");
    expect(message.timing).toEqual({
      groupId: "group-1",
      anchorMs: Date.parse("2026-09-01T12:00:00Z"),
      durationsMs: [5_000, 7_000],
      clockOffsetMs: 0,
    });
  });
});
