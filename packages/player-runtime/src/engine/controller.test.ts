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
});
