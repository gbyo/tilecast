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
} from "../src/discovery.ts";
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
      "plugins/athletics/widgets/scoreboard",
      "widgets/clock",
    ]);
    expect(discovery.problems).toEqual([
      "widgets/orphan: has runtime/index.ts but no tilecast.widget.json",
    ]);
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
      "plugins/athletics/widgets/scoreboard",
      "widgets/clock",
    ]);
    expect(result.widgets[0]!.source).toEqual({
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
      "widgets/a: provider identity a is also declared by plugins/athletics/widgets/b",
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
