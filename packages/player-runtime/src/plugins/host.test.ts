// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  defineRuntimePlugin,
  type RuntimeManifestEntry,
  type RuntimePluginContext,
  type RuntimePluginDefinition,
  type SurfaceClaim,
  type SurfaceGrant,
  type SurfaceSlot,
  type SurfaceTier,
} from "@tilecast/plugin-sdk/runtime";
import { ManualClock } from "../clock/scheduler";
import type { DiscoveredRuntimePlugin } from "./discovery";
import { RuntimeSurfaceHost, SURFACE_TICK_MS } from "./host";
import { MicrophoneService } from "./microphone";

const WALL = Date.parse("2026-09-01T15:00:00Z");

interface Probe {
  context: RuntimePluginContext | null;
  mounts: { slot: SurfaceSlot; container: HTMLElement }[];
  updates: (readonly RuntimeManifestEntry[])[];
  grants: SurfaceGrant[];
  awake: boolean[];
  disposed: number;
}

/** A plugin that claims whatever `claims` returns and records its calls. */
function fake(
  id: string,
  tier: SurfaceTier,
  surfaces: SurfaceSlot[],
  claims: (entries: readonly RuntimeManifestEntry[], probe: Probe) => unknown,
  extra: { throwOn?: "create" | "mount" | "update" | "render" } = {},
): { definition: RuntimePluginDefinition; probe: Probe } {
  const probe: Probe = {
    context: null,
    mounts: [],
    updates: [],
    grants: [],
    awake: [],
    disposed: 0,
  };
  const definition = defineRuntimePlugin({
    id,
    tier,
    manifestTypes: [id],
    surfaces,
    create(context) {
      if (extra.throwOn === "create") throw new Error("broken create");
      probe.context = context;
      return {
        mount(slot, container) {
          if (extra.throwOn === "mount") throw new Error("broken mount");
          const node = document.createElement("span");
          node.className = `mark-${id}`;
          node.textContent = `${id} ${slot}`;
          container.appendChild(node);
          probe.mounts.push({ slot, container });
        },
        update(entries) {
          probe.updates.push(entries);
          if (extra.throwOn === "update") throw new Error("broken update");
          return claims(entries, probe) as SurfaceClaim[];
        },
        render(grant) {
          probe.grants.push(grant);
          if (extra.throwOn === "render") throw new Error("broken render");
        },
        setAwake(awake) {
          probe.awake.push(awake);
        },
        dispose() {
          probe.disposed += 1;
        },
      };
    },
  });
  return { definition, probe };
}

function hostWith(
  definitions: RuntimePluginDefinition[],
  options: {
    hardware?: Record<string, string[]>;
    animationScale?: number;
  } = {},
) {
  const clock = new ManualClock({ wallMs: WALL });
  const stage = document.createElement("div");
  const diagnostics: string[] = [];
  const microphone = new MicrophoneService({
    source: "host-levels",
    clock,
    report: () => {},
    diagnostic: () => {},
  });
  const plugins: DiscoveredRuntimePlugin[] = definitions.map((definition) => ({
    dir: definition.id,
    definition,
    hardware: options.hardware?.[definition.id] ?? [],
  }));
  const host = new RuntimeSurfaceHost({
    clock,
    plugins,
    animationScale: options.animationScale ?? 1,
    reducedMotion: () => false,
    microphone,
    mediaUrl: (asset, variant) => `tcmedia://variant/${asset}/${variant}`,
    stage: () => stage,
    diagnostic: (id, message) => diagnostics.push(`${id}: ${message}`),
  });
  return { host, clock, stage, diagnostics, microphone };
}

const entry = (type: string, config: unknown = {}): RuntimeManifestEntry => ({
  id: `${type}-1`,
  type,
  version: 1,
  config,
});

const strip = (priority: number, heightPx = 72, displayMode = "overlay") => [
  { slot: "strip.bottom", priority, heightPx, displayMode },
];

describe("runtime surface host: containers and lifecycle", () => {
  it("mounts each declared surface once, into long-lived host containers", () => {
    const marks = fake(
      "marks",
      "ambient",
      ["corner.top-left", "corner.bottom-right"],
      () => [{ slot: "corner.top-left", priority: 0 }],
    );
    const { host, clock } = hostWith([marks.definition]);
    expect(marks.probe.mounts.map((mount) => mount.slot)).toEqual([
      "corner.top-left",
      "corner.bottom-right",
    ]);
    const containers = marks.probe.mounts.map((mount) => mount.container);
    const drawn = host.element.querySelector(".mark-marks");
    for (let index = 0; index < 5; index += 1) {
      host.setEntries([entry("marks")], 0);
      clock.advance(SURFACE_TICK_MS);
    }
    expect(marks.probe.mounts).toHaveLength(2);
    expect(host.element.querySelector(".mark-marks")).toBe(drawn);
    for (const container of containers) {
      expect(container.isConnected || container.parentElement).toBeTruthy();
      expect(container.parentElement).toBe(host.element);
    }
    // A slot the plugin did not win keeps its elements; it is only not granted.
    const bottomRight = containers[1]!;
    expect(bottomRight.classList.contains("tc-surface--granted")).toBe(false);
    expect(bottomRight.querySelector(".mark-marks")).not.toBeNull();
  });

  it("gives a plugin only the entries of its own manifest types", () => {
    const one = fake("one", "scheduled", ["overlay"], () => []);
    const two = fake("two", "scheduled", ["overlay"], () => []);
    const { host } = hostWith([one.definition, two.definition]);
    host.setEntries(
      [entry("one"), entry("two"), entry("from_a_newer_server")],
      0,
    );
    expect(one.probe.updates.at(-1)?.map((item) => item.type)).toEqual(["one"]);
    expect(two.probe.updates.at(-1)?.map((item) => item.type)).toEqual(["two"]);
  });

  it("paints stronger tiers after weaker ones within a slot", () => {
    const low = fake("low", "ambient", ["strip.bottom"], () => []);
    const high = fake("high", "emergency", ["strip.bottom"], () => []);
    const { host } = hostWith([high.definition, low.definition]);
    expect(
      [...host.element.children].map(
        (node) => (node as HTMLElement).dataset["plugin"],
      ),
    ).toEqual(["low", "high"]);
  });

  it("disposes plugins and cancels their timers on stop", () => {
    const timed = fake("timed", "live", ["overlay"], () => []);
    const { host, clock } = hostWith([timed.definition]);
    let fired = 0;
    timed.probe.context!.clock.after(500, () => (fired += 1));
    timed.probe.context!.clock.every(100, () => (fired += 1));
    host.setEntries([], 0);
    host.stop();
    clock.advance(5_000);
    expect(fired).toBe(0);
    expect(timed.probe.disposed).toBe(1);
    const updates = timed.probe.updates.length;
    timed.probe.context!.invalidate();
    host.setEntries([entry("timed")], 0);
    clock.advance(5_000);
    expect(timed.probe.updates).toHaveLength(updates);
    expect(clock.pendingTimers).toBe(0);
  });

  it("forwards sleep and wake and evaluates again", () => {
    const sleepy = fake("sleepy", "live", ["overlay"], () => []);
    const { host } = hostWith([sleepy.definition]);
    host.setEntries([], 0);
    const before = sleepy.probe.updates.length;
    host.setAwake(false);
    expect(sleepy.probe.awake).toEqual([false]);
    expect(sleepy.probe.context!.awake()).toBe(false);
    expect(sleepy.probe.updates.length).toBe(before + 1);
    host.setAwake(false);
    expect(sleepy.probe.awake).toEqual([false]);
    host.setAwake(true);
    expect(sleepy.probe.awake).toEqual([false, true]);
  });
});

describe("runtime surface host: evaluation scheduling", () => {
  it("evaluates on a manifest change, on each tick, and on invalidate", () => {
    const plugin = fake("p", "live", ["overlay"], () => []);
    const { host, clock } = hostWith([plugin.definition]);
    host.setEntries([], 0);
    expect(plugin.probe.updates).toHaveLength(1);
    clock.advance(SURFACE_TICK_MS);
    expect(plugin.probe.updates).toHaveLength(2);
    plugin.probe.context!.invalidate();
    expect(plugin.probe.updates).toHaveLength(2);
    clock.flush();
    expect(plugin.probe.updates).toHaveLength(3);
  });

  it("coalesces invalidations into one pass", () => {
    const plugin = fake("p", "live", ["overlay"], () => []);
    const { host, clock } = hostWith([plugin.definition]);
    host.setEntries([], 0);
    for (let index = 0; index < 10; index += 1) {
      plugin.probe.context!.invalidate();
    }
    clock.flush();
    expect(plugin.probe.updates).toHaveLength(2);
  });

  it("never re-enters update: an invalidate during evaluation schedules one more pass", () => {
    let depth = 0;
    let deepest = 0;
    const plugin = fake("p", "live", ["overlay"], (_entries, probe) => {
      depth += 1;
      deepest = Math.max(deepest, depth);
      if (probe.updates.length < 3) {
        probe.context!.invalidate();
        probe.context!.invalidate();
      }
      depth -= 1;
      return [];
    });
    const { host, clock } = hostWith([plugin.definition]);
    host.setEntries([], 0);
    expect(plugin.probe.updates).toHaveLength(1);
    clock.flush();
    expect(plugin.probe.updates).toHaveLength(3);
    expect(deepest).toBe(1);
  });

  it("makes a plugin that invalidates on every update wait for the tick", () => {
    const plugin = fake("busy", "live", ["overlay"], (_entries, probe) => {
      probe.context!.invalidate();
      return [];
    });
    const { host, clock, diagnostics } = hostWith([plugin.definition]);
    host.setEntries([], 0);
    clock.flush();
    const bounded = plugin.probe.updates.length;
    expect(bounded).toBeLessThanOrEqual(6);
    expect(diagnostics).toEqual([
      "busy: invalidates during every update; waiting for the next tick",
    ]);
    clock.advance(SURFACE_TICK_MS);
    expect(plugin.probe.updates.length).toBeGreaterThan(bounded);
    expect(plugin.probe.updates.length).toBeLessThanOrEqual(2 * bounded);
  });

  it("renders after every update, with the same grant for every plugin's view", () => {
    const plugin = fake("p", "live", ["overlay"], () => [
      { slot: "overlay", priority: 0 },
    ]);
    const { host } = hostWith([plugin.definition]);
    host.setEntries([], 0);
    expect(plugin.probe.grants).toHaveLength(1);
    expect([...plugin.probe.grants[0]!.shown]).toEqual(["overlay"]);
  });
});

describe("runtime surface host: arbitration and geometry", () => {
  it("lets a declared tier beat any priority", () => {
    const countdown = fake("countdown", "scheduled", ["strip.bottom"], () =>
      strip(1_000_000),
    );
    const alerts = fake("alerts", "emergency", ["strip.bottom"], () =>
      strip(-1_000_000, 96, "push"),
    );
    const { host } = hostWith([countdown.definition, alerts.definition]);
    host.setEntries([], 0);
    expect(host.describe().surfaces["strip.bottom"]?.plugin).toBe("alerts");
    expect(countdown.probe.grants.at(-1)?.shown.size).toBe(0);
    expect(alerts.probe.grants.at(-1)?.shown.has("strip.bottom")).toBe(true);
  });

  it("breaks a tie by plugin identifier", () => {
    const b = fake("b", "live", ["strip.bottom"], () => strip(3));
    const a = fake("a", "live", ["strip.bottom"], () => strip(3));
    const { host } = hostWith([b.definition, a.definition]);
    host.setEntries([], 0);
    expect(host.describe().surfaces["strip.bottom"]?.plugin).toBe("a");
  });

  it("owns the content-stage insets for push strips, top and bottom", () => {
    let mode = "push";
    const bottom = fake("bottom", "live", ["strip.bottom"], () =>
      strip(0, 96, mode),
    );
    const top = fake("top", "live", ["strip.top"], () => [
      { slot: "strip.top", priority: 0, heightPx: 48, displayMode: "push" },
    ]);
    const { host, stage, clock } = hostWith([
      bottom.definition,
      top.definition,
    ]);
    host.setEntries([], 0);
    expect(stage.style.getPropertyValue("--tc-stage-bottom")).toBe("96px");
    expect(stage.style.getPropertyValue("--tc-stage-top")).toBe("48px");
    expect(host.describe().insets).toEqual({ top: 48, bottom: 96 });
    mode = "overlay";
    clock.advance(SURFACE_TICK_MS);
    expect(stage.style.getPropertyValue("--tc-stage-bottom")).toBe("0px");
    expect(stage.style.getPropertyValue("--tc-stage-top")).toBe("48px");
  });

  it("sizes each strip container to its plugin's claim", () => {
    const bar = fake("bar", "live", ["strip.bottom"], () => strip(0, 120));
    const { host } = hostWith([bar.definition]);
    host.setEntries([], 0);
    const container = bar.probe.mounts[0]!.container;
    expect(container.style.getPropertyValue("--tc-strip-height")).toBe("120px");
    expect(container.classList.contains("tc-surface--granted")).toBe(true);
  });

  it("lifts corners clear of whichever strips are held", () => {
    let showStrip = true;
    const bar = fake("bar", "live", ["strip.bottom"], () =>
      showStrip ? strip(0, 80) : [],
    );
    const marks = fake("marks", "ambient", ["corner.bottom-left"], () => [
      { slot: "corner.bottom-left", priority: 0 },
    ]);
    const { host, clock } = hostWith([bar.definition, marks.definition]);
    host.setEntries([], 0);
    expect(host.element.style.getPropertyValue("--tc-corner-lift-bottom")).toBe(
      "80px",
    );
    expect(marks.probe.grants.at(-1)?.bottomLiftPx).toBe(80);
    expect(marks.probe.grants.at(-1)?.topLiftPx).toBe(0);
    showStrip = false;
    clock.advance(SURFACE_TICK_MS);
    expect(host.element.style.getPropertyValue("--tc-corner-lift-bottom")).toBe(
      "0px",
    );
  });
});

describe("runtime surface host: a malformed plugin cannot break the Player", () => {
  it.each(["create", "mount", "update", "render"] as const)(
    "isolates a plugin whose %s throws",
    (throwOn) => {
      const broken = fake(
        "broken",
        "emergency",
        ["strip.bottom"],
        () => strip(9),
        {
          throwOn,
        },
      );
      const healthy = fake("healthy", "scheduled", ["strip.bottom"], () =>
        strip(1),
      );
      const { host, diagnostics } = hostWith([
        broken.definition,
        healthy.definition,
      ]);
      expect(() => host.setEntries([], 0)).not.toThrow();
      expect(diagnostics.some((line) => line.startsWith("broken: "))).toBe(
        true,
      );
      if (throwOn !== "render") {
        expect(host.describe().surfaces["strip.bottom"]?.plugin).toBe(
          "healthy",
        );
      }
      expect(healthy.probe.grants.length).toBeGreaterThan(0);
    },
  );

  it("drops invalid claims with one diagnostic each, not one per tick", () => {
    const sloppy = fake("sloppy", "emergency", ["strip.bottom"], () => [
      { slot: "strip.bottom", priority: 1, heightPx: Infinity },
      { slot: "corner.top-left", priority: 1 },
    ]);
    const good = fake("good", "ambient", ["strip.bottom"], () => strip(0));
    const { host, clock, diagnostics } = hostWith([
      sloppy.definition,
      good.definition,
    ]);
    host.setEntries([], 0);
    clock.advance(SURFACE_TICK_MS * 5);
    expect(host.describe().surfaces["strip.bottom"]?.plugin).toBe("good");
    expect(diagnostics).toEqual([
      "sloppy: claim for strip.bottom has an invalid heightPx",
      "sloppy: claim for undeclared slot corner.top-left",
    ]);
    expect(host.describe().diagnostics).toHaveLength(2);
  });

  it("reports a throwing timer callback instead of crashing", () => {
    const timed = fake("timed", "live", ["overlay"], () => []);
    const { clock, diagnostics } = hostWith([timed.definition]);
    timed.probe.context!.clock.after(10, () => {
      throw new Error("boom");
    });
    expect(() => clock.advance(10)).not.toThrow();
    expect(diagnostics).toEqual(["timed: timer failed: boom"]);
  });
});

describe("runtime surface host: context", () => {
  it("gives plugins the corrected clock and the host's motion settings", () => {
    const plugin = fake("p", "live", ["overlay"], () => []);
    const { host, clock } = hostWith([plugin.definition], {
      animationScale: 0,
    });
    host.setEntries([], 2_500);
    const context = plugin.probe.context!;
    expect(context.clock.localNow()).toBe(WALL);
    expect(context.clock.now()).toBe(WALL + 2_500);
    expect(context.animationScale).toBe(0);
    expect(context.reducedMotion()).toBe(false);
    clock.advance(1_000);
    expect(context.clock.now()).toBe(WALL + 3_500);
    expect(context.mediaUrl("a", "b")).toBe("tcmedia://variant/a/b");
  });

  it("gives the microphone only to a plugin that declares it", () => {
    const listens = fake("listens", "live", ["overlay"], () => []);
    const deaf = fake("deaf", "live", ["overlay"], () => []);
    hostWith([listens.definition, deaf.definition], {
      hardware: { listens: ["microphone"] },
    });
    expect(listens.probe.context!.microphone?.source).toBe("host-levels");
    expect(deaf.probe.context!.microphone).toBeUndefined();
  });
});
