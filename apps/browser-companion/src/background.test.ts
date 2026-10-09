import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkerState } from "./background";
import type { CompanionProvider } from "./providers";

const ORIGIN = "https://signage.example.org";
const PLAYER_URL = `${ORIGIN}/player/lobby`;

/** Test-only fake provider proving the worker bridge. */
function fakeProvider(): CompanionProvider & {
  calls: { operation: string; input: Record<string, unknown> }[];
} {
  const calls: { operation: string; input: Record<string, unknown> }[] = [];
  return {
    id: "fake-display",
    calls,
    describe: () => ({
      "display.power": { version: 1, provider: "fake" },
    }),
    invoke: async (operation, input) => {
      calls.push({ operation, input });
      return { success: true, code: "fake_ok" };
    },
  };
}

function stateWith(provider: CompanionProvider): WorkerState {
  return { origins: [ORIGIN], connections: [], providers: [provider] };
}

let background!: typeof import("./background");

beforeEach(async () => {
  vi.resetModules();
  const store: Record<string, unknown> = {};
  const listeners: ((...args: never[]) => unknown)[] = [];
  (globalThis as Record<string, unknown>).chrome = {
    storage: {
      local: {
        get: async (keys: string[]) =>
          Object.fromEntries(keys.map((key) => [key, store[key]])),
        set: async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        },
        remove: async (keys: string[]) => {
          for (const key of keys) delete store[key];
        },
      },
    },
    runtime: {
      onMessage: {
        addListener: (listener: (...args: never[]) => unknown) => {
          listeners.push(listener);
        },
      },
    },
  };
  background = await import("./background");
  expect(listeners).toHaveLength(1);
});

describe("companion worker", () => {
  it("registers listeners synchronously and loads empty state", async () => {
    const loaded = await background.loadState();
    expect(loaded.origins).toEqual([]);
    expect(loaded.connections).toEqual([]);
    expect(loaded.providers).toEqual([]);
  });

  it("handshakes a player and answers describe from providers", async () => {
    const provider = fakeProvider();
    const state = stateWith(provider);
    const hello = await background.handleBridgeMessage(state, PLAYER_URL, 7, {
      connectionId: "c1",
      message: {
        source: "tilecast-companion",
        kind: "companion-handshake",
        protocol: 1,
        connectionId: "c1",
        player: "tilecast-browser-player",
        hostVersion: "1.0",
      },
    });
    expect(hello?.message).toMatchObject({
      kind: "companion-described",
      capabilities: { "display.power": { version: 1, provider: "fake" } },
    });
    const described = await background.handleBridgeMessage(
      state,
      PLAYER_URL,
      7,
      {
        connectionId: "c1",
        message: {
          source: "tilecast-companion",
          kind: "companion-describe",
          protocol: 1,
          connectionId: "c1",
          id: "r1",
        },
      },
    );
    expect(described?.message).toMatchObject({
      kind: "companion-described",
      id: "r1",
      capabilities: { "display.power": { version: 1, provider: "fake" } },
    });
  });

  it("invokes only described capabilities", async () => {
    const provider = fakeProvider();
    const state = stateWith(provider);
    state.connections.push({
      connectionId: "c1",
      origin: ORIGIN,
      tabId: 7,
      connectedAt: 0,
    });
    const good = await background.handleBridgeMessage(state, PLAYER_URL, 7, {
      connectionId: "c1",
      message: {
        source: "tilecast-companion",
        kind: "companion-invoke",
        protocol: 1,
        connectionId: "c1",
        id: "r1",
        operation: "display.power",
        input: { state: "off" },
      },
    });
    expect(good?.message).toMatchObject({
      kind: "companion-result",
      id: "r1",
      result: { success: true, code: "fake_ok" },
    });
    expect(provider.calls).toEqual([
      { operation: "display.power", input: { state: "off" } },
    ]);
    const undescribed = await background.handleBridgeMessage(
      state,
      PLAYER_URL,
      7,
      {
        connectionId: "c1",
        message: {
          source: "tilecast-companion",
          kind: "companion-invoke",
          protocol: 1,
          connectionId: "c1",
          id: "r2",
          operation: "display.volume",
          input: { volume: 3 },
        },
      },
    );
    expect(undescribed).toBeUndefined();
    expect(provider.calls).toHaveLength(1);
  });

  it("refuses ungranted origins, wrong tabs, and dead connections", async () => {
    const state = stateWith(fakeProvider());
    state.connections.push({
      connectionId: "c1",
      origin: ORIGIN,
      tabId: 7,
      connectedAt: 0,
    });
    const describe = {
      connectionId: "c1",
      message: {
        source: "tilecast-companion",
        kind: "companion-describe",
        protocol: 1,
        connectionId: "c1",
        id: "r1",
      },
    };
    expect(
      await background.handleBridgeMessage(
        state,
        "https://evil.example.org/player/",
        9,
        describe,
      ),
    ).toBeUndefined();
    expect(
      await background.handleBridgeMessage(state, PLAYER_URL, 8, describe),
    ).toBeUndefined();
    expect(
      await background.handleBridgeMessage(state, PLAYER_URL, 7, {
        connectionId: "nope",
        message: { ...describe.message, connectionId: "nope" },
      }),
    ).toBeUndefined();
    expect(
      await background.handleBridgeMessage(
        state,
        `${ORIGIN}/studio/`,
        7,
        describe,
      ),
    ).toBeUndefined();
  });

  it("drops connections on bye", async () => {
    const state = stateWith(fakeProvider());
    state.connections.push({
      connectionId: "c1",
      origin: ORIGIN,
      tabId: 7,
      connectedAt: 0,
    });
    await background.handleBridgeMessage(state, PLAYER_URL, 7, {
      connectionId: "c1",
      message: {
        source: "tilecast-companion",
        kind: "companion-bye",
        protocol: 1,
        connectionId: "c1",
      },
    });
    expect(state.connections).toEqual([]);
  });

  it("persists grants and revocations", async () => {
    expect(await background.grantOrigin(ORIGIN)).toEqual([ORIGIN]);
    expect(await background.grantOrigin(ORIGIN)).toEqual([ORIGIN]);
    const loaded = await background.loadState();
    expect(loaded.origins).toEqual([ORIGIN]);
    await background.revokeOrigin(ORIGIN);
    expect((await background.loadState()).origins).toEqual([]);
  });

  it("bounds provider answers and survives failures", async () => {
    const chatty: CompanionProvider = {
      id: "chatty",
      describe: () => ({
        "display.power": { version: 1, provider: "chatty" },
      }),
      invoke: async () => ({
        success: true,
        code: "x".repeat(200),
        message: "y".repeat(500),
      }),
    };
    const state: WorkerState = {
      origins: [ORIGIN],
      connections: [
        { connectionId: "c1", origin: ORIGIN, tabId: 7, connectedAt: 0 },
      ],
      providers: [chatty],
    };
    const capped = await background.handleBridgeMessage(state, PLAYER_URL, 7, {
      connectionId: "c1",
      message: {
        source: "tilecast-companion",
        kind: "companion-invoke",
        protocol: 1,
        connectionId: "c1",
        id: "r1",
        operation: "display.power",
        input: {},
      },
    });
    expect(capped?.message).toMatchObject({
      result: { success: true, code: "x".repeat(80), message: "y".repeat(240) },
    });

    const failing: CompanionProvider = {
      id: "failing",
      describe: () => ({
        "display.power": { version: 1, provider: "failing" },
      }),
      invoke: async () => {
        throw new Error("boom");
      },
    };
    const failed = await background.handleBridgeMessage(
      { ...state, providers: [failing] },
      PLAYER_URL,
      7,
      {
        connectionId: "c1",
        message: {
          source: "tilecast-companion",
          kind: "companion-invoke",
          protocol: 1,
          connectionId: "c1",
          id: "r2",
          operation: "display.power",
          input: {},
        },
      },
    );
    expect(failed?.message).toMatchObject({
      result: { success: false, code: "provider_failed" },
    });
  });
});
