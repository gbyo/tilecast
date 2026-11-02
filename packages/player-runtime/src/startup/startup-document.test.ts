// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import indexHtml from "../../static/index.html?raw";
import runtimeCss from "../../static/runtime.css?raw";
import pulseLogo from "../../static/tilecast-logo-pulse-white.svg?raw";
import { ManualClock } from "../clock/scheduler";
import { PlaybackController } from "../engine/controller";
import type { RuntimeCapabilitiesV1, RuntimeItem } from "../host/contract";
import type { RuntimeSurfaceHost } from "../plugins/host";
import type { RuntimeWidgetHost } from "../widgets/host";
import { PlayerRoot } from "../views/player-root";
import { STARTUP_MIN_INTRO_MS, startupFor } from "./sequence";

const BODY = /<body>([\s\S]*)<\/body>/.exec(indexHtml)![1]!;
const paths = (source: string) =>
  [...source.matchAll(/ d="([^"]+)"/g)].map((match) => match[1]!);
const flush = async () => {
  for (let i = 0; i < 6; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A fresh runtime document: what every host loads at startup. */
function loadDocument() {
  document.body.innerHTML = BODY;
}

beforeEach(() => {
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0),
  );
  vi.stubGlobal("matchMedia", () => ({ matches: false }));
  loadDocument();
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

describe("startup layer markup", () => {
  it("is the first thing in the trusted document, before the runtime renders", () => {
    const first = document.body.firstElementChild;
    expect(first?.id).toBe("tc-startup");
    expect(first?.getAttribute("data-phase")).toBe("intro");
    expect(document.querySelector("tc-player")).not.toBeNull();
  });

  it("draws the animated pulse logo with its exact paths", () => {
    const logo = new Set(paths(pulseLogo));
    const layer = paths(
      document.getElementById("tc-startup")!.outerHTML.replace(/\s+/g, " "),
    );
    expect(new Set(layer)).toEqual(logo);
    // The front tile is drawn once and shaded by a second copy of its path.
    expect(layer.length).toBe(logo.size + 1);
  });

  it("keeps the source pulse timing", () => {
    expect(pulseLogo).toContain(
      "animation:tc-pulse 1.5s ease-in-out infinite both",
    );
    expect(pulseLogo).toContain(".b{animation-delay:.18s}");
    expect(pulseLogo).toContain(".c{animation-delay:.36s}");
    expect(pulseLogo).toContain(
      "@keyframes tc-pulse{0%,60%,100%{opacity:.22;transform:translate(0,0)}25%{opacity:1;transform:translate(4.6px,4.0px)}}",
    );
    expect(runtimeCss).toMatch(
      /\.tc-startup__tile \{\s*animation: tc-startup-pulse 1\.5s ease-in-out infinite both;/,
    );
    expect(runtimeCss).toMatch(
      /\.tc-startup__tile--middle \{\s*animation-delay: 0\.18s;/,
    );
    expect(runtimeCss).toMatch(
      /\.tc-startup__tile--front \{\s*animation-delay: 0\.36s;/,
    );
    expect(runtimeCss).toMatch(
      /0%,\s*60%,\s*100% \{\s*opacity: 0\.22;\s*transform: translate\(0, 0\);\s*\}\s*25% \{\s*opacity: 1;\s*transform: translate\(4\.6px, 4px\);/,
    );
  });

  it("paints on black above every other runtime layer", () => {
    const block = /#tc-startup \{([^}]*)\}/.exec(runtimeCss)![1]!;
    expect(block).toMatch(/background: #000;/);
    expect(block).toMatch(/position: fixed;/);
    expect(block).toMatch(/inset: 0;/);
    const own = Number(/z-index: (\d+);/.exec(block)![1]);
    const others = [...runtimeCss.matchAll(/z-index: (\d+);/g)]
      .map((match) => Number(match[1]))
      .filter((value) => value !== own);
    expect(others.length).toBeGreaterThan(0);
    expect(own).toBeGreaterThan(Math.max(...others));
  });

  it("uses no inline style the runtime CSP would refuse", () => {
    const layer = document.getElementById("tc-startup")!;
    expect(layer.querySelector("style")).toBeNull();
    expect(layer.querySelector("[style]")).toBeNull();
  });
});

describe("startup lifecycle", () => {
  it("is removed before the runtime reports ready in conformance runs", () => {
    const sequence = startupFor(document, {
      clock: new ManualClock({ wallMs: 0 }),
      conformance: true,
      reducedMotion: () => true,
    });
    expect(sequence.phase).toBe("done");
    expect(document.getElementById("tc-startup")).toBeNull();
  });

  it("plays again in every new runtime document and keeps nothing between them", async () => {
    const storage = vi.spyOn(Storage.prototype, "getItem");
    const write = vi.spyOn(Storage.prototype, "setItem");
    for (let run = 0; run < 2; run++) {
      loadDocument();
      const clock = new ManualClock({ wallMs: 0 });
      const sequence = startupFor(document, {
        clock,
        conformance: false,
        reducedMotion: () => false,
      });
      expect(sequence.phase).toBe("intro");
      await flush();
      sequence.presentationShown();
      clock.advance(STARTUP_MIN_INTRO_MS);
      await flush();
      expect(sequence.phase).toBe("done");
      expect(document.getElementById("tc-startup")).toBeNull();
    }
    expect(storage).not.toHaveBeenCalled();
    expect(write).not.toHaveBeenCalled();
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
  const evidence: string[] = [];
  const controller = new PlaybackController({
    clock,
    synchronizedPlayback: false,
    reports: {
      evidence: (_activation, kind, itemId) =>
        evidence.push(`${kind}:${itemId}`),
      playbackError: () => undefined,
      presentationResult: () => undefined,
      websiteRecovered: () => undefined,
    },
  });
  const startup = startupFor(document, {
    clock,
    conformance: false,
    reducedMotion: () => false,
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
  });
  await view.updateComplete;
  await flush();
  const show = (id: string) => {
    controller.present({
      type: "presentation",
      presentation: { state: "playing", generation: 1, items: [image(id)] },
    });
    const state = controller.state;
    if (state.mode !== "playing" || !state.stage) throw new Error("not staged");
    // The image decoded on the hidden layer.
    controller.surface({ type: "SURFACE_READY", mount: state.stage.mount });
  };
  const layer = () => document.getElementById("tc-startup");
  const visibleItem = () =>
    document.querySelector(".layer.visible img")?.getAttribute("src") ?? null;
  return {
    clock,
    controller,
    startup,
    view,
    show,
    layer,
    visibleItem,
    evidence,
  };
}

describe("startup over the first presentation", () => {
  it("prepares and shows the first presentation beneath the layer, then reveals it once", async () => {
    const h = await boot();
    h.show("first");
    await flush();
    // The presentation is live and reporting under the layer…
    expect(h.visibleItem()).toBe("tcmedia://cap/first");
    expect(h.evidence).toContain("image-shown:first");
    expect(h.startup.describe().presentationShown).toBe(true);
    // …but the startup layer is still on top while the pulse finishes.
    expect(h.layer()?.dataset["phase"]).toBe("intro");
    expect(h.startup.covering).toBe(true);

    h.clock.advance(STARTUP_MIN_INTRO_MS);
    await flush();
    expect(h.startup.phase).toBe("done");
    expect(h.layer()).toBeNull();
    expect(h.visibleItem()).toBe("tcmedia://cap/first");
  });

  it("keeps pulsing past the minimum until the presentation is ready", async () => {
    const h = await boot();
    h.clock.advance(STARTUP_MIN_INTRO_MS * 3);
    await flush();
    expect(h.layer()?.dataset["phase"]).toBe("intro");
    h.show("late");
    await flush();
    expect(h.layer()).toBeNull();
  });

  it("does not replay for later presentation changes", async () => {
    const h = await boot();
    h.show("first");
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    await flush();
    expect(h.layer()).toBeNull();
    for (const id of ["second", "third"]) {
      h.show(id);
      await flush();
      expect(h.layer()).toBeNull();
      expect(document.querySelector("[data-phase]")).toBeNull();
    }
    h.controller.present({
      type: "presentation",
      presentation: { state: "idle" },
    } as never);
    await flush();
    expect(h.startup.phase).toBe("done");
    expect(document.getElementById("tc-startup")).toBeNull();
  });

  it("reveals a Tilecast status surface the same way", async () => {
    const h = await boot();
    h.controller.present({
      type: "presentation",
      presentation: { state: "setup" },
    } as never);
    await flush();
    expect(h.startup.describe().presentationShown).toBe(true);
    expect(h.layer()?.dataset["phase"]).toBe("intro");
    h.clock.advance(STARTUP_MIN_INTRO_MS);
    await flush();
    expect(h.layer()).toBeNull();
  });
});
