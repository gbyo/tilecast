// @vitest-environment jsdom
/**
 * Plugin API v2 extension seams in the Shared Runtime: `player.events@1` and
 * `player.presentation.provide@1`. The fixture plugins exist only here. They
 * prove that a future plugin reaches a new capability through a narrow,
 * versioned service, and that failure, lifecycle, and bounds are the host's.
 */
import { describe, expect, it, vi } from "vitest";
import type { PluginManifestInput } from "@tilecast/plugin-sdk/manifest";
import {
  definePlayerPlugin,
  type PlayerPluginInstance,
  type PresentationProviderSession,
} from "@tilecast/plugin-sdk/player";
import { ManualClock } from "../clock/scheduler";
import type { PluginEventMessageV1 } from "../host/contract";
import {
  type PlayerEvents,
  parseEventMessage,
  validEventPayload,
} from "./events";
import { PlayerPluginHost } from "./player-host";
import { PlayerPlugins } from "./player-plugins";
import { discoverPlayerPlugins } from "./player-discovery";
import {
  type PresentationProviders,
  type ProviderHooks,
} from "./presentation-providers";
import { PlayerServiceRegistry } from "./services";
import type { RuntimeModules } from "./discovery";

const WALL = Date.parse("2026-10-15T12:00:00Z");

const fixtureText = import.meta.glob<string>(
  "../../../player-contracts/fixtures/plugin-events.json",
  { query: "?raw", import: "default", eager: true },
);
const fixture = JSON.parse(Object.values(fixtureText)[0]!);

/** The shared Runtime seam sources, read as text for the identity scan. */
const seamSources = import.meta.glob<string>(
  [
    "./events.ts",
    "./presentation-providers.ts",
    "./services.ts",
    "./player-host.ts",
    "./player-plugins.ts",
    "./service-providers.ts",
  ],
  { query: "?raw", import: "default", eager: true },
);

interface FixtureManifest {
  id: string;
  required?: string[];
  optional?: string[];
  events?: { name: string; version: number; source: "native" | "runtime" }[];
  providers?: string[];
}

function manifestOf(options: FixtureManifest): PluginManifestInput {
  return {
    apiVersion: 2,
    id: options.id,
    definitionVersion: 1,
    name: options.id,
    description: "Fixture.",
    category: "Hardware",
    icon: "puzzle",
    maintainers: ["@gbyo"],
    instanceNoun: { singular: "item", plural: "items" },
    server: { entrypoint: "./plugin.go" },
    player: {
      state: [{ type: options.id, version: 1 }],
      runtime: {
        entrypoint: "./runtime/index.ts",
        services: {
          required: options.required ?? [],
          optional: options.optional ?? [],
        },
        surfaces: [],
        providers: (options.providers ?? []).map((id) => ({ id })),
      },
      native: options.events?.length ? [{ id: "input", services: {} }] : [],
      events: options.events ?? [],
    },
  } as PluginManifestInput;
}

function state(plugin: string, value: Record<string, unknown> = {}) {
  return {
    id: `${plugin}-1`,
    type: "plugin_state",
    version: 1,
    plugin,
    definitionVersion: 1,
    stateType: plugin,
    stateVersion: 1,
    state: value,
    media: [],
  };
}

interface Harness {
  clock: ManualClock;
  host: PlayerPluginHost;
  events: PlayerEvents | null;
  providers: PresentationProviders;
  sent: PluginEventMessageV1[];
  diagnostics: string[];
  refuse: { value: boolean };
  send(entries: unknown[]): void;
  status(id: string): string | undefined;
}

function harness(
  plugins: { manifest: FixtureManifest; definition: unknown }[],
  options: { withEvents?: boolean } = {},
): Harness {
  const clock = new ManualClock({ wallMs: WALL });
  const diagnostics: string[] = [];
  const sent: PluginEventMessageV1[] = [];
  const refuse = { value: false };
  const diagnostic = (id: string, message: string) =>
    diagnostics.push(`${id}: ${message}`);
  const manifests: Record<string, PluginManifestInput> = {};
  const modules: RuntimeModules = {};
  for (const { manifest, definition } of plugins) {
    const dir = manifest.id.replaceAll("_", "-");
    manifests[`../../../../plugins/${dir}/tilecast.plugin.json`] =
      manifestOf(manifest);
    modules[`../../../../plugins/${dir}/runtime/index.ts`] = {
      default: definition as never,
    };
  }
  const discovery = discoverPlayerPlugins(manifests, modules);
  expect(discovery.problems).toEqual([]);
  const composition = new PlayerPlugins({
    clock,
    runtimePlugins: [],
    playerPlugins: discovery.plugins,
    pluginState: true,
    pluginEvents:
      options.withEvents === false
        ? undefined
        : (message) => {
            if (refuse.value) return false;
            sent.push(message);
            return true;
          },
    animationScale: 0,
    reducedMotion: () => true,
    mediaUrl: () => "",
    stage: () => null,
    diagnostic,
  });
  const { host, events, providers } = composition;
  return {
    clock,
    host,
    events,
    providers,
    sent,
    diagnostics,
    refuse,
    send: (entries) => {
      composition.receive({ plugins: entries as never, clockOffsetMs: 0 });
      clock.flush();
    },
    status: (id) =>
      host.describe().plugins.find((plugin) => plugin.id === id)?.status,
  };
}

const message = (
  plugin: string,
  event: string,
  version = 1,
  payload: Record<string, unknown> = {},
) => ({ type: "plugin-event", plugin, event, version, payload });

const INPUT_EVENTS = [
  { name: "button_pressed", version: 1, source: "native" as const },
  { name: "ring_chime", version: 1, source: "runtime" as const },
];

describe("player.events@1", () => {
  it("replays the shared event fixture and its bounds", () => {
    expect(fixture.messageType).toBe("plugin-event");
    for (const valid of fixture.valid) {
      expect(parseEventMessage(valid.message), valid.name).toEqual(
        valid.message,
      );
    }
    for (const invalid of fixture.invalid) {
      expect(parseEventMessage(invalid.message), invalid.name).toBeNull();
    }
    const { maxPayloadBytes, maxPayloadDepth, maxPayloadValues } =
      fixture.limits;
    expect(validEventPayload({ text: "x".repeat(maxPayloadBytes) })).toBe(
      false,
    );
    let deep: unknown = 1;
    for (let level = 0; level <= maxPayloadDepth; level += 1)
      deep = { n: deep };
    expect(validEventPayload(deep)).toBe(false);
    const wide = Object.fromEntries(
      Array.from({ length: maxPayloadValues + 1 }, (_, index) => [
        `k${index}`,
        index,
      ]),
    );
    expect(validEventPayload(wide)).toBe(false);
    for (const payload of [[], 1, "text", null, undefined, { f: () => 1 }]) {
      expect(validEventPayload(payload)).toBe(false);
    }
    expect(validEventPayload({ n: Number.NaN })).toBe(false);
    expect(validEventPayload({})).toBe(true);
  });

  function inputPlugin(
    log: string[],
    overrides: Partial<PlayerPluginInstance> = {},
  ) {
    return definePlayerPlugin({
      id: "input_events",
      services: { required: ["player.events@1"], optional: [] },
      activate: ({ services }) => {
        const unsubscribe = services["player.events@1"].on(
          "button_pressed",
          1,
          (payload) => log.push(`pressed ${JSON.stringify(payload)}`),
        );
        log.push(`subscribed ${unsubscribe !== null}`);
        // The Shared Runtime part answers with a runtime-sourced event.
        const emit = services["player.events@1"].emit;
        return {
          stateChanged: () => log.push("state"),
          describe: () => String(emit("ring_chime", 1, { times: 2 })),
          ...overrides,
        };
      },
    });
  }

  it("delivers a native event to the plugin's portable behavior", () => {
    const log: string[] = [];
    const h = harness([
      {
        manifest: {
          id: "input_events",
          required: ["player.events@1"],
          events: INPUT_EVENTS,
        },
        definition: inputPlugin(log),
      },
    ]);
    h.send([state("input_events")]);
    expect(h.status("input_events")).toBe("active");
    expect(
      h.events!.receive(
        message("input_events", "button_pressed", 1, { pin: 4 }),
      ),
    ).toBe(true);
    expect(log).toEqual(["subscribed true", "state", 'pressed {"pin":4}']);
    // An event never replaces state: the state hook did not run again.
    expect(log.filter((line) => line === "state")).toHaveLength(1);

    // Another plugin's event, a wrong version, a runtime-sourced name, and
    // malformed input all reach nobody.
    for (const refused of [
      message("someone_else", "button_pressed"),
      message("input_events", "button_pressed", 2),
      message("input_events", "ring_chime"),
      { ...message("input_events", "button_pressed"), target: "other" },
      "button_pressed",
    ]) {
      expect(h.events!.receive(refused)).toBe(false);
    }
    expect(log).toHaveLength(3);
  });

  it("emits only declared runtime events, stamped with the plugin's own identity", () => {
    const log: string[] = [];
    let emit:
      | ((
          name: string,
          version: number,
          payload: Record<string, unknown>,
        ) => boolean)
      | null = null;
    const h = harness([
      {
        manifest: {
          id: "input_events",
          required: ["player.events@1"],
          events: INPUT_EVENTS,
        },
        definition: definePlayerPlugin({
          id: "input_events",
          services: { required: ["player.events@1"], optional: [] },
          activate: ({ services }) => {
            emit = services["player.events@1"].emit;
          },
        }),
      },
    ]);
    h.send([state("input_events")]);
    expect(emit!("ring_chime", 1, { times: 2 })).toBe(true);
    expect(h.sent).toEqual([
      message("input_events", "ring_chime", 1, { times: 2 }),
    ]);
    expect(emit!("ring_chime", 2, {})).toBe(false); // undeclared version
    expect(emit!("button_pressed", 1, {})).toBe(false); // native-sourced
    expect(emit!("ring_chime", 1, [] as never)).toBe(false); // not an object
    expect(emit!("ring_chime", 1, { text: "x".repeat(4096) })).toBe(false); // too large
    expect(h.sent).toHaveLength(1);
    h.refuse.value = true; // the host's queue is full
    expect(emit!("ring_chime", 1, {})).toBe(false);
    expect(log).toEqual([]);
  });

  it("ends with the plugin: a disposed plugin can neither emit nor receive", () => {
    const log: string[] = [];
    let service: {
      emit: (n: string, v: number, p: Record<string, unknown>) => boolean;
      on: (n: string, v: number, l: () => void) => unknown;
    } | null = null;
    const h = harness([
      {
        manifest: {
          id: "input_events",
          required: ["player.events@1"],
          events: INPUT_EVENTS,
        },
        definition: definePlayerPlugin({
          id: "input_events",
          services: { required: ["player.events@1"], optional: [] },
          activate: ({ services }) => {
            service = services["player.events@1"];
            service.on("button_pressed", 1, () => log.push("pressed"));
          },
        }),
      },
    ]);
    h.send([state("input_events")]);
    expect(h.events!.receive(message("input_events", "button_pressed"))).toBe(
      true,
    );
    h.send([]); // no state: the plugin is disposed
    expect(h.status("input_events")).toBe("inactive");
    expect(h.events!.receive(message("input_events", "button_pressed"))).toBe(
      false,
    );
    expect(service!.emit("ring_chime", 1, {})).toBe(false);
    expect(service!.on("button_pressed", 1, () => undefined)).toBeNull();
    expect(log).toEqual(["pressed"]);
    expect(h.sent).toEqual([]);
  });

  it("isolates a throwing listener to its own plugin", () => {
    const healthy: string[] = [];
    const h = harness([
      {
        manifest: {
          id: "input_events",
          required: ["player.events@1"],
          events: INPUT_EVENTS,
        },
        definition: definePlayerPlugin({
          id: "input_events",
          services: { required: ["player.events@1"], optional: [] },
          activate: ({ services }) => {
            services["player.events@1"].on("button_pressed", 1, () => {
              throw new Error("listener bug");
            });
          },
        }),
      },
      {
        manifest: {
          id: "second_input",
          required: ["player.events@1"],
          events: [{ name: "button_pressed", version: 1, source: "native" }],
        },
        definition: definePlayerPlugin({
          id: "second_input",
          services: { required: ["player.events@1"], optional: [] },
          activate: ({ services }) => {
            services["player.events@1"].on("button_pressed", 1, () =>
              healthy.push("ok"),
            );
          },
        }),
      },
    ]);
    h.send([state("input_events"), state("second_input")]);
    h.events!.receive(message("input_events", "button_pressed"));
    h.events!.receive(message("second_input", "button_pressed"));
    expect(h.status("input_events")).toBe("failed");
    expect(h.status("second_input")).toBe("active");
    expect(healthy).toEqual(["ok"]);
    expect(h.diagnostics.join("\n")).toMatch(
      /input_events: callback failed: listener bug/,
    );
    // The failed plugin no longer receives events.
    expect(h.events!.receive(message("input_events", "button_pressed"))).toBe(
      false,
    );
  });

  it("negotiates like any service: required makes the plugin unsupported, optional makes it null", () => {
    const required = harness(
      [
        {
          manifest: {
            id: "input_events",
            required: ["player.events@1"],
            events: INPUT_EVENTS,
          },
          definition: inputPlugin([]),
        },
      ],
      { withEvents: false },
    );
    required.send([state("input_events")]);
    expect(required.events).toBeNull();
    expect(required.status("input_events")).toBe("unsupported");
    expect(required.host.describe().plugins[0]?.missing).toEqual([
      "player.events@1",
    ]);

    let seen: unknown = "unset";
    const optional = harness(
      [
        {
          manifest: {
            id: "soft_input",
            optional: ["player.events@1"],
            events: INPUT_EVENTS,
          },
          definition: definePlayerPlugin({
            id: "soft_input",
            services: { required: [], optional: ["player.events@1"] },
            activate: ({ services }) => {
              seen = services["player.events@1"];
            },
          }),
        },
      ],
      { withEvents: false },
    );
    optional.send([state("soft_input")]);
    expect(optional.events).toBeNull();
    expect(optional.status("soft_input")).toBe("active");
    expect(seen).toBeNull();
  });
});

// ------------------------------------------------------------- providers

function hooks() {
  const log: string[] = [];
  const value: ProviderHooks = {
    owned: (owned) => log.push(`owned ${owned}`),
    presenting: () => log.push("presenting"),
    failed: (reason) => log.push(`failed ${reason}`),
  };
  return { log, value };
}

const external = (provider: string, extra: Record<string, unknown> = {}) =>
  ({
    state: "external-presentation",
    provider,
    sessionId: "s-1",
    ...extra,
  }) as never;

/** A fixture provider: a host-owned container, then `presenting()`. */
function providerPlugin(
  seen: { session: PresentationProviderSession | null; log: string[] },
  options: { throwOnStart?: boolean } = {},
) {
  return definePlayerPlugin({
    id: "fixture_provider",
    services: { required: ["player.presentation.provide@1"], optional: [] },
    activate: ({ services }) => {
      services["player.presentation.provide@1"].provide("echo", {
        start(session) {
          seen.log.push("start");
          if (options.throwOnStart) throw new Error("provider bug");
          seen.session = session;
          session.container.textContent = "frame";
          session.presenting();
          return { stop: () => seen.log.push("stop") };
        },
      });
    },
  });
}

const PROVIDER_MANIFEST: FixtureManifest = {
  id: "fixture_provider",
  required: ["player.presentation.provide@1"],
  providers: ["echo"],
};

describe("player.presentation.provide@1", () => {
  it("lets a plugin supply presentation behavior without taking over the Player", async () => {
    const seen = {
      session: null as PresentationProviderSession | null,
      log: [] as string[],
    };
    const h = harness([
      { manifest: PROVIDER_MANIFEST, definition: providerPlugin(seen) },
    ]);
    const mount = document.createElement("div");
    const view = hooks();

    // Nothing is registered until the plugin has state.
    expect(
      h.providers.present(external("fixture_provider/echo"), mount, view.value),
    ).toBe(false);
    h.send([state("fixture_provider")]);
    await Promise.resolve(); // adoption of the waiting presentation
    expect(h.providers.describe()).toEqual({
      registered: ["fixture_provider/echo"],
      active: "fixture_provider/echo",
      presented: true,
    });
    expect(view.log).toEqual(["owned true", "presenting"]);
    expect(seen.session?.container.parentElement).toBe(mount);
    expect(seen.session?.sessionId).toBe("s-1");

    // The same session presented again is kept; evidence is reported again.
    expect(
      h.providers.present(external("fixture_provider/echo"), mount, view.value),
    ).toBe(true);
    expect(seen.log).toEqual(["start"]);
    expect(view.log.at(-1)).toBe("presenting");

    // An unrelated presentation ends the session; the host decides.
    expect(
      h.providers.present({ state: "idle" } as never, mount, view.value),
    ).toBe(false);
    expect(seen.log).toEqual(["start", "stop"]);
    expect(mount.childElementCount).toBe(0);
    expect(h.providers.describe().active).toBeNull();
  });

  it("leaves a presentation that names no registered provider to the host", () => {
    const h = harness([]);
    const mount = document.createElement("div");
    const view = hooks();
    for (const provider of [
      "airplay",
      "fixture_provider/echo",
      "nothing/at-all",
    ]) {
      expect(h.providers.present(external(provider), mount, view.value)).toBe(
        false,
      );
    }
    expect(view.log).toEqual([]);
    expect(mount.childElementCount).toBe(0);
  });

  it("recovers the screen when a provider fails, throws, or disappears", async () => {
    // It reports its own failure.
    const seen = {
      session: null as PresentationProviderSession | null,
      log: [] as string[],
    };
    let h = harness([
      { manifest: PROVIDER_MANIFEST, definition: providerPlugin(seen) },
    ]);
    h.send([state("fixture_provider")]);
    const mount = document.createElement("div");
    let view = hooks();
    expect(
      h.providers.present(external("fixture_provider/echo"), mount, view.value),
    ).toBe(true);
    seen.session!.fail("decoder lost");
    expect(view.log).toEqual([
      "owned true",
      "presenting",
      "owned false",
      "failed decoder lost",
    ]);
    expect(mount.childElementCount).toBe(0);
    expect(seen.log).toEqual(["start", "stop"]);

    // It throws while starting: the plugin fails, and so does the session.
    const thrown = {
      session: null as PresentationProviderSession | null,
      log: [] as string[],
    };
    h = harness([
      {
        manifest: PROVIDER_MANIFEST,
        definition: providerPlugin(thrown, { throwOnStart: true }),
      },
    ]);
    h.send([state("fixture_provider")]);
    view = hooks();
    expect(
      h.providers.present(external("fixture_provider/echo"), mount, view.value),
    ).toBe(false);
    expect(view.log).toEqual([
      "owned true",
      "owned false",
      "failed the provider is no longer available",
    ]);
    expect(h.status("fixture_provider")).toBe("failed");
    expect(h.providers.describe().registered).toEqual([]);

    // Its state ends mid-session: the provider is withdrawn.
    const ended = {
      session: null as PresentationProviderSession | null,
      log: [] as string[],
    };
    h = harness([
      { manifest: PROVIDER_MANIFEST, definition: providerPlugin(ended) },
    ]);
    h.send([state("fixture_provider")]);
    view = hooks();
    h.providers.present(external("fixture_provider/echo"), mount, view.value);
    h.send([]);
    expect(view.log.slice(-2)).toEqual([
      "owned false",
      "failed the provider is no longer available",
    ]);
    expect(ended.log).toEqual(["start", "stop"]);
    await Promise.resolve();
  });

  it("refuses an undeclared provider and keeps providers plugin-scoped", () => {
    const h = harness([
      {
        manifest: PROVIDER_MANIFEST,
        definition: definePlayerPlugin({
          id: "fixture_provider",
          services: {
            required: ["player.presentation.provide@1"],
            optional: [],
          },
          activate: ({ services }) => {
            const provide = services["player.presentation.provide@1"].provide;
            expect(
              provide("undeclared", { start: () => undefined }),
            ).toBeNull();
            expect(provide("echo", { start: () => undefined })).not.toBeNull();
            expect(provide("echo", { start: () => undefined })).toBeNull(); // once
          },
        }),
      },
    ]);
    h.send([state("fixture_provider")]);
    expect(h.providers.describe().registered).toEqual([
      "fixture_provider/echo",
    ]);
    expect(h.diagnostics.join("\n")).toMatch(
      /provider undeclared is not declared/,
    );
  });

  it("passes only bounded scalar parameters to the provider", () => {
    const seen = {
      session: null as PresentationProviderSession | null,
      log: [] as string[],
    };
    const h = harness([
      { manifest: PROVIDER_MANIFEST, definition: providerPlugin(seen) },
    ]);
    h.send([state("fixture_provider")]);
    h.providers.present(
      external("fixture_provider/echo", {
        receiverName: "Lobby",
        connected: false,
        nested: { secret: 1 },
        long: "x".repeat(1000),
      }),
      document.createElement("div"),
      hooks().value,
    );
    expect(seen.session?.parameters).toMatchObject({
      receiverName: "Lobby",
      connected: false,
    });
    expect(seen.session?.parameters).not.toHaveProperty("nested");
    expect(String(seen.session?.parameters["long"]).length).toBe(256);
    expect(seen.session?.parameters).not.toHaveProperty("provider");
  });
});

// -------------------------------------------------- one rule for every seam

describe("no seam decides from a plugin identity or a platform", () => {
  it("keeps plugin ids and platform names out of the shared Runtime seams", () => {
    const sources = Object.values(seamSources);
    expect(sources).toHaveLength(6);
    const plugins = [
      "countdown_bar",
      "emergency_alerts",
      "forms",
      "countdown-bar",
      "emergency-alerts",
    ];
    const platforms = [
      "edge",
      "windows",
      "android",
      "electron",
      "wpe",
      "webview",
      "airplay",
      "rtsp",
    ];
    for (const source of sources) {
      const code = source.toLowerCase();
      for (const name of [...plugins, ...platforms]) {
        // Whole words only: "knowledge" is not "edge".
        expect(new RegExp(`\\b${name}\\b`).test(code), name).toBe(false);
      }
    }
  });

  it("adds a service by registering a provider, with no change to the host", () => {
    // A future service the vocabulary does not know yet: the registry and the
    // host carry it unchanged.
    const hostSpy = vi.fn();
    const registry = new PlayerServiceRegistry([
      {
        name: "player.future-thing",
        version: 2,
        bind: () => ({ api: { read: () => 7 }, dispose: hostSpy }),
      },
    ]);
    expect(registry.available()).toEqual({ "player.future-thing": 2 });
    expect(registry.provider("player.future-thing@1")).not.toBeNull();
    expect(registry.provider("player.future-thing@3")).toBeNull();
  });
});
