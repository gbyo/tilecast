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
    const document = buildSandboxFrameDocument(BUNDLE.javaScript, "hello-1");
    expect(document).toContain(SANDBOX_BRIDGE_PROTOCOL);
    expect(document).toContain(SANDBOX_DEFINITION_GLOBAL);
    expect(document).toContain("frame-hello");
    expect(document).toContain("hello-1");
    expect(document).toContain("tilecast-widget-ready");
    expect(document).toContain("tilecast-widget-empty");
    expect(document).toContain("tilecast-widget-error");
    // Bootstrap first so the hello posts before the bundle runs.
    expect(document.indexOf("frame-hello")).toBeLessThan(
      document.indexOf(BUNDLE.javaScript),
    );
  });

  it("reserves a single bundle slot for the server template", () => {
    const bootstrap = sandboxFrameBootstrap("hello-1");
    expect(bootstrap).not.toContain(SANDBOX_BUNDLE_PLACEHOLDER);
    const template = buildSandboxFrameDocument(SANDBOX_BUNDLE_PLACEHOLDER);
    expect(template.split(SANDBOX_BUNDLE_PLACEHOLDER).length - 1).toBe(1);
    // The server template carries no per-attach token; hosted hellos
    // authenticate by frame origin instead.
    expect(template).toContain('var HELLO_TOKEN = ""');
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

/** Read the per-attach token the executor embedded in the document. */
function helloTokenFrom(frame: HTMLIFrameElement): string {
  const match = /var HELLO_TOKEN = "([^"]*)"/.exec(frame.srcdoc);
  if (!match) throw new Error("hello token missing from frame document");
  return match[1]!;
}

/** Post a frame hello on the window bus, as the bootstrap does. */
function hello(
  frame: HTMLIFrameElement,
  token: string,
  overrides: { origin?: string; source?: unknown; data?: unknown } = {},
): void {
  window.dispatchEvent(
    new MessageEvent("message", {
      origin: overrides.origin ?? "null",
      source: (overrides.source ?? frame.contentWindow) as Window,
      data:
        "data" in overrides
          ? overrides.data
          : {
              protocol: SANDBOX_BRIDGE_PROTOCOL,
              kind: "frame-hello",
              helloToken: token,
            },
    }),
  );
}

interface PostedInit {
  message: {
    kind?: unknown;
    nonce?: unknown;
    snapshot?: { component?: { config?: unknown } };
  };
  origin: unknown;
  transfer: unknown;
}

function postedInits(spy: { mock: { calls: unknown[][] } }): PostedInit[] {
  return spy.mock.calls.map((call) => ({
    message: call[0] as PostedInit["message"],
    origin: call[1],
    transfer: call[2],
  }));
}

// Port delivery and timers are separate task sources: a single tick does
// not reliably flush a posted port message under load. Presence
// assertions below wait for the expected state; absence assertions drain
// several ticks so a promptly delivered message would have arrived.
const flushPorts = async (ticks = 8): Promise<void> => {
  for (let i = 0; i < ticks; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
};

const waitForLastState = (
  states: WidgetMountState[],
  expected: WidgetMountState,
): Promise<void> =>
  vi.waitFor(() => {
    expect(states.at(-1)).toEqual(expected);
  });

const waitForFrameKinds = (
  frameReceived: Array<{ kind?: unknown }>,
  kinds: string[],
): Promise<void> =>
  vi.waitFor(() => {
    expect(frameReceived.map((message) => message.kind)).toEqual(kinds);
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

  it("answers the frame hello with init and the port, exactly once", async () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe")!;
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    // Mounting sends nothing: the hello drives the handshake.
    expect(spy).not.toHaveBeenCalled();
    hello(frame, helloTokenFrom(frame));
    const inits = postedInits(spy);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.message.kind).toBe("init");
    expect(typeof inits[0]?.message.nonce).toBe("string");
    expect(inits[0]?.message.snapshot?.component?.config).toEqual({
      label: "probe",
    });
    // Opaque targets cannot name an origin, so the single-shot transfer
    // is the one parent-to-frame post allowed a wildcard.
    expect(inits[0]?.origin).toBe("*");
    const transfer = inits[0]?.transfer as unknown[];
    expect(transfer).toHaveLength(1);
    expect(transfer[0]).toBeInstanceOf(MessagePort);
    // A duplicate hello answers nothing: one document, one channel.
    hello(frame, helloTokenFrom(frame));
    expect(spy).toHaveBeenCalledTimes(1);
    const framePort = transfer[0] as MessagePort;
    framePort.postMessage({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: inits[0]?.message.nonce,
      state: { state: "ready" },
    });
    await waitForLastState(states, { state: "ready" });
    expect(execution.state).toEqual({ state: "ready" });
    execution.dispose();
  });

  it("ignores hellos from foreign windows, origins, or documents", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe")!;
    const token = helloTokenFrom(frame);
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    // A foreign window, even with the token, is not our document.
    hello(frame, token, { source: window });
    // A navigated document reports its own origin, not the opaque one.
    hello(frame, token, { origin: "https://evil.example" });
    // A substituted opaque document never learned the token.
    hello(frame, "wrong");
    hello(frame, token, { data: { protocol: SANDBOX_BRIDGE_PROTOCOL } });
    hello(frame, token, { data: null });
    expect(spy).not.toHaveBeenCalled();
    expect(states).toEqual([{ state: "pending" }]);
    // None of the forgeries consumed the handshake: the real hello
    // still answers.
    hello(frame, token);
    expect(spy).toHaveBeenCalledTimes(1);
    execution.dispose();
  });

  it("ignores window reports once traffic moves to the port", async () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe")!;
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    hello(frame, helloTokenFrom(frame));
    const nonce = postedInits(spy)[0]?.message.nonce;
    // A well-formed report on the window bus is a forgery after the
    // handshake: only the port settles placement state.
    window.dispatchEvent(
      new MessageEvent("message", {
        origin: "null",
        source: frame.contentWindow,
        data: {
          protocol: SANDBOX_BRIDGE_PROTOCOL,
          nonce,
          state: { state: "ready" },
        },
      }),
    );
    await flushPorts();
    expect(states).toEqual([{ state: "pending" }]);
    execution.dispose();
  });

  it("ignores forged and malformed port reports", async () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe")!;
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    hello(frame, helloTokenFrom(frame));
    const inits = postedInits(spy);
    const nonce = inits[0]?.message.nonce;
    const framePort = (inits[0]?.transfer as unknown[])[0] as MessagePort;
    framePort.postMessage({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: "wrong",
      state: { state: "ready" },
    });
    framePort.postMessage(null);
    framePort.postMessage({ protocol: SANDBOX_BRIDGE_PROTOCOL, nonce });
    await flushPorts();
    expect(states).toEqual([{ state: "pending" }]);
    framePort.postMessage({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      state: { state: "ready" },
    });
    await waitForLastState(states, { state: "ready" });
    execution.dispose();
  });

  it("never resends init to a reloaded document", async () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe")!;
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    hello(frame, helloTokenFrom(frame));
    const inits = postedInits(spy);
    expect(inits).toHaveLength(1);
    const framePort = (inits[0]?.transfer as unknown[])[0] as MessagePort;
    const frameReceived: unknown[] = [];
    framePort.onmessage = (event: MessageEvent) =>
      void frameReceived.push(event.data);
    // The initial navigation's load is expected and changes nothing.
    frame.dispatchEvent(new Event("load"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(states).toEqual([{ state: "pending" }]);
    // The reload kills the connection: no resend, no fresh channel for
    // the replacement document, and the placement fails loudly.
    frame.dispatchEvent(new Event("load"));
    expect(states.at(-1)).toEqual({ state: "error", code: "frame_error" });
    expect(spy).toHaveBeenCalledTimes(1);
    hello(frame, helloTokenFrom(frame));
    expect(spy).toHaveBeenCalledTimes(1);
    // Updates send nothing and the dead port settles nothing.
    execution.update(
      requestFor((state) => states.push(state), {
        component: {
          type: "acme.probe",
          version: 2,
          config: { label: "again" },
        },
      }),
    );
    framePort.postMessage({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: inits[0]?.message.nonce,
      state: { state: "ready" },
    });
    await waitForLastState(states, { state: "error", code: "frame_error" });
    expect(frameReceived).toHaveLength(0);
    execution.dispose();
  });

  it("dies when the frame navigates before the handshake", () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe")!;
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    // Two loads without a hello: the original document never announced
    // and the replacement must never receive the channel.
    frame.dispatchEvent(new Event("load"));
    frame.dispatchEvent(new Event("load"));
    expect(states.at(-1)).toEqual({ state: "error", code: "frame_error" });
    expect(spy).not.toHaveBeenCalled();
    hello(frame, helloTokenFrom(frame));
    expect(spy).not.toHaveBeenCalled();
    execution.dispose();
  });

  it("authenticates hosted hellos by frame origin and names it on transfer", async () => {
    const executor = new SandboxedWidgetExecutor();
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state), {
        embedding: "hosted",
        frameUrl: "https://frames.example/f/ok.html",
      }),
    );
    const frame = container.querySelector("iframe")!;
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    // The server template carries no token; the origin is the check.
    hello(frame, "", { origin: "null" });
    hello(frame, "", { origin: "https://evil.example" });
    expect(spy).not.toHaveBeenCalled();
    hello(frame, "", { origin: "https://frames.example" });
    const inits = postedInits(spy);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.origin).toBe("https://frames.example");
    const framePort = (inits[0]?.transfer as unknown[])[0] as MessagePort;
    framePort.postMessage({
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce: inits[0]?.message.nonce,
      state: { state: "ready" },
    });
    await waitForLastState(states, { state: "ready" });
    execution.dispose();
  });

  it("sends updates and dispose over the port after the handshake", async () => {
    const channel = new MessageChannel();
    const closeSpy = vi.spyOn(channel.port1, "close");
    const executor = new SandboxedWidgetExecutor({
      createChannel: () => channel,
    });
    const states: WidgetMountState[] = [];
    const container = document.createElement("div");
    document.body.appendChild(container);
    const execution = executor.mount(
      container,
      requestFor((state) => states.push(state)),
    );
    const frame = container.querySelector("iframe")!;
    // An update before the hello sends nothing; the init answers with
    // the latest snapshot instead of racing the navigation.
    execution.update(
      requestFor((state) => states.push(state), {
        component: {
          type: "acme.probe",
          version: 2,
          config: { label: "again" },
        },
      }),
    );
    const spy = vi
      .spyOn(frame.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    hello(frame, helloTokenFrom(frame));
    const inits = postedInits(spy);
    expect(inits).toHaveLength(1);
    expect(inits[0]?.message.snapshot?.component?.config).toEqual({
      label: "again",
    });
    const framePort = (inits[0]?.transfer as unknown[])[0] as MessagePort;
    const frameReceived: Array<{ kind?: unknown }> = [];
    framePort.onmessage = (event: MessageEvent) =>
      void frameReceived.push(event.data as { kind?: unknown });
    execution.update(
      requestFor((state) => states.push(state), {
        component: {
          type: "acme.probe",
          version: 2,
          config: { label: "third" },
        },
      }),
    );
    await waitForFrameKinds(frameReceived, ["update"]);
    expect(spy).toHaveBeenCalledTimes(1);
    execution.dispose();
    await waitForFrameKinds(frameReceived, ["update", "dispose"]);
    expect(closeSpy).toHaveBeenCalled();
  });

  it("closes the port on remount and re-handshakes the new document", () => {
    const channels: MessageChannel[] = [];
    const executor = new SandboxedWidgetExecutor({
      createChannel: () => {
        const channel = new MessageChannel();
        channels.push(channel);
        return channel;
      },
    });
    const container = document.createElement("div");
    document.body.appendChild(container);
    const base = requestFor(() => {});
    const execution = executor.mount(container, base);
    const first = container.querySelector("iframe")!;
    const firstToken = helloTokenFrom(first);
    const firstSpy = vi
      .spyOn(first.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    hello(first, firstToken);
    expect(firstSpy).toHaveBeenCalledTimes(1);
    const closeSpy = vi.spyOn(channels[0]!.port1, "close");
    execution.update({
      ...base,
      component: { ...base.component, version: 3 },
    });
    expect(closeSpy).toHaveBeenCalled();
    const second = container.querySelector("iframe")!;
    expect(second).not.toBe(first);
    const secondToken = helloTokenFrom(second);
    expect(secondToken).not.toBe(firstToken);
    const secondSpy = vi
      .spyOn(second.contentWindow!, "postMessage")
      .mockImplementation(() => {});
    // The old document's token buys nothing on the new frame.
    hello(second, firstToken);
    expect(secondSpy).not.toHaveBeenCalled();
    hello(second, secondToken);
    expect(secondSpy).toHaveBeenCalledTimes(1);
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
