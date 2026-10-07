import { expect, it } from "vitest";
import { storageFacts } from "./persistence";

it("reports best effort when persistence is denied, with measured quota", async () => {
  const storage = {
    persisted: async () => false,
    persist: async () => false,
    estimate: async () => ({ quota: 1000, usage: 250 }),
  } as StorageManager;
  expect(await storageFacts(storage, true)).toEqual({
    persistenceRequested: true,
    persistenceGranted: false,
    quotaBytes: 1000,
    usageBytes: 250,
    availableBytes: 750,
  });
});

it("does not invent storage measurements when browser APIs fail", async () => {
  const storage = {
    persisted: async () => {
      throw new Error("Unavailable");
    },
    estimate: async () => {
      throw new Error("Unavailable");
    },
  } as unknown as StorageManager;
  expect(await storageFacts(storage, true)).toEqual({
    persistenceRequested: true,
    persistenceGranted: false,
  });
});

it("does not request persistence before enrollment", async () => {
  let requested = false;
  const storage = {
    persisted: async () => false,
    persist: async () => {
      requested = true;
      return true;
    },
    estimate: async () => ({}),
  } as StorageManager;
  await storageFacts(storage, false);
  expect(requested).toBe(false);
});
