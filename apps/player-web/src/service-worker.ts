/// <reference lib="webworker" />
import { openDatabase } from "./storage/database";
import { activeGrant } from "./storage/activation";
import { OPFSFiles } from "./storage/opfs";
import { IndexedObjects } from "./storage/index";
import { VerifiedStore } from "./storage/verified-store";
import { mediaResponse } from "./storage/range";

declare const __SHELL_VERSION__: string;
declare const __SHELL_FILES__: string[];
const worker = globalThis as unknown as ServiceWorkerGlobalScope;
const CACHE = `tilecast-player-shell:${__SHELL_VERSION__}`;
const files = new Set(__SHELL_FILES__);
const authorizations = new Map<
  string,
  { clientId: string; resolve(value: boolean): void }
>();

worker.addEventListener("install", (event) => {
  // Updates wait while the old Host plays. No unconditional skipWaiting.
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll([...files])));
});
worker.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      for (const name of await caches.keys()) {
        if (name.startsWith("tilecast-player-shell:") && name !== CACHE)
          await caches.delete(name);
      }
      await worker.clients.claim();
    })(),
  );
});
worker.addEventListener("message", (event) => {
  const message = event.data as {
    type?: string;
    requestId?: string;
    allowed?: boolean;
  };
  if (message?.type === "media-authorization" && message.requestId) {
    const pending = authorizations.get(message.requestId);
    if (
      pending &&
      event.source &&
      "id" in event.source &&
      event.source.id === pending.clientId
    )
      pending.resolve(message.allowed === true);
  }
});

async function authorized(event: FetchEvent): Promise<boolean> {
  if (!event.clientId) return false;
  const client = await worker.clients.get(event.clientId);
  if (!client) return false;
  const url = new URL(client.url);
  if (
    url.origin !== worker.location.origin ||
    !/^\/player(?:\/|$)/.test(url.pathname)
  )
    return false;
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    const finish = (allowed: boolean) => {
      clearTimeout(timer);
      authorizations.delete(requestId);
      resolve(allowed);
    };
    const timer = setTimeout(() => finish(false), 5000);
    authorizations.set(requestId, {
      clientId: event.clientId,
      resolve: finish,
    });
    client.postMessage({
      type: "authorize-media",
      requestId,
      uri: new URL(event.request.url).pathname,
    });
  });
}

async function localMedia(event: FetchEvent): Promise<Response> {
  if (!(await authorized(event)))
    return new Response(null, {
      status: 404,
      headers: { "Cache-Control": "no-store" },
    });
  const database = await openDatabase();
  try {
    const grant = await activeGrant(
      database,
      new URL(event.request.url).pathname,
    );
    if (!grant) return new Response(null, { status: 404 });
    const files = await OPFSFiles.open(worker.navigator.storage);
    const store = new VerifiedStore(
      new IndexedObjects(database),
      files,
      Number.MAX_SAFE_INTEGER,
    );
    // Verify bytes again after browser restarts or external storage eviction.
    const file = await worker.navigator.locks.request(
      "tilecast-player-cas",
      () => store.verified(grant),
    );
    if (!file) return new Response(null, { status: 404 });
    // Recheck the grant after hashing: activation replacement can revoke it.
    if (!(await activeGrant(database, new URL(event.request.url).pathname)))
      return new Response(null, { status: 404 });
    return mediaResponse(event.request, file, grant.mimeType);
  } finally {
    database.close();
  }
}

worker.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== worker.location.origin) return;
  if (/^\/player\/media\/\d+\/[a-f0-9-]{36}$/.test(url.pathname)) {
    event.respondWith(
      localMedia(event).catch(() => new Response(null, { status: 503 })),
    );
    return;
  }
  if (event.request.method !== "GET") return;
  if (files.has(url.pathname) && !url.search) {
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) =>
            (await cache.match(url.pathname)) ?? fetch(event.request),
        ),
    );
    return;
  }
  if (
    event.request.mode === "navigate" &&
    /^\/player(?:\/[a-f0-9-]{36})?\/?$/.test(url.pathname)
  ) {
    event.respondWith(
      caches
        .open(CACHE)
        .then(
          async (cache) =>
            (await cache.match("/player/")) ?? fetch(event.request),
        ),
    );
  }
  // All API, Studio and unrelated requests use the normal network boundary.
});
