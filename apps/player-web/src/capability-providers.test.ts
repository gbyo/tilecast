import { describe, expect, it, vi } from "vitest";
import {
  CapabilityProviderRegistry,
  encodeCapabilitySet,
  type BrowserCapabilityProvider,
  type TypedCapabilityResult,
} from "./capability-providers";

/**
 * Test-only fake providers prove the bridge. No public capability ships
 * for the bare Browser Player: the first real Companion capability
 * arrives with an actual product need.
 */
function fakeDisplayProvider(
  calls: { operation: string; input: Record<string, unknown> }[] = [],
): BrowserCapabilityProvider & {
  calls: { operation: string; input: Record<string, unknown> }[];
} {
  return {
    id: "fake-display",
    calls,
    describe: () => ({
      "display.power": { version: 1, provider: "fake" },
      "display.volume": { version: 1, provider: "fake" },
    }),
    invoke: async (
      operation: string,
      input: Record<string, unknown>,
    ): Promise<TypedCapabilityResult> => {
      calls.push({ operation, input });
      return { success: true, code: "fake_ok" };
    },
  };
}

describe("CapabilityProviderRegistry", () => {
  it("describes the empty set with no providers", () => {
    const registry = new CapabilityProviderRegistry();
    expect(registry.describe()).toEqual({});
    expect(registry.size).toBe(0);
  });

  it("merges provider reports first-wins", () => {
    const registry = new CapabilityProviderRegistry();
    registry.add(fakeDisplayProvider());
    registry.add({
      id: "late",
      describe: () => ({
        "display.power": { version: 1, provider: "late" },
        "display.mute": { version: 1, provider: "late" },
      }),
      invoke: async () => ({ success: true, code: "late" }),
    });
    expect(registry.describe()).toEqual({
      "display.power": { version: 1, provider: "fake" },
      "display.volume": { version: 1, provider: "fake" },
      "display.mute": { version: 1, provider: "late" },
    });
  });

  it("drops malformed and throwing reports", () => {
    const registry = new CapabilityProviderRegistry();
    registry.add({
      id: "bad",
      describe: () =>
        ({
          "display.power": { version: "1", provider: "fake" },
          "display.mute": { version: 1, provider: "" },
        }) as unknown as ReturnType<BrowserCapabilityProvider["describe"]>,
      invoke: async () => ({ success: true, code: "bad" }),
    });
    registry.add({
      id: "throwing",
      describe: () => {
        throw new Error("boom");
      },
      invoke: async () => ({ success: true, code: "throwing" }),
    });
    expect(registry.describe()).toEqual({});
  });

  it("routes power commands with reconstructed discriminators", async () => {
    const registry = new CapabilityProviderRegistry();
    const provider = fakeDisplayProvider();
    registry.add(provider);
    const off = await registry.invokeCommand("display_power_off", {});
    expect(off).toEqual({ success: true, code: "fake_ok" });
    expect(provider.calls).toEqual([
      { operation: "display.power", input: { state: "off" } },
    ]);
    const on = await registry.invokeCommand("display_power_on", null);
    expect(on?.success).toBe(true);
    expect(provider.calls[1]).toEqual({
      operation: "display.power",
      input: { state: "on" },
    });
  });

  it("routes volume commands with payload passthrough", async () => {
    const registry = new CapabilityProviderRegistry();
    const provider = fakeDisplayProvider();
    registry.add(provider);
    const result = await registry.invokeCommand("display_set_volume", {
      volume: 42,
    });
    expect(result?.success).toBe(true);
    expect(provider.calls).toEqual([
      { operation: "display.volume", input: { volume: 42 } },
    ]);
  });

  it("answers undefined for unrouted commands", async () => {
    const registry = new CapabilityProviderRegistry();
    registry.add(fakeDisplayProvider());
    // No registry route.
    expect(await registry.invokeCommand("sync_now", {})).toBeUndefined();
    // A route whose capability no provider describes.
    expect(
      await registry.invokeCommand("display_set_brightness", {
        brightness: 10,
      }),
    ).toBeUndefined();
    // Unknown entirely.
    expect(await registry.invokeCommand("launch_missiles", {})).toBeUndefined();
  });

  it("answers undefined without providers", async () => {
    const registry = new CapabilityProviderRegistry();
    expect(
      await registry.invokeCommand("display_power_on", {}),
    ).toBeUndefined();
  });

  it("loses capabilities promptly when a provider disconnects", async () => {
    const registry = new CapabilityProviderRegistry();
    registry.add(fakeDisplayProvider());
    expect(registry.provides("display.power", 1)).toBe(true);
    expect(registry.remove("fake-display")).toBe(true);
    expect(registry.describe()).toEqual({});
    expect(registry.provides("display.power", 1)).toBe(false);
    expect(
      await registry.invokeCommand("display_power_on", {}),
    ).toBeUndefined();
    expect(registry.remove("fake-display")).toBe(false);
  });

  it("fails closed on provider errors and bad results", async () => {
    const registry = new CapabilityProviderRegistry();
    registry.add({
      id: "failing",
      describe: () => ({
        "display.power": { version: 1, provider: "failing" },
      }),
      invoke: async () => {
        throw new Error('prov"id"er exploded');
      },
    });
    const failed = await registry.invokeCommand("display_power_on", {});
    expect(failed?.success).toBe(false);
    expect(failed?.code).toBe("provider_failed");

    const registry2 = new CapabilityProviderRegistry();
    registry2.add({
      id: "misshapen",
      describe: () => ({
        "display.power": { version: 1, provider: "misshapen" },
      }),
      invoke: async () => ({ nope: true }) as unknown as TypedCapabilityResult,
    });
    const bad = await registry2.invokeCommand("display_power_on", {});
    expect(bad).toEqual({
      success: false,
      code: "provider_bad_result",
      message: "The provider answered outside its result shape.",
    });
  });

  it("caps provider result text", async () => {
    const registry = new CapabilityProviderRegistry();
    registry.add({
      id: "chatty",
      describe: () => ({
        "display.power": { version: 1, provider: "chatty" },
      }),
      invoke: async () => ({
        success: true,
        code: "x".repeat(200),
        message: "y".repeat(500),
      }),
    });
    const result = await registry.invokeCommand("display_power_on", {});
    expect(result?.code).toHaveLength(80);
    expect(result?.message).toHaveLength(240);
  });

  it("encodes sets stably for change tracking", () => {
    expect(encodeCapabilitySet({})).toBe("[]");
    const a = encodeCapabilitySet({
      "display.volume": { version: 1, provider: "fake" },
      "display.power": { version: 1, provider: "fake" },
    });
    const b = encodeCapabilitySet({
      "display.power": { version: 1, provider: "fake" },
      "display.volume": { version: 1, provider: "fake" },
    });
    expect(a).toBe(b);
    expect(
      encodeCapabilitySet({
        "display.power": { version: 1, provider: "other" },
      }),
    ).not.toBe(a);
  });

  it("ignores describe exceptions during routing", async () => {
    const registry = new CapabilityProviderRegistry();
    const flaky = {
      id: "flaky",
      fail: false,
      describe() {
        if (this.fail) throw new Error("gone");
        return { "display.power": { version: 1, provider: "flaky" } };
      },
      invoke: vi.fn(async () => ({ success: true, code: "ok" })),
    };
    registry.add(flaky);
    flaky.fail = true;
    expect(
      await registry.invokeCommand("display_power_on", {}),
    ).toBeUndefined();
    expect(flaky.invoke).not.toHaveBeenCalled();
  });
});
