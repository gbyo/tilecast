// @vitest-environment jsdom
/**
 * Plugin API v2 in the Shared Runtime: discovery, the event-driven Player
 * Plugin Host, and its services. The fixture plugins exist only here; no
 * bundled plugin uses Plugin API v2 yet.
 */
import { describe, expect, it } from "vitest";
import type { PluginManifestInput } from "@tilecast/plugin-sdk/manifest";
import {
  definePlayerPlugin,
  type PlayerStateEntry,
  type PlayerSurfaceGrant,
  type PresentationObservation,
} from "@tilecast/plugin-sdk/player";
import type { RuntimeManifestEntry } from "@tilecast/plugin-sdk/runtime";
import { ManualClock } from "../clock/scheduler";
import {
  discoverRuntimePlugins,
  playerDiscovery,
  runtimeDiscovery,
  type RuntimeModules,
} from "./discovery";
import { RuntimeSurfaceHost } from "./host";
import { PlayerPluginHost } from "./player-host";
import { discoverPlayerPlugins } from "./player-discovery";
import {
  clockService,
  mediaService,
  PresentationObserver,
  surfaceService,
} from "./service-providers";
import { PlayerServiceRegistry, type PlayerServiceProvider } from "./services";

const WALL = Date.parse("2026-09-01T15:00:00Z");
const ASSET = "11111111-1111-4111-8111-111111111111";
const VARIANT = "22222222-2222-4222-8222-222222222222";

type Services = { required?: string[]; optional?: string[] };

function manifestV2(
  id: string,
  services: Services,
  surfaces: { id: string; slots: string[]; tier: string }[] = [],
  state = [{ type: id, version: 1 }],
): PluginManifestInput {
  return {
    apiVersion: 2,
    id,
    definitionVersion: 1,
    name: id,
    description: "Fixture.",
    category: "Display",
    icon: "puzzle",
    maintainers: ["@gbyo"],
    instanceNoun: { singular: "item", plural: "items" },
    server: { entrypoint: "./plugin.go" },
    player: {
      state,
      runtime: {
        entrypoint: "./runtime/index.ts",
        services: {
          required: services.required ?? [],
          optional: services.optional ?? [],
        },
        surfaces,
      },
    },
  } as PluginManifestInput;
}

const path = (id: string, file: string) =>
  `../../../../plugins/${id.replaceAll("_", "-")}/${file}`;

function discovered(
  plugins: { manifest: PluginManifestInput; definition: unknown }[],
) {
  const manifests: Record<string, PluginManifestInput> = {};
  const modules: RuntimeModules = {};
  for (const { manifest, definition } of plugins) {
    manifests[path(manifest.id, "tilecast.plugin.json")] = manifest;
    modules[path(manifest.id, "runtime/index.ts")] = {
      default: definition as never,
    };
  }
  return discoverPlayerPlugins(manifests, modules);
}

function stateEntry(
  plugin: string,
  id: string,
  state: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return {
    id,
    type: "plugin_state",
    version: 1,
    plugin,
    definitionVersion: 1,
    stateType: plugin,
    stateVersion: 1,
    state,
    media: [],
    ...extra,
  };
}

/** A Player: the real surface host with the bundled v1 plugins, plus v2. */
function player(
  plugins: { manifest: PluginManifestInput; definition: unknown }[],
  options: { withSurface?: boolean; withPresentation?: boolean } = {},
) {
  const clock = new ManualClock({ wallMs: WALL });
  const stage = document.createElement("div");
  const diagnostics: string[] = [];
  const surfaces = new RuntimeSurfaceHost({
    clock,
    plugins: runtimeDiscovery.plugins,
    animationScale: 0,
    reducedMotion: () => true,
    mediaUrl: (asset, variant) => `tcmedia://variant/${asset}/${variant}`,
    stage: () => stage,
    diagnostic: (id, message) => diagnostics.push(`${id}: ${message}`),
  });
  document.body.replaceChildren(surfaces.element);
  const observer = new PresentationObserver();
  const offset = { value: 0 };
  const providers: PlayerServiceProvider[] = [
    clockService({ clock, clockOffsetMs: () => offset.value }),
    mediaService({
      resolve: (asset, variant) => `tcmedia://variant/${asset}/${variant}`,
    }),
  ];
  if (options.withPresentation !== false) providers.push(observer.provider());
  if (options.withSurface !== false) {
    providers.push(
      surfaceService({
        surfaces,
        reducedMotion: () => true,
        animationScale: 0,
      }),
    );
  }
  const services = new PlayerServiceRegistry(providers);
  const discovery = discovered(plugins);
  expect(discovery.problems).toEqual([]);
  const host = new PlayerPluginHost({
    clock,
    plugins: discovery.plugins,
    services,
    diagnostic: (id, message) => diagnostics.push(`${id}: ${message}`),
  });
  /** One plugins message: v1 entries go to the surface host, v2 to the host. */
  const send = (entries: unknown[]) => {
    surfaces.setEntries(entries as never, offset.value);
    host.setState(entries, offset.value);
    clock.flush();
  };
  return {
    clock,
    stage,
    surfaces,
    host,
    observer,
    services,
    diagnostics,
    send,
  };
}

const status = (host: PlayerPluginHost, id: string) =>
  host.describe().plugins.find((plugin) => plugin.id === id);

describe("Plugin API v2 discovery", () => {
  it("finds no bundled v2 plugins yet and leaves v1 discovery unchanged", () => {
    expect(playerDiscovery.problems).toEqual([]);
    expect(playerDiscovery.plugins).toEqual([]);
    expect(runtimeDiscovery.problems).toEqual([]);
  });

  it("pairs a v2 manifest with definePlayerPlugin and refuses mismatches", () => {
    const manifest = manifestV2("beacon", { required: ["player.clock@1"] });
    const good = definePlayerPlugin({
      id: "beacon",
      services: { required: ["player.clock@1"], optional: [] },
      activate: () => ({}),
    });
    expect(discovered([{ manifest, definition: good }]).plugins).toHaveLength(
      1,
    );

    const wrongServices = definePlayerPlugin({
      id: "beacon",
      services: { required: [], optional: ["player.clock@1"] },
      activate: () => ({}),
    });
    expect(
      discovered([{ manifest, definition: wrongServices }]).problems[0],
    ).toMatch(/services differ/);
    expect(
      discovered([{ manifest, definition: { id: "beacon" } }]).problems[0],
    ).toMatch(/definePlayerPlugin/);
  });

  it("keeps v2 modules out of v1 discovery and v1 types out of v2 state", () => {
    const manifest = manifestV2(
      "countdown_bar",
      {},
      [],
      [{ type: "countdown_bar", version: 1 }],
    );
    const definition = definePlayerPlugin({
      id: "countdown_bar",
      services: { required: [], optional: [] },
      activate: () => ({}),
    });
    const manifests = {
      [path("countdown_bar", "tilecast.plugin.json")]: manifest,
    };
    const modules: RuntimeModules = {
      [path("countdown_bar", "runtime/index.ts")]: { default: definition },
    };
    expect(discoverRuntimePlugins(manifests, modules)).toEqual({
      plugins: [],
      problems: [],
    });
    expect(
      discoverPlayerPlugins(manifests, modules, ["countdown_bar"]).problems[0],
    ).toMatch(/also owned by a Plugin API 1 plugin/);
  });
});

describe("Player Plugin Host", () => {
  // Case: a Player plugin with no visual surface.
  it("hosts a plugin that draws nothing, driven by events and its clock", () => {
    const calls: string[] = [];
    let seen: readonly PlayerStateEntry[] = [];
    let mediaUrl: string | null | undefined;
    let undeclaredUrl: string | null | undefined;
    const observations: PresentationObservation[] = [];
    const plugin = definePlayerPlugin({
      id: "ambient_audio",
      services: {
        required: ["player.clock@1", "player.media@1"],
        optional: ["player.presentation.observe@1"],
      },
      activate(context) {
        calls.push("activate");
        const clock = context.services["player.clock@1"];
        const media = context.services["player.media@1"];
        clock.every(1_000, () => calls.push("tick"));
        context.services["player.presentation.observe@1"]?.subscribe((value) =>
          observations.push(value),
        );
        return {
          stateChanged(entries) {
            seen = entries;
            mediaUrl = media.url({ assetId: ASSET, variantId: VARIANT });
            undeclaredUrl = media.url({ assetId: VARIANT, variantId: ASSET });
            calls.push("state");
          },
          awakeChanged: (awake) => calls.push(`awake:${awake}`),
          dispose: () => calls.push("dispose"),
        };
      },
    });
    const p = player([
      {
        manifest: manifestV2("ambient_audio", {
          required: ["player.clock@1", "player.media@1"],
          optional: ["player.presentation.observe@1"],
        }),
        definition: plugin,
      },
    ]);
    p.send([]);
    expect(calls).toEqual([]);
    expect(status(p.host, "ambient_audio")?.status).toBe("inactive");

    p.send([
      stateEntry(
        "ambient_audio",
        "a",
        { track: 1 },
        {
          media: [{ assetId: ASSET, variantId: VARIANT }],
        },
      ),
    ]);
    expect(calls).toEqual(["activate", "state"]);
    expect(seen.map((entry) => entry.state)).toEqual([{ track: 1 }]);
    expect(mediaUrl).toBe(`tcmedia://variant/${ASSET}/${VARIANT}`);
    expect(undeclaredUrl).toBeNull();
    expect(
      p.surfaces.element.querySelector("[data-plugin=ambient_audio]"),
    ).toBeNull();

    p.clock.advance(2_000);
    expect(calls.filter((call) => call === "tick")).toHaveLength(2);

    p.observer.publish({
      mode: "playing",
      item: { id: "video-1", kind: "video", occurrence: 1, audible: true },
    });
    expect(observations.map((value) => value.item?.audible)).toEqual([true]);

    // The same state again is not a change.
    p.send([
      stateEntry(
        "ambient_audio",
        "a",
        { track: 1 },
        {
          media: [{ assetId: ASSET, variantId: VARIANT }],
        },
      ),
    ]);
    expect(calls.filter((call) => call === "state")).toHaveLength(1);

    p.host.setAwake(false);
    expect(calls).toContain("awake:false");

    // No state: the plugin is disposed and its timers end with it.
    p.send([]);
    expect(calls.at(-1)).toBe("dispose");
    const ticks = calls.filter((call) => call === "tick").length;
    p.clock.advance(5_000);
    expect(calls.filter((call) => call === "tick")).toHaveLength(ticks);
    expect(status(p.host, "ambient_audio")?.status).toBe("inactive");
  });

  // Case: the surface service, with push geometry and arbitration shared
  // with unchanged Plugin API v1 plugins.
  it("arbitrates v2 surface contributions with v1 plugins by declared tier", () => {
    let grant = null as PlayerSurfaceGrant | null;
    let container = null as HTMLElement | null;
    let claim: (priority: number | null) => void = () => undefined;
    const notices = definePlayerPlugin({
      id: "service_notices",
      services: { required: ["player.surface@1"], optional: [] },
      activate(context) {
        const surface = context.services["player.surface@1"];
        const ticker = surface.open("ticker", (next) => (grant = next));
        if (!ticker) throw new Error("ticker was not opened");
        container = ticker.container("strip.bottom");
        container.textContent = "Bus 12 is late";
        claim = (priority) =>
          priority === null
            ? ticker.release()
            : ticker.claim([
                {
                  slot: "strip.bottom",
                  priority,
                  heightPx: 64,
                  displayMode: "push",
                },
              ]);
        return {
          stateChanged(entries) {
            const priority = entries[0]?.state["priority"];
            claim(typeof priority === "number" ? priority : null);
          },
        };
      },
    });
    const p = player([
      {
        manifest: manifestV2(
          "service_notices",
          { required: ["player.surface@1"] },
          [{ id: "ticker", slots: ["strip.bottom"], tier: "scheduled" }],
        ),
        definition: notices,
      },
    ]);
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
    const alert: RuntimeManifestEntry = {
      id: "alert-1",
      type: "alert_ticker",
      version: 1,
      config: {
        message: "Severe weather warning.",
        severity: "warning",
        displayMode: "push",
        heightPx: 96,
        speed: "medium",
        priority: 0,
        expiresAt: "2026-09-01T15:30:00.000Z",
      },
    };
    const holder = () => p.surfaces.describe().surfaces["strip.bottom"]?.plugin;

    // Same tier: the v2 claim's higher priority wins and pushes the stage.
    p.send([
      countdown,
      stateEntry("service_notices", "n", { priority: 2_000 }),
    ]);
    expect(holder()).toBe("service_notices/ticker");
    expect(grant?.shown.has("strip.bottom")).toBe(true);
    expect(p.stage.style.getPropertyValue("--tc-stage-bottom")).toBe("64px");
    const element = container;

    // A stronger declared tier wins whatever the v2 priority is.
    p.send([
      countdown,
      alert,
      stateEntry("service_notices", "n", { priority: 999_999 }),
    ]);
    expect(holder()).toBe("emergency_alerts");
    expect(grant?.shown.has("strip.bottom")).toBe(false);
    expect(p.stage.style.getPropertyValue("--tc-stage-bottom")).toBe("96px");

    // Lower priority within the tier: the v1 countdown holds the strip,
    // overlaying rather than pushing. The v2 container stays mounted.
    p.send([countdown, stateEntry("service_notices", "n", { priority: 10 })]);
    expect(holder()).toBe("countdown_bar");
    expect(p.stage.style.getPropertyValue("--tc-stage-bottom")).toBe("0px");
    expect(container).toBe(element);
    expect(element?.isConnected).toBe(true);

    // Removing the v2 state disposes the plugin and removes its containers.
    p.send([countdown]);
    expect(element?.isConnected).toBe(false);
    expect(holder()).toBe("countdown_bar");
  });

  it("refuses a claim for an undeclared slot or a tier the claim tries to set", () => {
    let opened: ReturnType<
      import("@tilecast/plugin-sdk/player").PlayerSurfaceService["open"]
    > = null;
    const plugin = definePlayerPlugin({
      id: "corner_badge",
      services: { required: ["player.surface@1"], optional: [] },
      activate(context) {
        const surface = context.services["player.surface@1"];
        expect(surface.open("undeclared", () => undefined)).toBeNull();
        opened = surface.open("badge", () => undefined);
        opened?.claim([
          { slot: "strip.top", priority: 1, heightPx: 10 },
          { slot: "corner.top-right", priority: 1, tier: "emergency" } as never,
        ]);
        return {};
      },
    });
    const p = player([
      {
        manifest: manifestV2(
          "corner_badge",
          { required: ["player.surface@1"] },
          [{ id: "badge", slots: ["corner.top-right"], tier: "ambient" }],
        ),
        definition: plugin,
      },
    ]);
    p.send([stateEntry("corner_badge", "b", {})]);
    expect(opened).not.toBeNull();
    expect(p.surfaces.describe().surfaces["corner.top-right"]).toBeUndefined();
    expect(p.diagnostics.join("\n")).toMatch(/undeclared slot strip.top/);
    expect(p.diagnostics.join("\n")).toMatch(/names a tier/);
  });

  // Case: required-service rejection.
  it("does not activate a plugin whose required service the Player lacks", () => {
    let activations = 0;
    const plugin = definePlayerPlugin({
      id: "needs_surface",
      services: { required: ["player.surface@1"], optional: [] },
      activate() {
        activations += 1;
        return {};
      },
    });
    const p = player(
      [
        {
          manifest: manifestV2(
            "needs_surface",
            { required: ["player.surface@1"] },
            [{ id: "bar", slots: ["strip.top"], tier: "ambient" }],
          ),
          definition: plugin,
        },
      ],
      { withSurface: false },
    );
    p.send([stateEntry("needs_surface", "s", {})]);
    expect(activations).toBe(0);
    expect(status(p.host, "needs_surface")).toMatchObject({
      status: "unsupported",
      missing: ["player.surface@1"],
    });

    // When the service appears, the plugin activates without new state.
    p.services.provide(
      surfaceService({
        surfaces: p.surfaces,
        reducedMotion: () => true,
        animationScale: 0,
      }),
    );
    expect(activations).toBe(1);
    expect(status(p.host, "needs_surface")?.status).toBe("active");

    // And it is disposed when the service goes away again.
    p.services.withdraw("player.surface");
    expect(status(p.host, "needs_surface")?.status).toBe("unsupported");
  });

  // Case: optional-service graceful degradation.
  it("runs a plugin without an optional service and tells it when one appears", () => {
    const seen: (string | null)[] = [];
    const plugin = definePlayerPlugin({
      id: "observer",
      services: {
        required: ["player.clock@1"],
        optional: ["player.presentation.observe@1"],
      },
      activate(context) {
        const report = () =>
          seen.push(
            context.services["player.presentation.observe@1"]?.current().mode ??
              null,
          );
        report();
        return { servicesChanged: report };
      },
    });
    const p = player(
      [
        {
          manifest: manifestV2("observer", {
            required: ["player.clock@1"],
            optional: ["player.presentation.observe@1"],
          }),
          definition: plugin,
        },
      ],
      { withPresentation: false },
    );
    p.send([stateEntry("observer", "o", {})]);
    expect(seen).toEqual([null]);
    expect(status(p.host, "observer")).toMatchObject({
      status: "active",
      degraded: ["player.presentation.observe@1"],
    });
    p.services.provide(p.observer.provider());
    expect(seen).toEqual([null, "waiting"]);
    expect(status(p.host, "observer")?.degraded).toEqual([]);
  });

  // Case: failure isolation.
  it("disposes only a plugin that throws, wherever it throws", () => {
    const healthy: string[] = [];
    const broken = (where: "activate" | "state" | "timer") =>
      definePlayerPlugin({
        id: `broken_${where}`,
        services: { required: ["player.clock@1"], optional: [] },
        activate(context) {
          if (where === "activate") throw new Error("boom");
          context.services["player.clock@1"].after(10, () => {
            if (where === "timer") throw new Error("boom");
          });
          return {
            stateChanged() {
              if (where === "state") throw new Error("boom");
            },
          };
        },
      });
    const good = definePlayerPlugin({
      id: "good",
      services: { required: ["player.clock@1"], optional: [] },
      activate(context) {
        context.services["player.clock@1"].every(10, () =>
          healthy.push("tick"),
        );
        return { stateChanged: () => healthy.push("state") };
      },
    });
    const clockOnly = { required: ["player.clock@1"] };
    const p = player([
      ...(["activate", "state", "timer"] as const).map((where) => ({
        manifest: manifestV2(`broken_${where}`, clockOnly),
        definition: broken(where),
      })),
      { manifest: manifestV2("good", clockOnly), definition: good },
    ]);
    p.send([
      stateEntry("broken_activate", "1", {}),
      stateEntry("broken_state", "2", {}),
      stateEntry("broken_timer", "3", {}),
      stateEntry("good", "4", {}),
    ]);
    p.clock.advance(30);
    const states = p.host
      .describe()
      .plugins.map((plugin) => [plugin.id, plugin.status]);
    expect(states).toEqual([
      ["broken_activate", "failed"],
      ["broken_state", "failed"],
      ["broken_timer", "failed"],
      ["good", "active"],
    ]);
    expect(healthy.filter((call) => call === "tick")).toHaveLength(3);
    expect(healthy[0]).toBe("state");
    // A failed plugin stays failed; it is not reactivated by new state.
    p.send([
      stateEntry("broken_state", "2", { again: true }),
      stateEntry("good", "4", {}),
    ]);
    expect(status(p.host, "broken_state")?.status).toBe("failed");
  });

  // Case: plugin-only state updates reach only their own plugin.
  it("delivers a state change only to the plugin it belongs to", () => {
    const deliveries: string[] = [];
    const recorder = (id: string) =>
      definePlayerPlugin({
        id,
        services: { required: [], optional: [] },
        activate: () => ({
          stateChanged: (entries) =>
            deliveries.push(`${id}:${JSON.stringify(entries[0]?.state)}`),
        }),
      });
    const p = player([
      { manifest: manifestV2("first", {}), definition: recorder("first") },
      { manifest: manifestV2("second", {}), definition: recorder("second") },
    ]);
    p.send([
      stateEntry("first", "1", { n: 1 }),
      stateEntry("second", "2", { n: 1 }),
    ]);
    p.send([
      stateEntry("first", "1", { n: 2 }),
      stateEntry("second", "2", { n: 1 }),
    ]);
    expect(deliveries).toEqual([
      'first:{"n":1}',
      'second:{"n":1}',
      'first:{"n":2}',
    ]);
  });

  it("drops undeclared, malformed, and expired state on the corrected clock", () => {
    const seen: unknown[][] = [];
    const plugin = definePlayerPlugin({
      id: "notice",
      services: { required: [], optional: [] },
      activate: () => ({
        stateChanged: (entries) => seen.push(entries.map((entry) => entry.id)),
        dispose: () => seen.push(["disposed"]),
      }),
    });
    const p = player([
      { manifest: manifestV2("notice", {}), definition: plugin },
    ]);
    p.send([
      stateEntry("notice", "keep", {}, { validUntil: "2026-09-01T15:00:30Z" }),
      stateEntry("notice", "old", {}, { validUntil: "2026-09-01T14:00:00Z" }),
      stateEntry("notice", "v9", {}, { stateVersion: 9 }),
      stateEntry("notice", "bad", "not an object" as never),
      stateEntry("unknown_plugin", "x", {}),
    ]);
    expect(seen).toEqual([["keep"]]);
    expect(p.diagnostics.join("\n")).toMatch(/state is not an object/);
    p.clock.advance(31_000);
    expect(seen.at(-1)).toEqual(["disposed"]);
  });
});
