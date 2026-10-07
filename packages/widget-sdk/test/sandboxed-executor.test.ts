import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SANDBOX_BRIDGE_PROTOCOL,
  type DeclaredWidgetInputs,
} from "../src/sandbox-bridge.ts";
import {
  buildSandboxFrameDocument,
  escapeInlineScript,
  SANDBOX_BUNDLE_PLACEHOLDER,
  SANDBOX_DEFINITION_GLOBAL,
  sandboxFrameBootstrap,
  SandboxedWidgetExecutor,
  snapshotSandboxContext,
  type SandboxedWidgetBundle,
  type SandboxedWidgetRequest,
} from "../src/sandboxed-executor.ts";
import type { WidgetMountState } from "../src/mount.ts";
import {
  createManualClock,
  createTestContext,
  fixtureResources,
} from "../src/testing.ts";

const BUNDLE: SandboxedWidgetBundle = {
  javaScript: "globalThis.__tilecastWidgetDefinition={type:1};",
  sha256: "0".repeat(64),
};

const DECLARED: DeclaredWidgetInputs = {
  dataSources: ["schedule"],
  media: [{ assetId: "hero", variantId: "full" }],
};

function requestFor(
  onState: (state: WidgetMountState) => void,
  overrides: Partial<SandboxedWidgetRequest> = {},
): SandboxedWidgetRequest {
  return {
    component: {
      type: "acme.probe",
      version: 2,
      config: { label: "probe" },
    },
    resources: fixtureResources(),
    context: createTestContext(),
    onState,
    bundle: BUNDLE,
    declared: DECLARED,
    ...overrides,
  };
}

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("sandbox frame document", () => {
  it("carries the protocol constants the parent enforces", () => {
    const document = buildSandboxFrameDocument(BUNDLE.javaScript);
    expect(document).toContain(SANDBOX_BRIDGE_PROTOCOL);
    expect(document).toContain(SANDBOX_DEFINITION_GLOBAL);
    expect(document).toContain("tilecast-widget-ready");
    expect(document).toContain("tilecast-widget-empty");
    expect(document).toContain("tilecast-widget-error");
    // Bootstrap first so the handshake listener exists before the bundle runs.
    expect(document.indexOf('addEventListener("message"')).toBeLessThan(
      document.indexOf(BUNDLE.javaScript),
    );
  });

  it("reserves a single bundle slot for the server template", () => {
    const bootstrap = sandboxFrameBootstrap();
    expect(bootstrap).not.toContain(SANDBOX_BUNDLE_PLACEHOLDER);
    const template = buildSandboxFrameDocument(SANDBOX_BUNDLE_PLACEHOLDER);
    expect(template.split(SANDBOX_BUNDLE_PLACEHOLDER).length - 1).toBe(1);
  });

  it("keeps a hostile bundle inside its own script block", () => {
    const hostile = `</script><script>fetch("https://evil.example")</script>`;
    const escaped = escapeInlineScript(hostile);
    expect(escaped).not.toContain("</script");
    const document = buildSandboxFrameDocument(hostile);
    // Exactly the two intended closers: bootstrap, then bundle. The
    // hostile payload's own closer is escaped, so it cannot break out.
    expect(document.match(/<\/script>/g)).toHaveLength(2);
    expect(document).toContain(escaped);
  });
});

describe("sandbox context snapshot", () => {
  it("projects the clock offset and copies the serializable fields", () => {
    const clock = createManualClock(1_000_000);
    const context = createTestContext({ clock, mode: "playback" });
    const snapshot = snapshotSandboxContext(context);
    expect(snapshot.wallClockOffsetMs).toBe(1_000_000 - Date.now());
    expect(snapshot.locale).toBe("en-US");
    expect(snapshot.timeZone).toBe("America/Chicago");
    expect(snapshot.hourCycle).toBe("locale");
    expect(snapshot.theme).toEqual({
      scheme: "dark",
      background: "#0e141b",
      foreground: "#f5f7fa",
      accent: "#4f9dff",
    });
    expect(snapshot.reducedMotion).toBe(true);
    expect(snapshot.mode).toBe("playback");
  });
});

describe("SandboxedWidgetExecutor", () => {
  it("mounts a locked-down frame and reports pending first", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame?.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame?.style.width).toBe("100%");
    expect(frame?.style.height).toBe("100%");
    expect(frame?.style.border).toBe("0px");
    expect(frame?.srcdoc).toContain(BUNDLE.javaScript);
    expect(states).toEqual([{ state: "pending" }]);
    expect(execution.state).toEqual({ state: "pending" });
    execution.dispose();
  });

  it("uses blob URLs when asked and revokes them on dispose", () => {
    const created: string[] = [];
    const revoked: string[] = [];
    const executor = new SandboxedWidgetExecutor({
      defaultEmbedding: "blob",
      createObjectURL: (text: string) => {
        expect(text).toContain(BUNDLE.javaScript);
        created.push("blob:fixture");
        return "blob:fixture";
      },
      revokeObjectURL: (url: string) => void revoked.push(url),
    });
    const container = document.createElement("div");
    const execution = executor.mount(
      container,
      requestFor(() => {}),
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("blob:fixture");
    expect(frame?.srcdoc).toBe("");
    execution.dispose();
    expect(created).toEqual(["blob:fixture"]);
    expect(revoked).toEqual(["blob:fixture"]);
    expect(container.querySelector("iframe")).toBeNull();
  });

  it("mounts a hosted frame without inline bundle bytes", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const request = requestFor((state) => states.push(state), {
      embedding: "hosted",
      frameUrl: "https://frames.example/f/ok.html",
    });
    delete (request as { bundle?: SandboxedWidgetBundle }).bundle;
    const execution = executor.mount(container, request);
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("https://frames.example/f/ok.html");
    expect(states).toEqual([{ state: "pending" }]);
    expect(execution.state).toEqual({ state: "pending" });
    execution.dispose();
  });

  it("refuses a hosted mount without a frame URL", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const request = requestFor((state) => states.push(state), {
      embedding: "hosted",
    });
    delete (request as { bundle?: SandboxedWidgetBundle }).bundle;
    executor.mount(container, request);
    expect(container.querySelector("iframe")).toBeNull();
    expect(states).toEqual([
      { state: "pending" },
      { state: "error", code: "frame_error" },
    ]);
  });

  it("reposts init on frame load for asynchronously navigated frames", () => {
    const executor = new SandboxedWidgetExecutor();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor(() => {}, {
        embedding: "hosted",
        frameUrl: "https://frames.example/f/ok.html",
      }),
    );
    const frame = container.querySelector("iframe");
    expect(frame?.getAttribute("src")).toBe("https://frames.example/f/ok.html");
    const posted: Array<{ kind?: unknown; nonce?: unknown }> = [];
    vi.spyOn(frame!.contentWindow!, "postMessage").mockImplementation(
      (message: unknown) =>
        void posted.push(message as { kind?: unknown; nonce?: unknown }),
    );
    // The mount-time post predates the spy; only the load repost is visible.
    frame!.dispatchEvent(new Event("load"));
    expect(posted).toHaveLength(1);
    expect(posted[0]?.kind).toBe("init");
    expect(typeof posted[0]?.nonce).toBe("string");
    // A disposed placement stays silent on late load events. dispose()
    // posts its own best-effort message; the late load must add nothing.
    execution.dispose();
    const settled = posted.length;
    frame!.dispatchEvent(new Event("load"));
    expect(posted).toHaveLength(settled);
    expect(posted.filter((message) => message.kind === "init")).toHaveLength(1);
  });

  it("settles frames that report through the bridge and ignores the rest", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe");
    const posted: Array<{ nonce?: unknown }> = [];
    vi.spyOn(frame!.contentWindow!, "postMessage").mockImplementation(
      (message: unknown) => void posted.push(message as { nonce?: unknown }),
    );
    // Drive an update so the posted message is captured deterministically.
    execution.update(requestFor((state) => states.push(state)));
    const nonce = posted[0]?.nonce;
    expect(typeof nonce).toBe("string");
    const report = (data: unknown, origin = "null") =>
      window.dispatchEvent(new MessageEvent("message", { origin, data }));
    // Foreign origins and nonces never touch placement state.
    report(
      { protocol: SANDBOX_BRIDGE_PROTOCOL, nonce, state: { state: "ready" } },
      "https://evil.example",
    );
    report({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: "wrong",
      state: { state: "ready" },
    });
    expect(states).toEqual([{ state: "pending" }, { state: "pending" }]);
    report({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      state: { state: "ready" },
    });
    expect(states.at(-1)).toEqual({ state: "ready" });
    expect(execution.state).toEqual({ state: "ready" });
    execution.dispose();
  });

  it("times out a frame that never reports", () => {
    const clock = createManualClock();
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state), {
        context: createTestContext({ clock }),
        readyTimeoutMs: 50,
      }),
    );
    clock.advance(49);
    expect(execution.state).toEqual({ state: "pending" });
    clock.advance(1);
    expect(execution.state).toEqual({
      state: "error",
      code: "widget_ready_timeout",
    });
    expect(states.at(-1)).toEqual({
      state: "error",
      code: "widget_ready_timeout",
    });
    execution.dispose();
  });

  it("remounts across component versions and reuses the frame otherwise", () => {
    const executor = new SandboxedWidgetExecutor();
    const container = document.createElement("div");
    const base = requestFor(() => {});
    const execution = executor.mount(container, base);
    const first = container.querySelector("iframe");
    execution.update({
      ...base,
      component: { ...base.component, config: { label: "again" } },
    });
    expect(container.querySelector("iframe")).toBe(first);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    execution.update({
      ...base,
      component: { ...base.component, version: 3 },
    });
    const second = container.querySelector("iframe");
    expect(second).not.toBe(first);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
    execution.dispose();
  });

  it("keeps reporting to the mount callback when an update omits it", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const silent = requestFor(() => {
      throw new Error("must not be called");
    });
    delete (silent as { onState?: unknown }).onState;
    execution.update(silent);
    // The update's own pending proves the mount callback survived.
    expect(states).toEqual([{ state: "pending" }, { state: "pending" }]);
    execution.dispose();
  });

  it("refuses an empty bundle without creating a frame", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state), {
        bundle: { javaScript: "", sha256: "0".repeat(64) },
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    expect(states).toEqual([
      { state: "pending" },
      { state: "error", code: "frame_error" },
    ]);
    execution.dispose();
  });

  it("reports an oversize snapshot instead of throwing", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state), {
        component: {
          type: "acme.probe",
          version: 2,
          config: { label: "x".repeat(5 * 1024 * 1024) },
        },
      }),
    );
    expect(states).toEqual([
      { state: "pending" },
      { state: "error", code: "frame_error" },
    ]);
    execution.dispose();
  });

  it("never reports after dispose", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    execution.dispose();
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "null",
        data: {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce: "anything",
          state: { state: "ready" },
        },
      }),
    );
    expect(states).toEqual([{ state: "pending" }]);
    expect(container.querySelector("iframe")).toBeNull();
  });
});
