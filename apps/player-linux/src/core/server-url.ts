/**
 * Server URL normalization and security policy.
 *
 * HTTPS is required for any routable host so device credentials never cross
 * the network in the clear. Private/loopback/link-local hosts and `.local`
 * mDNS names may use plain HTTP because they are inherently LAN-scoped and
 * often have no certificate — this matches the Android ServerUrlPolicy so a
 * screen paired on one platform validates identically on the other. Paths,
 * query strings, fragments, and embedded credentials are rejected.
 */

export interface UrlPolicyResult {
  ok: boolean;
  url?: string;
  error?: string;
}

function isPrivateOrLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  if (h === "localhost" || h.endsWith(".local") || h.endsWith(".localhost")) {
    return true;
  }
  // IPv6 loopback / unique-local / link-local.
  if (
    h === "::1" ||
    h.startsWith("fc") ||
    h.startsWith("fd") ||
    h.startsWith("fe80")
  ) {
    return true;
  }
  // IPv4 ranges: 10/8, 127/8, 169.254/16, 172.16–31/12, 192.168/16.
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 10 || a === 127) {
      return true;
    }
    if (a === 169 && b === 254) {
      return true;
    }
    if (a === 172 && b >= 16 && b <= 31) {
      return true;
    }
    if (a === 192 && b === 168) {
      return true;
    }
  }
  return false;
}

/**
 * Normalize a user- or discovery-provided server address into a canonical
 * origin (scheme + host + optional port), or explain why it is rejected.
 */
export function normalizeServerUrl(input: string): UrlPolicyResult {
  const trimmed = input.trim();
  if (trimmed.length === 0) {
    return { ok: false, error: "Enter a server address" };
  }

  // Default to https:// when no scheme is given so a bare host is treated
  // securely rather than downgraded.
  const withScheme = /^[a-z]+:\/\//i.test(trimmed)
    ? trimmed
    : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    return { ok: false, error: "That is not a valid address" };
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, error: "Address must be http or https" };
  }
  if (parsed.username || parsed.password) {
    return {
      ok: false,
      error: "Address must not contain a username or password",
    };
  }
  if (
    (parsed.pathname && parsed.pathname !== "/") ||
    parsed.search ||
    parsed.hash
  ) {
    return {
      ok: false,
      error: "Enter only the server address, without a path",
    };
  }

  const host = parsed.hostname;
  // WHATWG URL keeps brackets around IPv6 hostnames (for example `[::1]`).
  // The policy helper expects the address itself, so remove those brackets
  // only for classification while preserving them in the canonical URL.
  const policyHost =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (parsed.protocol === "http:" && !isPrivateOrLocalHost(policyHost)) {
    return {
      ok: false,
      error:
        "Public servers must use https:// to protect the device credential",
    };
  }

  // Canonical origin, no trailing slash.
  const portPart = parsed.port ? `:${parsed.port}` : "";
  return { ok: true, url: `${parsed.protocol}//${host}${portPart}` };
}
