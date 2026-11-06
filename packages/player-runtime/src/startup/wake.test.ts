// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../static/index.html?raw";
import { ManualClock } from "../clock/scheduler";
import { PlaybackController } from "../engine/controller";
import type {
  RuntimeCapabilitiesV1,
  RuntimeItem,
  RuntimePresentation,
} from "../host/contract";
import type { RuntimeSurfaceHost } from "../plugins/host";
import type { RuntimeWidgetHost } from "../widgets/host";
import { PlayerRoot } from "../views/player-root";
import { STARTUP_MIN_INTRO_MS, startupFor } from "./sequence";
import { GLIDE_MS } from "./view";
import { captureStartupLayer, WakeAnimation } from "./wake";

const BODY = /<body>([\s\S]*)<\/body>/.exec(indexHtml)![1]!;
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  document.body.innerHTML = BODY;
});

afterEach(() => {
  delete (HTMLElement.prototype as unknown as Record<string, unknown>)[
    "animate"
  ];
  delete (SVGElement.prototype as unknown as Record<string, unknown>)[
    "animate"
  ];
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

const origin = {
  rect: { left: 40, top: 20, width: 250, height: 61 },
  src: "tilecast-logo-cast-white.svg",
};

function wakeWith(
  options: {
    template?: HTMLElement | null;
    startupCovering?: boolean;
    reducedMotion?: boolean;
  } = {},
) {
  const clock = new ManualClock({ wallMs: 0, monotonicMs: 1_000 });
  const covering: boolean[] = [];
  const wake = new WakeAnimation({
    clock,
    template:
      options.template === undefined
        ? captureStartupLayer(document)
        : options.template,
    reducedMotion: () => options.reducedMotion ?? false,
    startupCovering: () => options.startupCovering ?? false,
    covering: (held) => covering.push(held),
  });
  return { clock, wake, covering };
}

describe("captureStartupLayer", () => {
  it("copies the layer without touching the document's own", () => {
    const copy = captureStartupLayer(document)!;
    expect(copy.id).toBe("tc-startup");
    expect(copy.querySelector(".tc-startup__card")).not.toBeNull();
    expect(document.querySelectorAll("#tc-startup")).toHaveLength(1);
    expect(copy).not.toBe(document.getElementById("tc-startup"));
  });

  it("is null when the document has no startup layer", () => {
    document.getElementById("tc-startup")!.remove();
    expect(captureStartupLayer(document)).toBeNull();
  });
});

describe("WakeAnimation", () => {
  it("plays nothing without a copy of the layer", () => {
    const { wake, covering } = wakeWith({ template: null });
    expect(wake.begin(null)).toBeNull();
    expect(covering).toEqual([]);
  });

  it("adds nothing while the document's first startup still covers the screen", () => {
    const { wake } = wakeWith({ startupCovering: true });
    expect(wake.begin(null)).toBeNull();
    expect(document.querySelectorAll("#tc-startup")).toHaveLength(1);
  });

  it("mounts a layer, covers until the presentation shows, then removes it", async () => {
    document.getElementById("tc-startup")!.remove();
    const { wake, clock, covering } = wakeWith({
      template: captureStartupLayer(
        (() => {
          document.body.innerHTML = BODY;
          return document;
        })(),
      ),
    });
    document.getElementById("tc-startup")!.remove();
    const signals = wake.begin(null)!;
    expect(signals).not.toBeNull();
    expect(document.getElementById("tc-startup")?.dataset["phase"]).toBe(
      "intro",
    );
    expect(covering).toEqual([true]);

    signals.presentationAccepted();
    signals.presentationShown();
    clock.advance(STARTUP_MIN_INTRO_MS);
    await flush();
    expect(document.getElementById("tc-startup")).toBeNull();
    expect(covering).toEqual([true, false]);
  });

  it("starts the pulse's minimum time when the glide arrives", async () => {
    const animate = vi.fn(() => ({ finished: Promise.resolve() }));
    Object.defineProperty(HTMLElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    Object.defineProperty(SVGElement.prototype, "animate", {
      configurable: true,
      value: animate,
    });
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      left: 500,
      top: 400,
      width: 500,
      height: 122,
      right: 1000,
      bottom: 522,
      x: 500,
      y: 400,
      toJSON: () => ({}),
    } as DOMRect);
    const { wake, clock } = wakeWith();
    document.getElementById("tc-startup")!.remove();
    const signals = wake.begin(origin)!;
    signals.presentationAccepted();
    signals.presentationShown();
    // The glide plus a full pulse: the reveal is not allowed earlier.
    clock.advance(STARTUP_MIN_INTRO_MS);
    await flush();
    expect(document.getElementById("tc-startup")).not.toBeNull();
    clock.advance(GLIDE_MS);
    await flush();
    const logoKeyframes = (
      animate.mock.calls as unknown as [Keyframe[], unknown][]
    ).map(([frames]) => frames);
    expect(logoKeyframes[0]![0]!["transform"]).toBe(
      "translate(-585px, -410.5px) scale(0.5)",
    );
    expect(logoKeyframes[0]![1]!["transform"]).toBe(
      "translate(0px, 0px) scale(1)",
    );
    expect(
      document.querySelector(".tc-startup__ghost")?.getAttribute("src"),
    ).toBe("tilecast-logo-cast-white.svg");
  });

  it("does not glide under reduced motion", () => {
    const { wake } = wakeWith({ reducedMotion: true });
    document.getElementById("tc-startup")!.remove();
    wake.begin(origin);
    expect(document.querySelector(".tc-startup__ghost")).toBeNull();
  });

  it("starts one wake at a time and drops it when the screen sleeps again", () => {
    const { wake, covering } = wakeWith();
    document.getElementById("tc-startup")!.remove();
    expect(wake.begin(null)).not.toBeNull();
    expect(wake.begin(null)).toBeNull();
    wake.abort();
    expect(document.getElementById("tc-startup")).toBeNull();
    expect(covering).toEqual([true, false]);
    expect(wake.begin(null)).not.toBeNull();
  });
});

function image(id: string): RuntimeItem {
  return {
    id,
    kind: "image",
    src: `tcmedia://cap/${id}`,
    durationMs: 60_000,
    fitMode: "contain",
    audioEnabled: false,
    volume: 1,
    videoStartOffsetMs: null,
    videoEndOffsetMs: null,
  };
}

async function boot() {
  const clock = new ManualClock({ wallMs: Date.UTC(2026, 9, 13) });
  const controller = new PlaybackController({
    clock,
    synchronizedPlayback: false,
    reports: {
      evidence: () => undefined,
      playbackError: () => undefined,
      presentationResult: () => undefined,
      websiteRecovered: () => undefined,
    },
  });
  const template = captureStartupLayer(document);
  const startup = startupFor(document, {
    clock,
    conformance: false,
    reducedMotion: () => false,
  });
  const wake = new WakeAnimation({
    clock,
    template,
    reducedMotion: () => false,
    startupCovering: () => startup.covering,
  });
  const view = document.querySelector("tc-player") as PlayerRoot;
  expect(view).toBeInstanceOf(PlayerRoot);
  const capabilities: RuntimeCapabilitiesV1 = {
    remoteWeb: null,
    synchronizedPlayback: false,
    setup: false,
    discovery: false,
  };
  view.bind({
    controller,
    surfaces: {
      element: document.createElement("div"),
    } as unknown as RuntimeSurfaceHost,
    clock,
    capabilities,
    setup: { available: false, submit: async () => ({ ok: false }) },
    animationScale: 1,
    remoteWeb: null,
    widgets: {} as RuntimeWidgetHost,
    startup,
    wake,
  });
  await view.updateComplete;
  await flush();
  const present = (presentation: RuntimePresentation) =>
    controller.present({ type: "presentation", presentation });
  const show = (id: string) => {
    present({ state: "playing", generation: 1, items: [image(id)] });
    const state = controller.state;
    if (state.mode !== "playing" || !state.stage) throw new Error("not staged");
    controller.surface({ type: "SURFACE_READY", mount: state.stage.mount });
  };
  const layer = () => document.getElementById("tc-startup");
  // Get past the document's first startup, into outside hours.
  present({ state: "sleep", display: "bouncing_logo" });
  await flush();
  clock.advance(STARTUP_MIN_INTRO_MS);
  await flush();
  expect(layer()).toBeNull();
  return { clock, present, show, layer, view };
}

describe("wake animation over the first presentation after outside hours", () => {
  it("plays the startup animation, then reveals the content beneath it", async () => {
    const h = await boot();
    h.show("morning");
    await flush();
    expect(h.layer()?.dataset["phase"]).toBe("intro");
    expect(
      document.querySelector(".layer.visible img")?.getAttribute("src"),
    ).toBe("tcmedia://cap/morning");
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    await flush();
    expect(h.layer()).toBeNull();
  });

  it("does nothing when the animation is turned off", async () => {
    const h = await boot();
    h.present({ state: "sleep", display: "black", wakeAnimation: false });
    await flush();
    h.show("morning");
    await flush();
    expect(h.layer()).toBeNull();
  });

  it("plays when the player does not say (older configuration)", async () => {
    const h = await boot();
    h.present({ state: "sleep", display: "custom_text", text: "Closed" });
    await flush();
    h.show("morning");
    await flush();
    expect(h.layer()).not.toBeNull();
  });

  it("is dropped if the screen goes back to outside hours first", async () => {
    const h = await boot();
    h.show("morning");
    await flush();
    expect(h.layer()).not.toBeNull();
    h.present({ state: "sleep", display: "black" });
    await flush();
    expect(h.layer()).toBeNull();
  });

  it("does not replay for ordinary presentation changes", async () => {
    const h = await boot();
    h.show("morning");
    await flush();
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    await flush();
    h.show("noon");
    await flush();
    expect(h.layer()).toBeNull();
  });
});
