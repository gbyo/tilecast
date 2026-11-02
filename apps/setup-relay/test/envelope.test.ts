// A reference implementation of the setup envelope in docs/phone-setup.md,
// run through the relay. Studio seals; the Player opens. The relay only
// carries the result.
import { exports } from "cloudflare:workers";
import { expect, it } from "vitest";

const INFO = new TextEncoder().encode("tilecast-setup-v1");
const ECDH = { name: "ECDH", namedCurve: "P-256" } as const;

function encode(bytes: ArrayBuffer | Uint8Array): string {
  return btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function decode(text: string): Uint8Array<ArrayBuffer> {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
}

async function aesKey(
  privateKey: CryptoKey,
  peer: Uint8Array<ArrayBuffer>,
  epk: Uint8Array,
  playerKey: Uint8Array,
): Promise<CryptoKey> {
  const publicKey = await crypto.subtle.importKey("raw", peer, ECDH, false, []);
  // The Workers types spell the standard `public` member as `$public`.
  const algorithm = { name: "ECDH", public: publicKey };
  const shared = await crypto.subtle.deriveBits(
    algorithm as unknown as SubtleCryptoDeriveKeyAlgorithm,
    privateKey,
    256,
  );
  const ikm = await crypto.subtle.importKey("raw", shared, "HKDF", false, [
    "deriveKey",
  ]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: concat(epk, playerKey), info: INFO },
    ikm,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

async function seal(id: string, k: string, payload: object) {
  const playerKey = decode(k);
  const ephemeral = (await crypto.subtle.generateKey(ECDH, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const epk = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );
  const key = await aesKey(ephemeral.privateKey, playerKey, epk, playerKey);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(id) },
    key,
    new TextEncoder().encode(JSON.stringify(payload)),
  );
  return { v: 1, epk: encode(epk), iv: encode(iv), ct: encode(ct) };
}

async function open(
  id: string,
  player: CryptoKeyPair,
  playerKey: Uint8Array,
  envelope: { epk: string; iv: string; ct: string },
): Promise<unknown> {
  const epk = decode(envelope.epk);
  const key = await aesKey(player.privateKey, epk, epk, playerKey);
  const plaintext = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: decode(envelope.iv),
      additionalData: new TextEncoder().encode(id),
    },
    key,
    decode(envelope.ct),
  );
  return JSON.parse(new TextDecoder().decode(plaintext));
}

it("carries a sealed server address from Studio to the Player", async () => {
  // Player: a new key pair and setup code for each QR code.
  const player = (await crypto.subtle.generateKey(ECDH, true, [
    "deriveBits",
  ])) as CryptoKeyPair;
  const playerKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", player.publicKey)) as ArrayBuffer,
  );
  const id = encode(crypto.getRandomValues(new Uint8Array(16)));
  const k = encode(playerKey);
  expect(k).toMatch(/^B[A-Za-z0-9_-]{86}$/);

  const response = await exports.default.fetch(
    "https://relay.test/v1/rendezvous",
    { headers: { Upgrade: "websocket", Authorization: `Rendezvous ${id}` } },
  );
  const socket = response.webSocket!;
  const received = new Promise<string>((resolve) =>
    socket.addEventListener("message", (event) => resolve(String(event.data))),
  );
  socket.accept();

  // Studio: seal the address for the key in the QR code and deliver it.
  const payload = {
    serverUrl: "https://signage.example.org",
    installationId: "0b0f4a52-9f1e-4f43-a0a4-6d3f7c1d2e11",
  };
  const delivered = await exports.default.fetch(
    "https://relay.test/v1/rendezvous",
    {
      method: "PUT",
      headers: { Authorization: `Rendezvous ${id}` },
      body: JSON.stringify(await seal(id, k, payload)),
    },
  );
  expect(delivered.status).toBe(202);

  const envelope = JSON.parse(await received);
  expect(await open(id, player, playerKey, envelope)).toEqual(payload);

  // The same envelope cannot be opened for another setup code.
  const other = encode(crypto.getRandomValues(new Uint8Array(16)));
  await expect(open(other, player, playerKey, envelope)).rejects.toThrow();
});

it("opens the shared Player fixture with WebCrypto", async () => {
  const { default: fixture } =
    await import("../../../packages/player-contracts/fixtures/phone-setup-envelope.json");
  const player = await crypto.subtle.importKey(
    "jwk",
    { ...fixture.player.privateKeyJwk, ext: true },
    ECDH,
    false,
    ["deriveBits"],
  );
  const playerKey = decode(fixture.player.publicKey);
  for (const testCase of fixture.cases) {
    const epk = decode(testCase.envelope.epk);
    const peer = await crypto.subtle.importKey("raw", epk, ECDH, false, []);
    const algorithm = { name: "ECDH", public: peer };
    const shared = await crypto.subtle.deriveBits(
      algorithm as unknown as SubtleCryptoDeriveKeyAlgorithm,
      player,
      256,
    );
    expect(encode(shared), testCase.name).toBe(testCase.sharedSecret);
    const opened = open(
      fixture.player.setupCode,
      { privateKey: player, publicKey: player } as CryptoKeyPair,
      playerKey,
      testCase.envelope,
    ).then((payload) => {
      const value = payload as Record<string, unknown>;
      const keys = Object.keys(value).sort().join();
      if (keys !== "installationId,serverUrl") throw new Error("payload");
      return value;
    });
    if (testCase.accepted) {
      expect(await opened, testCase.name).toEqual(testCase.payload);
    } else {
      await expect(opened, testCase.name).rejects.toThrow();
    }
  }
});
