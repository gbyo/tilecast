// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  defineRuntimePlugin,
  type SurfaceGrant,
} from "@tilecast/plugin-sdk/runtime";
import type {
  ExternalRuntimePluginV1,
  PluginFrameBindingV1,
} from "../host/contract";
import { ManualClock } from "../clock/scheduler";
import { RuntimeSurfaceHost } from "./host";
import {
  boundedPluginJSON,
  parseExternalEntry,
  pluginFrameURI,
  PLUGIN_SURFACE_PROTOCOL,
} from "./external";

const NOW = Date.parse("2026-10-13T12:00:00Z");
const entry = (id = "acme.presence.badge"): ExternalRuntimePluginV1 => ({
  id,
  type: "external_plugin",
  version: 1,
  definitionVersion: 1,
  package: {
    packageId: id.slice(0, id.lastIndexOf(".")),
    packageDigest: `sha256:${"a".repeat(64)}`,
    contributionId: id,
    frame: {
      sha256: "f".repeat(64),
      fileSize: 2000,
      downloadPath: "/api/v1/player/packages/acme.presence/plugins/badge/frame",
    },
  },
  runtime: {
    tier: "live",
    surfaces: ["corner.bottom-left", "corner.top-right"],
  },
  state: { count: 12 },
  validUntil: new Date(NOW + 75_000).toISOString(),
});
const binding = (value: ExternalRuntimePluginV1): PluginFrameBindingV1 => ({
  packageId: value.package.packageId,
  packageDigest: value.package.packageDigest,
  frameDigest: value.package.frame.sha256,
  uri: `https://frames.local/plugin/${value.id}`,
});
class Port {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  messages: Record<string, unknown>[] = [];
  closed = false;
  start() {}
  close() {
    this.closed = true;
  }
  postMessage(message: Record<string, unknown>) {
    this.messages.push(message);
  }
  deliver(message: unknown) {
    this.onmessage?.({ data: message } as MessageEvent);
  }
}
const active: RuntimeSurfaceHost[] = [];
afterEach(() => {
  active.splice(0).forEach((host) => host.stop());
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture(enabled = true, builtIn = false) {
  const clock = new ManualClock({ wallMs: NOW });
  const ports: Port[] = [];
  const diagnostics: string[] = [];
  const grants: SurfaceGrant[] = [];
  const definition = defineRuntimePlugin({
    id: "emergency",
    tier: "emergency",
    manifestTypes: ["notice"],
    surfaces: ["corner.bottom-left"],
    create: () => ({
      mount() {},
      update: () =>
        builtIn ? [{ slot: "corner.bottom-left", priority: -1000 }] : [],
      render: (grant) => grants.push(grant),
      dispose() {},
    }),
  });
  const host = new RuntimeSurfaceHost({
    clock,
    plugins: [{ dir: "emergency", definition }],
    animationScale: 1,
    reducedMotion: () => false,
    mediaUrl: () => "",
    stage: () => null,
    diagnostic: (id, message) => diagnostics.push(`${id}: ${message}`),
    externalPluginFrames: enabled,
    createPluginChannel: () => {
      const port1 = new Port();
      ports.push(port1);
      return { port1, port2: new Port() } as unknown as MessageChannel;
    },
  });
  active.push(host);
  document.body.appendChild(host.element);
  const value = entry();
  host.setEntries([value], 0, [binding(value)]);
  const frame = host.element.querySelector("iframe");
  function attach(frame: HTMLIFrameElement | null) {
    if (!frame?.contentWindow) throw new Error("no frame");
    const init = vi.spyOn(frame.contentWindow, "postMessage");
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame.contentWindow,
        origin: "null",
        data: {
          protocol: PLUGIN_SURFACE_PROTOCOL,
          kind: "frame-hello",
          helloToken: new URL(frame.src).hash.slice(1),
        },
      }),
    );
    const message = init.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    const port = ports.at(-1)!;
    const claim = (value: unknown, revision = Number(message.revision)) => {
      port.deliver({
        protocol: PLUGIN_SURFACE_PROTOCOL,
        nonce: message.nonce,
        revision,
        kind: "claim",
        value,
      });
      clock.advance(0);
    };
    return { message, port, claim };
  }
  return { clock, host, ports, diagnostics, value, frame, attach, grants };
}

describe("external plugin execution", () => {
  it("requires the separate host capability and the exact unique frame identity", () => {
    expect(fixture(false).frame).toBeNull();
    const value = entry();
    expect(pluginFrameURI(value, [])).toBeNull();
    expect(pluginFrameURI(value, [null as never])).toBeNull();
    expect(
      pluginFrameURI(value, [
        { ...binding(value), packageDigest: { toString: 12 } as never },
      ]),
    ).toBeNull();
    expect(
      pluginFrameURI(value, [{ ...binding(value), packageId: "other" }]),
    ).toBeNull();
    expect(pluginFrameURI(value, [binding(value), binding(value)])).toBeNull();
    expect(
      pluginFrameURI(value, [
        { ...binding(value), uri: "javascript:alert(1)" },
      ]),
    ).toBeNull();
    expect(
      pluginFrameURI(value, [
        { ...binding(value), uri: "https://secret@frames.local/frame" },
      ]),
    ).toBeNull();
    expect(pluginFrameURI(value, [binding(value)])).toBe(binding(value).uri);
  });
  it("bounds state, nesting, deadlines and verified surface declarations", () => {
    const value = entry();
    expect(parseExternalEntry(value, NOW)).toEqual(value);
    expect(
      parseExternalEntry(
        {
          ...value,
          package: { ...value.package, packageDigest: { toString: 12 } },
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseExternalEntry({ ...value, validUntil: { toString: 12 } }, NOW),
    ).toBeNull();
    expect(
      parseExternalEntry(
        { ...value, validUntil: new Date(NOW).toISOString() },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseExternalEntry(
        { ...value, state: { text: "x".repeat(16 * 1024) } },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseExternalEntry(
        { ...value, runtime: { tier: "root", surfaces: ["overlay"] } },
        NOW,
      ),
    ).toBeNull();
    let deep: unknown = null;
    for (let n = 0; n < 20; n++) deep = { deep };
    expect(boundedPluginJSON(deep, 32768)).toBe(false);
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(boundedPluginJSON(cyclic, 32768)).toBe(false);
    expect(boundedPluginJSON({ n: Infinity }, 32768)).toBe(false);
  });
  it("binds only an opaque document from the exact window and fragment token", () => {
    const { frame, attach, ports } = fixture();
    const hello = {
      protocol: PLUGIN_SURFACE_PROTOCOL,
      kind: "frame-hello",
      helloToken: new URL(frame!.src).hash.slice(1),
    };
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        origin: "null",
        data: hello,
      }),
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: frame!.contentWindow,
        origin: "https://frames.local",
        data: hello,
      }),
    );
    expect(ports).toHaveLength(0);
    const { message } = attach(frame);
    expect(ports).toHaveLength(1);
    expect(message.state).toEqual({ count: 12 });
    expect(frame!.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame!.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(message).not.toHaveProperty("package");
  });
  it("preserves the iframe across state and corner changes, rejects old revisions, expires locally", () => {
    const { value, host, frame, attach, clock } = fixture();
    const { claim, port, message } = attach(frame);
    frame!.dispatchEvent(new Event("load"));
    claim({ slot: "corner.bottom-left", priority: 0 });
    expect(host.describe().surfaces["corner.bottom-left"]?.plugin).toBe(
      value.id,
    );
    const next = { ...value, state: { count: 13 } };
    host.setEntries([next], 0, [binding(next)]);
    expect(host.element.querySelector("iframe")).toBe(frame);
    expect(port.messages.find((m) => m.kind === "state")?.state).toEqual({
      count: 13,
    });
    claim(
      { slot: "corner.bottom-left", priority: 100 },
      Number(message.revision),
    );
    expect(host.describe().surfaces["corner.bottom-left"]?.plugin).toBe(
      value.id,
    );
    const revision = Number(
      port.messages.find((m) => m.kind === "state")?.revision,
    );
    claim({ slot: "corner.top-right", priority: 0 }, revision);
    expect(host.describe().surfaces["corner.top-right"]?.plugin).toBe(value.id);
    expect(host.element.querySelector("iframe")).toBe(frame);
    clock.advance(76_000);
    expect(host.describe().surfaces["corner.top-right"]).toBeUndefined();
    expect(frame!.parentElement?.style.visibility).toBe("hidden");
  });
  it("uses verified tier arbitration and rejects undeclared slots and caller tiers", () => {
    const { value, host, frame, attach, diagnostics } = fixture(true, true);
    const { claim } = attach(frame);
    claim({ slot: "corner.bottom-left", priority: 1_000_000 });
    expect(host.describe().surfaces["corner.bottom-left"]?.plugin).toBe(
      "emergency",
    );
    claim({ slot: "overlay", priority: 0 });
    expect(() => claim({ slot: { toString: 12 }, priority: 0 })).not.toThrow();
    claim({ slot: "corner.top-right", priority: 0, tier: "emergency" });
    expect(host.describe().surfaces["corner.top-right"]).toBeUndefined();
    expect(diagnostics.some((message) => message.includes("undeclared"))).toBe(
      true,
    );
    expect(
      diagnostics.some((message) => message.includes("names a tier")),
    ).toBe(true);
    expect(value.runtime.tier).toBe("live");
  });
  it("bounds unanswered claims during state handoff without extending them on another update", () => {
    const { host, value, frame, attach, clock } = fixture();
    attach(frame).claim({ slot: "corner.bottom-left", priority: 0 });
    host.setEntries([{ ...value, state: { count: 0 } }], 0, [binding(value)]);
    expect(host.describe().surfaces["corner.bottom-left"]?.plugin).toBe(
      value.id,
    );
    clock.advance(400);
    host.setEntries([{ ...value, state: { count: 1 } }], 0, [binding(value)]);
    clock.advance(100);
    expect(host.describe().surfaces["corner.bottom-left"]).toBeUndefined();
  });
  it("hides at an exact deadline between periodic ticks and releases on sleep", () => {
    const { value, host, frame, attach, clock } = fixture();
    const { claim, port } = attach(frame);
    const next = { ...value, validUntil: new Date(NOW + 7501).toISOString() };
    host.setEntries([next], 0, [binding(next)]);
    claim(
      { slot: "corner.bottom-left", priority: 0 },
      Number(
        port.messages.find((message) => message.kind === "state")?.revision,
      ),
    );
    host.setAwake(false);
    expect(host.describe().surfaces["corner.bottom-left"]).toBeUndefined();
    host.setAwake(true);
    claim(
      { slot: "corner.bottom-left", priority: 0 },
      Number(
        port.messages.filter((message) => message.kind === "state").at(-1)
          ?.revision,
      ),
    );
    clock.advance(7500);
    expect(host.describe().surfaces["corner.bottom-left"]?.plugin).toBe(
      value.id,
    );
    clock.advance(1);
    expect(host.describe().surfaces["corner.bottom-left"]).toBeUndefined();
  });
  it("closes flooding and navigated documents, times out unattached documents", () => {
    const first = fixture();
    const { claim, port } = first.attach(first.frame);
    for (let n = 0; n < 25; n++) claim(null);
    expect(port.closed).toBe(true);
    expect(first.host.element.querySelector("iframe")).toBeNull();
    const second = fixture();
    const attached = second.attach(second.frame);
    second.frame!.dispatchEvent(new Event("load"));
    second.frame!.dispatchEvent(new Event("load"));
    expect(attached.port.closed).toBe(true);
    const third = fixture();
    third.clock.advance(6000);
    expect(third.host.element.querySelector("iframe")).toBeNull();
  });
  it("removes only the named instance, and keeps distinct package identities for identical bytes", () => {
    const { value, host, frame } = fixture();
    const other = entry("other.presence.badge");
    host.setEntries([value, other], 0, [binding(value), binding(other)]);
    expect(host.element.querySelectorAll("iframe")).toHaveLength(2);
    expect(host.element.querySelector("iframe")).toBe(frame);
    host.setEntries([other], 0, [binding(other)]);
    expect(host.element.querySelectorAll("iframe")).toHaveLength(1);
    expect(host.element.querySelector("iframe")?.src).toContain(other.id);
  });
  it("refuses duplicate identities even when a third entry repeats the same identity", () => {
    const { host, value } = fixture();
    host.setEntries([value, value, value], 0, [binding(value)]);
    expect(host.element.querySelector("iframe")).toBeNull();
  });
});
