import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  type AnyWidgetDefinition,
  definitionProblem,
} from "../src/definition.ts";
import { buildSandboxFrameDocument } from "../src/sandboxed-executor.ts";
import { fixtureResources } from "../src/testing.ts";

const here = dirname(fileURLToPath(import.meta.url));
const packageDir = join(
  here,
  "..",
  "..",
  "player-contracts",
  "fixtures",
  "widget-package",
);

function loadFixture(name: string): {
  source: string;
  definition: AnyWidgetDefinition;
} {
  const source = readFileSync(join(packageDir, name), "utf-8");
  const scope = globalThis as unknown as Record<string, unknown>;
  delete scope.__tilecastWidgetDefinition;
  // The fixtures are classic scripts evaluated exactly once, as the
  // frame bootstrap would after verifying the bundle's own checks.
  // eslint-disable-next-line no-eval
  (0, eval)(`${source}\n//# sourceURL=tilecast-fixture/${name}`);
  const definition = scope.__tilecastWidgetDefinition as AnyWidgetDefinition;
  delete scope.__tilecastWidgetDefinition;
  return { source, definition };
}

describe("external-widget conformance fixtures", () => {
  it("the well-behaved bundle validates and assembles", () => {
    const { source, definition } = loadFixture("bundle.js");
    expect(definitionProblem(definition)).toBeNull();
    expect(definition.type).toBe("acme.athletics.scoreboard");
    expect(definition.version).toBe(2);
    const document = buildSandboxFrameDocument(source);
    expect(document).toContain(source);
    expect(document).not.toContain("__TILECAST_SANDBOX_BUNDLE__");
  });

  it("the well-behaved bundle gates ready on every input", () => {
    const { definition } = loadFixture("bundle.js");
    const config = {
      label: "Lobby",
      mediaAssetId: "hero",
      mediaVariantId: "full",
      documentId: "schedule",
    };
    const parsed = definition.parseConfig(config, 2);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(definition.parseConfig({ label: "" }, 2).ok).toBe(false);
    expect(definition.parseConfig({ label: "x" }, 2).ok).toBe(false);
    const full = fixtureResources({
      documents: { schedule: { schemaVersion: 1, datasets: [{ label: "Week 1" }] } },
      media: { "hero/full": "tcmedia://cap/x" },
    });
    const ready = definition.resolveData(parsed.config, full);
    expect(ready).toMatchObject({ state: "ready" });
    const noDocument = definition.resolveData(parsed.config, fixtureResources());
    expect(noDocument).toMatchObject({
      state: "error",
      code: "widget_data_missing",
    });
    const noMedia = definition.resolveData(
      parsed.config,
      fixtureResources({
        documents: {
          schedule: { schemaVersion: 1, datasets: [{ label: "Week 1" }] },
        },
      }),
    );
    expect(noMedia).toMatchObject({
      state: "error",
      code: "widget_media_missing",
    });
  });

  it("the hostile bundle validates and always completes", () => {
    const { source, definition } = loadFixture("hostile.js");
    expect(definitionProblem(definition)).toBeNull();
    expect(definition.type).toBe("acme.evil.probe");
    const parsed = definition.parseConfig(
      { exfil: "https://player.test/api/v1/player/probe-exfil" },
      1,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(definition.parseConfig({}, 1).ok).toBe(false);
    const outcome = definition.resolveData(parsed.config, fixtureResources());
    expect(outcome).toMatchObject({ state: "ready" });
    const document = buildSandboxFrameDocument(source);
    expect(document).toContain("acme-evil-probe");
  });
});
