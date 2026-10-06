import { read, write } from "./storage/database";

export interface BrowserIdentity {
  installationId: string;
  privateKey: CryptoKey;
  publicKey: JsonWebKey;
  serverInstallationId?: string;
  slotId?: string;
  bindingId?: string;
}

/** Caller holds the profile-wide identity Web Lock before creating the key. */
export async function loadIdentity(
  database: IDBDatabase,
  slot = "unmanaged",
): Promise<BrowserIdentity> {
  const key = `device:${slot}`;
  const saved = await read<BrowserIdentity>(database, "identity", key);
  if (saved) {
    if (saved.privateKey.extractable || saved.privateKey.type !== "private") {
      throw new Error("Browser Player device key is invalid");
    }
    return saved;
  }
  const keys = await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign", "verify"],
  );
  const identity: BrowserIdentity = {
    installationId: crypto.randomUUID(),
    privateKey: keys.privateKey,
    publicKey: await crypto.subtle.exportKey("jwk", keys.publicKey),
  };
  await write(database, "identity", key, identity);
  return identity;
}

/** Signs the complete server-issued message. The key never leaves WebCrypto. */
export async function signChallenge(
  identity: BrowserIdentity,
  message: string,
): Promise<string> {
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      identity.privateKey,
      new TextEncoder().encode(message),
    ),
  );
  return btoa(String.fromCharCode(...signature))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}
