// Studio has one Widget editor (docs/widget-authoring.md). These checks
// keep it that way: no per-provider editor, no second save or draft owner,
// and no routing decision based on which Widget type is open.
import { describe, expect, it } from "vitest";
import { describesAuthoring } from "./widgetAuthoring";
import { repositoryCatalog } from "./testing";

const sources = import.meta.glob<string>(
  ["../../../**/*.{ts,tsx}", "!../../../**/*.test.{ts,tsx}"],
  { eager: true, query: "?raw", import: "default" },
);

function production() {
  return Object.entries(sources).filter(
    ([path]) => !path.endsWith("/testing.tsx"),
  );
}

describe("Widget authoring architecture", () => {
  it("has no provider-specific or fallback Widget editors", () => {
    const retired = [
      "V2WidgetEditor",
      "GenericWidgetEditor",
      "WebsiteEditor",
      "YouTubeSourceEditor",
      "EditorHeaderActions",
    ];
    const offenders = production().flatMap(([path, source]) =>
      retired
        .filter((name) => new RegExp(`\\b${name}\\b`).test(source))
        .map((name) => `${path}: ${name}`),
    );
    expect(offenders).toEqual([]);
  });

  it("saves Widgets only through the editor session", () => {
    const writers = production()
      .filter(([, source]) =>
        /\bapi\.(createWidget|updateWidget)\(/.test(source),
      )
      .map(([path]) => path.split("/").at(-1));
    expect(writers).toEqual(["useWidgetEditorSession.ts"]);
  });

  it("routes every Widget type to the one workspace", () => {
    const source = (suffix: string) =>
      Object.entries(sources).find(([path]) => path.endsWith(suffix))?.[1];
    const page = source("/pages/WidgetEditorPage.tsx");
    const route = source("/pages/widgetEditorRoute.ts");
    const host = source("WidgetEditorSessionHost.tsx");
    expect(page).toBeDefined();
    expect(page).toContain("<WidgetEditorSessionHost");
    expect(host).toContain("<WidgetEditorWorkspace");
    // The route never chooses an editor by provider.
    for (const text of [page, route])
      expect(text).not.toMatch(/provider\s*===|definition\.id\s*===/);
    const workspace = Object.entries(sources).filter(([path]) =>
      path.includes("/widget-editor/"),
    );
    for (const [path, source] of workspace)
      expect(source, `${path} compares a provider id`).not.toMatch(
        /(?:provider|definition\.id)\s*===\s*"/,
      );
  });

  it("ships only Widget types that describe themselves to the editor", () => {
    const undescribed = repositoryCatalog()
      .widgets.filter(
        (definition) =>
          definition.availability?.enabled !== false &&
          !describesAuthoring(definition),
      )
      .map((definition) => definition.id);
    expect(undescribed).toEqual([]);
  });
});
