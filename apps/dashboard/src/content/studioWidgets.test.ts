import { describe, expect, it } from "vitest";
import type { ContentDefinitionCatalog, WidgetDefinition } from "../api/types";
import { studioPreviewComponent } from "./studioWidgets";

function catalogWith(
  entry: Partial<WidgetDefinition> & { id: string },
): ContentDefinitionCatalog {
  return {
    revision: "test",
    compilerVersion: "test",
    fingerprint: "test",
    widgets: [entry as WidgetDefinition],
    dataSources: [],
  };
}

const component = {
  type: "acme.scoreboard",
  version: 1,
  tagName: "acme-scoreboard",
  entrypoint: "widgets/scoreboard/runtime/index.js",
  configTemplate: { label: { $config: "label" } },
  dataSourceFields: ["schedule"],
  empty: "render" as const,
};

describe("studioPreviewComponent", () => {
  it("resolves a package-source Widget to a sandbox placement", () => {
    const resolved = studioPreviewComponent(
      catalogWith({
        id: "acme.athletics.scoreboard",
        component,
        source: {
          kind: "package",
          packageId: "acme.athletics",
          packageVersion: "2.4.1",
          digest: "sha256:abc",
        },
      }),
      "acme.athletics.scoreboard",
    );
    expect(resolved?.kind).toBe("sandbox");
    if (resolved?.kind !== "sandbox") return;
    expect(resolved.sandbox.type).toBe("acme.scoreboard");
    expect(resolved.sandbox.version).toBe(1);
    expect(resolved.sandbox.configTemplate).toEqual({
      label: { $config: "label" },
    });
    expect(resolved.sandbox.dataSourceFields).toEqual(["schedule"]);
    expect(resolved.sandbox.frameUrl).toBe(
      "/api/v1/packages/acme.athletics/widgets/scoreboard/frame",
    );
  });

  it("prefers the trusted registry when the release bundles the type", () => {
    const resolved = studioPreviewComponent(
      catalogWith({
        id: "tilecast.clock",
        component: {
          ...component,
          type: "tilecast.clock",
          tagName: "tc-widget-clock",
        },
      }),
      "tilecast.clock",
    );
    expect(resolved?.kind).toBe("trusted");
  });

  it("returns null without a component contract", () => {
    const resolved = studioPreviewComponent(
      catalogWith({
        id: "acme.athletics.scoreboard",
        source: {
          kind: "package",
          packageId: "acme.athletics",
          packageVersion: "2.4.1",
          digest: "sha256:abc",
        },
      }),
      "acme.athletics.scoreboard",
    );
    expect(resolved).toBeNull();
  });

  it("returns null when the package identity does not qualify the catalog ID", () => {
    const catalog = catalogWith({
      id: "acme.athletics.scoreboard",
      component,
      source: {
        kind: "package",
        packageId: "acme.other",
        packageVersion: "2.4.1",
        digest: "sha256:abc",
      },
    });
    expect(
      studioPreviewComponent(catalog, "acme.athletics.scoreboard"),
    ).toBeNull();
  });

  it("returns null for unknown providers and missing catalogs", () => {
    expect(studioPreviewComponent(undefined, "acme.x.y")).toBeNull();
    expect(
      studioPreviewComponent(catalogWith({ id: "acme.x.y" }), "acme.x.y"),
    ).toBeNull();
  });
});
