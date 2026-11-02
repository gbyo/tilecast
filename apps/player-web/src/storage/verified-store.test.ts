import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VerifiedStore,
  type ObjectFiles,
  type ObjectIndex,
  type ResourceClaim,
  type VerifiedObject,
} from "./verified-store";

const claim = (text: string): ResourceClaim => ({
  digest: createHash("sha256").update(text).digest("hex"),
  size: Buffer.byteLength(text),
  mimeType: "video/mp4",
});

function harness(limit = 100) {
  const metadata = new Map<string, VerifiedObject>();
  const bytes = new Map<string, Blob>();
  let aborted = 0;
  const index: ObjectIndex = {
    list: async () => [...metadata.values()],
    get: async (digest) => metadata.get(digest),
    put: async (object) => {
      metadata.set(object.digest, object);
    },
    remove: async (digest) => {
      metadata.delete(digest);
    },
  };
  const files: ObjectFiles = {
    read: async (digest) => bytes.get(digest),
    remove: async (digest) => {
      bytes.delete(digest);
    },
    partial: async () => {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let closed = false;
      return {
        write: async (chunk) => {
          chunks.push(new Uint8Array(chunk));
        },
        close: async () => {
          closed = true;
        },
        abort: async () => {
          aborted++;
        },
        commit: async (digest) => {
          expect(closed).toBe(true);
          expect(metadata.has(digest)).toBe(false);
          bytes.set(digest, new Blob(chunks));
        },
      };
    },
  };
  const store = new VerifiedStore(index, files, limit, () => 1000);
  return { store, metadata, bytes, aborted: () => aborted };
}

describe("verified browser content store", () => {
  it("registers bytes only after expected size and streamed SHA-256 verification", async () => {
    const h = harness();
    const resource = claim("test video");
    const file = await h.store.prepare(
      resource,
      async () => new Response("test video"),
    );
    expect(await file.text()).toBe("test video");
    expect(h.metadata.get(resource.digest)).toMatchObject({
      size: 10,
      pins: [],
    });
    expect(await (await h.store.verified(resource))?.text()).toBe("test video");
  });

  it.each(["test videX", "short", "test video extra"])(
    "never registers corrupt or truncated bytes: %s",
    async (text) => {
      const h = harness();
      await expect(
        h.store.prepare(claim("test video"), async () => new Response(text)),
      ).rejects.toThrow();
      expect(h.metadata.size).toBe(0);
      expect(h.bytes.size).toBe(0);
      expect(h.aborted()).toBe(1);
    },
  );

  it("never treats a network 206 as a complete verified object", async () => {
    const h = harness();
    await expect(
      h.store.prepare(
        claim("test video"),
        async () => new Response("test video", { status: 206 }),
      ),
    ).rejects.toThrow("Complete");
    expect(h.metadata.size).toBe(0);
  });

  it("repairs corrupt and missing OPFS objects, retaining the activation pin", async () => {
    const h = harness();
    const resource = claim("test video");
    await h.store.prepare(resource, async () => new Response("test video"));
    h.metadata.get(resource.digest)!.pins = ["active"];
    h.bytes.set(resource.digest, new Blob(["test videX"]));
    await h.store.prepare(resource, async () => new Response("test video"));
    expect(h.metadata.get(resource.digest)!.pins).toEqual(["active"]);
    h.bytes.delete(resource.digest);
    await h.store.prepare(resource, async () => new Response("test video"));
    expect(await (await h.store.verified(resource))?.text()).toBe("test video");
  });

  it("evicts deterministically without removing pinned active resources", async () => {
    const h = harness(10);
    const a = claim("aaaa"),
      b = claim("bbbb"),
      c = claim("cccc");
    await h.store.prepare(a, async () => new Response("aaaa"));
    await h.store.prepare(b, async () => new Response("bbbb"));
    h.metadata.get(a.digest)!.pins = ["active"];
    await h.store.prepare(c, async () => new Response("cccc"));
    expect(h.metadata.has(a.digest)).toBe(true);
    expect(h.metadata.has(b.digest)).toBe(false);
    expect(h.metadata.has(c.digest)).toBe(true);
    h.metadata.get(c.digest)!.pins = ["active"];
    await expect(
      h.store.prepare(claim("12345"), async () => new Response("12345")),
    ).rejects.toThrow("Active content");
    expect(h.bytes.size).toBe(2);
  });

  it("releases preparation pins left by an ended page so the cache can evict", async () => {
    const h = harness(10);
    const abandoned = claim("aaaa"),
      active = claim("bbbb"),
      incoming = claim("cccc");
    await h.store.prepare(abandoned, async () => new Response("aaaa"));
    await h.store.prepare(active, async () => new Response("bbbb"));
    // A page crashed after pinning `abandoned` and before its release ran.
    h.metadata.get(abandoned.digest)!.pins = ["preparing:page-that-ended"];
    h.metadata.get(active.digest)!.pins = ["active"];
    await h.store.reconcile();
    expect(h.metadata.get(abandoned.digest)!.pins).toEqual([]);
    expect(h.metadata.get(active.digest)!.pins).toEqual(["active"]);
    await h.store.prepare(incoming, async () => new Response("cccc"));
    expect(h.metadata.has(abandoned.digest)).toBe(false);
    expect(h.metadata.has(active.digest)).toBe(true);
    expect(h.metadata.has(incoming.digest)).toBe(true);
  });

  it("aborts an interrupted streamed download and propagates quota errors", async () => {
    const h = harness();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("test"));
      },
      pull(controller) {
        controller.error(
          new DOMException("Storage is full", "QuotaExceededError"),
        );
      },
    });
    await expect(
      h.store.prepare(claim("test video"), async () => new Response(stream)),
    ).rejects.toThrow("Storage is full");
    expect(h.aborted()).toBe(1);
    expect(h.metadata.size).toBe(0);
  });
});
