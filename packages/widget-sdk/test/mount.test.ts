import { afterEach, describe, expect, it } from "vitest";
import {
  announceEmpty,
  announceError,
  announceReady,
  defineWidget,
  empty,
  failure,
  ready,
  WidgetRegistry,
  type WidgetContext,
} from "../src/index.ts";
import { WidgetMount } from "../src/mount.ts";
import {
  createManualClock,
  createTestContext,
  fixtureResources,
  mountForTest,
} from "../src/testing.ts";

type Config = { mode: "ready" | "empty" | "error" | "silent" | "bad-event" };

let counter = 0;

/** A minimal element that renders synchronously and reports its inputs. */
function makeDefinition(
  overrides: Partial<{ tag: string; type: string }> = {},
) {
  counter += 1;
  const tag = overrides.tag ?? `tc-widget-probe${counter}`;
  const type = overrides.type ?? `tilecast.probe${counter}`;
  class Probe extends HTMLElement {
    declare config: Config;
    declare data: { text: string } | null;
    declare empty: string | null;
    declare context: WidgetContext;
    renders = 0;
    connectedCallback() {
      this.render();
    }
    render() {
      this.renders += 1;
      this.textContent = this.empty ?? this.data?.text ?? "";
      if (this.config.mode === "silent") return;
      if (this.config.mode === "bad-event") {
        this.dispatchEvent(
          new CustomEvent("tilecast-widget-error", {
            bubbles: true,
            detail: { code: "<img src=x onerror=alert(1)>" },
          }),
        );
        return;
      }
      if (this.empty) announceEmpty(this, this.empty);
      else if (this.config.mode === "error") announceError(this, "bad_input");
      else announceReady(this);
    }
  }
  return defineWidget<Config, { text: string }>({
    type,
    version: 2,
    tagName: tag,
    parseConfig(value) {
      const mode = (value as Config | null)?.mode;
      return mode === "ready" ||
        mode === "empty" ||
        mode === "error" ||
        mode === "silent" ||
        mode === "bad-event"
        ? { ok: true, config: { mode } }
        : { ok: false, problem: "mode" };
    },
    resolveData(config) {
      if (config.mode === "empty") return empty("nothing_today");
      return ready({ text: "hello" });
    },
    element: Probe,
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("WidgetMount", () => {
  it("assigns typed properties and settles ready from the element event", () => {
    const definition = makeDefinition();
    const test = mountForTest(definition, { config: { mode: "ready" } });
    expect(test.states).toEqual([{ state: "ready" }]);
    const element = test.element as HTMLElement & { config: Config };
    expect(element.tagName.toLowerCase()).toBe(definition.tagName);
    expect(element.config).toEqual({ mode: "ready" });
    expect(element.getAttribute("config")).toBeNull();
    expect(element.textContent).toBe("hello");
    test.dispose();
  });

  it("passes an expected empty resolution to the element without failing", () => {
    const test = mountForTest(makeDefinition(), { config: { mode: "empty" } });
    expect(test.states).toEqual([{ state: "empty", reason: "nothing_today" }]);
    expect(test.element?.textContent).toBe("nothing_today");
    test.dispose();
  });

  it("refuses unknown types and newer versions than it renders", () => {
    const definition = makeDefinition();
    const container = document.createElement("div");
    const states: unknown[] = [];
    const base = {
      registry: new WidgetRegistry([definition]),
      container,
      resources: fixtureResources(),
      context: createTestContext(),
      onState: (state: unknown) => states.push(state),
    };
    new WidgetMount({
      ...base,
      component: { type: "tilecast.nope", version: 1, config: {} },
    });
    new WidgetMount({
      ...base,
      component: { type: definition.type, version: 3, config: {} },
    });
    expect(states).toEqual([
      { state: "error", code: "widget_unsupported" },
      { state: "error", code: "widget_unsupported" },
    ]);
    expect(container.children).toHaveLength(0);
  });

  it("renders every earlier component version", () => {
    const definition = makeDefinition();
    const test = mountForTest(definition, {
      config: { mode: "ready" },
      version: 1,
    });
    expect(test.states).toEqual([{ state: "ready" }]);
    test.dispose();
  });

  it("fails closed on invalid configuration and never mounts the element", () => {
    const definition = makeDefinition();
    const test = mountForTest(definition, {
      config: { mode: "<script>alert(1)</script>" },
    });
    expect(test.states).toEqual([
      { state: "error", code: "widget_config_invalid" },
    ]);
    expect(test.container.children).toHaveLength(0);
  });

  it("bounds the codes a Widget reports", () => {
    const test = mountForTest(makeDefinition(), {
      config: { mode: "bad-event" },
    });
    expect(test.states).toEqual([{ state: "error", code: "widget_error" }]);
    test.dispose();
  });

  it("times out on the Widget clock when the element never announces", () => {
    const clock = createManualClock();
    const test = mountForTest(makeDefinition(), {
      config: { mode: "silent" },
      context: createTestContext({ clock }),
    });
    expect(test.states).toEqual([]);
    clock.advance(9_999);
    expect(test.states).toEqual([]);
    clock.advance(1);
    expect(test.states).toEqual([
      { state: "error", code: "widget_ready_timeout" },
    ]);
    test.dispose();
  });

  it("updates in place for new inputs and remounts for a new type", () => {
    const first = makeDefinition();
    const second = makeDefinition();
    const registry = new WidgetRegistry([first, second]);
    const test = mountForTest(first, { config: { mode: "ready" }, registry });
    const original = test.element as HTMLElement & {
      render(): void;
      renders: number;
    };
    test.mount.update({
      component: { type: first.type, version: 2, config: { mode: "empty" } },
    });
    // The element instance survives; this probe re-renders on demand.
    expect(test.element).toBe(original);
    original.render();
    expect(test.states.at(-1)).toEqual({
      state: "empty",
      reason: "nothing_today",
    });
    test.mount.update({
      component: { type: second.type, version: 2, config: { mode: "ready" } },
    });
    expect(test.element).not.toBe(original);
    expect(original.isConnected).toBe(false);
    expect(test.element?.tagName.toLowerCase()).toBe(second.tagName);
    test.dispose();
  });

  it("updates resources and context in place and re-resolves data", () => {
    counter += 1;
    const tagName = `tc-widget-resource-probe${counter}`;
    const type = `tilecast.resource-probe${counter}`;
    class ResourceProbe extends HTMLElement {
      declare config: { source: string };
      declare data: { attribution: string } | null;
      declare empty: string | null;
      declare context: WidgetContext;

      connectedCallback() {
        announceReady(this);
      }
    }
    const definition = defineWidget<
      { source: string },
      { attribution: string }
    >({
      type,
      version: 1,
      tagName,
      parseConfig(value) {
        const source = (value as { source?: unknown } | null)?.source;
        return typeof source === "string"
          ? { ok: true, config: { source } }
          : { ok: false, problem: "source" };
      },
      resolveData(config, resources) {
        return ready({
          attribution: resources.attribution(config.source) ?? "none",
        });
      },
      element: ResourceProbe,
    });
    const resources = (attribution: string) =>
      fixtureResources({
        documents: {
          source: {
            schemaVersion: 1,
            datasets: [
              {
                id: "rows",
                kind: "records",
                attribution,
                records: [],
              },
            ],
          },
        },
      });
    const firstContext = createTestContext({ locale: "en-US" });
    const secondContext = createTestContext({ locale: "fr-FR" });
    const test = mountForTest(definition, {
      config: { source: "source" },
      resources: resources("First"),
      context: firstContext,
    });
    const original = test.element as ResourceProbe;
    expect(original.data).toEqual({ attribution: "First" });
    expect(original.context).toBe(firstContext);

    test.mount.update({
      resources: resources("Second"),
      context: secondContext,
    });

    expect(test.element).toBe(original);
    expect(original.data).toEqual({ attribution: "Second" });
    expect(original.context).toBe(secondContext);
    test.dispose();
  });

  it("removes the element, listeners and timers on dispose", () => {
    const clock = createManualClock();
    const test = mountForTest(makeDefinition(), {
      config: { mode: "silent" },
      context: createTestContext({ clock }),
    });
    expect(clock.pendingTimers).toBe(1);
    const element = test.element!;
    test.dispose();
    expect(element.isConnected).toBe(false);
    expect(clock.pendingTimers).toBe(0);
    announceReady(element);
    expect(test.states).toEqual([]);
  });

  it("refuses a tag another definition already owns", () => {
    const owner = makeDefinition({ tag: "acme-shared", type: "acme.first" });
    mountForTest(owner, { config: { mode: "ready" } }).dispose();
    const intruder = makeDefinition({
      tag: "acme-shared",
      type: "acme.second",
    });
    const test = mountForTest(intruder, { config: { mode: "ready" } });
    expect(test.states).toEqual([
      { state: "error", code: "widget_tag_conflict" },
    ]);
  });

  it("refuses to mount without adopted stylesheets when the host requires them", () => {
    const definition = makeDefinition();
    const states: unknown[] = [];
    new WidgetMount({
      registry: new WidgetRegistry([definition]),
      container: document.createElement("div"),
      component: {
        type: definition.type,
        version: 2,
        config: { mode: "ready" },
      },
      resources: fixtureResources(),
      context: createTestContext(),
      onState: (state) => states.push(state),
      // jsdom has no Document.adoptedStyleSheets.
      requireAdoptedStyleSheets: true,
    });
    expect(states).toEqual([
      { state: "error", code: "widget_styles_unsupported" },
    ]);
  });

  it("turns a resolver failure or throw into a bounded error", () => {
    const definition = defineWidget({
      ...makeDefinition(),
      resolveData: () => failure("source unavailable!!"),
    });
    const test = mountForTest(definition, { config: { mode: "ready" } });
    expect(test.states).toEqual([{ state: "error", code: "widget_error" }]);
    const throwing = defineWidget({
      ...makeDefinition(),
      resolveData: () => {
        throw new Error("boom");
      },
    });
    const second = mountForTest(throwing, { config: { mode: "ready" } });
    expect(second.states).toEqual([
      { state: "error", code: "widget_resolve_failed" },
    ]);
  });
});
