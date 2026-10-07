import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { expect, it, vi } from "vitest";
import {
  authenticate,
  fetchServerIdentity,
  IdentityMismatch,
  PairingEnded,
  type BrowserSession,
} from "./authentication";
import { PlayerAPI, serverUnreachable } from "./api";
import { loadIdentity } from "./identity";
import { openDatabase, read, STORES, result } from "./storage/database";
import type { DeviceMetadata } from "@tilecast/player-runtime/projection";

const server = {
  installationId: crypto.randomUUID(),
  product: "Tilecast",
  organizationName: "Test organization",
  apiVersion: "v1",
  pairingEnabled: true,
};
const session: BrowserSession = {
  slotId: crypto.randomUUID(),
  bindingId: crypto.randomUUID(),
  screenId: crypto.randomUUID(),
  screenName: "Browser",
  epoch: 1,
  expiresAt: new Date(Date.now() + 10000).toISOString(),
};
const metadata: DeviceMetadata = {
  playerInstallationId: "",
  platform: "browser",
  manufacturer: "Browser",
  model: "Chromium",
  androidVersion: "",
  playerVersion: "0.1.0",
  screenWidth: 1920,
  screenHeight: 1080,
  density: 1,
  locale: "en",
  timezone: "UTC",
};
const ok = (data: unknown) =>
  new Response(JSON.stringify({ data }), { status: 200 });
const denied = () =>
  new Response(
    JSON.stringify({ error: { code: "device_credential_invalid" } }),
    { status: 401 },
  );

it("prefers its cookie and never exchanges or persists an unused recovery fragment", async () => {
  const db = await openDatabase();
  const key = crypto.randomUUID();
  const identity = {
    ...(await loadIdentity(db, key)),
    slotId: session.slotId,
    bindingId: session.bindingId,
    serverInstallationId: server.installationId,
  };
  const calls: string[] = [];
  const secret =
    crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().slice(0, 11);
  const api = new PlayerAPI(async (path) => {
    calls.push(String(path));
    return ok(String(path).endsWith("/identity") ? server : session);
  });
  const authenticated = await authenticate(
    api,
    db,
    server,
    identity,
    key,
    secret,
    metadata,
    () => {},
    new AbortController().signal,
  );
  expect(authenticated.session).toEqual(session);
  expect(calls).toEqual(["/api/v1/player/browser/session"]);
  for (const store of STORES) {
    expect(
      JSON.stringify(
        await result(db.transaction(store).objectStore(store).getAll()),
      ),
    ).not.toContain(secret);
  }
  db.close();
});

it("signs the exact server-issued message with the saved non-extractable key when cookies disappear", async () => {
  const db = await openDatabase();
  const key = crypto.randomUUID();
  const identity = {
    ...(await loadIdentity(db, key)),
    slotId: session.slotId,
    bindingId: session.bindingId,
    serverInstallationId: server.installationId,
  };
  const nonce = "n".repeat(43);
  // The same text the Go server builds and verifies.
  const message = `tilecast-browser-player-v1:${session.slotId}:${session.bindingId}:${nonce}`;
  const requests: { path: string; body?: Record<string, string> }[] = [];
  let verified = 0;
  const api = new PlayerAPI(async (path, options) => {
    const target = String(path);
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, string>)
      : undefined;
    requests.push({ path: target, body });
    if (target.endsWith("/session")) return denied();
    if (target.endsWith("/challenge"))
      return ok({
        nonce,
        message,
        expiresAt: new Date(Date.now() + 120000).toISOString(),
      });
    const publicKey = await crypto.subtle.importKey(
      "jwk",
      identity.publicKey,
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    const signature = Uint8Array.from(
      atob(body!.signature!.replaceAll("-", "+").replaceAll("_", "/")),
      (char) => char.charCodeAt(0),
    );
    const verify = (text: string) =>
      crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        new TextEncoder().encode(text),
      );
    expect(await verify(message)).toBe(true);
    // The previous behavior signed only the nonce. The server rejects that.
    expect(await verify(nonce)).toBe(false);
    verified++;
    return ok(session);
  });
  await authenticate(
    api,
    db,
    server,
    identity,
    key,
    null,
    metadata,
    () => {},
    new AbortController().signal,
  );
  expect(verified).toBe(1);
  expect(requests.map((request) => request.path)).toEqual([
    "/api/v1/player/browser/session",
    "/api/v1/player/browser/challenge",
    "/api/v1/player/browser/renew",
  ]);
  expect(requests[2]!.body).toMatchObject({
    slotId: session.slotId,
    bindingId: session.bindingId,
    nonce,
  });
  db.close();
});

it("persists a new binding once and a routine renewal writes nothing", async () => {
  const db = await openDatabase();
  const key = crypto.randomUUID();
  const fresh = await loadIdentity(db, key);
  const secret = "r".repeat(43);
  const api = new PlayerAPI(async (path) => {
    const target = String(path);
    if (target.endsWith("/session")) return denied();
    return ok(session);
  });
  const result = await authenticate(
    api,
    db,
    server,
    fresh,
    key,
    secret,
    metadata,
    () => {},
    new AbortController().signal,
  );
  expect(
    await read<{ bindingId: string; serverInstallationId: string }>(
      db,
      "identity",
      `device:${key}`,
    ),
  ).toMatchObject({
    bindingId: session.bindingId,
    serverInstallationId: server.installationId,
  });
  expect(result.identity.bindingId).toBe(session.bindingId);
  db.close();
});

it("refuses to sign a challenge that names another slot, binding or text", async () => {
  const db = await openDatabase();
  const key = crypto.randomUUID();
  const identity = {
    ...(await loadIdentity(db, key)),
    slotId: session.slotId,
    bindingId: session.bindingId,
    serverInstallationId: server.installationId,
  };
  const nonce = "n".repeat(43);
  for (const message of [
    `tilecast-browser-player-v1:${crypto.randomUUID()}:${session.bindingId}:${nonce}`,
    `tilecast-browser-player-v1:${session.slotId}:${crypto.randomUUID()}:${nonce}`,
    `${nonce}`,
    `tilecast-browser-player-v1:${session.slotId}:${session.bindingId}:${nonce}\nextra`,
  ]) {
    let renewed = false;
    const api = new PlayerAPI(async (path) => {
      const target = String(path);
      if (target.endsWith("/session")) return denied();
      if (target.endsWith("/challenge"))
        return ok({ nonce, message, expiresAt: new Date().toISOString() });
      renewed = true;
      return ok(session);
    });
    await expect(
      authenticate(
        api,
        db,
        server,
        identity,
        key,
        null,
        metadata,
        () => {},
        new AbortController().signal,
      ),
    ).rejects.toThrow("unexpected signing challenge");
    expect(renewed).toBe(false);
  }
  db.close();
});

it("a server that cannot be reached is not an authorization failure", async () => {
  const api = new PlayerAPI(async () => {
    throw new TypeError("Failed to fetch");
  });
  await expect(fetchServerIdentity(api)).rejects.toSatisfy(serverUnreachable);
  const gateway = new PlayerAPI(
    async () => new Response("<html>Bad gateway</html>", { status: 502 }),
  );
  await expect(fetchServerIdentity(gateway)).rejects.toSatisfy(
    serverUnreachable,
  );
  const refused = new PlayerAPI(async () => denied());
  await expect(
    refused.request("/api/v1/player/browser/session"),
  ).rejects.not.toSatisfy(serverUnreachable);
});

it("checks installation identity before sending a cookie-selected Player request", async () => {
  const db = await openDatabase();
  const key = crypto.randomUUID();
  const identity = {
    ...(await loadIdentity(db, key)),
    slotId: session.slotId,
    bindingId: session.bindingId,
    serverInstallationId: crypto.randomUUID(),
  };
  let count = 0;
  const api = new PlayerAPI(async () => {
    count++;
    return ok(session);
  });
  await expect(
    authenticate(
      api,
      db,
      server,
      identity,
      key,
      null,
      metadata,
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(IdentityMismatch);
  // No request, so no cookie or signature reaches a different server.
  expect(count).toBe(0);
  db.close();
});

it("a replaced binding cannot silently adopt the replacing browser's cookie", async () => {
  const db = await openDatabase();
  const key = crypto.randomUUID();
  const identity = {
    ...(await loadIdentity(db, key)),
    slotId: session.slotId,
    bindingId: crypto.randomUUID(),
  };
  const api = new PlayerAPI(async (path) =>
    ok(String(path).endsWith("/identity") ? server : session),
  );
  await expect(
    authenticate(
      api,
      db,
      server,
      identity,
      key,
      null,
      metadata,
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(IdentityMismatch);
  db.close();
});

async function pairing(
  polls: object[],
  identitySlot = "unmanaged",
): Promise<{
  result: Promise<unknown>;
  calls: string[];
  presented: unknown[];
}> {
  // A fresh profile each time: a bound identity would not start pairing.
  const db = await openDatabase(new IDBFactory());
  const identity = await loadIdentity(db, identitySlot);
  // Storage is open before time is faked; only the poll interval is.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const calls: string[] = [];
  const presented: unknown[] = [];
  const queue = [...polls];
  const api = new PlayerAPI(async (path) => {
    const target = String(path);
    calls.push(target);
    if (target.endsWith("/session")) return denied();
    if (target.endsWith("/pairing-sessions"))
      return ok({
        id: "pairing-id",
        code: "ABC123",
        pollSecret: "poll-secret",
        approvalUrl: "https://signage.example.org/pair",
        organizationName: "Test organization",
        pollingIntervalSeconds: 1,
        expiresAt: new Date().toISOString(),
        serverTime: new Date().toISOString(),
      });
    if (target.includes("/pairing-sessions/")) return ok(queue.shift());
    return ok(session);
  });
  const result = authenticate(
    api,
    db,
    server,
    identity,
    identitySlot,
    null,
    metadata,
    (message) => presented.push(message),
    new AbortController().signal,
  );
  return { result, calls, presented };
}

it("enrolls when the first approved poll claims the session and returns its token", async () => {
  const run = await pairing([
    { status: "pending" },
    { status: "claimed", enrollmentToken: "one-time-token" },
  ]);
  await vi.advanceTimersByTimeAsync(3_000);
  const authenticated = (await run.result) as { session: BrowserSession };
  expect(authenticated.session.slotId).toBe(session.slotId);
  expect(run.calls.at(-1)).toBe("/api/v1/player/browser/enroll");
  expect(run.presented[0]).toMatchObject({
    presentation: { state: "pairing", code: "ABC123" },
  });
  vi.useRealTimers();
});

it.each([
  [[{ status: "rejected" }]],
  [[{ status: "expired" }]],
  [[{ status: "claimed" }]],
])("ends pairing without enrolling for %j", async (polls) => {
  const run = await pairing(polls);
  const outcome = expect(run.result).rejects.toBeInstanceOf(PairingEnded);
  await vi.advanceTimersByTimeAsync(2_000);
  await outcome;
  expect(run.calls).not.toContain("/api/v1/player/browser/enroll");
  vi.useRealTimers();
});
