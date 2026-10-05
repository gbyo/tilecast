/**
 * Strict parser for Tilecast pairing approval URLs carried by Player QR
 * codes. Scanned text is hostile input: this accepts only an approval URL,
 * and the scanned host never becomes trusted. Studio resolves the extracted
 * visible pairing code against its already verified active server.
 */

/** The server pairing alphabet: ambiguous characters are excluded. */
export const PAIRING_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

/** Longest QR payload the native bridge delivers. */
export const MAX_QR_PAYLOAD_LENGTH = 4096;

const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PairingQrFailure =
  "not_pairing_url" | "wrong_installation" | "wrong_server";

export type PairingQrResult =
  { ok: true; code: string } | { ok: false; reason: PairingQrFailure };

export type ActiveServer = {
  /** Exactly window.location.origin of the connected Studio. */
  origin: string;
  /** The verified installation id from /api/v1/system/identity. */
  installationId: string;
};

/**
 * Normalizes a candidate code the same way the server does: uppercase,
 * spaces and hyphens removed. Returns null when it is not exactly six
 * alphabet characters.
 */
export function normalizePairingCode(value: string): string | null {
  const normalized = value
    .toUpperCase()
    .replaceAll("-", "")
    .replaceAll(" ", "");
  if (normalized.length !== 6) return null;
  for (const character of normalized) {
    if (!PAIRING_CODE_ALPHABET.includes(character)) return null;
  }
  return normalized;
}

const failed = (reason: PairingQrFailure): PairingQrResult => ({
  ok: false,
  reason,
});

/**
 * Parses a scanned QR payload. New-server codes carry ?installation=<id>:
 * when it matches the active verified installation the code is accepted
 * even if the QR origin differs (a hostname alias for the same server).
 * Codes without it are accepted only from the exact connected origin.
 */
export function parsePairingQr(
  value: string,
  active: ActiveServer,
): PairingQrResult {
  if (value.length > MAX_QR_PAYLOAD_LENGTH) return failed("not_pairing_url");
  // Reject whitespace and control characters anywhere in the raw payload.
  // eslint-disable-next-line no-control-regex
  if (/[\s\x00-\x1f\x7f]/.test(value)) return failed("not_pairing_url");
  // Reject malformed percent encoding before URL parsing hides it.
  if (/%(?![0-9a-fA-F]{2})/.test(value)) return failed("not_pairing_url");
  if (!/^https?:\/\//i.test(value)) return failed("not_pairing_url");
  if (value.includes("#")) return failed("not_pairing_url");
  if (value.includes("\\")) return failed("not_pairing_url");

  const beforeQuery = value.split("?", 1)[0] ?? "";
  const rawPath = beforeQuery.replace(/^https?:\/\/[^/]*/i, "");
  if (/(^|\/)\.\.(\/|$)|(^|\/)\.(\/|$)/.test(rawPath)) {
    return failed("not_pairing_url");
  }
  // The approval path is never encoded; any encoding there is ambiguity.
  if (rawPath.includes("%")) return failed("not_pairing_url");

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return failed("not_pairing_url");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return failed("not_pairing_url");
  }
  if (url.username !== "" || url.password !== "") {
    return failed("not_pairing_url");
  }

  const segments = url.pathname.split("/");
  if (
    segments.length !== 4 ||
    segments[1] !== "screens" ||
    segments[2] !== "pair"
  ) {
    return failed("not_pairing_url");
  }
  const code = normalizePairingCode(segments[3] ?? "");
  if (!code) return failed("not_pairing_url");

  const installations = url.searchParams.getAll("installation");
  const disguised = [...url.searchParams.keys()].filter(
    (key) => key.toLowerCase() === "installation" && key !== "installation",
  );
  if (installations.length > 1 || disguised.length > 0) {
    return failed("not_pairing_url");
  }
  const installation = installations[0];
  if (installation !== undefined) {
    if (!uuidPattern.test(installation)) return failed("not_pairing_url");
    if (installation.toLowerCase() !== active.installationId.toLowerCase()) {
      return failed("wrong_installation");
    }
    return { ok: true, code };
  }
  if (url.origin !== active.origin) return failed("wrong_server");
  return { ok: true, code };
}
