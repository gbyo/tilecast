import { createHash } from "node:crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { describe, expect, it } from "vitest";
import {
  authorizeFrameMedia,
  serveLocalFrame,
  serveLocalMedia,
} from "./media-service";
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

const frameHtml = "<!doctype html><html><body>frame</body></html>";
const frameClaim = {
  digest: createHash("sha256").update(frameHtml).digest("hex"),
  size: frameHtml.length,
  mimeType: "text/html",
};
const frameGrant: MediaGrant = {
  slotId: "slot",
  bindingId: "binding",
  activationId: "activation",
  generation: 1,
  trustedAt: 1,
  kind: "frame",
  ...frameClaim,
};
const frameUri = "/player/widget-frame/1/22222222-2222-4222-8222-222222222222";
const frameRequest = () =>
  new Request(`https://signage.example.org${frameUri}`);

async function frameHarness() {
  const memory = memoryStore();
  const store = new VerifiedStore(memory.index, memory.files, 10_000, () => 1);
  await store.prepare(frameClaim, async () => new Response(frameHtml));
  return { ...memory, store };
}

describe("activation-bound sandbox frames", () => {
  it("serves the frame document with the frame response policy", async () => {
    const h = await frameHarness();
    const response = await serveLocalFrame(frameRequest(), {
      authorized: async () => true,
      grant: async () => frameGrant,
      read: (value: MediaGrant) => h.store.trusted(value),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("text/html");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(response.headers.get("X-Frame-Options")).toBe("SAMEORIGIN");
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const policy = response.headers.get("Content-Security-Policy")!;
    expect(policy).toContain("sandbox allow-scripts");
    expect(policy).toContain("default-src 'none'");
    expect(policy).toContain(
      "img-src data: https://signage.example.org/player/media/",
    );
    expect(policy).toContain("connect-src 'none'");
    expect(policy).toContain("worker-src 'none'");
    expect(await response.text()).toBe(frameHtml);
  });

  it("pins each grant to its own route", async () => {
    const h = await frameHarness();
    const media = await harness();
    const frameDependencies = {
      authorized: async () => true,
      grant: async () => frameGrant,
      read: (value: MediaGrant) => h.store.trusted(value),
    };
    const mediaDependencies = {
      authorized: async () => true,
      grant: async () => ({ ...grant, kind: "media" as const }),
      read: (value: MediaGrant) => media.store.trusted(value),
    };
    // A frame grant never serves the media route.
    expect((await serveLocalMedia(request(), frameDependencies)).status).toBe(
      404,
    );
    // A media grant never serves the frame route.
    expect(
      (await serveLocalFrame(frameRequest(), mediaDependencies)).status,
    ).toBe(404);
    // A grant minted before kinds existed is always media.
    expect(
      (
        await serveLocalFrame(frameRequest(), {
          ...mediaDependencies,
          grant: async () => grant,
        })
      ).status,
    ).toBe(404);
    expect((await serveLocalMedia(request(), mediaDependencies)).status).toBe(
      200,
    );
  });

  it("refuses every range with 416 and advertises no ranges", async () => {
    const h = await frameHarness();
    const read = (value: MediaGrant) => h.store.trusted(value);
    const ranged = new Request(`https://signage.example.org${frameUri}`, {
      headers: { Range: "bytes=0-10" },
    });
    const response = await serveLocalFrame(ranged, {
      authorized: async () => true,
      grant: async () => frameGrant,
      read,
    });
    expect(response.status).toBe(416);
    expect(response.headers.get("Accept-Ranges")).toBe("none");
    expect(response.headers.get("Content-Range")).toBe(
      `bytes */${frameHtml.length}`,
    );
    expect(response.headers.get("Content-Security-Policy")).toContain(
      "sandbox allow-scripts",
    );
    const plain = await serveLocalFrame(frameRequest(), {
      authorized: async () => true,
      grant: async () => frameGrant,
      read,
    });
    expect(plain.headers.get("Accept-Ranges")).toBe("none");
  });

  it("serves no frame without a live authorization and a current grant", async () => {
    const h = await frameHarness();
    const read = (value: MediaGrant) => h.store.trusted(value);
    expect(
      (
        await serveLocalFrame(frameRequest(), {
          authorized: async () => false,
          grant: async () => frameGrant,
          read,
        })
      ).status,
    ).toBe(404);
    let calls = 0;
    expect(
      (
        await serveLocalFrame(frameRequest(), {
          authorized: async () => true,
          grant: async () => (++calls === 1 ? frameGrant : undefined),
          read,
        })
      ).status,
    ).toBe(404);
  });
});

describe("frame-aware media authorization", () => {
  const frameUrl = `https://signage.example.org${frameUri}`;
  const media: MediaGrant = { ...grant, kind: "media" };
  const lookup = (overrides: Record<string, MediaGrant | undefined> = {}) => {
    const grants: Record<string, MediaGrant | undefined> = {
      [frameUri]: frameGrant,
      [uri]: media,
      ...overrides,
    };
    return async (path: string) => grants[path];
  };

  it("authorizes same-activation media for a granted frame", async () => {
    expect(await authorizeFrameMedia(frameUrl, uri, lookup())).toBe(true);
  });

  it("refuses when either grant is missing, unkinded, or stale", async () => {
    expect(
      await authorizeFrameMedia(
        frameUrl,
        uri,
        lookup({ [frameUri]: undefined }),
      ),
    ).toBe(false);
    expect(
      await authorizeFrameMedia(frameUrl, uri, lookup({ [uri]: undefined })),
    ).toBe(false);
    // The frame URL must resolve to a frame grant, never a media grant.
    expect(
      await authorizeFrameMedia(frameUrl, uri, lookup({ [frameUri]: media })),
    ).toBe(false);
    // The media URI must resolve to a media grant, never a frame grant.
    expect(
      await authorizeFrameMedia(frameUrl, uri, lookup({ [uri]: frameGrant })),
    ).toBe(false);
  });

  it("refuses media from another slot, binding, activation, or generation", async () => {
    for (const mediaGrant of [
      { ...media, slotId: "other-slot" },
      { ...media, bindingId: "other-binding" },
      { ...media, activationId: "other-activation" },
      { ...media, generation: 2 },
    ]) {
      expect(
        await authorizeFrameMedia(frameUrl, uri, lookup({ [uri]: mediaGrant })),
      ).toBe(false);
    }
  });

  it("refuses non-frame clients without touching the grants", async () => {
    let calls = 0;
    const counting = async (_path: string) => {
      calls++;
      return undefined;
    };
    expect(
      await authorizeFrameMedia(
        "https://signage.example.org/player/",
        uri,
        counting,
      ),
    ).toBe(false);
    expect(await authorizeFrameMedia("not a url", uri, counting)).toBe(false);
    expect(calls).toBe(0);
  });
});
