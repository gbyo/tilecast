/**
 * Host connections of Plugin Manifest API 3: the origin rules and the
 * declaration bounds. The Go SDK (`go/plugin/origin.go` and
 * `connections_v3.go`) is authoritative on the Server; this half applies the
 * same rules in Studio and `pluginctl`. `testdata/origins.json` and the
 * manifest fixtures run in both.
 */

/** The most connections one plugin declares. */
export const MAX_CONNECTIONS = 8;
/** The most fixed origins of one connection. */
export const MAX_CONNECTION_ORIGINS = 8;
export const DEFAULT_MAX_RESPONSE_BYTES = 1 << 20;
export const MIN_MAX_RESPONSE_BYTES = 1 << 10;
export const MAX_MAX_RESPONSE_BYTES = 16 << 20;
export const DEFAULT_TIMEOUT_SECONDS = 10;
export const MAX_TIMEOUT_SECONDS = 60;
export const MAX_ORIGIN_LENGTH = 300;
export const OPERATOR_ORIGIN = "operator";
export const MAX_OAUTH_SCOPES = 16;
export const MAX_OAUTH_SCOPE_LENGTH = 256;
export const MAX_OAUTH_PARAMETERS = 8;
export const MAX_OAUTH_PARAMETER_VALUE = 256;
export const MAX_OAUTH_ENDPOINT_LENGTH = 2048;

/** Authorization request parameters the host sets itself. */
export const RESERVED_OAUTH_PARAMETERS = [
  "response_type",
  "client_id",
  "client_secret",
  "redirect_uri",
  "scope",
  "state",
  "code",
  "code_challenge",
  "code_challenge_method",
  "code_verifier",
  "grant_type",
  "refresh_token",
  "nonce",
] as const;

const labelPattern = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** A parsed origin: a scheme, a host, and an effective port. */
export interface Origin {
  scheme: "https" | "http";
  host: string;
  port: number;
}

function defaultPort(scheme: string): number {
  return scheme === "http" ? 80 : 443;
}

/** The canonical text: lower case, no default port, IPv6 in brackets. */
export function originText(origin: Origin): string {
  const host = origin.host.includes(":") ? `[${origin.host}]` : origin.host;
  return origin.port === defaultPort(origin.scheme)
    ? `${origin.scheme}://${host}`
    : `${origin.scheme}://${host}:${origin.port}`;
}

function parseIPv4(text: string): number[] | null {
  const parts = text.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const part of parts) {
    if (!/^(0|[1-9][0-9]{0,2})$/.test(part)) return null;
    const value = Number(part);
    if (value > 255) return null;
    out.push(value);
  }
  return out;
}

/** Parses an IPv6 address to eight 16-bit groups, or null. */
function parseIPv6(text: string): number[] | null {
  if (text.includes("%")) return null;
  let head = text;
  let tail: number[] = [];
  const lastColon = text.lastIndexOf(":");
  if (text.slice(lastColon + 1).includes(".")) {
    const ipv4 = parseIPv4(text.slice(lastColon + 1));
    if (!ipv4) return null;
    const [a = 0, b = 0, c = 0, d = 0] = ipv4;
    tail = [(a << 8) | b, (c << 8) | d];
    head = text.slice(0, lastColon + 1);
    if (head.endsWith(":") && !head.endsWith("::")) head = head.slice(0, -1);
  }
  const halves = head.split("::");
  if (halves.length > 2) return null;
  const group = (value: string) =>
    /^[0-9a-fA-F]{1,4}$/.test(value) ? parseInt(value, 16) : null;
  const read = (value: string): number[] | null => {
    if (value === "") return [];
    const out: number[] = [];
    for (const piece of value.split(":")) {
      const parsed = group(piece);
      if (parsed === null) return null;
      out.push(parsed);
    }
    return out;
  };
  const left = read(halves[0] ?? "");
  const right = halves.length === 2 ? read(halves[1] ?? "") : [];
  if (!left || !right) return null;
  const known = left.length + right.length + tail.length;
  if (halves.length === 2) {
    if (known > 7) return null;
    return [...left, ...new Array(8 - known).fill(0), ...right, ...tail];
  }
  return known === 8 ? [...left, ...tail] : null;
}

/** RFC 5952 text, as Go's netip prints it. */
function ipv6Text(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < 8; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < 8 && groups[j] === 0) j++;
    if (j - i > bestLength && j - i >= 2) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((value) => value.toString(16));
  if (bestStart < 0) return hex.join(":");
  return `${hex.slice(0, bestStart).join(":")}::${hex.slice(bestStart + bestLength).join(":")}`;
}

/**
 * Reads an origin an operator typed and returns it, or null when it is not
 * an origin: a path, a query, a fragment, user information, a scheme other
 * than http or https, a non-ASCII host, or a localhost name.
 */
export function parseOrigin(raw: string): Origin | null {
  const text = raw.trim();
  if (text === "" || text.length > MAX_ORIGIN_LENGTH) return null;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return null;
  }
  const match = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/(.*)$/.exec(text);
  if (!match) return null;
  const scheme = (match[1] ?? "").toLowerCase();
  if (scheme !== "https" && scheme !== "http") return null;
  const rest = match[2] ?? "";
  if (rest.includes("?") || rest.includes("#")) return null;
  const slash = rest.indexOf("/");
  const authority: string = slash < 0 ? rest : rest.slice(0, slash);
  const path = slash < 0 ? "" : rest.slice(slash);
  if (path !== "" && path !== "/") return null;
  if (authority === "" || authority.includes("@")) return null;
  let hostText: string;
  let portText: string | null = null;
  let bracketed = false;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close < 0) return null;
    hostText = authority.slice(1, close);
    bracketed = true;
    const after = authority.slice(close + 1);
    if (after !== "") {
      if (!after.startsWith(":")) return null;
      portText = after.slice(1);
    }
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon >= 0) {
      if (authority.indexOf(":") !== colon) return null;
      hostText = authority.slice(0, colon);
      portText = authority.slice(colon + 1);
    } else {
      hostText = authority;
    }
  }
  let port = defaultPort(scheme);
  if (portText !== null) {
    if (!/^[1-9][0-9]{0,4}$/.test(portText)) return null;
    port = Number(portText);
    if (port > 65535) return null;
  }
  if (hostText === "") return null;
  const lowered = hostText.toLowerCase();
  if (bracketed) {
    const groups = parseIPv6(lowered);
    if (!groups) return null;
    const [, , , , , marker = 0, high = 0, low = 0] = groups;
    const mapped = groups.slice(0, 5).every((value) => value === 0) && marker === 0xffff;
    const host = mapped
      ? [high >> 8, high & 255, low >> 8, low & 255].join(".")
      : ipv6Text(groups);
    return { scheme, host, port };
  }
  const ipv4 = parseIPv4(lowered);
  if (ipv4) return { scheme, host: ipv4.join("."), port };
  const host = lowered.endsWith(".") ? lowered.slice(0, -1) : lowered;
  if (host.length > 253) return null;
  const labels = host.split(".");
  if (!labels.every((label) => labelPattern.test(label))) return null;
  if (/^[0-9]+$/.test(labels[labels.length - 1] ?? "")) return null;
  if (host === "localhost" || host.endsWith(".localhost")) return null;
  return { scheme, host, port };
}

/** Reads an origin a manifest declares: it must already be canonical. */
export function parseCanonicalOrigin(raw: string): Origin | null {
  const origin = parseOrigin(raw);
  return origin && originText(origin) === raw ? origin : null;
}

/** The input shape of one connection declaration. */
export interface ConnectionDeclarationInput {
  id: string;
  type: string;
  origins: string | readonly string[];
  privateNetwork?: string;
  plainHttp?: string;
  allowPlaintextSecret?: boolean;
  oauth?: {
    authorizationEndpoint: string;
    tokenEndpoint: string;
    revocationEndpoint?: string;
    scopes: readonly string[];
    authorizationParameters?: Readonly<Record<string, string>>;
  };
}

/** An OAuth endpoint: an https URL without a query, fragment, or user. */
export function oauthEndpointProblem(raw: string): string | null {
  if (raw.length > MAX_OAUTH_ENDPOINT_LENGTH) return "is too long";
  if (raw.includes("#") || raw.includes("?") || raw.includes("@"))
    return "must be an https URL without a query, a fragment, or a user name";
  const match = /^https:\/\/([^/]*)(\/.*)?$/.exec(raw);
  if (!match) return "must be an https URL";
  const origin = parseOrigin(`https://${match[1] ?? ""}`);
  if (!origin) return "must be an https URL";
  return null;
}

/** Cross-member rules of one declaration a JSON Schema cannot state. */
export function connectionProblems(
  connection: ConnectionDeclarationInput,
): string[] {
  const where = `connection "${connection.id}"`;
  const problems: string[] = [];
  const operator = connection.origins === OPERATOR_ORIGIN;
  if (!operator && Array.isArray(connection.origins)) {
    const seen = new Set<string>();
    for (const raw of connection.origins) {
      const origin = parseCanonicalOrigin(raw);
      if (!origin) {
        problems.push(`${where}: invalid origin "${raw}"; write it canonically`);
        continue;
      }
      if (origin.scheme !== "https")
        problems.push(`${where} declares ${raw}; a fixed origin must use https`);
      if (seen.has(raw)) problems.push(`${where} declares ${raw} twice`);
      seen.add(raw);
    }
  }
  const plain = connection.plainHttp === "allowed";
  const privateNetwork = connection.privateNetwork === "allowed";
  if (plain && !operator)
    problems.push(`${where} allows plain HTTP; plain HTTP needs origins "operator"`);
  if (plain && !privateNetwork)
    problems.push(
      `${where} allows plain HTTP; plain HTTP reaches only private addresses, so privateNetwork must be "allowed"`,
    );
  if (connection.allowPlaintextSecret && !plain)
    problems.push(`${where} allows a plaintext secret without plainHttp "allowed"`);
  if (connection.type === "oauth2") {
    if (!connection.oauth) problems.push(`${where} has type "oauth2" and needs oauth`);
    if (operator || privateNetwork || plain || connection.allowPlaintextSecret)
      problems.push(
        `${where} is an OAuth connection; it needs fixed https origins and refuses the private network and plain HTTP`,
      );
  } else if (connection.oauth) {
    problems.push(`${where} declares oauth; only type "oauth2" takes it`);
  }
  const oauth = connection.oauth;
  if (oauth) {
    for (const [name, value] of [
      ["authorizationEndpoint", oauth.authorizationEndpoint],
      ["tokenEndpoint", oauth.tokenEndpoint],
      ["revocationEndpoint", oauth.revocationEndpoint],
    ] as const) {
      if (value === undefined) continue;
      const problem = oauthEndpointProblem(value);
      if (problem) problems.push(`${where} oauth ${name} ${problem}`);
    }
    if (new Set(oauth.scopes).size !== oauth.scopes.length)
      problems.push(`${where} oauth has an empty, long, or repeated scope`);
    for (const scope of oauth.scopes)
      if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope))
        problems.push(`${where} oauth scope "${scope}" holds a character a scope cannot hold`);
    for (const [key, value] of Object.entries(oauth.authorizationParameters ?? {})) {
      if (
        !/^[a-z][a-z0-9_]{0,39}$/.test(key) ||
        (RESERVED_OAUTH_PARAMETERS as readonly string[]).includes(key)
      )
        problems.push(`${where} oauth authorization parameter "${key}" is invalid or set by the host`);
      if (!/^[\x20-\x7e]+$/.test(value))
        problems.push(`${where} oauth authorization parameter "${key}" holds a control or non-ASCII character`);
    }
  }
  return problems;
}
