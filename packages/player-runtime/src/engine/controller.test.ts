import { describe, expect, it } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  PresentationResultV1,
  RuntimeItem,
  RuntimePresentation,
} from "../host/contract";
import { PlaybackController, type RuntimeViewState } from "./controller";
import type { SyncPosition } from "./timeline";

const T0 = Date.UTC(2026, 8, 1, 12, 0, 0);

function item(id: string, overrides: Partial<RuntimeItem> = {}): RuntimeItem {
  return {
    id,
    kind: "image",
    src: `tcmedia://cap/${id}`,
    durationMs: 5_000,
    fitMode: "contain",
    audioEnabled: false,
    volume: 1,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
    ...overrides,
  };
}

function harness() {
  const clock = new ManualClock({ wallMs: T0 });
  const log: string[] = [];
  const results: PresentationResultV1[] = [];
  const controller = new PlaybackController({
    clock,
    synchronizedPlayback: true,
    reports: {
      evidence: (activation, kind, itemId) =>
        log.push(`${activation?.activationId ?? "-"}:${kind}:${itemId ?? "-"}`),
      playbackError: (_activation, itemId, message) =>
        log.push(`error:${itemId}:${message}`),
      presentationResult: (result) => results.push(result),
      websiteRecovered: () => log.push("website-recovered"),
    },
  });
  const views: RuntimeViewState[] = [];
  controller.subscribe((state) => views.push(state));
  const positions: (SyncPosition | null)[] = [];
  controller.onSyncPosition((position) => positions.push(position));
  const stage = () => {
    const view = controller.state;
    return view.mode === "playing" ? view.stage : null;
  };
  const ready = () =>
    controller.surface({ type: "SURFACE_READY", mount: stage()!.mount });
  return { clock, log, results, controller, views, positions, stage, ready };
}

const playing = (
  items: RuntimeItem[],
  extra: Partial<Extract<RuntimePresentation, { state: "playing" }>> = {},
): RuntimePresentation => ({
  state: "playing",
  items,
  generation: 1,
  ...extra,
});

describe("playback controller", () => {
  it("reports current Layout zone failures through the playback-error reporter", () => {
    const h = harness();
    h.controller.present({
      type: "presentation",
      presentation: playing([
        item("layout", {
          kind: "layout",
          layout: {
            canvasWidth: 100,
            canvasHeight: 100,
            background: "#000",
            zones: [],
          },
        }),
      ]),
    });
    h.ready();
    const mount = h.stage()!.mount;
    h.controller.surface({
      type: "ZONE_FAILED",
      mount: mount - 1,
      zoneId: "stale",
      message: "failed",
    });
    expect(h.log).not.toContain("error:layout:zone stale: failed");
    h.controller.surface({
      type: "ZONE_FAILED",
      mount,
      zoneId: "clip",
      message: "video failed",
    });
    expect(h.log).toContain("error:layout:zone clip: video failed");
    expect(h.stage()!.item.id).toBe("layout");
  });
  it("routes status and sleep surfaces and reports them once painted", () => {
    const h = harness();
    h.controller.present({
      type: "presentation",
      presentation: {
        state: "idle",
        title: "Tilecast",
        message: "No content assigned.",
      },
      activation: { activationId: "a1", generation: 1 },
    });
    expect(h.controller.state.mode).toBe("status");
    expect(h.results).toEqual([
      {
        activation: { activationId: "a1", generation: 1 },
        outcome: "accepted",
      },
    ]);
    const view = h.controller.state as Extract<
      RuntimeViewState,
      { mode: "status" }
    >;
    h.controller.statusPainted(view.key - 1);
    expect(h.log).toEqual([]);
    h.controller.statusPainted(view.key);
    expect(h.log).toEqual(["a1:surface-shown:-"]);
    h.controller.present({
      type: "presentation",
      presentation: { state: "sleep", display: "black" },
    });
    expect(h.controller.state.mode).toBe("sleep");
  });

  it("replaces a running presentation and cancels everything it scheduled", () => {
    const h = harness();
    h.controller.present({
      type: "presentation",
      presentation: playing([item("a"), item("b")]),
      activation: { activationId: "a1", generation: 1 },
    });
    h.ready();
    const firstMount = h.stage()!.mount;
    h.controller.present({
      type: "presentation",
      presentation: playing([item("t")], { takeover: true }),
      activation: { activationId: "a2", generation: 2 },
    });
    expect(h.stage()!.item.id).toBe("t");
    expect(h.stage()!.mount).toBe(firstMount + 1);
    // The takeover dissolves from whatever was on screen.
    expect(h.stage()!.transition).toBe("fade");
    h.controller.surface({ type: "SURFACE_READY", mount: firstMount });
    h.clock.advance(60_000);
    expect(h.log.some((entry) => entry.includes(":b"))).toBe(false);
    expect(h.log).toContain("a2:item-started:t");
  });

  it("rejects a presentation it cannot project and keeps the previous one", () => {
    const h = harness();
    h.controller.present({
      type: "presentation",
      presentation: playing([item("a")]),
    });
    const before = h.stage();
    h.controller.present({
      type: "presentation",
      presentation: playing([
        item("w", { kind: "widget", widget: { widgetAssetId: "x" } }),
      ]),
      activation: { activationId: "a3", generation: 3 },
    });
    expect(h.results.at(-1)).toMatchObject({
      outcome: "rejected",
      code: "runtime_error",
      activation: { activationId: "a3", generation: 3 },
    });
    expect(h.stage()).toBe(before);
  });

  it("follows the shared timeline and ignores a wall-clock step", () => {
    const h = harness();
    const items = [
      item("a", { durationMs: 10_000 }),
      item("v", {
        kind: "video",
        durationMs: 20_000,
        videoStartOffsetMs: 1_000,
      }),
    ];
    // Anchored 15 s ago: 15 s into the 30 s cycle, 5 s into the video.
    h.controller.present({
      type: "presentation",
      presentation: playing(items, { synchronized: true }),
      timing: {
        groupId: "g",
        anchorMs: T0 - 15_000,
        durationsMs: [10_000, 20_000],
        clockOffsetMs: 0,
      },
    });
    expect(h.stage()!.item).toMatchObject({
      id: "v",
      durationMs: 15_000,
      videoStartOffsetMs: 6_000,
    });
    expect(h.positions.at(-1)).toMatchObject({ itemId: "v", offsetMs: 5_000 });
    // An NTP step must not move the timeline.
    h.clock.stepWall(-3_600_000);
    h.clock.advance(250);
    expect(h.positions.at(-1)).toMatchObject({ itemId: "v", offsetMs: 5_250 });
    h.clock.advance(14_750 + 5);
    expect(h.stage()!.item.id).toBe("a");
    expect(h.log).toContain("-:item-transition:v");
    // The machine never advances on its own under a shared timeline.
    h.ready();
    h.clock.advance(9_000);
    expect(h.stage()!.item.id).toBe("a");
    h.clock.advance(1_010);
    expect(h.stage()!.item.id).toBe("v");
    expect(h.stage()!.item.videoStartOffsetMs).toBe(1_000);
  });

  it("uses the host's server offset to place the screen in the cycle", () => {
    const h = harness();
    h.controller.present({
      type: "presentation",
      presentation: playing([item("a"), item("b")], { synchronized: true }),
      timing: {
        groupId: "g",
        anchorMs: T0,
        durationsMs: [10_000, 10_000],
        clockOffsetMs: 12_000,
      },
    });
    expect(h.stage()!.item).toMatchObject({ id: "b", durationMs: 8_000 });
  });

  it("forwards retry and skip commands", () => {
    const h = harness();
    h.controller.present({
      type: "presentation",
      presentation: playing([item("a"), item("b")]),
    });
    h.ready();
    h.controller.skip();
    h.clock.flush();
    expect(h.stage()!.item.id).toBe("b");
    const mount = h.stage()!.mount;
    h.controller.retry();
    expect(h.stage()!.mount).toBe(mount + 1);
  });

  describe("synchronized timing with a degenerate duration", () => {
    const run = (durationsMs: number[]) => {
      const h = harness();
      h.controller.present({
        type: "presentation",
        presentation: playing([item("a", { durationMs: 0 })], {
          synchronized: true,
        }),
        timing: {
          groupId: "g",
          anchorMs: T0 - 5_000,
          durationsMs,
          clockOffsetMs: 0,
        },
      });
      for (let step = 0; step < 600; step += 1) {
        h.clock.advance(100);
        if (h.stage()) h.ready();
      }
      return h.log.filter((entry) => entry.includes("item-started")).length;
    };

    it("does not roll the cycle over every millisecond", () => {
      // Zero used to be clamped to one millisecond, so a minute of playback
      // produced thousands of item-started / item-transition pairs.
      expect(run([0])).toBeLessThanOrEqual(61);
    });

    it("treats a non-finite slot the same way", () => {
      expect(run([Number.NaN])).toBeLessThanOrEqual(61);
    });
  });
});

describe("shared occurrence boundaries", () => {
  const anchored = (h: ReturnType<typeof harness>, items: RuntimeItem[]) =>
    h.controller.present({
      type: "presentation",
      presentation: playing(items, { synchronized: true }),
      timing: {
        groupId: "g",
        anchorMs: T0,
        durationsMs: items.map((entry) => entry.durationMs ?? 10_000),
        clockOffsetMs: 0,
      },
    });
  const actor = (h: ReturnType<typeof harness>) =>
    (h.controller as unknown as { childRef: unknown }).childRef;
  const counters = (h: ReturnType<typeof harness>) =>
    h.controller.diagnostics.snapshot().counters;

  it("keeps the presentation actor across a looping single video", () => {
    const h = harness();
    anchored(h, [item("v", { kind: "video", durationMs: 10_000 })]);
    const first = actor(h);
    h.ready();
    const mount = h.stage()!.mount;
    for (let lap = 1; lap <= 4; lap += 1) {
      h.clock.advance(10_000);
      expect(actor(h)).toBe(first);
      expect(h.stage()!.mount).toBe(mount + lap);
      expect(h.stage()!.sharedBoundary).toBe(true);
      h.ready();
    }
    expect(counters(h)["presentation-actors"]).toBe(1);
    expect(counters(h)["occurrence-boundaries"]).toBe(4);
  });

  it("replaces the actor when the host presents something new", () => {
    const h = harness();
    anchored(h, [item("v", { kind: "video", durationMs: 10_000 })]);
    const first = actor(h);
    h.clock.advance(10_000);
    expect(actor(h)).toBe(first);
    anchored(h, [item("v", { kind: "video", durationMs: 10_000 })]);
    expect(actor(h)).not.toBe(first);
    expect(h.stage()!.sharedBoundary).toBeUndefined();
    expect(counters(h)["presentation-actors"]).toBe(2);
  });

  it("reports the transition before the start, once per boundary", () => {
    const h = harness();
    anchored(h, [item("v", { kind: "video", durationMs: 10_000 })]);
    h.clock.advance(20_000);
    expect(h.log).toEqual([
      "-:item-started:v",
      "-:item-transition:v",
      "-:item-started:v",
      "-:item-transition:v",
      "-:item-started:v",
    ]);
  });

  it("publishes the position after the occurrence is mounted", () => {
    const h = harness();
    anchored(h, [item("v", { kind: "video", durationMs: 10_000 })]);
    const seen: { occurrence: number; mount: number }[] = [];
    h.controller.onSyncPosition((position) => {
      if (position) {
        seen.push({ occurrence: position.occurrence, mount: h.stage()!.mount });
      }
    });
    const before = h.stage()!.mount;
    h.clock.advance(10_500);
    // Every position of the new occurrence is seen with the new occurrence
    // already mounted; none can be applied to the video it replaced.
    const lap = seen.filter((entry) => entry.occurrence === 1);
    expect(lap.length).toBeGreaterThan(0);
    expect(lap.every((entry) => entry.mount === before + 1)).toBe(true);
  });

  it("ignores a boundary older than the current generation", () => {
    const h = harness();
    anchored(h, [item("a", { durationMs: 10_000 }), item("b")]);
    h.clock.advance(10_000);
    const mount = h.stage()!.mount;
    const presentation = playing([item("a")], {
      synchronized: true,
      generation: 1,
    });
    (
      h.controller as unknown as {
        player: { send(event: unknown): void };
      }
    ).player.send({ type: "OCCURRENCE", presentation });
    expect(h.stage()!.mount).toBe(mount);
    expect(h.stage()!.item.id).toBe("b");
  });

  it("lets a takeover replace the shared presentation and stops the boundaries", () => {
    const h = harness();
    anchored(h, [item("a", { durationMs: 10_000 }), item("b")]);
    h.clock.advance(10_000);
    h.controller.present({
      type: "presentation",
      presentation: playing([item("t")], { takeover: true }),
    });
    expect(h.stage()!.item.id).toBe("t");
    h.clock.advance(60_000);
    expect(h.stage()!.item.id).toBe("t");
    expect(counters(h)["occurrence-boundaries"]).toBe(1);
  });

  it("does not let a screen skip or finish an occurrence on its own", () => {
    const h = harness();
    anchored(h, [item("a", { durationMs: 10_000 }), item("b")]);
    h.clock.advance(10_000);
    h.ready();
    const mount = h.stage()!.mount;
    h.controller.skip();
    h.controller.surface({ type: "SURFACE_ENDED", mount, source: "ended" });
    h.clock.flush();
    expect(h.stage()!.mount).toBe(mount);
  });
});
