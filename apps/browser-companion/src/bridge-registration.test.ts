import { describe, expect, it } from "vitest";
import {
  BRIDGE_SCRIPT_ID,
  bridgeRegistration,
  syncBridgeRegistration,
  type BridgeScripting,
} from "./bridge-registration";

const A = "https://signage.example.org";
const B = "https://lobby.example.net:8443";

function fakeScripting(): BridgeScripting & {
  registered: Map<string, chrome.scripting.RegisteredContentScript>;
} {
  const registered = new Map<
    string,
    chrome.scripting.RegisteredContentScript
  >();
  return {
    registered,
    getRegisteredContentScripts: async (options) =>
      [...registered.values()].filter(
        (script) =>
          options?.ids === undefined || options.ids.includes(script.id),
      ),
    updateContentScripts: async (scripts) => {
      for (const script of scripts) {
        if (!registered.has(script.id))
          throw new Error("nonexistent script id");
        registered.set(script.id, script);
      }
    },
    registerContentScripts: async (scripts) => {
      for (const script of scripts) {
        if (registered.has(script.id)) throw new Error("duplicate script id");
        registered.set(script.id, script);
      }
    },
    unregisterContentScripts: async (options) => {
      for (const id of options?.ids ?? []) {
        if (!registered.delete(id)) throw new Error("nonexistent script id");
      }
    },
  };
}

describe("bridge registration", () => {
  it("covers every granted origin's player path in the top frame", () => {
    expect(bridgeRegistration([A, B, A])).toEqual({
      id: BRIDGE_SCRIPT_ID,
      matches: [`${A}/player/*`, `${B}/player/*`],
      js: ["content.js"],
      runAt: "document_start",
      world: "ISOLATED",
      allFrames: false,
    });
    expect(bridgeRegistration([])).toBeNull();
  });

  it("keeps the first origin's bridge when a second connects", async () => {
    const scripting = fakeScripting();
    await syncBridgeRegistration(scripting, [A]);
    await syncBridgeRegistration(scripting, [A, B]);
    expect(scripting.registered.get(BRIDGE_SCRIPT_ID)?.matches).toEqual([
      `${A}/player/*`,
      `${B}/player/*`,
    ]);
  });

  it("keeps the remaining origins' bridge when one disconnects", async () => {
    const scripting = fakeScripting();
    await syncBridgeRegistration(scripting, [A, B]);
    await syncBridgeRegistration(scripting, [B]);
    expect(scripting.registered.get(BRIDGE_SCRIPT_ID)?.matches).toEqual([
      `${B}/player/*`,
    ]);
    await syncBridgeRegistration(scripting, []);
    expect(scripting.registered.size).toBe(0);
  });
  it("keeps the existing registration if the replacement update fails", async () => {
    const scripting = fakeScripting();
    await syncBridgeRegistration(scripting, [A]);
    const previous = scripting.registered.get(BRIDGE_SCRIPT_ID);
    scripting.updateContentScripts = async () => {
      throw new Error("update failed");
    };

    await expect(syncBridgeRegistration(scripting, [A, B])).rejects.toThrow(
      "update failed",
    );
    expect(scripting.registered.get(BRIDGE_SCRIPT_ID)).toBe(previous);
    expect(scripting.registered.get(BRIDGE_SCRIPT_ID)?.matches).toEqual([
      `${A}/player/*`,
    ]);
  });

  it("does not unregister a script that was not registered", async () => {
    const scripting = fakeScripting();
    await expect(
      syncBridgeRegistration(scripting, []),
    ).resolves.toBeUndefined();
    expect(scripting.registered.size).toBe(0);
  });
});
