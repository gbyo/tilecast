import { describe, expect, it } from "vitest";
import type { Playlist } from "../api/types";
import { i18n } from "../i18n";
import { playlistDuration } from "./schedulePresentationModel";

const t = i18n.getFixedT("en", "schedules");
const playlist = (...durationMs: number[]) =>
  ({
    items: durationMs.map((value) => ({ durationMs: value })),
    itemCount: durationMs.length,
  }) as unknown as Playlist;

describe("playlistDuration", () => {
  it("reads minutes and seconds", () => {
    expect(playlistDuration(playlist(62_000), t)).toBe("1 min 2 sec");
    expect(playlistDuration(playlist(30_000), t)).toBe("30 sec");
  });

  it("rounds the total before splitting it, so seconds never read 60", () => {
    expect(playlistDuration(playlist(59_600), t)).toBe("1 min");
    expect(playlistDuration(playlist(119_700), t)).toBe("2 min");
  });
});
