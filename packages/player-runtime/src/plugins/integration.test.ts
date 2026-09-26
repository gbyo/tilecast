// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import {
  defineRuntimePlugin,
  type RuntimeManifestEntry,
} from "@tilecast/plugin-sdk/runtime";
import type { PluginManifestInput } from "@tilecast/plugin-sdk/manifest";
import { ManualClock } from "../clock/scheduler";
import { discoverRuntimePlugins, runtimeDiscovery } from "./discovery";
import { RuntimeSurfaceHost, SURFACE_TICK_MS } from "./host";
import { MicrophoneService } from "./microphone";

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

function player(
  options: {
    source?: "host-levels" | "renderer-microphone" | null;
    animationScale?: number;
  } = {},
) {
  const clock = new ManualClock({ wallMs: WALL });
  const reports: string[] = [];
  const stage = document.createElement("div");
  const microphone = new MicrophoneService({
    source: options.source === undefined ? "host-levels" : options.source,
    clock,
    report: (report) => reports.push(report.status),
    diagnostic: () => {},
  });
  const diagnostics: string[] = [];
  const host = new RuntimeSurfaceHost({
    clock,
    plugins: runtimeDiscovery.plugins,
    animationScale: options.animationScale ?? 1,
    reducedMotion: () => (options.animationScale ?? 1) === 0,
    microphone,
    mediaUrl: (asset, variant) => `tcmedia://variant/${asset}/${variant}`,
    stage: () => stage,
    diagnostic: (id, message) => diagnostics.push(`${id}: ${message}`),
  });
  document.body.replaceChildren(host.element);
  return { clock, host, stage, microphone, reports, diagnostics };
}

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
    ).toEqual([
      ["countdown_bar", "scheduled"],
      ["emergency_alerts", "emergency"],
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
      },
      {
        "../../../../plugins/sample-surface/runtime/index.ts": {
          default: definition(),
        },
      },
      [definition()],
    );
    expect(found.problems.join()).toMatch(/remove its temporary adapter/);
  });
});

describe("runtime plugins together", () => {
  it("gives an emergency ticker the strip and pushes content", () => {
    const { host, stage, clock } = player();
    host.setEntries([countdown], 0);
    expect(holder(host, "strip.bottom")).toBe("countdown_bar");
    expect(host.describe().surfaces["strip.bottom"]?.text).toBe(
      "Lunch starts in 10m 0s",
    );
    expect(host.element.style.getPropertyValue("--tc-corner-lift-bottom")).toBe(
      "72px",
    );

    host.setEntries([countdown, ticker], 0);
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
    expect(holder(host, "strip.bottom")).toBe("countdown_bar");
    expect(stage.style.getPropertyValue("--tc-stage-bottom")).toBe("0px");
    const alerts = document.querySelector(".tc-emergency-alerts")!;
    expect(alerts.classList.contains("tc-emergency-alerts--visible")).toBe(
      false,
    );
  });

  it("freezes the ticker at a deterministic frame when motion is frozen", () => {
    const { host } = player({ animationScale: 0 });
    host.setEntries([ticker], 0);
    const track = document.querySelector<HTMLElement>(
      ".tc-emergency-alerts__track",
    )!;
    // jsdom has no layout, so the frame is the fixed point of a 0px bar.
    expect(track.style.getPropertyValue("transform")).toMatch(/^translateX\(/);
  });

  it("ignores entries of removed plugins in a cached manifest", () => {
    // Brand Bug and Noise Meter were removed; a Player may still hold a
    // manifest that carries their entries until the next sync.
    const { host, stage, diagnostics } = player();
    host.setEntries(
      [
        {
          id: "bug-1",
          type: "brand_bug",
          version: 1,
          config: { corner: "top_left" },
        },
        { id: "noise-1", type: "noise_meter", version: 1, config: {} },
        countdown,
      ],
      0,
    );
    expect(Object.keys(host.describe().surfaces)).toEqual(["strip.bottom"]);
    expect(holder(host, "strip.bottom")).toBe("countdown_bar");
    expect(stage.style.getPropertyValue("--tc-stage-bottom")).toBe("0px");
    expect(diagnostics).toEqual([]);
  });
});
