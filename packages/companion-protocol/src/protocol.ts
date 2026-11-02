/**
 * The page-to-content-script protocol. Versioned, bounded, data-only.
 * The Browser Player and the content bridge both validate every field;
 * the service worker revalidates everything the bridge relays, because
 * the content script is not a trust boundary.
 *
 * Wire shape (window.postMessage, same origin, top-level /player/* page):
 * - bridge → page:   {source, kind:"companion-hello", protocol, connectionId}
 * - page → bridge:   {source, kind:"companion-handshake", protocol, connectionId, player, hostVersion}
 * - page → bridge:   {source, kind:"companion-describe", protocol, connectionId, id}
 * - bridge → page:   {source, kind:"companion-described", protocol, connectionId, id, capabilities}
 * - page → bridge:   {source, kind:"companion-invoke", protocol, connectionId, id, operation, input}
 * - bridge → page:   {source, kind:"companion-result", protocol, connectionId, id, result}
 * - either → either: {source, kind:"companion-bye", protocol, connectionId}
 */

export const COMPANION_SOURCE = "tilecast-companion";
export const COMPANION_PROTOCOL = 1;
export const COMPANION_PLAYER_PATH = "/player/";

/** Largest accepted message, measured after JSON encoding. */
export const MAX_MESSAGE_BYTES = 32 * 1024;
/** Largest accepted invoke input, measured after JSON encoding. */
export const MAX_INPUT_BYTES = 4 * 1024;
/** Largest accepted provider result text. */
export const MAX_RESULT_TEXT = 240;
/** Identifiers: connection, request, capability, provider. */
export const MAX_ID_LENGTH = 128;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;
const OPERATION_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9]*)+$/;
const PROVIDER_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;

export interface CompanionCapabilities {
  [capability: string]: { version: number; provider: string };
}

export interface CompanionResult {
  success: boolean;
  code: string;
  message?: string;
}

export type CompanionMessage =
  | {
      source: typeof COMPANION_SOURCE;
      kind: "companion-hello";
      protocol: typeof COMPANION_PROTOCOL;
      connectionId: string;
    }
  | {
      source: typeof COMPANION_SOURCE;
      kind: "companion-handshake";
      protocol: typeof COMPANION_PROTOCOL;
      connectionId: string;
      player: string;
      hostVersion: string;
    }
  | {
      source: typeof COMPANION_SOURCE;
      kind: "companion-describe";
      protocol: typeof COMPANION_PROTOCOL;
      connectionId: string;
      id: string;
    }
  | {
      source: typeof COMPANION_SOURCE;
      kind: "companion-described";
      protocol: typeof COMPANION_PROTOCOL;
      connectionId: string;
      id: string;
      capabilities: CompanionCapabilities;
    }
  | {
      source: typeof COMPANION_SOURCE;
      kind: "companion-invoke";
      protocol: typeof COMPANION_PROTOCOL;
      connectionId: string;
      id: string;
      operation: string;
      input: Record<string, unknown>;
    }
  | {
      source: typeof COMPANION_SOURCE;
      kind: "companion-result";
      protocol: typeof COMPANION_PROTOCOL;
      connectionId: string;
      id: string;
      result: CompanionResult;
    }
  | {
      source: typeof COMPANION_SOURCE;
      kind: "companion-bye";
      protocol: typeof COMPANION_PROTOCOL;
      connectionId: string;
    };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function validCapabilities(value: unknown): value is CompanionCapabilities {
  if (!isRecord(value)) return false;
  const entries = Object.entries(value);
  if (entries.length > 32) return false;
  return entries.every(
    ([id, report]) =>
      OPERATION_PATTERN.test(id) &&
      id.length <= MAX_ID_LENGTH &&
      isRecord(report) &&
      Object.keys(report).length === 2 &&
      typeof report.version === "number" &&
      Number.isInteger(report.version) &&
      (report.version as number) >= 1 &&
      (report.version as number) <= 99 &&
      typeof report.provider === "string" &&
      PROVIDER_PATTERN.test(report.provider as string),
  );
}

function validResult(value: unknown): value is CompanionResult {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  if (
    keys.length < 2 ||
    keys.length > 3 ||
    !keys.includes("success") ||
    !keys.includes("code")
  ) {
    return false;
  }
  if (typeof value.success !== "boolean") return false;
  if (typeof value.code !== "string" || value.code.length > 80) return false;
  return (
    value.message === undefined ||
    (typeof value.message === "string" &&
      value.message.length <= MAX_RESULT_TEXT)
  );
}

function validInput(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  let encoded: string;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return false;
  }
  return encoded.length <= MAX_INPUT_BYTES;
}

/**
 * Validates one protocol message. Total: anything unexpected answers
 * undefined. Callers additionally check the transport facts this pure
 * function cannot see: same-origin sender, top-level frame, /player/*
 * path, and (worker-side) a granted origin with a live connection.
 */
export function parseCompanionMessage(
  value: unknown,
): CompanionMessage | undefined {
  let encoded: string | undefined;
  try {
    encoded = JSON.stringify(value);
  } catch {
    return undefined;
  }
  // stringify answers undefined for undefined, functions, and symbols.
  if (typeof encoded !== "string" || encoded.length > MAX_MESSAGE_BYTES) {
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  if (value.source !== COMPANION_SOURCE) return undefined;
  if (value.protocol !== COMPANION_PROTOCOL) return undefined;
  if (typeof value.connectionId !== "string") return undefined;
  if (!ID_PATTERN.test(value.connectionId)) return undefined;
  switch (value.kind) {
    case "companion-hello":
      if (Object.keys(value).length !== 4) return undefined;
      return value as CompanionMessage;
    case "companion-bye":
      if (Object.keys(value).length !== 4) return undefined;
      return value as CompanionMessage;
    case "companion-handshake":
      if (
        Object.keys(value).length !== 6 ||
        typeof value.player !== "string" ||
        value.player.length > MAX_ID_LENGTH ||
        typeof value.hostVersion !== "string" ||
        value.hostVersion.length > MAX_ID_LENGTH
      ) {
        return undefined;
      }
      return value as CompanionMessage;
    case "companion-describe":
      if (Object.keys(value).length !== 5) return undefined;
      if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
        return undefined;
      }
      return value as CompanionMessage;
    case "companion-described":
      if (Object.keys(value).length !== 6) return undefined;
      if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
        return undefined;
      }
      if (!validCapabilities(value.capabilities)) return undefined;
      return value as CompanionMessage;
    case "companion-invoke":
      if (Object.keys(value).length !== 7) return undefined;
      if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
        return undefined;
      }
      if (
        typeof value.operation !== "string" ||
        !OPERATION_PATTERN.test(value.operation) ||
        value.operation.length > MAX_ID_LENGTH
      ) {
        return undefined;
      }
      if (!validInput(value.input)) return undefined;
      return value as CompanionMessage;
    case "companion-result":
      if (Object.keys(value).length !== 6) return undefined;
      if (typeof value.id !== "string" || !ID_PATTERN.test(value.id)) {
        return undefined;
      }
      if (!validResult(value.result)) return undefined;
      return value as CompanionMessage;
    default:
      return undefined;
  }
}

/** True for an http(s) URL whose path may host the Browser Player. */
export function isPlayerUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return false;
  }
  return parsed.pathname.startsWith(COMPANION_PLAYER_PATH);
}

/** The exact origin pattern a grant request asks Chrome to persist. */
export function originPattern(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return undefined;
  }
  return `${parsed.origin}/*`;
}
