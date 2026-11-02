// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import { PlaybackDiagnostics } from "../engine/diagnostics";
import type { EvidenceKind, RuntimeItem } from "../host/contract";
import type { SurfaceSink } from "./surface";
import { FakeMedia, settle } from "./test-support/fake-media";
import { HtmlVideoSurface, VIDEO_REBIND_TIMEOUT_MS } from "./video-surface";

let media: FakeMedia;
beforeEach(() => {
  media = FakeMedia.install();
});
afterEach(() => media.uninstall());

function item(overrides: Partial<RuntimeItem> = {}): RuntimeItem {
  return {
    id: "v",
    kind: "video",
    src: "tcmedia://cap/v",
    durationMs: null,
    fitMode: "contain",
    audioEnabled: false,
    volume: 1,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
    ...overrides,
  };
}

function sinkFor(label: string, log: string[]): SurfaceSink {
  const noop = () => undefined;
  return {
    ended: (source) => log.push(`${label}:ended:${source}`),
    failed: (message) => log.push(`${label}:failed:${message}`),
    resumed: () => log.push(`${label}:resumed`),
    evidence: (kind: EvidenceKind) => log.push(`${label}:${kind}`),
    websiteFailed: noop,
    websiteRecovered: noop,
    fallbackShown: noop,
    zoneFailed: noop,
    widgetEmpty: noop,
  };
}

async function shownSurface() {
  const clock = new ManualClock({ wallMs: 0 });
  const log: string[] = [];
  const diagnostics = new PlaybackDiagnostics({ clock });
  const surface = new HtmlVideoSurface(
    item(),
    {
      clock,
      sink: sinkFor("old", log),
      animationScale: 1,
      diagnostics,
    },
    1,
  );
  const ready = surface.prepare();
  media.ready(surface.element);
  await ready;
  await surface.activate();
  return { clock, log, surface, diagnostics, element: surface.element };
}

describe("a video surface moved to the next occurrence", () => {
  it("routes everything to the new occurrence's sink", async () => {
    const t = await shownSurface();
    const log = t.log;
    const next = t.surface.rebind(item(), sinkFor("new", log), 2);
    media.completeSeek(t.element);
    await next;
    t.element.dispatchEvent(new Event("ended"));
    media.fail(t.element, "late");
    expect(log.filter((entry) => entry.startsWith("old:"))).toEqual([]);
    expect(log).toEqual(["new:ended:ended", "new:failed:video failed: late"]);
  });

  it("ignores what the element reports until the seek has completed", async () => {
    const t = await shownSurface();
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    // An `ended` and a frame queued for the previous occurrence.
    t.element.dispatchEvent(new Event("ended"));
    t.element.dispatchEvent(new Event("timeupdate"));
    media.frame(t.element, 9.9);
    expect(t.log).toEqual([]);
    media.completeSeek(t.element);
    await next;
    media.frame(t.element, 0.04);
    expect(t.log).toEqual(["new:video-progress"]);
  });

  it("reports video-progress again for the new occurrence", async () => {
    const t = await shownSurface();
    media.state(t.element).paused = false;
    media.frame(t.element, 0.1);
    expect(t.log).toEqual(["old:video-progress"]);
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    media.completeSeek(t.element);
    await next;
    media.frame(t.element, 0.04);
    expect(t.log).toEqual(["old:video-progress", "new:video-progress"]);
  });

  it("resolves only once the seek completed and a frame is available", async () => {
    const t = await shownSurface();
    let done = false;
    const next = t.surface
      .rebind(item(), sinkFor("new", t.log), 2)
      .then(() => (done = true));
    await settle();
    expect(done).toBe(false);
    media.state(t.element).readyState = 1;
    media.completeSeek(t.element);
    await settle();
    expect(done).toBe(false);
    media.state(t.element).readyState = 4;
    t.element.dispatchEvent(new Event("canplay"));
    await next;
    expect(done).toBe(true);
  });

  it("seeks to the new start offset and keeps the same element", async () => {
    const t = await shownSurface();
    const element = t.element;
    const next = t.surface.rebind(
      item({ videoStartOffsetMs: 3_000 }),
      sinkFor("new", t.log),
      2,
    );
    media.completeSeek(element);
    await next;
    expect(t.surface.element).toBe(element);
    expect(media.seeks[media.seeks.length - 1]!.toMs).toBe(3_000);
    expect(element.dataset["tilecastMount"]).toBe("2");
    expect(media.created).toHaveLength(1);
    expect(media.loads).toBe(0);
  });

  it("resets a playback-rate nudge", async () => {
    const t = await shownSurface();
    t.element.playbackRate = 1.02;
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    media.completeSeek(t.element);
    await next;
    expect(t.element.playbackRate).toBe(1);
  });

  it("resumes an element that ended before the boundary", async () => {
    const t = await shownSurface();
    const state = media.state(t.element);
    state.paused = true;
    state.ended = true;
    const plays = media.plays;
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    media.completeSeek(t.element);
    await next;
    expect(media.plays).toBe(plays + 1);
    expect(state.paused).toBe(false);
  });

  it("does not mark the element failed when a newer move supersedes the older", async () => {
    const t = await shownSurface();
    const first = t.surface.rebind(item(), sinkFor("one", t.log), 2);
    const second = t.surface.rebind(item(), sinkFor("two", t.log), 3);
    await expect(first).rejects.toThrow("superseded");
    expect(t.surface.reuseState(true).failed).toBe(false);
    media.completeSeek(t.element);
    await second;
  });

  it("gives up after the timeout and refuses to be reused again", async () => {
    const t = await shownSurface();
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    const settled = expect(next).rejects.toThrow("video seek did not complete");
    t.clock.advance(VIDEO_REBIND_TIMEOUT_MS);
    await settled;
    expect(t.surface.reuseState(true).failed).toBe(true);
    expect(t.clock.pendingTimers).toBe(0);
  });

  it("fails the move when the element cannot be played again", async () => {
    const t = await shownSurface();
    t.element.play = () => Promise.reject(new Error("blocked"));
    media.state(t.element).paused = true;
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    await expect(next).rejects.toThrow("video restart failed");
    expect(t.surface.reuseState(true).failed).toBe(true);
  });

  it("releases its timer and listeners when disposed mid-move", async () => {
    const t = await shownSurface();
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    const settled = expect(next).rejects.toThrow("disposed");
    t.surface.dispose();
    await settled;
    expect(t.clock.pendingTimers).toBe(0);
    t.element.dispatchEvent(new Event("ended"));
    expect(t.log).toEqual([]);
    expect(t.surface.reuseState(true).disposed).toBe(true);
  });

  it("describes the playback configuration of the occurrence it now plays", async () => {
    const t = await shownSurface();
    expect(t.surface.playbackConfig()).toMatchObject({
      itemId: "v",
      endOffsetMs: null,
    });
    const next = t.surface.rebind(
      item({ videoEndOffsetMs: 9_000 }),
      sinkFor("new", t.log),
      2,
    );
    media.completeSeek(t.element);
    await next;
    expect(t.surface.playbackConfig().endOffsetMs).toBe(9_000);
  });

  it("does not correct drift while the move is in flight", async () => {
    const t = await shownSurface();
    const next = t.surface.rebind(item(), sinkFor("new", t.log), 2);
    const seeks = media.seeks.length;
    for (let i = 0; i < 8; i += 1) {
      t.clock.advance(250);
      t.surface.correct({
        itemId: "v",
        kind: "video",
        offsetMs: 5_000 + i * 250,
        occurrence: 1,
        videoStartOffsetMs: 0,
      });
    }
    expect(media.seeks.length).toBe(seeks);
    media.completeSeek(t.element);
    await next;
  });
});

describe("a video surface that is not reused", () => {
  it("is not reusable before it has shown a frame, or after it failed", async () => {
    const clock = new ManualClock({ wallMs: 0 });
    const surface = new HtmlVideoSurface(
      item(),
      { clock, sink: sinkFor("s", []), animationScale: 1 },
      1,
    );
    void surface.prepare().catch(() => undefined);
    expect(surface.reuseState(true).shown).toBe(false);
    media.fail(surface.element);
    expect(surface.reuseState(true).failed).toBe(true);
  });
});
