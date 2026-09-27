/// <reference types="vite/client" />
/**
 * The Widget catalog gate. Every module below widgets/ must agree with its
 * manifest, compile its defaults and fixtures into bounded configuration
 * that its own parser accepts, and settle each fixture in the state the
 * fixture declares. `npm run widgets:check` runs this suite.
 */
import { afterEach, describe, expect, it } from "vitest";
import { discoverWidgets } from "../../src/discovery.ts";
import { renderFixture } from "../../src/fixtures.ts";
import {
  compileComponentConfig,
  configLimitProblem,
  widgetFixtureSchema,
  widgetManifestSchema,
  type WidgetManifestInput,
} from "../../src/manifest.ts";

const manifests = import.meta.glob<WidgetManifestInput>(
  "../../../../widgets/*/tilecast.widget.json",
  { eager: true, import: "default" },
);
const modules = import.meta.glob<{ default?: unknown }>(
  "../../../../widgets/*/runtime/index.ts",
  { eager: true },
);
const fixtures = import.meta.glob<unknown>(
  "../../../../widgets/*/fixtures/*.json",
  { eager: true, import: "default" },
);
const stories = Object.keys(
  import.meta.glob("../../../../widgets/*/runtime/*.stories.ts"),
);

const discovery = discoverWidgets(manifests, modules);
const dirOf = (path: string) => /(widgets\/[^/]+)\//.exec(path)![1]!;

afterEach(() => document.body.replaceChildren());

describe("Widget catalog", () => {
  it("discovers every Widget without a diagnostic", () => {
    expect(discovery.problems).toEqual([]);
    expect(discovery.widgets.length).toBe(Object.keys(manifests).length);
    expect(discovery.widgets.length).toBeGreaterThan(0);
  });

  describe.each(discovery.widgets.map((widget) => [widget.dir, widget]))(
    "widgets/%s",
    (dir, widget) => {
      it("has a valid manifest", () => {
        const parsed = widgetManifestSchema.safeParse(widget.manifest);
        expect(parsed.error?.issues ?? []).toEqual([]);
      });

      it("compiles its catalog defaults into configuration it accepts", () => {
        const config = compileComponentConfig(
          widget.manifest.component.configTemplate,
          widget.manifest.defaultConfiguration ?? {},
        );
        expect(configLimitProblem(config)).toBeNull();
        expect(
          widget.definition.parseConfig(config, widget.definition.version),
        ).toMatchObject({ ok: true });
      });

      it("has stories and a ready fixture", () => {
        expect(stories.some((path) => dirOf(path) === dir)).toBe(true);
        const own = Object.entries(fixtures).filter(
          ([path]) => dirOf(path) === dir,
        );
        expect(
          own.some(
            ([, value]) => (value as { expect?: string }).expect === "ready",
          ),
        ).toBe(true);
      });

      const own = Object.entries(fixtures).filter(
        ([path]) => dirOf(path) === dir,
      );
      it.each(own.map(([path, value]) => [path.split("/").pop(), value]))(
        "fixture %s settles as declared",
        async (_name, value) => {
          const fixture = widgetFixtureSchema.parse(value);
          const config = compileComponentConfig(
            widget.manifest.component.configTemplate,
            fixture.configuration,
          );
          expect(configLimitProblem(config)).toBeNull();
          const container = document.createElement("div");
          document.body.appendChild(container);
          const rendered = renderFixture({
            definition: widget.definition,
            manifest: widget.manifest,
            fixture,
            container,
          });
          const element = rendered.mount.element as
            (HTMLElement & { updateComplete?: Promise<unknown> }) | null;
          await element?.updateComplete;
          expect(rendered.state().state).toBe(fixture.expect);
          rendered.dispose();
          expect(container.children).toHaveLength(0);
          expect(rendered.clock.pendingTimers).toBe(0);
        },
      );
    },
  );
});
