import { describe, expect, it } from "vitest";
import {
  componentCapability,
  createWidgetResources,
  defineWidget,
  identityProblem,
  ready,
  resolveTheme,
  TILECAST_DISPLAY_THEME,
  validTimeZone,
  WidgetRegistry,
} from "../src/index.ts";
import {
  discoverSourcedWidgets,
  discoverWidgets,
  pairSourcedEntries,
  pluginIdResolver,
  sourceForWidgetManifestPath,
} from "../src/discovery.ts";
import { MAX_COMPONENT_TYPE_LENGTH } from "../src/identity.ts";
import {
  compileComponentConfig,
  configLimitProblem,
  widgetManifestSchema,
} from "../src/manifest.ts";

const element = class extends HTMLElement {} as never;

const definition = (type: string, tagName: string, version = 1) =>
  defineWidget({
    type,
    version,
    tagName,
    parseConfig: () => ({ ok: true, config: {} }),
    resolveData: () => ready({}),
    element,
  });

const manifest = (type: string, tagName: string, version = 1) => ({
  id: type.split(".").pop()!,
  apiVersion: 1 as const,
  version: 1,
  name: "Probe",
  description: "Probe.",
  category: "Essentials",
  icon: "clock",
  runtime: "native" as const,
  configurationSchema: { fields: [] },
  defaultConfiguration: {},
  presentationSchemaVersion: 1 as const,
  requiredCapabilities: { "content.text": 1 },
  emptyStateBehavior: "text",
  legacyEditor: true,
  deprecation: {},
  component: {
    type,
    version,
    tagName,
    entrypoint: "./runtime/index.ts" as const,
    configTemplate: {},
    empty: "render" as const,
  },
  compatibility: { fallback: "legacy" as const },
});

describe("identity", () => {
  it("accepts namespaced types and tilecast tags", () => {
    expect(
      identityProblem({
        type: "tilecast.clock",
        version: 1,
        tagName: "tc-widget-clock",
      }),
    ).toBeNull();
    expect(componentCapability("tilecast.clock")).toBe("widget.tilecast.clock");

    const boundaryType = `${"a".repeat(25)}.${"b".repeat(47)}`;
    expect(componentCapability(boundaryType)).toHaveLength(80);
    expect(
      identityProblem({
        type: boundaryType,
        version: 1,
        tagName: "acme-boundary",
      }),
    ).toBeNull();
    expect(
      identityProblem({
        type: "gbyo.athletics.scoreboard",
        version: 1,
        tagName: "acme-scoreboard",
      }),
    ).toBeNull();
  });

  it.each([
    [{ type: "clock", version: 1, tagName: "tc-widget-clock" }],
    [{ type: "Tilecast.Clock", version: 1, tagName: "tc-widget-clock" }],
    [{ type: "tilecast.clock", version: 0, tagName: "tc-widget-clock" }],
    [{ type: "tilecast.clock", version: 1.5, tagName: "tc-widget-clock" }],
    [{ type: "tilecast.clock", version: 101, tagName: "tc-widget-clock" }],
    [{ type: "tilecast.clock", version: 1, tagName: "clock" }],
    [{ type: "tilecast.clock", version: 1, tagName: "tc-widget-weather" }],
    [
      {
        type: `${"a".repeat(25)}.${"b".repeat(48)}`,
        version: 1,
        tagName: "acme-x",
      },
    ],
  ])("rejects %j", (identity) => {
    expect(identityProblem(identity)).not.toBeNull();
  });
});

describe("registry", () => {
  it("reports sorted capabilities and refuses duplicate tags", () => {
    const registry = new WidgetRegistry([
      definition("tilecast.weather", "tc-widget-weather", 2),
      definition("tilecast.clock", "tc-widget-clock"),
    ]);
    expect(registry.capabilities()).toEqual({
      "widget.tilecast.clock": 1,
      "widget.tilecast.weather": 2,
    });
    expect(() =>
      registry.register(definition("acme.clock", "tc-widget-clock")),
    ).toThrow(/reuses tag/);
  });
});

describe("discovery", () => {
  it("pairs manifests and modules and reports every mismatch", () => {
    const result = discoverWidgets(
      {
        "../../widgets/clock/tilecast.widget.json": manifest(
          "tilecast.clock",
          "tc-widget-clock",
        ),
        "../../widgets/weather/tilecast.widget.json": manifest(
          "tilecast.weather",
          "tc-widget-weather",
          2,
        ),
        "../../widgets/lonely/tilecast.widget.json": manifest(
          "tilecast.lonely",
          "tc-widget-lonely",
        ),
      },
      {
        "../../widgets/clock/runtime/index.ts": {
          default: definition("tilecast.clock", "tc-widget-clock"),
        },
        "../../widgets/weather/runtime/index.ts": {
          default: definition("tilecast.weather", "tc-widget-weather", 1),
        },
        "../../widgets/orphan/runtime/index.ts": {
          default: definition("tilecast.orphan", "tc-widget-orphan"),
        },
      },
    );
    expect(result.widgets.map((widget) => widget.dir)).toEqual([
      "widgets/clock",
    ]);
    expect(result.widgets[0]!.source).toEqual({ kind: "core" });
    expect(result.problems).toEqual([
      "widgets/lonely: declares ./runtime/index.ts but it does not exist",
      "widgets/orphan: has runtime/index.ts but no tilecast.widget.json",
      "widgets/weather: definition does not match its manifest: version 1 ≠ 2",
    ]);
    expect(result.registry.capabilities()).toEqual({
      "widget.tilecast.clock": 1,
    });
  });

  it("reports duplicate types and tags across directories", () => {
    const result = discoverWidgets(
      {
        "/widgets/a/tilecast.widget.json": manifest(
          "tilecast.a",
          "tc-widget-a",
        ),
        "/widgets/b/tilecast.widget.json": {
          ...manifest("tilecast.a", "tc-widget-a"),
          id: "b",
        },
      },
      {
        "/widgets/a/runtime/index.ts": {
          default: definition("tilecast.a", "tc-widget-a"),
        },
        "/widgets/b/runtime/index.ts": {
          default: definition("tilecast.a", "tc-widget-a"),
        },
      },
    );
    expect(result.problems).toEqual([
      "widgets/b: type tilecast.a is also declared by widgets/a",
    ]);
  });

  it("pairs glob records into sourced entries", () => {
    const clockManifest = manifest("tilecast.clock", "tc-widget-clock");
    const clockModule = {
      default: definition("tilecast.clock", "tc-widget-clock"),
    };
    const entries = pairSourcedEntries(
      {
        "../../widgets/clock/tilecast.widget.json": clockManifest,
        "../../plugins/athletics/widgets/scoreboard/tilecast.widget.json": {
          ...manifest("athletics.scoreboard", "acme-scoreboard"),
          id: "scoreboard",
        },
      },
      {
        "../../widgets/clock/runtime/index.ts": clockModule,
        "../../plugins/athletics/widgets/scoreboard/runtime/index.ts": {
          default: definition("athletics.scoreboard", "acme-scoreboard"),
        },
        "../../widgets/orphan/runtime/index.ts": {
          default: definition("tilecast.orphan", "tc-widget-orphan"),
        },
      },
    );
    expect(
      entries.map((entry) => [
        entry.manifestPath,
        entry.modulePath,
        entry.source,
      ]),
    ).toEqual([
      [
        "../../widgets/clock/tilecast.widget.json",
        "../../widgets/clock/runtime/index.ts",
        { kind: "core" },
      ],
      [
        "../../plugins/athletics/widgets/scoreboard/tilecast.widget.json",
        "../../plugins/athletics/widgets/scoreboard/runtime/index.ts",
        { kind: "plugin", pluginId: "athletics" },
      ],
      [
        "../../widgets/orphan/tilecast.widget.json",
        "../../widgets/orphan/runtime/index.ts",
        { kind: "core" },
      ],
    ]);
    const discovery = discoverSourcedWidgets(entries);
    expect(discovery.widgets.map((widget) => widget.dir)).toEqual([
      "widgets/clock",
      "plugins/athletics/widgets/scoreboard",
    ]);
    expect(discovery.problems).toEqual([
      "widgets/orphan: has runtime/index.ts but no tilecast.widget.json",
    ]);
  });

  it("resolves plugin identity from tilecast.plugin.json, not the directory", () => {
    // plugins/emergency-alerts/ is owned by plugin emergency_alerts: the
    // directory basename must never become the semantic plugin id.
    const resolve = pluginIdResolver({
      "../../plugins/emergency-alerts/tilecast.plugin.json": {
        id: "emergency_alerts",
      },
      "../../plugins/athletics/tilecast.plugin.json": { id: "athletics" },
    });
    expect(resolve("emergency-alerts")).toBe("emergency_alerts");
    expect(resolve("athletics")).toBe("athletics");
    expect(resolve("unknown")).toBeNull();
    expect(
      sourceForWidgetManifestPath(
        "../../plugins/emergency-alerts/widgets/siren/tilecast.widget.json",
        resolve,
      ),
    ).toEqual({ kind: "plugin", pluginId: "emergency_alerts" });

    const entries = pairSourcedEntries(
      {
        "../../plugins/emergency-alerts/widgets/siren/tilecast.widget.json": {
          ...manifest("emergencyalerts.siren", "acme-siren"),
          id: "emergency_alerts_siren",
        },
      },
      {
        "../../plugins/emergency-alerts/widgets/siren/runtime/index.ts": {
          default: definition("emergencyalerts.siren", "acme-siren"),
        },
      },
      resolve,
    );
    expect(entries.map((entry) => entry.source)).toEqual([
      { kind: "plugin", pluginId: "emergency_alerts" },
    ]);
    const discovery = discoverSourcedWidgets(entries);
    expect(discovery.problems).toEqual([]);
    expect(discovery.widgets.map((widget) => widget.dir)).toEqual([
      "plugins/emergency-alerts/widgets/siren",
    ]);
    expect(discovery.widgets[0]!.source).toEqual({
      kind: "plugin",
      pluginId: "emergency_alerts",
    });
  });

  it("fails closed when a plugin directory has no manifest identity", () => {
    const entries = pairSourcedEntries(
      {
        "../../plugins/mystery/widgets/siren/tilecast.widget.json": {
          ...manifest("mystery.siren", "acme-siren"),
          id: "mystery_siren",
        },
      },
      {
        "../../plugins/mystery/widgets/siren/runtime/index.ts": {
          default: definition("mystery.siren", "acme-siren"),
        },
      },
      pluginIdResolver({}),
    );
    expect(entries.map((entry) => entry.source)).toEqual([
      { kind: "plugin", pluginId: "" },
    ]);
    const discovery = discoverSourcedWidgets(entries);
    expect(discovery.widgets).toEqual([]);
    expect(discovery.problems).toEqual([
      "plugins/mystery/widgets/siren: plugin directory has no readable tilecast.plugin.json identity",
    ]);
  });

  it("derives the directory basename only without a resolver", () => {
    // Legacy behavior for unit tests: real hosts always pass a resolver.
    expect(
      sourceForWidgetManifestPath(
        "../../plugins/athletics/widgets/scoreboard/tilecast.widget.json",
      ),
    ).toEqual({ kind: "plugin", pluginId: "athletics" });
  });

  it("discovers plugin sources with explicit ownership", () => {
    const pluginManifest = manifest("athletics.scoreboard", "acme-scoreboard");
    const result = discoverSourcedWidgets([
      {
        manifestPath: "widgets/clock/tilecast.widget.json",
        modulePath: "widgets/clock/runtime/index.ts",
        manifest: manifest("tilecast.clock", "tc-widget-clock"),
        module: {
          default: definition("tilecast.clock", "tc-widget-clock"),
        },
        source: { kind: "core" },
      },
      {
        manifestPath:
          "plugins/athletics/widgets/scoreboard/tilecast.widget.json",
        modulePath: "plugins/athletics/widgets/scoreboard/runtime/index.ts",
        manifest: { ...pluginManifest, id: "scoreboard" },
        module: {
          default: definition("athletics.scoreboard", "acme-scoreboard"),
        },
        source: { kind: "plugin", pluginId: "athletics" },
      },
    ]);
    expect(result.problems).toEqual([]);
    expect(result.widgets.map((widget) => widget.dir)).toEqual([
      "widgets/clock",
      "plugins/athletics/widgets/scoreboard",
    ]);
    expect(result.widgets[1]!.source).toEqual({
      kind: "plugin",
      pluginId: "athletics",
    });
  });

  it("reports cross-source collisions and ownership violations", () => {
    const tilecastPlugin = discoverSourcedWidgets([
      {
        manifestPath: "plugins/athletics/widgets/clock/tilecast.widget.json",
        manifest: manifest("tilecast.clock", "tc-widget-clock"),
        module: {
          default: definition("tilecast.clock", "tc-widget-clock"),
        },
        source: { kind: "plugin", pluginId: "athletics" },
      },
    ]);
    expect(tilecastPlugin.problems).toEqual([
      "plugins/athletics/widgets/clock: type tilecast.clock uses the reserved tilecast namespace but comes from a non-core source",
    ]);

    const duplicateId = discoverSourcedWidgets([
      {
        manifestPath: "widgets/a/tilecast.widget.json",
        manifest: manifest("acme.a", "acme-a"),
        module: { default: definition("acme.a", "acme-a") },
        source: { kind: "core" },
      },
      {
        manifestPath: "plugins/athletics/widgets/b/tilecast.widget.json",
        manifest: { ...manifest("acme.b", "acme-b"), id: "a" },
        module: { default: definition("acme.b", "acme-b") },
        source: { kind: "plugin", pluginId: "athletics" },
      },
    ]);
    expect(duplicateId.problems).toEqual([
      "plugins/athletics/widgets/b: provider identity a is also declared by widgets/a",
    ]);
    expect(duplicateId.widgets.map((widget) => widget.dir)).toEqual([
      "widgets/a",
    ]);

    const outsidePackage = discoverSourcedWidgets([
      {
        manifestPath: "widgets/scoreboard/tilecast.widget.json",
        manifest: manifest("other.scoreboard", "acme-scoreboard"),
        module: {
          default: definition("other.scoreboard", "acme-scoreboard"),
        },
        source: {
          kind: "package",
          packageId: "district96.athletics",
          packageVersion: "2.1.0",
          digest: "sha256:abc",
        },
      },
    ]);
    expect(outsidePackage.problems).toEqual([
      "widgets/scoreboard: type other.scoreboard is outside package namespace district96.athletics",
    ]);
  });
});

describe("manifest", () => {
  it("validates a manifest and its fallback rule", () => {
    expect(
      widgetManifestSchema.safeParse(
        manifest("tilecast.clock", "tc-widget-clock"),
      ).success,
    ).toBe(true);
    const templateWithout = {
      ...manifest("tilecast.clock", "tc-widget-clock"),
      compatibility: { fallback: "template" },
    };
    expect(widgetManifestSchema.safeParse(templateWithout).success).toBe(false);
    const unknownKey = {
      ...manifest("tilecast.clock", "tc-widget-clock"),
      renderer: "kotlin",
    };
    expect(widgetManifestSchema.safeParse(unknownKey).success).toBe(false);
  });

  it("limits the component type so widget.<type> fits the capability bound", () => {
    const fitting = `a${"b".repeat(31)}.${"c".repeat(40)}`;
    expect(fitting).toHaveLength(MAX_COMPONENT_TYPE_LENGTH);
    expect(
      widgetManifestSchema.safeParse(manifest(fitting, "tc-widget-probe"))
        .success,
    ).toBe(true);
    const overflowing = `${fitting}d`;
    expect(overflowing).toHaveLength(MAX_COMPONENT_TYPE_LENGTH + 1);
    expect(
      widgetManifestSchema.safeParse(manifest(overflowing, "tc-widget-probe"))
        .success,
    ).toBe(false);
  });

  it("compiles configTemplate with defaults and refuses missing keys", () => {
    const template = {
      timeZone: { $config: "timezone", default: "" },
      nested: { showSeconds: { $config: "showSeconds", default: false } },
      fixed: "standard",
    };
    expect(
      compileComponentConfig(template, { timezone: "Europe/Paris" }),
    ).toEqual({
      timeZone: "Europe/Paris",
      nested: { showSeconds: false },
      fixed: "standard",
    });
    expect(() =>
      compileComponentConfig({ a: { $config: "missing" } }, {}),
    ).toThrow(/missing configuration/);
  });

  it("honors a when gate so legacy toggles survive projection", () => {
    const template = {
      instruction: { $config: "body", default: "", when: "showBody" },
    };
    expect(
      compileComponentConfig(template, { body: "Point it.", showBody: true }),
    ).toEqual({ instruction: "Point it." });
    expect(
      compileComponentConfig(template, { body: "Point it.", showBody: false }),
    ).toEqual({ instruction: "" });
    // A persisted record that predates the flag keeps the mapped value.
    expect(compileComponentConfig(template, { body: "Point it." })).toEqual({
      instruction: "Point it.",
    });
  });

  it("resolves chained defaults onto superseded configuration keys", () => {
    const template = {
      payload: {
        $config: "payload",
        default: { $config: "value", default: "" },
      },
    };
    expect(
      compileComponentConfig(template, { value: "https://example.org" }),
    ).toEqual({
      payload: "https://example.org",
    });
    expect(
      compileComponentConfig(template, {
        payload: "https://example.com",
        value: "https://example.org",
      }),
    ).toEqual({ payload: "https://example.com" });
    expect(compileComponentConfig(template, {})).toEqual({ payload: "" });
  });

  it("bounds component configuration size and shape", () => {
    expect(configLimitProblem({ a: "ok" })).toBeNull();
    expect(configLimitProblem({ a: "x".repeat(2_001) })).toMatch(/string/);
    expect(configLimitProblem({ a: "x".repeat(9_000) })).toMatch(/bytes/);
    expect(configLimitProblem({ a: new Array(201).fill(0) })).toMatch(/array/);
    let deep: unknown = 1;
    for (let i = 0; i < 7; i += 1) deep = { deep };
    expect(configLimitProblem(deep)).toMatch(/deeper/);
    const wide = Object.fromEntries(
      Array.from({ length: 65 }, (_, i) => [`k${i}`, i]),
    );
    expect(configLimitProblem(wide)).toMatch(/object/);
  });
});

describe("resources", () => {
  const documents = new Map([
    [
      "granted",
      {
        schemaVersion: 1,
        datasets: [
          { id: "current", kind: "object", attribution: "Open-Meteo" },
        ],
      },
    ],
    [
      "secret",
      { schemaVersion: 1, datasets: [{ id: "all", kind: "records" }] },
    ],
  ]);
  const media = new Map([
    ["a1/v1", "tcmedia://variant/a1/v1"],
    ["a2/v2", "tcmedia://variant/a2/v2"],
  ]);

  it("answers only for what the component declared", () => {
    const resources = createWidgetResources(
      { documents, media },
      { dataSources: ["granted"], media: [{ assetId: "a1", variantId: "v1" }] },
    );
    expect(resources.dataset("granted", "current")?.kind).toBe("object");
    expect(resources.attribution("granted")).toBe("Open-Meteo");
    expect(resources.dataDocument("secret")).toBeNull();
    expect(resources.dataset("secret", "all")).toBeNull();
    expect(resources.media("a1", "v1")).toBe("tcmedia://variant/a1/v1");
    expect(resources.media("a2", "v2")).toBeNull();
    expect(Object.keys(resources).sort()).toEqual([
      "attribution",
      "dataDocument",
      "dataset",
      "media",
    ]);
  });

  it("grants nothing by default", () => {
    const resources = createWidgetResources({ documents, media }, {});
    expect(resources.dataDocument("granted")).toBeNull();
    expect(resources.media("a1", "v1")).toBeNull();
  });

  it("prevents one Widget from mutating a Data Document shared by another", () => {
    const sharedDocument = {
      schemaVersion: 1,
      datasets: [
        {
          id: "current",
          kind: "records",
          records: [
            {
              id: "record-1",
              values: { title: { kind: "text", text: "Original" } },
            },
          ],
        },
      ],
    };
    const sharedDocuments = new Map([["source", sharedDocument]]);
    const grant = { dataSources: ["source"] };
    const mutatingWidget = createWidgetResources(
      { documents: sharedDocuments },
      grant,
    );
    const observingWidget = createWidgetResources(
      { documents: sharedDocuments },
      grant,
    );

    const title = mutatingWidget.dataset("source", "current")?.records?.[0]
      ?.values.title;
    expect(title).toBeDefined();
    expect(Reflect.set(title!, "text", "Changed by another Widget")).toBe(
      false,
    );
    const observedTitle = observingWidget.dataset("source", "current")
      ?.records?.[0]?.values.title;
    const sharedTitle = sharedDocument.datasets[0]?.records?.[0]?.values.title;
    expect(observedTitle?.text).toBe("Original");
    expect(Object.isFrozen(sharedTitle)).toBe(true);
  });
});

describe("theme", () => {
  it("validates colors and derives the scheme from the background", () => {
    expect(resolveTheme({})).toEqual(TILECAST_DISPLAY_THEME);
    const light = resolveTheme({ background: "#FFF", foreground: "#111111" });
    expect(light).toMatchObject({
      scheme: "light",
      background: "#ffffff",
      foreground: "#111111",
      accent: "#1f5fbf",
    });
    const hostile = resolveTheme({
      background: "red; background: url(https://example.com)",
      accent: "var(--x)",
    });
    expect(hostile).toEqual(TILECAST_DISPLAY_THEME);
  });

  it("accepts only real time zones", () => {
    expect(validTimeZone("Europe/London")).toBe("Europe/London");
    expect(validTimeZone("Mars/Olympus")).toBeNull();
    expect(validTimeZone("x".repeat(100))).toBeNull();
  });
});
