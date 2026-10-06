import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { openDatabase, read, write } from "./database";
import {
  activeGrant,
  commitActivation,
  loadActivation,
  type PreparedActivation,
} from "./activation";
import type { VerifiedObject } from "./verified-store";

const digest = "a".repeat(64);
const other = "b".repeat(64);
const object = (key: string): VerifiedObject => ({
  digest: key,
  size: 10,
  mimeType: "video/mp4",
  verifiedAt: 1,
  lastUsedAt: 1,
  pins: [],
});
const activation = (generation = 1): PreparedActivation => ({
  slotId: "slot",
  bindingId: "binding",
  serverInstallationId: "server",
  generation,
  activationId: `activation-${generation}`,
  resources: [
    {
      digest,
      size: 10,
      mimeType: "video/mp4",
      assetId: "asset",
      variantId: "variant",
    },
  ],
  presentation: {
    type: "presentation",
    presentation: { state: "idle" },
    projection: { schema: 1, clockOffsetMs: 0, manifest: {}, media: [] },
  },
  plugins: { type: "plugins", plugins: [], clockOffsetMs: 0 },
});

describe("atomic browser activation and media grants", () => {
  it("never changes active state or grants for an incomplete preparation", async () => {
    const database = await openDatabase(new IDBFactory());
    await write(database, "objects", digest, object(digest));
    const first = await commitActivation(database, activation());
    const uri = first.plugins.media![0]!.uri;
    const incomplete = activation(2);
    incomplete.resources.push({ ...incomplete.resources[0]!, digest: other });
    await expect(commitActivation(database, incomplete)).rejects.toThrow(
      "unprepared",
    );
    expect((await loadActivation(database, "slot"))?.generation).toBe(1);
    expect(await activeGrant(database, uri)).toMatchObject({ generation: 1 });
    database.close();
  });

  it("replaces grants and transfers pins as one transaction", async () => {
    const database = await openDatabase(new IDBFactory());
    await write(database, "objects", digest, object(digest));
    await write(database, "objects", other, {
      ...object(other),
      pins: ["active:another-slot"],
    });
    const first = await commitActivation(database, activation());
    const old = first.plugins.media![0]!.uri;
    const next = activation(2);
    next.resources = [{ ...next.resources[0]!, digest: other }];
    const second = await commitActivation(database, next);
    const current = second.plugins.media![0]!.uri;
    expect(current).not.toBe(old);
    expect(await activeGrant(database, old)).toBeUndefined();
    expect(await activeGrant(database, current)).toMatchObject({
      digest: other,
      generation: 2,
    });
    expect(
      (await read<VerifiedObject>(database, "objects", digest))?.pins,
    ).toEqual([]);
    expect(
      (await read<VerifiedObject>(database, "objects", other))?.pins,
    ).toEqual(["active:another-slot", "active:slot"]);
    expect(second.presentation.projection!.media).toEqual(second.plugins.media);
    database.close();
  });

  it("rejects stale grants when binding metadata is replaced", async () => {
    const database = await openDatabase(new IDBFactory());
    await write(database, "objects", digest, object(digest));
    const saved = await commitActivation(database, activation());
    const uri = saved.plugins.media![0]!.uri;
    await write(database, "activations", "slot", {
      ...saved,
      bindingId: "replacement",
    });
    expect(await activeGrant(database, uri)).toBeUndefined();
    database.close();
  });
});
