import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import { serveLocalMedia } from "./media-service";
import type { MediaGrant } from "./storage/activation";
import { VerifiedStore } from "./storage/verified-store";
import { memoryStore } from "./test-support/memory-store";

const text = "0123456789".repeat(100);
const claim = {
  digest: createHash("sha256").update(text).digest("hex"),
  size: text.length,
  mimeType: "video/mp4",
};
const grant: MediaGrant = {
  slotId: "slot",
  bindingId: "binding",
  activationId: "activation",
  generation: 1,
  trustedAt: 1,
  ...claim,
};
const uri = "/player/media/1/11111111-1111-4111-8111-111111111111";
const request = (method = "GET", range?: string) =>
  new Request(`https://signage.example.org${uri}`, {
    method,
    headers: range ? { Range: range } : {},
  });

async function harness() {
  const memory = memoryStore();
  let hashers = 0;
  const store = new VerifiedStore(memory.index, memory.files, 10_000, () => 1, {
    hasher: () => {
      hashers++;
      return sha256.create();
    },
  });
  await store.prepare(claim, async () => new Response(text));
  return { ...memory, store, hashers: () => hashers };
}

describe("activation-bound local media", () => {
  it("serves many ranges from one verified object without hashing it again", async () => {
    const h = await harness();
    expect(h.hashers()).toBe(1);
    let reads = 0;
    const dependencies = {
      authorized: async () => true,
      grant: async () => grant,
      read: async (value: MediaGrant) => {
        reads++;
        return h.store.trusted(value);
      },
    };
    for (let offset = 0; offset < 900; offset += 100) {
      const response = await serveLocalMedia(
        request("GET", `bytes=${offset}-${offset + 99}`),
        dependencies,
      );
      expect(response.status).toBe(206);
      expect(response.headers.get("Content-Range")).toBe(
        `bytes ${offset}-${offset + 99}/${text.length}`,
      );
      expect(await response.text()).toBe(text.slice(offset, offset + 100));
    }
    expect(reads).toBe(9);
    // One hash while the object was committed and none for nine range reads.
    expect(h.hashers()).toBe(1);
  });

  it("answers GET, HEAD, an unsatisfiable range and a bad method correctly", async () => {
    const h = await harness();
    const dependencies = {
      authorized: async () => true,
      grant: async () => grant,
      read: (value: MediaGrant) => h.store.trusted(value),
    };
    const full = await serveLocalMedia(request(), dependencies);
    expect(full.status).toBe(200);
    expect(full.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(full.headers.get("Cache-Control")).toBe("no-store");
    const head = await serveLocalMedia(request("HEAD"), dependencies);
    expect(head.status).toBe(200);
    expect(head.headers.get("Content-Length")).toBe(String(text.length));
    expect(await head.text()).toBe("");
    const bad = await serveLocalMedia(
      request("GET", `bytes=${text.length}-`),
      dependencies,
    );
    expect(bad.status).toBe(416);
    expect(bad.headers.get("Content-Range")).toBe(`bytes */${text.length}`);
    const post = await serveLocalMedia(request("POST"), dependencies);
    expect(post.status).toBe(405);
  });

  it("serves nothing without a live authorization and a current grant", async () => {
    const h = await harness();
    const read = (value: MediaGrant) => h.store.trusted(value);
    expect(
      (
        await serveLocalMedia(request(), {
          authorized: async () => false,
          grant: async () => grant,
          read,
        })
      ).status,
    ).toBe(404);
    expect(
      (
        await serveLocalMedia(request(), {
          authorized: async () => true,
          grant: async () => undefined,
          read,
        })
      ).status,
    ).toBe(404);
    // A grant revoked while bytes were being read is not honored.
    let calls = 0;
    expect(
      (
        await serveLocalMedia(request(), {
          authorized: async () => true,
          grant: async () => (++calls === 1 ? grant : undefined),
          read,
        })
      ).status,
    ).toBe(404);
  });

  it("invalidates metadata whose bytes are gone or the wrong size", async () => {
    const h = await harness();
    h.bytes.set(claim.digest, new Blob(["short"]));
    expect(await h.store.trusted(claim)).toBeUndefined();
    expect(h.metadata.has(claim.digest)).toBe(false);
    expect(h.bytes.has(claim.digest)).toBe(false);
    const gone = await harness();
    gone.bytes.delete(claim.digest);
    await gone.store.reconcile();
    expect(gone.metadata.has(claim.digest)).toBe(false);
  });

  it("removes bytes with no metadata during reconciliation", async () => {
    const h = await harness();
    h.bytes.set("f".repeat(64), new Blob(["orphan"]));
    await h.store.reconcile();
    expect([...h.bytes.keys()]).toEqual([claim.digest]);
  });
});
