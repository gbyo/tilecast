import { describe, expect, it } from "vitest";
import { DATA_TYPE_NAMES, dataTypeProblem } from "../src/datatypes.ts";
import {
  ADAPTER_IDS,
  adapterDeclarativeProblem,
  adapterProblem,
  adapterTakesFetch,
  DECLARATIVE_ADAPTERS,
  fetchSpecProblems,
} from "../src/fetch.ts";
import { setupGuideProblems } from "../src/setup.ts";
import {
  dataSourceManifestSchema,
  dataSourceManifestJSONSchema,
} from "../src/manifest.ts";
import {
  discoverSourcedDataSources,
  pluginIdResolver,
  sourceForDataSourceManifestPath,
} from "../src/discovery.ts";

function validManifest(overrides: Record<string, unknown> = {}) {
  return {
    apiVersion: 1 as const,
    id: "lost_and_found",
    version: 1,
    name: "Lost and Found",
    description: "Recover misplaced belongings.",
    category: "Essentials",
    icon: "layout",
    configurationSchema: { fields: [] },
    defaultConfiguration: {},
    outputSchema: {
      kind: "records" as const,
      fields: [{ key: "title", label: "Title", type: "text" as const }],
    },
    adapterId: "manual_records" as const,
    ...overrides,
  };
}

function validFetch(overrides: Record<string, unknown> = {}) {
  return {
    urlTemplate: "https://example.org/api/items",
    format: "json",
    mapping: { title: "title" },
    maximumRecords: 100,
    refreshSeconds: 3600,
    ...overrides,
  };
}

describe("Tilecast Data Types", () => {
  it("mirrors the output types the Server projector understands", () => {
    expect([...DATA_TYPE_NAMES].sort()).toEqual(
      [
        "text",
        "number",
        "integer",
        "percent",
        "currency",
        "boolean",
        "date",
        "datetime",
        "duration",
        "url",
        "asset",
      ].sort(),
    );
    for (const type of DATA_TYPE_NAMES) {
      expect(dataTypeProblem(type)).toBeNull();
    }
  });

  it("rejects types outside the registry", () => {
    expect(dataTypeProblem("html")).toContain("unknown Tilecast Data Type");
    expect(dataTypeProblem("image")).toContain("unknown Tilecast Data Type");
  });
});

describe("adapter vocabulary", () => {
  it("uses the exact Server adapter registry ids", () => {
    expect([...ADAPTER_IDS].sort()).toEqual(
      [
        "calendar",
        "structured",
        "manual_table",
        "weather",
        "transit",
        "cap_alerts",
        "air_quality",
        "manual_object",
        "manual_records",
        "http_records",
        "form_records",
      ].sort(),
    );
    expect(adapterProblem("http_records")).toBeNull();
    expect(adapterProblem("ftp")).toContain("unknown adapter");
  });

  it("binds only the trusted declarative families", () => {
    expect([...DECLARATIVE_ADAPTERS].sort()).toEqual(
      ["http_records", "manual_object", "manual_records"].sort(),
    );
    for (const adapter of DECLARATIVE_ADAPTERS) {
      expect(adapterDeclarativeProblem(adapter)).toBeNull();
    }
    // Executable providers read adapter-specific configuration shapes or
    // run plugin-owned code, so they have no declarative binding.
    for (const adapter of [
      "weather",
      "calendar",
      "structured",
      "form_records",
    ]) {
      expect(adapterDeclarativeProblem(adapter)).toContain(
        "no declarative binding",
      );
    }
    expect(adapterTakesFetch("http_records")).toBe(true);
    expect(adapterTakesFetch("manual_records")).toBe(false);
    expect(adapterTakesFetch("manual_object")).toBe(false);
  });
});

describe("fetch conformance", () => {
  const outputs = new Set(["title"]);

  it("accepts a bounded release-pinned fetch", () => {
    expect(fetchSpecProblems(validFetch(), [], outputs)).toEqual([]);
  });

  it("rejects unpinned, credentialed, and unbounded declarations", () => {
    expect(
      fetchSpecProblems(
        validFetch({ urlTemplate: "http://example.org/x" }),
        [],
        outputs,
      ),
    ).toContain("fetch url template must be an absolute HTTPS URL");
    expect(
      fetchSpecProblems(
        validFetch({ urlTemplate: "https://user@example.org/x" }),
        [],
        outputs,
      ),
    ).toContain("fetch url template may not carry credentials");
    expect(
      fetchSpecProblems(validFetch({ mapping: {} }), [], outputs),
    ).toContain("fetch specification declares no field mapping");
    expect(
      fetchSpecProblems(validFetch({ mapping: { nope: "name" } }), [], outputs),
    ).toContain('fetch mapping targets undeclared output field "nope"');
    expect(
      fetchSpecProblems(validFetch({ maximumRecords: 501 }), [], outputs),
    ).toContain("fetch maximum record count must be between 0 and 500");
    expect(
      fetchSpecProblems(validFetch({ refreshSeconds: 30 }), [], outputs),
    ).toContain("fetch refresh interval must be at least 60 seconds");
  });

  it("requires placeholders to name bounded author-controlled fields", () => {
    const fetch = validFetch({
      urlTemplate: "https://example.org/items/{area}/{missing}",
    });
    expect(fetchSpecProblems(fetch, [], outputs)).toEqual([
      'fetch url template references unknown configuration "area"',
      'fetch url template references unknown configuration "missing"',
    ]);
    const fields = [
      { key: "area", control: "text", maxLength: 40 },
      { key: "mode", control: "boolean" },
    ];
    expect(
      fetchSpecProblems(
        validFetch({ urlTemplate: "https://example.org/items/{mode}" }),
        fields,
        outputs,
      ),
    ).toEqual([
      'fetch url placeholder "mode" must name a text, select, integer, or number field',
    ]);
    expect(
      fetchSpecProblems(
        validFetch({ urlTemplate: "https://example.org/items/{area}" }),
        [{ key: "area", control: "text" }],
        outputs,
      ),
    ).toEqual([
      'fetch url placeholder "area" must declare a maximum length of 1 to 200',
    ]);
  });
});

describe("authored setup", () => {
  it("accepts flat Studio copy within bounds", () => {
    expect(
      setupGuideProblems({
        eyebrow: "Connect",
        tip: "Paste the public link.",
        steps: ["Open the source.", "Copy the identifier."],
        emptyState: "Nothing configured yet.",
      }),
    ).toEqual([]);
    expect(setupGuideProblems(undefined)).toEqual([]);
  });

  it("rejects overlong copy", () => {
    expect(setupGuideProblems({ steps: [""] })).toEqual([
      "setup step 0 must be 1 to 280 characters",
    ]);
    expect(setupGuideProblems({ eyebrow: "x".repeat(81) })).toEqual([
      "setup eyebrow is longer than 80 characters",
    ]);
  });
});

describe("data source manifests", () => {
  it("accepts minimal manual and http modules", () => {
    expect(dataSourceManifestSchema.safeParse(validManifest()).success).toBe(
      true,
    );
    expect(
      dataSourceManifestSchema.safeParse(
        validManifest({ adapterId: "http_records", fetch: validFetch() }),
      ).success,
    ).toBe(true);
  });

  it("rejects unknown adapters, bad types, executable shapes, and self-declared sources", () => {
    expect(
      dataSourceManifestSchema.safeParse(validManifest({ adapterId: "ftp" }))
        .success,
    ).toBe(false);
    expect(
      dataSourceManifestSchema.safeParse(
        validManifest({
          outputSchema: {
            kind: "records",
            fields: [{ key: "title", label: "Title", type: "html" }],
          },
        }),
      ).success,
    ).toBe(false);
    expect(
      dataSourceManifestSchema.safeParse(
        validManifest({ outputSchema: { kind: "table", fields: [] } }),
      ).success,
    ).toBe(false);
    expect(
      dataSourceManifestSchema.safeParse(
        validManifest({ transform: "return rows;" }),
      ).success,
    ).toBe(false);
    expect(
      dataSourceManifestSchema.safeParse(
        validManifest({ source: { kind: "core" } }),
      ).success,
    ).toBe(false);
  });

  it("emits a portable JSON schema", () => {
    const schema = dataSourceManifestJSONSchema() as Record<string, unknown>;
    expect(schema.type).toBe("object");
  });
});

describe("data source discovery", () => {
  const resolve = pluginIdResolver({
    "../../plugins/emergency-alerts/tilecast.plugin.json": {
      id: "emergency_alerts",
    },
  });

  it("resolves plugin identity from the manifest, not the directory", () => {
    expect(
      sourceForDataSourceManifestPath(
        "../../plugins/emergency-alerts/data-sources/intake/tilecast.datasource.json",
        resolve,
      ),
    ).toEqual({ kind: "plugin", pluginId: "emergency_alerts" });
    expect(
      sourceForDataSourceManifestPath(
        "../../data-sources/lost-and-found/tilecast.datasource.json",
        resolve,
      ),
    ).toEqual({ kind: "core" });
  });

  it("fails closed without a manifest identity", () => {
    const discovery = discoverSourcedDataSources(
      {
        "../../plugins/mystery/data-sources/x/tilecast.datasource.json":
          validManifest({ id: "mystery_x" }),
      },
      pluginIdResolver({}),
    );
    expect(discovery.sources).toEqual([]);
    expect(discovery.problems).toEqual([
      "plugins/mystery/data-sources/x: plugin directory has no readable tilecast.plugin.json identity",
    ]);
  });

  it("pairs core and plugin manifests with explicit sources", () => {
    const discovery = discoverSourcedDataSources(
      {
        "../../data-sources/lost-and-found/tilecast.datasource.json":
          validManifest(),
        "../../plugins/emergency-alerts/data-sources/intake/tilecast.datasource.json":
          validManifest({ id: "emergency_alerts_intake" }),
      },
      resolve,
    );
    expect(discovery.problems).toEqual([]);
    expect(discovery.sources).toEqual([
      { dir: "data-sources/lost-and-found", source: { kind: "core" } },
      {
        dir: "plugins/emergency-alerts/data-sources/intake",
        source: { kind: "plugin", pluginId: "emergency_alerts" },
      },
    ]);
  });
});
