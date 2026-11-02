import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";
import { openDatabase, read, write } from "./database";
import {
  activeGrant,
  commitActivation,
  loadActivation,
  type ActivationFrameResource,
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

const frame = "c".repeat(64);
const frameResource = (): ActivationFrameResource => ({
  digest: frame,
  size: 10,
  mimeType: "text/html",
  packageId: "acme.athletics",
  packageDigest: "sha256:" + "d".repeat(64),
  frameDigest: frame,
});

describe("atomic browser activation and frame grants", () => {
  it("mints kind-pinned frame grants and publishes the frame table", async () => {
    const database = await openDatabase(new IDBFactory());
    await write(database, "objects", digest, object(digest));
    await write(database, "objects", frame, {
      ...object(frame),
      mimeType: "text/html",
    });
    const pending = activation();
    pending.frames = [frameResource()];
    const committed = await commitActivation(database, pending);
    const table = committed.presentation.projection!.widgetFrames!;
    expect(table).toHaveLength(1);
    expect(table[0]).toMatchObject({
      packageId: "acme.athletics",
      packageDigest: "sha256:" + "d".repeat(64),
      frameDigest: frame,
    });
    expect(table[0]!.uri).toMatch(/^\/player\/widget-frame\/1\/[a-f0-9-]{36}$/);
    expect(await activeGrant(database, table[0]!.uri)).toMatchObject({
      kind: "frame",
      digest: frame,
      mimeType: "text/html",
      generation: 1,
    });
    const mediaUri = committed.plugins.media![0]!.uri;
    expect(mediaUri).toMatch(/^\/player\/media\/1\/[a-f0-9-]{36}$/);
    expect(await activeGrant(database, mediaUri)).toMatchObject({
      kind: "media",
    });
    database.close();
  });

  it("never changes active state or grants for an unprepared frame", async () => {
    const database = await openDatabase(new IDBFactory());
    await write(database, "objects", digest, object(digest));
    await write(database, "objects", frame, {
      ...object(frame),
      mimeType: "text/html",
    });
    const pending = activation();
    pending.frames = [frameResource()];
    const first = await commitActivation(database, pending);
    const frameUri = first.presentation.projection!.widgetFrames![0]!.uri;
    const incomplete = activation(2);
    incomplete.frames = [{ ...frameResource(), digest: other }];
    await expect(commitActivation(database, incomplete)).rejects.toThrow(
      "unprepared frame",
    );
    expect((await loadActivation(database, "slot"))?.generation).toBe(1);
    expect(await activeGrant(database, frameUri)).toMatchObject({
      kind: "frame",
      generation: 1,
    });
    database.close();
  });
});
