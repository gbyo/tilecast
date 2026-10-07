import { IDBFactory } from "fake-indexeddb";
import { expect, it } from "vitest";
import { loadIdentity, signChallenge } from "./identity";
import { openDatabase } from "./storage/database";

it("persists a non-extractable private key and restores the same installation", async () => {
  const database = await openDatabase(new IDBFactory());
  const identity = await loadIdentity(database);
  expect(identity.privateKey.extractable).toBe(false);
  await expect(
    crypto.subtle.exportKey("jwk", identity.privateKey),
  ).rejects.toThrow();
  const restored = await loadIdentity(database);
  expect(restored.installationId).toBe(identity.installationId);
  expect(restored.privateKey.extractable).toBe(false);
  const signature = await signChallenge(restored, "server-challenge");
  const bytes = Uint8Array.from(
    atob(signature.replaceAll("-", "+").replaceAll("_", "/")),
    (character) => character.charCodeAt(0),
  );
  const publicKey = await crypto.subtle.importKey(
    "jwk",
    restored.publicKey,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      bytes,
      new TextEncoder().encode("server-challenge"),
    ),
  ).toBe(true);
  expect(
    await crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      bytes,
      new TextEncoder().encode("other-challenge"),
    ),
  ).toBe(false);
  database.close();
});
