import { afterEach, describe, expect, it } from "vitest";
import {
  announceReady,
  defineWidget,
  WidgetRegistry,
  type WidgetContext,
} from "../src/index.ts";
import {
  TrustedWidgetExecutor,
  type WidgetExecutionRequest,
} from "../src/executor.ts";
import type { WidgetMountState } from "../src/mount.ts";
import { createTestContext, fixtureResources } from "../src/testing.ts";

let counter = 0;

function makeDefinition() {
  counter += 1;
  const tag = `tc-widget-executor-probe${counter}`;
  const type = `tilecast.executor-probe${counter}`;
  class Probe extends HTMLElement {
    declare config: { label: string };
    declare data: { text: string } | null;
    declare empty: string | null;
    declare context: WidgetContext;
    connectedCallback() {
      this.textContent = this.data?.text ?? "";
      announceReady(this);
    }
  }
  return defineWidget<{ label: string }, { text: string }>({
    type,
    version: 1,
    tagName: tag,
    parseConfig: (value) => ({ ok: true, config: value as { label: string } }),
    resolveData: () => ({ state: "ready" as const, data: { text: "hi" } }),
    element: Probe,
  });
}

function requestFor(
  definition: ReturnType<typeof makeDefinition>,
  onState: (state: WidgetMountState) => void,
): WidgetExecutionRequest {
  return {
    component: {
      type: definition.type,
      version: 1,
      config: { label: "probe" },
    },
    resources: fixtureResources(),
    context: createTestContext(),
    onState,
  };
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("TrustedWidgetExecutor", () => {
  it("mounts through the shared mount and reports its state once", () => {
    const definition = makeDefinition();
    const executor = new TrustedWidgetExecutor({
      registry: new WidgetRegistry([definition]),
    });
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor(definition, (state) => states.push(state)),
    );
    expect(execution.state).toEqual({ state: "ready" });
    expect(states).toEqual([{ state: "ready" }]);
    expect(container.textContent).toBe("hi");
    execution.dispose();
    expect(container.childElementCount).toBe(0);
  });

  it("updates inputs in place and remounts across component versions", () => {
    const definition = makeDefinition();
    const executor = new TrustedWidgetExecutor({
      registry: new WidgetRegistry([definition]),
    });
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const base = requestFor(definition, (state) => states.push(state));
    const first = base.component;
    const execution = executor.mount(container, base);
    const node = container.firstElementChild;
    execution.update({
      ...base,
      component: { ...first, config: { label: "again" } },
    });
    // Same type and version: the element survives the update.
    expect(container.firstElementChild).toBe(node);
    execution.update({
      ...base,
      component: { ...first, version: 2 },
    });
    expect(execution.state).toEqual({
      state: "error",
      code: "widget_unsupported",
    });
    execution.dispose();
  });

  it("reports an error for types the registry does not know", () => {
    const executor = new TrustedWidgetExecutor({
      registry: new WidgetRegistry([makeDefinition()]),
    });
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    const execution = executor.mount(container, {
      component: { type: "tilecast.nope", version: 1, config: {} },
      resources: fixtureResources(),
      context: createTestContext(),
      onState: (state) => states.push(state),
    });
    expect(states).toEqual([{ state: "error", code: "widget_unsupported" }]);
    expect(execution.state).toEqual(states[0]);
    execution.dispose();
  });

  it("never reports after dispose", () => {
    const definition = makeDefinition();
    const executor = new TrustedWidgetExecutor({
      registry: new WidgetRegistry([definition]),
    });
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    const execution = executor.mount(
      container,
      requestFor(definition, (state) => states.push(state)),
    );
    const settled = states.length;
    execution.dispose();
    execution.update(requestFor(definition, (state) => states.push(state)));
    expect(states.length).toBe(settled);
  });
});
