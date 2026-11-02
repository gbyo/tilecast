// Wire rules shared by the Worker and the rendezvous Durable Object. The
// relay never decrypts an envelope; it only checks its shape and size.

// A Player stops waiting after 30 minutes, so one slot covers a whole setup
// session. The setup code is shown on the screen, so a long life costs no
// secrecy, and each new slot costs a request, an alarm and row writes.
export const SLOT_LIFETIME_MS = 60 * 60 * 1000;
export const MAX_ENVELOPE_BYTES = 2048;

export const CloseCode = {
  delivered: 1000,
  unexpectedMessage: 1003,
  expired: 4408,
  replaced: 4409,
} as const;

// 16 random bytes, base64url without padding.
const RENDEZVOUS_HEADER = /^Rendezvous ([A-Za-z0-9_-]{22})$/;

export function rendezvousId(authorization: string | null): string | null {
  return RENDEZVOUS_HEADER.exec(authorization ?? "")?.[1] ?? null;
}

export interface Envelope {
  v: 1;
  epk: string;
  iv: string;
  ct: string;
}

const ENVELOPE_FIELDS = ["ct", "epk", "iv", "v"];
// An uncompressed P-256 point is 65 bytes and starts with 0x04.
const EPHEMERAL_KEY = /^B[A-Za-z0-9_-]{86}$/;
const NONCE = /^[A-Za-z0-9_-]{16}$/;
// The AES-GCM tag alone is 16 bytes (22 characters).
const CIPHERTEXT = /^[A-Za-z0-9_-]{23,1600}$/;

export function parseEnvelope(text: string): Envelope | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (Object.keys(record).sort().join() !== ENVELOPE_FIELDS.join()) {
    return null;
  }
  const { v, epk, iv, ct } = record;
  if (v !== 1) return null;
  if (typeof epk !== "string" || !EPHEMERAL_KEY.test(epk)) return null;
  if (typeof iv !== "string" || !NONCE.test(iv)) return null;
  if (typeof ct !== "string" || !CIPHERTEXT.test(ct)) return null;
  return { v, epk, iv, ct };
}

export async function slotName(id: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(id),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}
