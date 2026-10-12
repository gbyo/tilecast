// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ManualClock } from "../clock/scheduler";
import type {
  EvidenceKind,
  RuntimeCapabilitiesV1,
  RuntimeItem,
} from "../host/contract";
import { PlaybackController } from "../engine/controller";
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
function mirror() {
  const clock = new ManualClock({ wallMs: T0 });
  const log: string[] = [];
  const errors: string[] = [];
  const controller = new PlaybackController({
    clock,
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
  });
  controller.subscribe((view) => {
    if (view.mode === "playing") stage.update(view.stage);
  });
  controller.onSyncPosition((position) => stage.correct(position));

  /** Distinct presentation actors the controller has run. */
  const actors = new Set<unknown>();
  const mounts = new Set<number>();
  const observe = () => {
    const child = (controller as unknown as { childRef: unknown }).childRef;
    if (child) actors.add(child);
    const view = controller.state;
    if (view.mode === "playing" && view.stage) mounts.add(view.stage.mount);
  };
  controller.subscribe(observe);

  /** Advance time in drift-sized steps, playing every live element. */
  const run = async (ms: number) => {
    for (let elapsed = 0; elapsed < ms; elapsed += TICK_MS) {
      clock.advance(TICK_MS);
      for (const element of media.created) {
        const state = media.state(element);
        if (state.seeking) media.completeSeek(element);
        media.play(element, TICK_MS);
        // A new element presents its first frame before it is swapped in.
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
  ) => {
    controller.present({
      type: "presentation",
      presentation: {
        state: "playing",
        items,
        generation: 1,
        synchronized: true,
      },
      timing: { groupId: "g", anchorMs, durationsMs, clockOffsetMs: 0 },
    });
  };
  return {
    clock,
    log,
    errors,
    controller,
    stage,
    actors,
    mounts,
    run,
    makeReady,
    present,
  };
}

describe("a single-video loop on a Mirror screen (before the fix)", () => {
  it("replaces the presentation actor, remounts and creates a decoder at every lap", async () => {
    const m = mirror();
    const LAPS = 5;
    m.present([video("v")], [10_000]);
    await m.makeReady();
    for (let lap = 0; lap < LAPS; lap += 1) {
      await m.run(10_000);
      await m.makeReady();
      await m.run(TICK_MS);
    }
    // The last boundary falls just after the lap; let its decoder be swapped in.
    await m.makeReady();
    await m.run(TICK_MS);
    expect(m.actors.size).toBe(LAPS + 1);
    expect(m.mounts.size).toBe(LAPS + 1);
    expect(media.created.length).toBe(LAPS + 1);
    // Each outgoing decoder is released once its replacement is swapped in:
    // one load() per replaced element.
    expect(media.loads).toBe(LAPS);
  });
});
