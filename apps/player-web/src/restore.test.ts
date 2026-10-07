import { createHash } from "node:crypto";
import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { restoreLocalActivation } from "./restore";
import { openDatabase } from "./storage/database";
import { IndexedObjects } from "./storage/index";
import {
  activeGrant,
  commitActivation,
  loadActivation,
  type PreparedActivation,
} from "./storage/activation";
import { VerifiedStore } from "./storage/verified-store";
import { memoryStore } from "./test-support/memory-store";

const body = "committed video bytes";
const digest = createHash("sha256").update(body).digest("hex");
const binding = {
  serverInstallationId: "server",
  slotId: "slot",
  bindingId: "binding",
};

async function committed() {
  const database = await openDatabase(new IDBFactory());
  const memory = memoryStore();
  const index = new IndexedObjects(database);
  const store = () => new VerifiedStore(index, memory.files, 10_000);
  await store().prepare(
    { digest, size: body.length, mimeType: "video/mp4" },
    async () => new Response(body),
  );
  const activation: PreparedActivation = await commitActivation(database, {
    ...binding,
    generation: 1,
    activationId: "activation",
    resources: [
      {
        assetId: "a",
        variantId: "v",
        digest,
        size: body.length,
        mimeType: "video/mp4",
      },
    ],
    presentation: {
      type: "presentation",
      presentation: { state: "idle" },
      projection: { schema: 1, clockOffsetMs: 0, manifest: {}, media: [] },
    },
    plugins: { type: "plugins", plugins: [], clockOffsetMs: 0 },
  });
  return { database, memory, store, activation };
}

describe("offline restoration of the last committed activation", () => {
  it("restores an activation whose resources still match, without any server", async () => {
    const h = await committed();
    const restored = await restoreLocalActivation(
      h.database,
      h.store(),
      binding,
    );
    expect(restored?.activationId).toBe("activation");
    const uri = restored!.plugins.media![0]!.uri;
    // The page rehashed the object, so its grant authorizes reads again.
    expect(await activeGrant(h.database, uri)).toMatchObject({
      activationId: "activation",
    });
  });

  it("keeps a grant untrusted while restoration is unverified", async () => {
    const h = await committed();
    const uri = h.activation.plugins.media![0]!.uri;
    h.memory.bytes.set(digest, new Blob(["x".repeat(body.length)]));
    expect(
      await restoreLocalActivation(h.database, h.store(), binding),
    ).toBeUndefined();
    expect(await activeGrant(h.database, uri)).toBeUndefined();
  });

  it.each([
    [
      "a missing object",
      (h: Awaited<ReturnType<typeof committed>>) =>
        h.memory.bytes.delete(digest),
    ],
    [
      "a truncated object",
      (h: Awaited<ReturnType<typeof committed>>) =>
        h.memory.bytes.set(digest, new Blob(["short"])),
    ],
    [
      "a corrupted object",
      (h: Awaited<ReturnType<typeof committed>>) =>
        h.memory.bytes.set(digest, new Blob(["y".repeat(body.length)])),
    ],
  ])("discards the whole activation for %s", async (_name, damage) => {
    const h = await committed();
    damage(h);
    expect(
      await restoreLocalActivation(h.database, h.store(), binding),
    ).toBeUndefined();
    expect(await loadActivation(h.database, "slot")).toBeUndefined();
  });

  it.each([
    [
      "another server installation",
      { ...binding, serverInstallationId: "other" },
    ],
    ["another binding", { ...binding, bindingId: "replaced" }],
  ])("does not restore content committed for %s", async (_name, other) => {
    const h = await committed();
    expect(
      await restoreLocalActivation(h.database, h.store(), other),
    ).toBeUndefined();
    expect(await loadActivation(h.database, "slot")).toBeUndefined();
    expect(
      await activeGrant(h.database, h.activation.plugins.media![0]!.uri),
    ).toBeUndefined();
  });

  it("restores nothing for a browser that was never bound", async () => {
    const h = await committed();
    expect(
      await restoreLocalActivation(h.database, h.store(), {}),
    ).toBeUndefined();
    expect(
      await restoreLocalActivation(h.database, h.store(), {
        serverInstallationId: "server",
        slotId: "slot",
      }),
    ).toBeUndefined();
    // Not bound is not the same as invalid: the activation is left alone.
    expect(await loadActivation(h.database, "slot")).toBeDefined();
  });
});
