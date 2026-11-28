import { describe, expect, it } from "vitest";
import type { StoredManifest } from "./manifest";
import type { Presentation, PresentationItem } from "./player";
import {
  activateSynchronizedClock,
  effectiveDurationMs,
  enrichSynchronizedPresentation,
  projectSynchronizedPresentation,
  synchronizedNowMs,
  synchronizedPlaybackPosition,
  type SynchronizedPlayingPresentation,
} from "./synchronized-playback";
import type {
  Manifest,
  ManifestAsset,
  ManifestItem,
  ManifestSchedule,
} from "./types";

const videoAsset = (
  variantId: string,
  durationSeconds: number,
): ManifestAsset => ({
  assetId: "video-asset",
  variantId,
  mimeType: "video/mp4",
  sha256: "0".repeat(64),
  fileSize: 1_024,
  durationSeconds,
  downloadPath: `/media/${variantId}`,
});

const image = (id: string, durationMs: number): PresentationItem => ({
  id,
  kind: "image",
  src: `tcmedia://variant/${id}/v-${id}`,
  durationMs,
  fitMode: "contain",
  audioEnabled: false,
  volume: 0,
  videoStartOffsetMs: null,
  videoEndOffsetMs: null,
});

const video = (id: string): PresentationItem => ({
  id,
  kind: "video",
  src: `tcmedia://variant/${id}/v-${id}`,
  durationMs: null,
  fitMode: "contain",
  audioEnabled: true,
  volume: 1,
  videoStartOffsetMs: 2_000,
  videoEndOffsetMs: 22_000,
});

function manifest(epoch: string): Manifest {
  const items: ManifestItem[] = [
    {
      id: "image-1",
      assetId: "image-asset",
      variantId: "v-image-1",
      assetType: "image",
      durationMs: 10_000,
      fitMode: "contain",
      transition: "none",
      audioEnabled: false,
      volume: 0,
      deliveryPolicy: "download",
    },
    {
      id: "video-1",
      assetId: "video-asset",
      variantId: "v-video-1",
      assetType: "video",
      fitMode: "contain",
      transition: "none",
      audioEnabled: true,
      volume: 1,
      videoStartOffsetMs: 2_000,
      videoEndOffsetMs: 22_000,
      deliveryPolicy: "download",
    },
  ];
  const playlist = { id: "playlist-1", revision: 1, name: "Group", items };
  return {
    schemaVersion: 14,
    manifestVersion: 1,
    screenId: "screen-1",
    generatedAt: epoch,
    mode: "single-zone",
    playlist,
    directFallbackPlaylist: null,
    playlists: [playlist],
    schedules: [],
    assets: [
      {
        assetId: "image-asset",
        variantId: "v-image-1",
        mimeType: "image/png",
        sha256: "a",
        fileSize: 1,
        downloadPath: "/image",
      },
      {
        assetId: "video-asset",
        variantId: "v-video-1",
        mimeType: "video/mp4",
        sha256: "b",
        fileSize: 1,
        durationSeconds: 24,
        downloadPath: "/video",
      },
    ],
    serverTime: epoch,
    prefetchHorizonDays: 7,
    activationGraceSeconds: 0,
    websites: [],
    takeover: null,
    syncGroup: { id: "group-1", playbackEpoch: epoch },
  };
}

describe("synchronizedPlaybackPosition", () => {
  it("selects the shared item and in-item offset", () => {
    const position = synchronizedPlaybackPosition(
      { groupId: "group-1", anchorMs: 1_000, durationsMs: [10_000, 20_000] },
      16_000,
    );
    expect(position).toEqual({
      index: 1,
      offsetMs: 5_000,
      remainingMs: 15_000,
      occurrence: 1,
    });
  });

  it("increments occurrences for single-item playlists", () => {
    const position = synchronizedPlaybackPosition(
      { groupId: "group-1", anchorMs: 0, durationsMs: [10_000] },
      25_000,
    );
    expect(position).toMatchObject({
      index: 0,
      offsetMs: 5_000,
      occurrence: 2,
    });
  });
});

describe("projectSynchronizedPresentation", () => {
  it("rotates to the expected item and seeks into video", () => {
    const base = {
      state: "playing",
      items: [image("image-1", 10_000), video("video-1")],
      takeover: false,
      generation: 2,
      synchronizedPlayback: {
        groupId: "group-1",
        anchorMs: 0,
        durationsMs: [10_000, 20_000],
      },
    } satisfies SynchronizedPlayingPresentation;
    const projected = projectSynchronizedPresentation(
      base,
      { index: 1, offsetMs: 5_000, remainingMs: 15_000, occurrence: 1 },
      99,
    );
    expect(projected.generation).toBe(99);
    expect(projected.items.map((item) => item.id)).toEqual([
      "video-1",
      "image-1",
    ]);
    expect(projected.items[0]).toMatchObject({
      durationMs: 15_000,
      videoStartOffsetMs: 7_000,
    });
  });
});

describe("enrichSynchronizedPresentation", () => {
  it("uses the group epoch and Android-compatible effective durations", () => {
    const epoch = "2026-07-20T12:00:00Z";
    const stored: StoredManifest = {
      manifest: manifest(epoch),
      etag: null,
      storedAt: epoch,
    };
    const presentation: Presentation = {
      state: "playing",
      items: [image("image-1", 10_000), video("video-1")],
      takeover: false,
      generation: 1,
    };
    const enriched = enrichSynchronizedPresentation(
      presentation,
      stored,
      Date.parse(epoch) + 15_000,
    ) as SynchronizedPlayingPresentation;
    expect(enriched.synchronizedPlayback).toEqual({
      groupId: "group-1",
      anchorMs: Date.parse(epoch),
      durationsMs: [10_000, 20_000],
    });
  });

  it("does not synchronize ungrouped playback", () => {
    const epoch = "2026-07-20T12:00:00Z";
    const ungrouped = manifest(epoch);
    ungrouped.syncGroup = null;
    const presentation: Presentation = {
      state: "playing",
      items: [image("image-1", 10_000)],
      takeover: false,
      generation: 1,
    };
    expect(
      enrichSynchronizedPresentation(presentation, {
        manifest: ungrouped,
        etag: null,
        storedAt: epoch,
      }),
    ).toBe(presentation);
  });
  it("anchors synchronized playback at the selected schedule's exact start", () => {
    const epoch = "2026-07-20T12:00:00Z";
    const scheduled = manifest(epoch);
    const schedule: ManifestSchedule = {
      id: "schedule-1",
      playlistId: "playlist-1",
      layoutId: null,
      type: "weekly",
      timezone: "America/New_York",
      priority: 1,
      specificity: 1,
      dailyStart: "07:00:10",
      dailyEnd: "07:00:25",
      daysOfWeek: [1],
    };
    scheduled.schedules = [schedule];
    const presentation: Presentation = {
      state: "playing",
      items: [image("image-1", 10_000)],
      takeover: false,
      generation: 1,
    };
    const enriched = enrichSynchronizedPresentation(
      presentation,
      { manifest: scheduled, etag: null, storedAt: epoch },
      Date.parse("2026-07-20T11:00:15Z"),
    );
    expect(enriched).toMatchObject({
      synchronizedPlayback: { anchorMs: Date.parse("2026-07-20T11:00:10Z") },
    });
  });
});

describe("effectiveDurationMs", () => {
  it("derives clipped video duration when no explicit duration exists", () => {
    expect(
      effectiveDurationMs(
        video("video-1"),
        {
          id: "video-1",
          assetId: "video-asset",
          variantId: "v-video-1",
          assetType: "video",
          fitMode: "contain",
          transition: "none",
          audioEnabled: true,
          volume: 1,
          videoStartOffsetMs: 2_000,
          videoEndOffsetMs: 22_000,
          deliveryPolicy: "download",
        },
        undefined,
      ),
    ).toBe(20_000);
  });

  it("ignores a renderer fallback duration on video and uses the asset length", () => {
    expect(
      effectiveDurationMs(
        // What the renderer would carry if the item delegated its duration:
        // a generic fallback, not the length of the file.
        {
          ...video("video-2"),
          durationMs: 30_000,
          videoStartOffsetMs: null,
          videoEndOffsetMs: null,
        },
        {
          id: "video-2",
          assetId: "video-asset",
          variantId: "v-video-2",
          assetType: "video",
          fitMode: "contain",
          transition: "none",
          audioEnabled: true,
          volume: 1,
          deliveryPolicy: "download",
        },
        videoAsset("v-video-2", 92),
      ),
    ).toBe(92_000);
  });

  it("still honours a duration the manifest actually authored", () => {
    expect(
      effectiveDurationMs(
        { ...video("video-3"), durationMs: 30_000 },
        {
          id: "video-3",
          assetId: "video-asset",
          variantId: "v-video-3",
          assetType: "video",
          durationMs: 8_000,
          fitMode: "contain",
          transition: "none",
          audioEnabled: true,
          volume: 1,
          deliveryPolicy: "download",
        },
        undefined,
      ),
    ).toBe(8_000);
  });
});

describe("synchronized playback clock", () => {
  it("marks a projected presentation as shared-timeline driven", () => {
    const base = {
      state: "playing",
      items: [image("image-1", 10_000), image("image-2", 10_000)],
      takeover: false,
      generation: 2,
      synchronizedPlayback: {
        groupId: "group-1",
        anchorMs: 0,
        durationsMs: [10_000, 10_000],
      },
    } satisfies SynchronizedPlayingPresentation;
    // The renderer suppresses its own advancement on this flag alone rather
    // than inferring synchronization from metadata it otherwise ignores.
    expect(
      projectSynchronizedPresentation(
        base,
        { index: 0, offsetMs: 0, remainingMs: 10_000, occurrence: 0 },
        7,
      ).synchronized,
    ).toBe(true);
    expect(
      projectSynchronizedPresentation(
        { ...base, items: [] },
        { index: 0, offsetMs: 0, remainingMs: 1, occurrence: 0 },
        7,
      ).synchronized,
    ).toBe(true);
  });

  it("derives the initial position from the wall clock", () => {
    // The shared anchor is wall-clock, so a late joiner must still land at the
    // right point in the cycle when it activates.
    const activation = activateSynchronizedClock(1_700_000_000_000, 500);
    expect(synchronizedNowMs(activation, 500)).toBe(1_700_000_000_000);
  });

  it("advances the timeline monotonically after activation", () => {
    const activation = activateSynchronizedClock(1_700_000_000_000, 500);
    expect(synchronizedNowMs(activation, 3_500)).toBe(1_700_000_003_000);
  });

  it("does not move the timeline when the wall clock is corrected backward", () => {
    // NTP stepping the clock back an hour, a manual correction, or a
    // suspend/resume must not rewind or fast-forward what is on screen: the
    // monotonic source is the only thing consulted after activation.
    const activation = activateSynchronizedClock(1_700_000_000_000, 500);
    const before = synchronizedNowMs(activation, 10_500);
    expect(before).toBe(1_700_000_010_000);

    const wallClockAfterCorrection = 1_700_000_000_000 - 3_600_000;
    expect(wallClockAfterCorrection).toBeLessThan(before);
    // Same activation, monotonic clock has moved on by another second.
    const after = synchronizedNowMs(activation, 11_500);
    expect(after).toBe(1_700_000_011_000);
    expect(after).toBeGreaterThan(before);
  });

  it("never runs the timeline backward if the monotonic source repeats", () => {
    const activation = activateSynchronizedClock(1_700_000_000_000, 5_000);
    expect(synchronizedNowMs(activation, 4_000)).toBe(1_700_000_000_000);
  });

  it("recalculates the initial position on reactivation", () => {
    const first = activateSynchronizedClock(1_700_000_000_000, 500);
    const second = activateSynchronizedClock(1_700_000_060_000, 60_500);
    expect(synchronizedNowMs(second, 60_500)).toBe(1_700_000_060_000);
    expect(synchronizedNowMs(second, 60_500)).toBeGreaterThan(
      synchronizedNowMs(first, 500),
    );
  });
});
