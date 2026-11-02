// @ts-check
// The shared Tilecast server address policy, as the Players apply it. The
// corpus in packages/player-contracts/fixtures/server-url-policy.json pins
// this copy. A screen applies the policy again after it decrypts the address.

/** @param {string} host */
function isPrivateOrLocalHost(host) {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) {
    return true;
  }
  if (
    h.includes(":") &&
    (h === "::1" ||
      h.startsWith("fc") ||
      h.startsWith("fd") ||
      h.startsWith("fe80"))
  ) {
    return true;
  }
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
  }
  return false;
}

/**
 * @typedef {"empty" | "invalid" | "scheme" | "credentials" | "path" | "insecure"} AddressError
 * @param {string} input
 * @returns {{ ok: true, url: string } | { ok: false, error: AddressError }}
 */
export function normalizeServerUrl(input) {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, error: "empty" };

  // A bare host means HTTPS. The page never downgrades an address.
  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  /** @type {URL} */
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "scheme" };
  }
  if (parsed.username || parsed.password) {
    return { ok: false, error: "credentials" };
  }
  if (
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return { ok: false, error: "path" };
  }

  const host = parsed.hostname;
  const policyHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (parsed.protocol === "http:" && !isPrivateOrLocalHost(policyHost)) {
    return { ok: false, error: "insecure" };
  }
  const port = parsed.port ? `:${parsed.port}` : "";
  return { ok: true, url: `${parsed.protocol}//${host}${port}` };
}

/**
 * Reads the setup fragment a screen encodes in its QR code. Returns the
 * canonical fragment to hand to Studio, or null when it is not valid.
 * @param {string} hash
 * @returns {string | null}
 */
export function setupFragment(hash) {
  const params = new URLSearchParams(hash.replace(/^#/, ""));
  const r = params.get("r");
  const k = params.get("k");
  if (params.get("v") !== "1") return null;
  if (r === null || !/^[A-Za-z0-9_-]{22}$/.test(r)) return null;
  if (k === null || !/^B[A-Za-z0-9_-]{86}$/.test(k)) return null;
  return `v=1&r=${r}&k=${k}`;
}

/**
 * @param {string} server a normalized server address
 * @param {string} fragment a canonical setup fragment
 */
export function studioSetupUrl(server, fragment) {
  return `${server}/screens/setup#${fragment}`;
}
