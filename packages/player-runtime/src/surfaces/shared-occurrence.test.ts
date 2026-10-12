// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  EvidenceKind,
  RuntimeCapabilitiesV1,
  RuntimeItem,
} from "../host/contract";
import { PlaybackController } from "../engine/controller";
import { PlaybackDiagnostics } from "../engine/diagnostics";
import { Stage } from "./stage";
import { FakeMedia, settle } from "./test-support/fake-media";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);
const TICK_MS = 250;

function video(id: string, overrides: Partial<RuntimeItem> = {}): RuntimeItem {
  return {
    id,
    kind: "video",
    src: `tcmedia://cap/${id}`,
    durationMs: null,
    fitMode: "contain",
    audioEnabled: false,
    volume: 1,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
    ...overrides,
  };
}

function image(id: string): RuntimeItem {
  return { ...video(id), kind: "image" };
}

let media: FakeMedia;
let originalAnimate: PropertyDescriptor | undefined;

beforeEach(() => {
  media = FakeMedia.install();
  originalAnimate = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "animate",
  );
  Object.defineProperty(HTMLElement.prototype, "animate", {
    configurable: true,
    value: () =>
      ({
        finished: Promise.resolve(),
        cancel: vi.fn(),
      }) as unknown as Animation,
  });
});

afterEach(() => {
  media.uninstall();
  if (originalAnimate) {
    Object.defineProperty(HTMLElement.prototype, "animate", originalAnimate);
  } else {
    delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
      "animate"
    ];
  }
});

/** A Mirror screen: controller, stage and the fake decoder, wired as in production. */
function mirror(options: { autoSeek?: boolean } = {}) {
  const autoSeek = options.autoSeek ?? true;
  const clock = new ManualClock({ wallMs: T0 });
  const log: string[] = [];
  const errors: string[] = [];
  const diagnostics = new PlaybackDiagnostics({ clock });
  const controller = new PlaybackController({
    clock,
    diagnostics,
    synchronizedPlayback: true,
    reports: {
      evidence: (_activation, kind: EvidenceKind, itemId) =>
        log.push(`${kind}:${itemId ?? "-"}`),
      playbackError: (_activation, itemId, message) =>
        errors.push(`${itemId}:${message}`),
      presentationResult: () => undefined,
      websiteRecovered: () => undefined,
    },
  });
  const layerA = document.createElement("div");
  const layerB = document.createElement("div");
  document.body.replaceChildren(layerA, layerB);
  const stage = new Stage(layerA, layerB, {
    clock,
    capabilities: {} as RuntimeCapabilitiesV1,
    send: (event) => controller.surface(event),
    animationScale: 1,
    diagnostics,
  });
  controller.subscribe((view) => {
    if (view.mode === "playing") stage.update(view.stage);
    // As the player root does: a Tilecast surface releases every decoder.
    else if (view.mode !== "waiting") stage.clear();
  });
  controller.onSyncPosition((position) => stage.correct(position));

  /** Distinct presentation actors the controller has run. */
  const actors = new Set<unknown>();
  const mounts = new Set<number>();
  controller.subscribe(() => {
    const child = (controller as unknown as { childRef: unknown }).childRef;
    if (child) actors.add(child);
    const view = controller.state;
    if (view.mode === "playing" && view.stage) mounts.add(view.stage.mount);
  });

  /** Advance time in drift-sized steps, playing every live element. */
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      clock.advance(TICK_MS);
      for (const element of media.created) {
        const state = media.state(element);
        if (autoSeek && state.seeking) media.completeSeek(element);
        media.play(element, TICK_MS);
        if (!state.paused && !state.seeking && state.readyState >= 3) {
          media.frame(element, state.currentTimeS);
        }
      }
      await settle();
    }
  };
  /** Every new element becomes playable, as a local file would. */
  const makeReady = async () => {
    for (const element of media.created) {
      if (media.state(element).readyState === 0 && element.src) {
        media.ready(element);
      }
    }
    await settle();
  };
  const present = (
    items: RuntimeItem[],
    durationsMs: number[],
    anchorMs = T0,
    extra: { generation?: number } = {},
  ) => {
    controller.present({
      type: "presentation",
      presentation: {
        state: "playing",
        items,
        generation: extra.generation ?? 1,
        synchronized: true,
      },
      timing: { groupId: "g", anchorMs, durationsMs, clockOffsetMs: 0 },
    });
  };
  const videos = () => document.querySelectorAll("video").length;
  return {
    clock,
    log,
    errors,
    controller,
    stage,
    diagnostics,
    actors,
    mounts,
    run,
    makeReady,
    present,
    videos,
  };
}

/** Run `laps` full laps of a looping playlist, readying new decoders. */
async function laps(
  m: ReturnType<typeof mirror>,
  count: number,
  lapMs: number,
) {
  await m.makeReady();
  for (let lap = 0; lap < count; lap += 1) {
    await m.run(lapMs);
    await m.makeReady();
  }
}

const LAPS = 5;

describe("a single-video loop on a Mirror screen", () => {
  it("keeps one presentation actor and one decoder across laps", async () => {
    // Before the fix, the same five laps ran 6 presentation actors, took 6
    // mounts and created and released 6 decoders.
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, LAPS, 10_000);
    const counters = m.diagnostics.snapshot().counters;
    console.log(
      JSON.stringify(m.diagnostics.snapshot(), null, 1),
      media.seeks.map((s) => Math.round(s.toMs)),
    );
    expect(m.actors.size).toBe(1);
    expect(m.mounts.size).toBe(LAPS + 1);
    expect(media.created.length).toBe(1);
    expect(media.loads).toBe(0);
    expect(m.videos()).toBe(1);
    expect(counters["presentation-actors"]).toBe(1);
    expect(counters["occurrence-boundaries"]).toBe(LAPS);
    expect(counters["decoders-created"]).toBe(1);
    expect(counters["decoders-reused"]).toBe(LAPS);
    expect(counters["unexpected-remounts"]).toBe(0);
    expect(counters["seeks-correction"]).toBe(0);
    expect(counters["seeks-occurrence"]).toBe(LAPS);
  });

  it("seeks the element once per lap, to the start of the clip", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, LAPS, 10_000);
    expect(media.seeks).toHaveLength(LAPS);
    expect(media.seeks.every((seek) => seek.toMs < 100)).toBe(true);
    expect(media.plays).toBeGreaterThanOrEqual(1);
  });

  it("reports exactly one transition, start and progress per lap, in order", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, 3, 10_000);
    expect(m.log).toEqual([
      "item-started:v",
      "video-progress:v",
      "item-transition:v",
      "item-started:v",
      "video-progress:v",
      "item-transition:v",
      "item-started:v",
      "video-progress:v",
      "item-transition:v",
      "item-started:v",
      "video-progress:v",
    ]);
    expect(m.errors).toEqual([]);
  });

  it("does not count a frame presented before the seek completed as progress", async () => {
    const m = mirror({ autoSeek: false });
    m.present([video("v")], [10_000]);
    await m.makeReady();
    media.completeSeek(media.last);
    await m.run(10_000 - TICK_MS);
    const before = m.log.length;
    m.clock.advance(TICK_MS + 10);
    await settle();
    expect(m.log.slice(before)).toEqual([
      "item-transition:v",
      "item-started:v",
    ]);
    // The previous lap's last frame arrives while the element is still seeking.
    media.frame(media.last, 9.9);
    await settle();
    expect(m.log.slice(before)).not.toContain("video-progress:v");
    media.completeSeek(media.last);
    await m.run(TICK_MS);
    expect(m.log.slice(before)).toContain("video-progress:v");
  });

  it("holds the new occurrence in preparing until the seek completes", async () => {
    const m = mirror({ autoSeek: false });
    m.present([video("v")], [10_000]);
    await m.makeReady();
    media.completeSeek(media.last);
    await m.run(10_000);
    const view = m.controller.state;
    expect(view.mode === "playing" && view.stage?.phase).toBe("preparing");
    expect(m.controller.describe()["presentation"]).toBe("preparing");
    media.completeSeek(media.last);
    await settle();
    const after = m.controller.state;
    expect(after.mode === "playing" && after.stage?.phase).toBe("shown");
  });

  it("keeps the element's identity attributes on the newest occurrence", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, 2, 10_000);
    const view = m.controller.state;
    const mount = view.mode === "playing" ? view.stage!.mount : -1;
    expect(media.last.dataset["tilecastMount"]).toBe(String(mount));
    expect(media.last.dataset["tilecastItemId"]).toBe("v");
  });

  it("does not accumulate timers or elements as laps pass", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, 3, 10_000);
    const timers = m.clock.pendingTimers;
    await laps(m, 8, 10_000);
    expect(m.clock.pendingTimers).toBe(timers);
    expect(m.videos()).toBe(1);
    expect(media.created.length).toBe(1);
  });

  it("restarts a clip that already reached its end before the boundary", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await m.makeReady();
    media.state(media.last).durationS = 9.5;
    await m.run(10_000);
    // The clip ended at 9.5 s and paused; the boundary sends it round again.
    expect(media.created.length).toBe(1);
    await m.run(2_000);
    const state = media.state(media.last);
    expect(state.paused).toBe(false);
    expect(state.currentTimeS).toBeGreaterThan(1);
    expect(m.errors).toEqual([]);
  });
});

describe("trimmed clips and late joins", () => {
  it("restarts a trimmed clip at its start offset on every lap", async () => {
    const m = mirror();
    const clip = video("v", {
      videoStartOffsetMs: 2_000,
      videoEndOffsetMs: 12_000,
    });
    m.present([clip], [10_000]);
    await laps(m, 3, 10_000);
    expect(media.created.length).toBe(1);
    // One seek for the start offset at load, one per lap after that.
    const targets = media.seeks.map((seek) => Math.round(seek.toMs / 100));
    expect(targets).toEqual([20, 20, 20, 20]);
  });

  it("joins mid-clip, then loops from the start", async () => {
    const m = mirror();
    // Anchored 4 s ago: the clip is 4 s in when this screen joins.
    m.present([video("v")], [10_000], T0 - 4_000);
    await m.makeReady();
    expect(media.seeks[0]!.toMs).toBe(4_000);
    await m.run(6_000 + 100);
    await m.makeReady();
    expect(media.created.length).toBe(1);
    const lastSeek = media.seeks[media.seeks.length - 1]!;
    expect(lastSeek.toMs).toBeLessThan(200);
  });
});

describe("multi-item playlists", () => {
  it("creates a decoder for different media and never reuses across items", async () => {
    const m = mirror();
    m.present([video("a"), video("b")], [5_000, 5_000]);
    await laps(m, 6, 5_000);
    const snapshot = m.diagnostics.snapshot();
    // Every boundary changes item: 7 occurrences, 7 decoders, no reuse.
    expect(media.created.length).toBe(7);
    expect(snapshot.counters["decoders-reused"]).toBe(0);
    expect(snapshot.reuseRejected["item-changed"]).toBe(6);
    // Different media is the playlist moving on, not an unexpected remount.
    expect(snapshot.counters["unexpected-remounts"]).toBe(0);
    expect(m.actors.size).toBe(1);
  });

  it("treats two video items sharing a file as different occurrences", async () => {
    const m = mirror();
    const a = video("a", { src: "tcmedia://cap/same" });
    const b = video("b", { src: "tcmedia://cap/same" });
    m.present([a, b], [5_000, 5_000]);
    await laps(m, 2, 5_000);
    expect(m.diagnostics.snapshot().reuseRejected["item-changed"]).toBe(2);
    expect(media.created.length).toBe(3);
  });
});

describe("when the element cannot be reused", () => {
  it("decodes afresh after the element failed, and says why", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, 1, 10_000);
    expect(media.created.length).toBe(1);
    media.fail(media.last, "decode error");
    await settle();
    expect(m.errors).toEqual(["v:video failed: decode error"]);
    await m.run(10_000);
    await m.makeReady();
    expect(media.created.length).toBe(2);
    const snapshot = m.diagnostics.snapshot();
    expect(snapshot.reuseRejected["surface-failed"]).toBe(1);
    expect(snapshot.counters["unexpected-remounts"]).toBe(1);
    // The failed decoder is released once the replacement has presented a
    // frame and been swapped in.
    await m.run(TICK_MS);
    expect(m.videos()).toBe(1);
    // And the screen recovers: the new element is reused on the next lap.
    await laps(m, 1, 10_000);
    expect(media.created.length).toBe(2);
  });

  it("decodes afresh when the seek to the next occurrence never completes", async () => {
    const m = mirror({ autoSeek: false });
    m.present([video("v")], [30_000]);
    await m.makeReady();
    media.completeSeek(media.last);
    await m.run(30_000);
    // The element is seeking and stays that way.
    await m.run(5_250);
    expect(m.errors).toEqual(["v:video seek did not complete"]);
    expect(m.diagnostics.snapshot().counters["reuse-failures"]).toBe(1);
    await m.run(25_000);
    await m.makeReady();
    expect(media.created.length).toBe(2);
    expect(m.diagnostics.snapshot().reuseRejected["surface-failed"]).toBe(1);
  });

  it("does not reuse an element that has not shown a frame", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    // The first video never becomes playable before the boundary.
    await m.run(10_000);
    expect(media.created.length).toBe(2);
    expect(m.diagnostics.snapshot().counters["decoders-reused"]).toBe(0);
  });

  it("does not correct the video the previous occurrence left on screen", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await m.makeReady();
    media.completeSeek(media.last);
    const first = media.last;
    // Not ready for reuse at the boundary: the new occurrence is staged on the
    // hidden layer while the old element, of the same item, stays in front.
    media.state(first).readyState = 1;
    await m.run(10_000);
    expect(media.created.length).toBe(2);
    const staged = media.last;
    const before = media.seeks.filter((seek) => seek.element === first).length;
    await m.run(2_000);
    expect(media.seeks.filter((seek) => seek.element === first).length).toBe(
      before,
    );
    expect(staged).not.toBe(first);
  });
});

describe("replacing the presentation", () => {
  it("decodes afresh for a new manifest, and replaces the actor", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, 2, 10_000);
    expect(m.actors.size).toBe(1);
    m.present([video("v")], [10_000], m.clock.wallNow(), { generation: 2 });
    await m.makeReady();
    expect(m.actors.size).toBe(2);
    expect(media.created.length).toBe(2);
    expect(m.diagnostics.snapshot().counters["presentation-actors"]).toBe(2);
    // A host replacement is never offered for reuse, so it is not a rejection.
    expect(m.diagnostics.snapshot().reuseRejected).toEqual({});
    await laps(m, 2, 10_000);
    expect(media.created.length).toBe(2);
    expect(m.actors.size).toBe(2);
  });

  it("releases the decoder when a status surface takes the screen", async () => {
    const m = mirror();
    m.present([video("v")], [10_000]);
    await laps(m, 2, 10_000);
    m.controller.present({
      type: "presentation",
      presentation: { state: "idle", title: "Tilecast", message: "Idle" },
    });
    await settle();
    expect(m.videos()).toBe(0);
    expect(media.loads).toBe(1);
    // Nothing keeps ticking into the cleared stage.
    const timers = m.clock.pendingTimers;
    await m.run(30_000);
    expect(media.seeks.length).toBe(2);
    expect(m.clock.pendingTimers).toBe(timers);
    m.present([video("v")], [10_000]);
    await m.makeReady();
    expect(media.created.length).toBe(2);
  });
});

describe("drift correction on the visible element", () => {
  /** Fall `behindMs` behind the shared position, as a slow decode would. */
  const fallBehind = (element: HTMLVideoElement, behindMs: number) => {
    media.state(element).currentTimeS -= behindMs / 1_000;
  };

  it("corrects a sustained 600 ms gap with exactly one seek", async () => {
    const m = mirror();
    m.present([video("v")], [60_000]);
    await m.makeReady();
    media.completeSeek(media.last);
    await m.run(2_000);
    const element = media.last;
    const seeksBefore = media.seeks.length;
    fallBehind(element, 600);
    await m.run(3_000);
    const corrections = media.seeks.slice(seeksBefore);
    expect(corrections).toHaveLength(1);
    // Aimed at the shared position, to within the time it took to confirm.
    expect(corrections[0]!.toMs).toBeGreaterThanOrEqual(2_500);
    expect(m.diagnostics.snapshot().counters["seeks-correction"]).toBe(1);
  });

  it("does not seek again while the first correction is still settling", async () => {
    const m = mirror({ autoSeek: false });
    m.present([video("v")], [60_000]);
    await m.makeReady();
    media.completeSeek(media.last);
    await m.run(2_000);
    const element = media.last;
    const seeksBefore = media.seeks.length;
    fallBehind(element, 600);
    await m.run(1_000);
    expect(media.seeks.length).toBe(seeksBefore + 1);
    // The seek takes three seconds to complete: nothing else is issued.
    await m.run(3_000);
    expect(media.seeks.length).toBe(seeksBefore + 1);
    // It completes; the pipeline then holds still for another second while
    // the group moves on. That is not drift to correct.
    media.completeSeek(element);
    const frozen = media.state(element).currentTimeS;
    for (let i = 0; i < 4; i += 1) {
      m.clock.advance(TICK_MS);
      await settle();
    }
    expect(media.state(element).currentTimeS).toBe(frozen);
    expect(media.seeks.length).toBe(seeksBefore + 1);
  });

  it("ignores a stale currentTime instead of treating it as drift", async () => {
    const m = mirror();
    m.present([video("v")], [60_000]);
    await m.makeReady();
    media.completeSeek(media.last);
    await m.run(2_000);
    const element = media.last;
    const seeksBefore = media.seeks.length;
    // The media clock stops reporting for two seconds.
    const state = media.state(element);
    state.paused = true;
    state.paused = false;
    const frozenAt = state.currentTimeS;
    for (let i = 0; i < 8; i += 1) {
      m.clock.advance(TICK_MS);
      await settle();
      state.currentTimeS = frozenAt;
    }
    expect(media.seeks.length).toBe(seeksBefore);
  });
});
