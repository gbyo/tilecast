// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  defineRuntimePlugin,
  type RuntimeManifestEntry,
} from "@tilecast/plugin-sdk/runtime";
import type { PluginManifestInput } from "@tilecast/plugin-sdk/manifest";
import { ManualClock } from "../clock/scheduler";
import {
  discoverRuntimePlugins,
  playerDiscovery,
  runtimeDiscovery,
} from "./discovery";
import type { RuntimeSurfaceHost } from "./host";
import { PlayerPlugins } from "./player-plugins";

const WALL = Date.parse("2026-09-01T15:00:00Z");

const countdown: RuntimeManifestEntry = {
  id: "cd-1",
  type: "countdown_bar",
  version: 1,
  config: {
    message: "Lunch starts in",
    scheduleType: "one_time",
    oneTimeAt: "2026-09-01T15:10:00.000Z",
    timezone: "UTC",
    leadTimeSeconds: 3_600,
    displayMode: "overlay",
    heightPx: 72,
    priority: 1_000,
  },
};

const ticker: RuntimeManifestEntry = {
  id: "alert-1",
  type: "alert_ticker",
  version: 1,
  config: {
    message: "Severe weather warning. Stay indoors.",
    severity: "warning",
    displayMode: "push",
    heightPx: 96,
    speed: "medium",
    priority: 10,
    expiresAt: "2026-09-01T15:02:00.000Z",
  },
};

/** The plugin composition a Player runs, with every bundled plugin. */
function player(
  options: { animationScale?: number; pluginState?: boolean } = {},
) {
  const clock = new ManualClock({ wallMs: WALL });
  const stage = document.createElement("div");
  const diagnostics: string[] = [];
  const plugins = new PlayerPlugins({
    clock,
    runtimePlugins: runtimeDiscovery.plugins,
    playerPlugins: playerDiscovery.plugins,
    animationScale: options.animationScale ?? 1,
    reducedMotion: () => (options.animationScale ?? 1) === 0,
    pluginState: options.pluginState ?? false,
    mediaUrl: (asset, variant) => `tcmedia://variant/${asset}/${variant}`,
    stage: () => stage,
    diagnostic: (id, message) => diagnostics.push(`${id}: ${message}`),
  });
  document.body.replaceChildren(plugins.surfaces.element);
  const host = plugins.surfaces;
  /** One plugins message, then the queued evaluation, as on a Player. */
  const send = (entries: unknown[]) => {
    plugins.receive({ plugins: entries as never, clockOffsetMs: 0 });
    clock.flush();
  };
  return { clock, host, plugins, send, stage, diagnostics };
}

/** The same Countdown Bar instance as Plugin API 2 Player state. */
const countdownState = {
  id: countdown.id,
  type: "plugin_state",
  version: 1,
  plugin: "countdown_bar",
  definitionVersion: 1,
  stateType: "countdown_bar",
  stateVersion: 1,
  state: countdown.config,
  media: [],
};

const holder = (host: RuntimeSurfaceHost, slot: "strip.bottom") =>
  host.describe().surfaces[slot]?.plugin ?? null;

describe("runtime plugin discovery", () => {
  it("finds every bundled runtime plugin, and each agrees with its manifest", () => {
    expect(runtimeDiscovery.problems).toEqual([]);
    expect(
      runtimeDiscovery.plugins.map((plugin) => [
        plugin.definition.id,
        plugin.definition.tier,
      ]),
    ).toEqual([["emergency_alerts", "emergency"]]);
    // Countdown Bar is a Plugin API 2 plugin that still accepts its v1 entry.
    expect(playerDiscovery.problems).toEqual([]);
    expect(
      playerDiscovery.plugins.map(({ declaration }) => ({
        id: declaration.id,
        v1: [...declaration.v1Types],
        surfaces: declaration.surfaces.map((surface) => surface.tier),
      })),
    ).toEqual([
      {
        id: "countdown_bar",
        v1: ["countdown_bar"],
        surfaces: ["scheduled", "scheduled"],
      },
    ]);
  });

  const manifest = (
    runtime: Record<string, unknown> | undefined,
    id = "sample_surface",
  ): PluginManifestInput =>
    ({
      apiVersion: 1,
      id,
      definitionVersion: 1,
      name: "Sample",
      description: "Sample.",
      category: "Display",
      icon: "hash",
      maintainers: ["@gbyo"],
      instanceNoun: { singular: "item", plural: "items" },
      capabilities: { playerManifest: true },
      ...(runtime ? { runtime } : {}),
    }) as PluginManifestInput;
  const definition = (changes: Record<string, unknown> = {}) =>
    defineRuntimePlugin({
      id: "sample_surface",
      tier: "live",
      manifestTypes: ["sample_surface"],
      surfaces: ["strip.bottom"],
      create: () => ({
        mount() {},
        update: () => [],
        render() {},
        dispose() {},
      }),
      ...changes,
    } as never);
  const declared = {
    entrypoint: "./runtime/index.ts",
    manifestTypes: ["sample_surface"],
    surfaces: ["strip.bottom"],
    tier: "live",
  };
  const discover = (
    runtime: Record<string, unknown> | undefined,
    module: unknown = definition(),
  ) =>
    discoverRuntimePlugins(
      {
        "../../../../plugins/sample-surface/tilecast.plugin.json":
          manifest(runtime),
      },
      {
        "../../../../plugins/sample-surface/runtime/index.ts": {
          default: module as never,
        },
      },
    );

  it("accepts a definition that matches its manifest", () => {
    const found = discover(declared);
    expect(found.problems).toEqual([]);
    expect(found.plugins.map((plugin) => plugin.dir)).toEqual([
      "sample-surface",
    ]);
  });

  it.each([
    [
      "a different tier",
      { ...declared, tier: "emergency" },
      /tier live ≠ emergency/,
    ],
    [
      "different surfaces",
      { ...declared, surfaces: ["overlay"] },
      /surfaces differ/,
    ],
    [
      "different types",
      { ...declared, manifestTypes: ["other"] },
      /manifestTypes differ/,
    ],
    ["no runtime declaration", undefined, /declares no runtime/],
    [
      "an undeclared entry point",
      { ...declared, entrypoint: undefined },
      /does not declare it/,
    ],
  ])("leaves out a plugin whose manifest has %s", (_name, runtime, message) => {
    const found = discover(runtime as Record<string, unknown> | undefined);
    expect(found.plugins).toEqual([]);
    expect(found.problems.join("\n")).toMatch(message);
  });

  it("leaves out a module without a definition and a mismatched id", () => {
    expect(discover(declared, null).problems.join()).toMatch(
      /must default-export/,
    );
    expect(
      discover(declared, definition({ id: "someone_else" })).problems.join(),
    ).toMatch(/id someone_else ≠ sample_surface/);
  });

  it("refuses two renderers for one manifest type", () => {
    const found = discoverRuntimePlugins(
      {
        "../../../../plugins/sample-surface/tilecast.plugin.json":
          manifest(declared),
        "../../../../plugins/sample-other/tilecast.plugin.json": manifest(
          declared,
          "sample_other",
        ),
      },
      {
        "../../../../plugins/sample-surface/runtime/index.ts": {
          default: definition(),
        },
        "../../../../plugins/sample-other/runtime/index.ts": {
          default: definition({ id: "sample_other" }),
        },
      },
    );
    expect(found.problems.join()).toMatch(/also rendered by/);
  });
});

describe("runtime plugins together", () => {
  it("gives an emergency ticker the strip and pushes content", () => {
    const { host, stage, clock, send } = player();
    send([countdown]);
    expect(holder(host, "strip.bottom")).toBe("countdown_bar/bar");
    expect(host.describe().surfaces["strip.bottom"]?.text).toBe(
      "Lunch starts in 10m 0s",
    );
    expect(host.element.style.getPropertyValue("--tc-corner-lift-bottom")).toBe(
      "72px",
    );

    send([countdown, ticker]);
    // A countdown priority of 1000 still loses to the emergency tier.
    expect(holder(host, "strip.bottom")).toBe("emergency_alerts");
    expect(host.describe().surfaces["strip.bottom"]?.text).toBe(
      "warning Severe weather warning. Stay indoors.",
    );
    expect(stage.style.getPropertyValue("--tc-stage-bottom")).toBe("96px");
    expect(host.element.style.getPropertyValue("--tc-corner-lift-bottom")).toBe(
      "96px",
    );

    // The cached manifest still holds the ticker; its expiry ends it locally.
    clock.advance(2 * 60_000);
    expect(holder(host, "strip.bottom")).toBe("countdown_bar/bar");
    expect(stage.style.getPropertyValue("--tc-stage-bottom")).toBe("0px");
    const alerts = document.querySelector(".tc-emergency-alerts")!;
    expect(alerts.classList.contains("tc-emergency-alerts--visible")).toBe(
      false,
    );
  });

  it("draws Countdown Bar the same from plugin_state and from its v1 entry", () => {
    const fromV1 = player();
    fromV1.send([countdown]);
    const v1 = fromV1.host.describe();
    const fromState = player({ pluginState: true });
    fromState.send([countdownState]);
    expect(fromState.host.describe()).toEqual(v1);
    expect(v1.surfaces["strip.bottom"]?.plugin).toBe("countdown_bar/bar");

    // A host that does not forward plugin_state never shows it.
    const unforwarded = player({ pluginState: false });
    unforwarded.send([countdownState]);
    expect(
      unforwarded.host.describe().surfaces["strip.bottom"],
    ).toBeUndefined();
  });

  it("keeps the bar and its elements across state-only changes", () => {
    const { host, send } = player({ pluginState: true });
    send([countdownState]);
    const bar = document.querySelector(".tc-countdown-bar");
    send([
      {
        ...countdownState,
        state: {
          ...(countdown.config as Record<string, unknown>),
          priority: 9,
        },
      },
    ]);
    expect(holder(host, "strip.bottom")).toBe("countdown_bar/bar");
    expect(document.querySelector(".tc-countdown-bar")).toBe(bar);
  });

  it("freezes the ticker at a deterministic frame when motion is frozen", () => {
    const { send } = player({ animationScale: 0 });
    send([ticker]);
    const track = document.querySelector<HTMLElement>(
      ".tc-emergency-alerts__track",
    )!;
    // jsdom has no layout, so the frame is the fixed point of a 0px bar.
    expect(track.style.getPropertyValue("transform")).toMatch(/^translateX\(/);
  });

  it("ignores entries of removed plugins in a cached manifest", () => {
    // Brand Bug and Noise Meter were removed; a Player may still hold a
    // manifest that carries their entries until the next sync.
    const { host, stage, diagnostics, send } = player();
    send([
      {
        id: "bug-1",
        type: "brand_bug",
        version: 1,
        config: { corner: "top_left" },
      },
      { id: "noise-1", type: "noise_meter", version: 1, config: {} },
      countdown,
    ]);
    expect(Object.keys(host.describe().surfaces)).toEqual(["strip.bottom"]);
    expect(holder(host, "strip.bottom")).toBe("countdown_bar/bar");
    expect(stage.style.getPropertyValue("--tc-stage-bottom")).toBe("0px");
    expect(diagnostics).toEqual([]);
  });
});
