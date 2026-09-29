import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { widgetManifestSchema } from "../src/manifest.ts";
import {
  authoringUiProblem,
  pluginWidgetIdentities,
  scaffold,
} from "../tools/widgetctl/main.ts";
import {
  ANDROID_CAPABILITIES,
  androidCapabilities,
  capabilities,
  generate,
  goQuoted,
  pluginWidgetLedger,
  stale,
} from "../tools/widgetctl/generate.ts";
import {
  discover,
  pluginIdForDir,
  repoRoot,
  resolvePlugin,
} from "../tools/widgetctl/repo.ts";

const keys = new Set(["style", "title"]);

describe("authoringUiProblem visibleWhen", () => {
  it("accepts a rule naming a known configuration field", () => {
    expect(
      authoringUiProblem(
        "showDate",
        "toggle",
        {
          section: "appearance",
          visibleWhen: { key: "style", notEquals: "minimal" },
        },
        keys,
      ),
    ).toBeNull();
  });

  it("rejects a rule naming an unknown configuration field", () => {
    expect(
      authoringUiProblem(
        "showDate",
        "toggle",
        {
          section: "appearance",
          visibleWhen: { key: "styel", notEquals: "minimal" },
        },
        keys,
      ),
    ).toBe("field showDate has a visibility rule on unknown field styel");
  });

  it("keeps validating rule shape when no field set is given", () => {
    expect(
      authoringUiProblem("showDate", "toggle", {
        visibleWhen: { key: "anything", equals: 1 },
      }),
    ).toBeNull();
    expect(
      authoringUiProblem("showDate", "toggle", {
        visibleWhen: { key: "style" },
      }),
    ).toBe("field showDate has a visibility rule with nothing to compare");
  });
});

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "widgetctl-"));
}

function writePluginManifest(root: string, dir: string, id: string): void {
  const path = join(root, "plugins", dir);
  mkdirSync(path, { recursive: true });
  writeFileSync(
    join(path, "tilecast.plugin.json"),
    JSON.stringify({ id, name: dir }),
  );
}

describe("plugin directory identity", () => {
  it("resolves the stable manifest id, never the directory basename", () => {
    const root = tempRoot();
    writePluginManifest(root, "emergency-alerts", "emergency_alerts");
    expect(pluginIdForDir(root, "emergency-alerts")).toEqual({
      id: "emergency_alerts",
    });
  });

  it("reports a missing parent manifest instead of guessing", () => {
    const root = tempRoot();
    mkdirSync(join(root, "plugins", "mystery", "widgets"), {
      recursive: true,
    });
    expect(pluginIdForDir(root, "mystery")).toBeNull();
  });

  it("rejects an invalid manifest id", () => {
    const root = tempRoot();
    writePluginManifest(root, "odd", "Odd Name");
    expect(pluginIdForDir(root, "odd")).toEqual({
      problem: "plugins/odd/tilecast.plugin.json names no valid plugin id",
    });
  });

  it("resolves --plugin by manifest id or directory", () => {
    const root = tempRoot();
    writePluginManifest(root, "emergency-alerts", "emergency_alerts");
    expect(resolvePlugin(root, "emergency_alerts")).toEqual({
      dir: "emergency-alerts",
      id: "emergency_alerts",
    });
    expect(resolvePlugin(root, "emergency-alerts")).toEqual({
      dir: "emergency-alerts",
      id: "emergency_alerts",
    });
    expect(resolvePlugin(root, "unknown")).toBeNull();
  });

  it("attributes discovered Widgets to the stable plugin id", () => {
    const root = tempRoot();
    writePluginManifest(root, "emergency-alerts", "emergency_alerts");
    const created = scaffold(root, {
      name: "siren",
      displayName: "Siren",
      plugin: { dir: "emergency-alerts", id: "emergency_alerts" },
    });
    expect(created[0]).toBe(
      "plugins/emergency-alerts/widgets/siren/tilecast.widget.json",
    );
    const repo = discover(root);
    expect(repo.problems).toEqual([]);
    expect(repo.widgets.map((widget) => [widget.dir, widget.source])).toEqual([
      [
        "plugins/emergency-alerts/widgets/siren",
        { kind: "plugin", pluginId: "emergency_alerts" },
      ],
    ]);
  });

  it("flags Widgets whose parent plugin manifest is missing", () => {
    const root = tempRoot();
    const path = join(root, "plugins", "mystery", "widgets", "siren");
    mkdirSync(join(path, "fixtures"), { recursive: true });
    writeFileSync(
      join(path, "tilecast.widget.json"),
      JSON.stringify({
        apiVersion: 1,
        id: "mystery_siren",
        version: 1,
        name: "Siren",
        description: "Siren.",
        category: "Essentials",
        icon: "layout",
        runtime: "native",
        configurationSchema: { fields: [] },
        defaultConfiguration: {},
        presentationSchemaVersion: 1,
        requiredCapabilities: {},
        emptyStateBehavior: "text",
        deprecation: {},
        component: {
          type: "mystery.siren",
          version: 1,
          tagName: "tc-widget-mystery-siren",
          entrypoint: "./runtime/index.ts",
          configTemplate: {},
          empty: "render",
        },
        compatibility: { fallback: "none" },
      }),
    );
    const repo = discover(root);
    expect(
      repo.problems.some((problem) =>
        problem.message.includes("has no tilecast.plugin.json"),
      ),
    ).toBe(true);
    expect(repo.widgets).toEqual([]);
  });
});

describe("plugin Widget scaffold", () => {
  it("derives qualified identities in the plugin's own lane", () => {
    expect(
      pluginWidgetIdentities(
        { dir: "emergency-alerts", id: "emergency_alerts" },
        "siren",
      ),
    ).toEqual({
      id: "emergency_alerts_siren",
      type: "emergencyalerts.siren",
      tagName: "tc-widget-emergencyalerts-siren",
    });
  });

  it("writes an ordinary Widget below the plugin's actual directory", () => {
    const root = tempRoot();
    writePluginManifest(root, "countdown-bar", "countdown_bar");
    const created = scaffold(root, {
      name: "race",
      displayName: "Race",
      plugin: { dir: "countdown-bar", id: "countdown_bar" },
    });
    expect(created).toContain(
      "plugins/countdown-bar/widgets/race/tilecast.widget.json",
    );
    expect(created).toContain(
      "plugins/countdown-bar/widgets/race/runtime/index.ts",
    );
    const manifest = widgetManifestSchema.parse(
      JSON.parse(
        readFileSync(
          join(root, "plugins/countdown-bar/widgets/race/tilecast.widget.json"),
          "utf8",
        ),
      ),
    );
    expect(manifest.id).toBe("countdown_bar_race");
    expect(manifest.component.type).toBe("countdownbar.race");
    expect(manifest.component.tagName).toBe("tc-widget-countdownbar-race");
  });

  it("refuses a Widget whose derived identity another plugin already uses", () => {
    const root = tempRoot();
    writePluginManifest(root, "ab-c", "ab_c");
    writePluginManifest(root, "a-bc", "a_bc");
    scaffold(root, {
      name: "x",
      displayName: "X",
      plugin: { dir: "ab-c", id: "ab_c" },
    });
    expect(() =>
      scaffold(root, {
        name: "x",
        displayName: "X",
        plugin: { dir: "a-bc", id: "a_bc" },
      }),
    ).toThrow(/would reuse .*plugins\/ab-c\/widgets\/x.*abc\.x/);
    expect(existsSync(join(root, "plugins/a-bc/widgets/x"))).toBe(false);
  });

  it("refuses an overlong derived provider id", () => {
    const root = tempRoot();
    const longId = "very_long_plugin_identifier_for_overflow_testing_123456";
    expect(longId.length).toBeGreaterThan(50);
    expect(() =>
      scaffold(root, {
        name: "twenty-five-char-widget00",
        displayName: "Long",
        plugin: { dir: "long-plugin", id: longId },
      }),
    ).toThrow(/too long or invalid/);
  });
});

describe("plugin Widget ledger", () => {
  it("quotes manifest bytes as a Go string literal", () => {
    expect(goQuoted('a"b\\c\nd')).toBe('"a\\"b\\\\c\\nd"');
  });

  it("emits an empty table when no plugin owns a Widget", () => {
    const ledger = pluginWidgetLedger([]);
    expect(ledger).toContain(
      "var pluginWidgetManifests = []PluginWidgetManifest{}",
    );
    expect(ledger).toContain("func PluginWidgetManifests()");
  });

  it("orders entries by directory with stable identities", () => {
    const ledger = pluginWidgetLedger([
      { dir: "plugins/b/widgets/y", pluginId: "b", json: '{"id":"y"}' },
      {
        dir: "plugins/emergency-alerts/widgets/siren",
        pluginId: "emergency_alerts",
        json: '{"id":"emergency_alerts_siren"}',
      },
    ]);
    const first = ledger.indexOf("plugins/b/widgets/y");
    const second = ledger.indexOf("plugins/emergency-alerts/widgets/siren");
    expect(first).toBeGreaterThan(-1);
    expect(second).toBeGreaterThan(first);
    expect(ledger).toContain('{PluginID: "emergency_alerts"');
  });
});

describe("Android Widget capabilities", () => {
  it("generates the Android artifact from the same discovered manifests", async () => {
    const repo = discover(repoRoot());
    expect(repo.problems).toEqual([]);
    const names = capabilities(repo).map(([name]) => name);
    expect(names.length).toBeGreaterThan(0);
    expect([...names].sort()).toEqual(names);
    const files = await generate(repo);
    expect(files.has(ANDROID_CAPABILITIES)).toBe(true);
    const android = files.get(ANDROID_CAPABILITIES) ?? "";
    expect(android).toContain("package org.tilecast.player.runtime");
    expect(android).toContain("object WidgetComponentCapabilities");
    expect(android).toContain("COMPONENT_PRESENTATION_SCHEMA_VERSION = 2");
    expect(android).toContain('"widget.tilecast.clock" to 2');
    expect(stale(repo, files)).toEqual([]);
  });

  it("emits one sorted widget capability per Widget", () => {
    const repo = discover(repoRoot());
    const android = androidCapabilities(repo);
    const entries = capabilities(repo).map(
      ([name, version]) => `"${name}" to ${version}`,
    );
    for (const entry of entries) expect(android).toContain(entry);
  });
});
