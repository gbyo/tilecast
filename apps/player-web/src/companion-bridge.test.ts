import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CapabilityProviderRegistry } from "./capability-providers";
import { CompanionBridge } from "./companion-bridge";

const ORIGIN = "https://signage.example.org";

interface StubWindow {
  location: { origin: string; pathname: string };
  top: unknown;
  listeners: Record<string, ((event: unknown) => void)[]>;
  addEventListener(type: string, listener: (event: unknown) => void): void;
}

function stubWindow(pathname = "/player/lobby"): StubWindow {
  const stub: StubWindow = {
    location: { origin: ORIGIN, pathname },
    top: null,
    listeners: {},
    addEventListener(type, listener) {
      (stub.listeners[type] ??= []).push(listener);
    },
  };
  stub.top = stub;
  return stub;
}

function emit(
  stub: StubWindow,
  data: unknown,
  overrides: { source?: unknown; origin?: string } = {},
) {
  for (const listener of stub.listeners["message"] ?? []) {
    listener({
      source: overrides.source ?? (stub as unknown),
      origin: overrides.origin ?? ORIGIN,
      data,
    });
  }
}

describe("CompanionBridge", () => {
  let stub: StubWindow;
  let posted: { message: unknown; origin: string }[];

  beforeEach(() => {
    stub = stubWindow();
    (globalThis as Record<string, unknown>).window = stub;
    posted = [];
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete (globalThis as Record<string, unknown>).window;
    vi.useRealTimers();
  });

  const bridge = (registry = new CapabilityProviderRegistry()) =>
    new CompanionBridge(registry, "9.9.9-test", (message, origin) => {
      posted.push({ message, origin });
    });

  it("stays silent without a companion", () => {
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    expect(companion.connected).toBe(false);
    expect(registry.describe()).toEqual({});
    expect(posted).toEqual([]);
  });

  it("handshakes and registers the companion provider", () => {
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-hello",
      protocol: 1,
      connectionId: "conn-1",
    });
    expect(companion.connected).toBe(true);
    expect(posted).toEqual([
      {
        message: {
          source: "tilecast-companion",
          kind: "companion-handshake",
          protocol: 1,
          connectionId: "conn-1",
          player: "tilecast-browser-player",
          hostVersion: "9.9.9-test",
        },
        origin: ORIGIN,
      },
    ]);
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-described",
      protocol: 1,
      connectionId: "conn-1",
      id: "handshake",
      capabilities: {
        "display.power": { version: 1, provider: "fake" },
      },
    });
    expect(registry.describe()).toEqual({
      "display.power": { version: 1, provider: "fake" },
    });
  });

  it("routes provider invokes over the bridge", async () => {
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-hello",
      protocol: 1,
      connectionId: "conn-1",
    });
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-described",
      protocol: 1,
      connectionId: "conn-1",
      id: "handshake",
      capabilities: {
        "display.power": { version: 1, provider: "fake" },
      },
    });
    const pending = registry.invokeCommand("display_power_off", {});
    expect(posted).toHaveLength(2);
    const asked = posted[1]?.message as { id: string };
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-result",
      protocol: 1,
      connectionId: "conn-1",
      id: asked.id,
      result: { success: true, code: "fake_ok" },
    });
    await expect(pending).resolves.toEqual({
      success: true,
      code: "fake_ok",
    });
  });

  it("fails invokes past the timeout", async () => {
    vi.useFakeTimers();
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-hello",
      protocol: 1,
      connectionId: "conn-1",
    });
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-described",
      protocol: 1,
      connectionId: "conn-1",
      id: "handshake",
      capabilities: {
        "display.power": { version: 1, provider: "fake" },
      },
    });
    const pending = registry.invokeCommand("display_power_on", {});
    await vi.advanceTimersByTimeAsync(10_001);
    await expect(pending).resolves.toMatchObject({
      success: false,
      code: "companion_timeout",
    });
  });

  it("drops the provider on bye", () => {
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-hello",
      protocol: 1,
      connectionId: "conn-1",
    });
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-described",
      protocol: 1,
      connectionId: "conn-1",
      id: "handshake",
      capabilities: {
        "display.power": { version: 1, provider: "fake" },
      },
    });
    expect(registry.describe()).not.toEqual({});
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-bye",
      protocol: 1,
      connectionId: "conn-1",
    });
    expect(companion.connected).toBe(false);
    expect(registry.describe()).toEqual({});
  });

  it("ignores forgeries and wrong contexts", () => {
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    const hello = {
      source: "tilecast-companion",
      kind: "companion-hello",
      protocol: 1,
      connectionId: "conn-1",
    };
    // Wrong origin.
    emit(stub, hello, { origin: "https://evil.example.org" });
    // Wrong sender.
    emit(stub, hello, { source: {} });
    // Wrong protocol.
    emit(stub, { ...hello, protocol: 2 });
    expect(companion.connected).toBe(false);
    expect(posted).toEqual([]);

    // Framed page: top is someone else.
    stub.top = {};
    emit(stub, hello);
    expect(companion.connected).toBe(false);
    stub.top = stub;

    // Non-player path.
    stub.location.pathname = "/studio/";
    emit(stub, hello);
    expect(companion.connected).toBe(false);
  });

  it("ignores a second hello while connected", () => {
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    const hello = {
      source: "tilecast-companion",
      kind: "companion-hello",
      protocol: 1,
      connectionId: "conn-1",
    };
    emit(stub, hello);
    emit(stub, { ...hello, connectionId: "conn-2" });
    expect(posted).toHaveLength(1);
  });

  it("asks the companion to refresh its set", () => {
    const registry = new CapabilityProviderRegistry();
    const companion = bridge(registry);
    companion.attach();
    companion.refresh();
    expect(posted).toEqual([]);
    emit(stub, {
      source: "tilecast-companion",
      kind: "companion-hello",
      protocol: 1,
      connectionId: "conn-1",
    });
    companion.refresh();
    expect(posted[1]?.message).toMatchObject({
      kind: "companion-describe",
      connectionId: "conn-1",
    });
  });
});
