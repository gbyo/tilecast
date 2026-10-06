import "fake-indexeddb/auto";
import { expect, it } from "vitest";
import {
  authenticate,
  IdentityMismatch,
  type BrowserSession,
} from "./authentication";
import { PlayerAPI } from "./api";
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
    identity,
    key,
    secret,
    metadata,
    () => {},
    new AbortController().signal,
  );
  expect(authenticated.session).toEqual(session);
  expect(calls).toEqual([
    "/api/v1/system/identity",
    "/api/v1/player/browser/session",
  ]);
  for (const store of STORES) {
    expect(
      JSON.stringify(
        await result(db.transaction(store).objectStore(store).getAll()),
      ),
    ).not.toContain(secret);
  }
  db.close();
});

it("silently signs a nonce with the saved non-extractable key when cookies disappear", async () => {
  const db = await openDatabase();
  const key = crypto.randomUUID();
  const identity = {
    ...(await loadIdentity(db, key)),
    slotId: session.slotId,
    bindingId: session.bindingId,
    serverInstallationId: server.installationId,
  };
  const nonce = crypto.randomUUID();
  const requests: { path: string; body?: Record<string, string> }[] = [];
  const api = new PlayerAPI(async (path, options) => {
    const target = String(path);
    const body = options?.body
      ? (JSON.parse(String(options.body)) as Record<string, string>)
      : undefined;
    requests.push({ path: target, body });
    if (target.endsWith("/identity")) return ok(server);
    if (target.endsWith("/session")) return denied();
    if (target.endsWith("/challenge")) return ok({ nonce });
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
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        publicKey,
        signature,
        new TextEncoder().encode(nonce),
      ),
    ).toBe(true);
    return ok(session);
  });
  await authenticate(
    api,
    db,
    identity,
    key,
    null,
    metadata,
    () => {},
    new AbortController().signal,
  );
  expect(requests.map((request) => request.path)).toEqual([
    "/api/v1/system/identity",
    "/api/v1/player/browser/session",
    "/api/v1/player/browser/challenge",
    "/api/v1/player/browser/renew",
  ]);
  expect(
    (await read<{ bindingId: string }>(db, "identity", `device:${key}`))
      ?.bindingId,
  ).toBe(session.bindingId);
  db.close();
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
    return ok(server);
  });
  await expect(
    authenticate(
      api,
      db,
      identity,
      key,
      null,
      metadata,
      () => {},
      new AbortController().signal,
    ),
  ).rejects.toBeInstanceOf(IdentityMismatch);
  expect(count).toBe(1);
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
