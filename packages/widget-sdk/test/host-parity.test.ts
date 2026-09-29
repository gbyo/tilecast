import { readdirSync, readFileSync } from "node:fs";
import { extname, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { studioWidgetDiscovery } from "../../../apps/dashboard/src/content/studioWidgets.ts";
import { widgetDiscovery as playerWidgetDiscovery } from "../../player-runtime/src/widgets/host.ts";

function discoveryIdentity(discovery: typeof studioWidgetDiscovery): Array<{
  dir: string;
  provider: string | null;
  type: string;
  version: number;
  tagName: string;
  source: (typeof discovery.widgets)[number]["source"];
}> {
  return discovery.widgets
    .map((widget) => ({
      dir: widget.dir,
      provider:
        typeof (widget.manifest as { id?: unknown }).id === "string"
          ? ((widget.manifest as { id: string }).id ?? null)
          : null,
      type: widget.definition.type,
      version: widget.definition.version,
      tagName: widget.definition.tagName,
      source: widget.source,
    }))
    .sort((a, b) => a.dir.localeCompare(b.dir));
}

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (
        (extname(entry.name) === ".ts" || extname(entry.name) === ".tsx") &&
        !entry.name.includes(".test.") &&
        !entry.name.includes(".spec.")
      ) {
        files.push(path);
      }
    }
  };
  visit(root);
  return files;
}

function filesContaining(root: string, text: string): string[] {
  return sourceFiles(root)
    .filter((path) => readFileSync(path, "utf8").includes(text))
    .map((path) => relative(root, path).replaceAll("\\", "/"))
    .sort();
}

describe("Widget host parity", () => {
  it("gives Studio and Player the same trusted Widget modules and diagnostics", () => {
    expect(studioWidgetDiscovery.problems).toEqual([]);
    expect(playerWidgetDiscovery.problems).toEqual(
      studioWidgetDiscovery.problems,
    );
    expect(discoveryIdentity(playerWidgetDiscovery)).toEqual(
      discoveryIdentity(studioWidgetDiscovery),
    );

    const playerByDir = new Map(
      playerWidgetDiscovery.widgets.map((widget) => [widget.dir, widget]),
    );
    for (const studioWidget of studioWidgetDiscovery.widgets) {
      const playerWidget = playerByDir.get(studioWidget.dir);
      expect(playerWidget).toBeDefined();
      // Both hosts must import the exact runtime module. Matching only
      // type/version/tag metadata would still allow two implementations to
      // drift behind the same manifest.
      expect(playerWidget?.definition).toBe(studioWidget.definition);
    }
  });

  it("keeps one production WidgetMount adapter per host", () => {
    // Workspace scripts run this package with packages/widget-sdk as cwd.
    // Avoid import.meta.url here because Vitest rewrites imported modules to
    // its Vite URL scheme rather than a file: URL.
    const dashboardRoot = resolve(process.cwd(), "../../apps/dashboard/src");
    const playerRuntimeRoot = resolve(process.cwd(), "../player-runtime/src");

    expect(filesContaining(dashboardRoot, "new WidgetMount({")).toEqual([
      "content/WidgetPreviewHost.tsx",
    ]);
    expect(filesContaining(playerRuntimeRoot, "new WidgetMount({")).toEqual([
      "widgets/host.ts",
    ]);
  });
});
