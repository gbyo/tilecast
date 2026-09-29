/**
 * Studio's implementation of the native bridge protocol, version 1. The
 * normative contract is packages/native-bridge-schema; protocol.test.ts runs
 * this code against that package's shared fixtures.
 */

export const NATIVE_BRIDGE_VERSION = 1;
/** The WebKit script message handler a native host registers. */
export const NATIVE_HANDLER_NAME = "tilecastNative";
/** The function a native host calls to deliver a message to Studio. */
export const NATIVE_RECEIVER_NAME = "tilecastNativeReceiver";

export type NativeCapabilities = { nativeNavigation: boolean };

export const noNativeCapabilities: NativeCapabilities = {
  nativeNavigation: false,
};

export type NavigationCatalogPayload = {
  groups: {
    id: string;
    title?: string;
    items: {
      id: string;
      title: string;
      icon: string;
      mobilePlacement: "primary" | "more";
    }[];
  }[];
};

export type NavigationStatePayload = {
  activeDestinationId: string | null;
  path: string;
};

/** Messages Studio sends, keyed by type. */
export type FrontendToNativePayloads = {
  "config/get": Record<string, never>;
  "frontend/ready": Record<string, never>;
  "navigation/catalog": NavigationCatalogPayload;
  "navigation/state": NavigationStatePayload;
};

export type FrontendToNativeType = keyof FrontendToNativePayloads;

export type NativeToFrontendMessage = {
  type: "navigation/request";
  id?: string;
  payload: { destinationId: string };
};

export type NativeReply =
  | { ok: true; id?: string; payload: Record<string, unknown> }
  | {
      ok: false;
      id?: string;
      error: { code: NativeErrorCode; supportedVersions?: number[] };
    };

export type NativeErrorCode =
  | "malformed"
  | "unknown_type"
  | "unsupported_version"
  | "forbidden"
  | "unavailable";

export type Decoded<Message> =
  | { outcome: "accept"; message: Message }
  | { outcome: "malformed" }
  | { outcome: "unknownType"; type: string }
  | { outcome: "unsupportedVersion"; version: number };

const messageTypePattern = /^[a-z][a-z0-9-]*(\/[a-z][a-z0-9-]*)+$/;
const destinationIdPattern = /^[a-z0-9][a-z0-9._:-]*$/;
const errorCodes = new Set<string>([
  "malformed",
  "unknown_type",
  "unsupported_version",
  "forbidden",
  "unavailable",
]);

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: JsonObject, allowed: readonly string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

export function isDestinationId(value: unknown): value is string {
  return isBoundedString(value, 128) && destinationIdPattern.test(value);
}

/**
 * The version is read first: a message from another protocol version may
 * have a different shape, so nothing else is inspected.
 */
function checkVersion(
  value: unknown,
):
  | { outcome: "malformed" }
  | { outcome: "unsupportedVersion"; version: number }
  | null {
  if (!isObject(value)) return { outcome: "malformed" };
  const version = value.version;
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1
  ) {
    return { outcome: "malformed" };
  }
  if (version !== NATIVE_BRIDGE_VERSION) {
    return { outcome: "unsupportedVersion", version };
  }
  return null;
}

/** Decodes a message a native host delivered to Studio. */
export function decodeNativeMessage(
  value: unknown,
): Decoded<NativeToFrontendMessage> {
  const refused = checkVersion(value);
  if (refused) return refused;
  const envelope = value as JsonObject;
  if (!onlyKeys(envelope, ["version", "id", "type", "payload"])) {
    return { outcome: "malformed" };
  }
  const { id, type, payload } = envelope;
  if (
    !isBoundedString(type, 64) ||
    type.length < 3 ||
    !messageTypePattern.test(type) ||
    (id !== undefined && !isBoundedString(id, 64)) ||
    !isObject(payload)
  ) {
    return { outcome: "malformed" };
  }
  if (type !== "navigation/request") return { outcome: "unknownType", type };
  if (!isDestinationId(payload.destinationId)) return { outcome: "malformed" };
  return {
    outcome: "accept",
    message: {
      type,
      ...(id !== undefined ? { id } : {}),
      payload: { destinationId: payload.destinationId },
    },
  };
}

/** Decodes a native host's reply to a message Studio sent. */
export function decodeNativeReply(value: unknown): Decoded<NativeReply> {
  const refused = checkVersion(value);
  if (refused) return refused;
  const reply = value as JsonObject;
  if (!onlyKeys(reply, ["version", "id", "ok", "payload", "error"])) {
    return { outcome: "malformed" };
  }
  const { id, ok, payload, error } = reply;
  if (id !== undefined && !isBoundedString(id, 64)) {
    return { outcome: "malformed" };
  }
  const withId = id !== undefined ? { id } : {};
  if (ok === true && isObject(payload) && error === undefined) {
    return { outcome: "accept", message: { ok, ...withId, payload } };
  }
  if (ok !== false || payload !== undefined || !isObject(error)) {
    return { outcome: "malformed" };
  }
  const { code, supportedVersions } = error;
  if (typeof code !== "string" || !errorCodes.has(code)) {
    return { outcome: "malformed" };
  }
  if (
    supportedVersions !== undefined &&
    !(
      Array.isArray(supportedVersions) &&
      supportedVersions.every(
        (version) => Number.isInteger(version) && (version as number) >= 1,
      )
    )
  ) {
    return { outcome: "malformed" };
  }
  return {
    outcome: "accept",
    message: {
      ok,
      ...withId,
      error: {
        code: code as NativeErrorCode,
        ...(supportedVersions
          ? { supportedVersions: supportedVersions as number[] }
          : {}),
      },
    },
  };
}

/**
 * The capabilities in a config/get reply payload. A capability that is
 * absent or not exactly true is unavailable.
 */
export function decodeCapabilities(
  payload: Record<string, unknown>,
): NativeCapabilities | null {
  const { protocolVersion, capabilities } = payload;
  if (
    typeof protocolVersion !== "number" ||
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 1 ||
    !isObject(capabilities)
  ) {
    return null;
  }
  return { nativeNavigation: capabilities.nativeNavigation === true };
}

export function frontendMessage<Type extends FrontendToNativeType>(
  type: Type,
  payload: FrontendToNativePayloads[Type],
  id?: string,
) {
  return {
    version: NATIVE_BRIDGE_VERSION,
    ...(id !== undefined ? { id } : {}),
    type,
    payload,
  };
}
