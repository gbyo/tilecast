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

/** Capabilities the native host offers, from its config/get reply. */
export type NativeCapabilities = {
  nativeNavigation: boolean;
  /** The host keeps a native credential that follows Studio's sign-out. */
  authLifecycle: boolean;
  /** The host presents /__native/modal routes in a native sheet. */
  nativePresentations: boolean;
  /** The host shows a native alert for alert/present, on either page. */
  nativeAlerts: boolean;
};

export const noNativeCapabilities: NativeCapabilities = {
  nativeNavigation: false,
  authLifecycle: false,
  nativePresentations: false,
  nativeAlerts: false,
};

/**
 * The kind of page this document is, as the host's config/get reply says.
 * main is the one Studio page with native navigation and the auth
 * lifecycle; presentation is the page that renders native presentations.
 */
export type BridgeContext = "main" | "presentation";

/** Capabilities Studio reports to the host in frontend/ready. */
export type FrontendCapabilities = {
  authLifecycle?: boolean;
  nativePresentations?: boolean;
  nativeAlerts?: boolean;
};

/**
 * What this Studio supports: it handles auth/sign-out-request, it has the
 * presentation routes and messages, and it handles alert/action.
 */
export const studioCapabilities: FrontendCapabilities = {
  authLifecycle: true,
  nativePresentations: true,
  nativeAlerts: true,
};

/** The one presentation route root a host knows. Studio owns its children. */
export const PRESENTATION_ROOT = "/__native/modal";

/** compact and full are defined; a host shows any other size as full. */
export type PresentationSize = "compact" | "full";

export type PresentationAction = { id: string; label: string; icon: string };

export type PresentationMenuItem = {
  id: string;
  label: string;
  icon?: string;
  disabled?: boolean;
};

/** A complete snapshot of the native header. It replaces the last one. */
export type PresentationHeader = {
  title: string;
  subtitle?: string;
  /** close dismisses; back reports the action id "back". */
  navigation?: "close" | "back";
  navigationLabel?: string;
  menuLabel?: string;
  actions?: PresentationAction[];
  menu?: PresentationMenuItem[];
};

export type PresentationOpenPayload = {
  presentationId: string;
  path: string;
  title: string;
  subtitle?: string;
  size?: PresentationSize;
  dismissible?: boolean;
};

export type PresentationUpdatePayload = {
  presentationId: string;
  header?: PresentationHeader;
  size?: PresentationSize;
  dismissible?: boolean;
};

export type AlertButton = {
  id: string;
  /** Already localized. */
  label: string;
  /** Advisory. The host styles cancel and destructive; anything else is default. */
  role?: "default" | "cancel" | "destructive";
};

export type AlertPresentPayload = {
  alertId: string;
  title: string;
  message?: string;
  /** One to three buttons. */
  actions: AlertButton[];
};

/**
 * The chrome of the current page. With back, the host shows a native
 * navigation bar: a back button labelled with the previous page, and the
 * title. Studio's router decides where back goes, so no path is sent.
 */
export type NavigationChromePayload = {
  title?: string;
  back?: { label: string };
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
  "frontend/ready": { capabilities?: FrontendCapabilities };
  "navigation/catalog": NavigationCatalogPayload;
  "navigation/state": NavigationStatePayload;
  /** Studio finished its own logout. Carries no credential. */
  "auth/signed-out": Record<string, never>;
  /** Main page: present a /__native/modal route natively. */
  "presentation/open": PresentationOpenPayload;
  /** Presentation page: booted, signed in, and listening. */
  "presentation/ready": Record<string, never>;
  "presentation/update": PresentationUpdatePayload;
  "presentation/close": { presentationId: string };
  /** Dismiss, then navigate the main Studio page to path. */
  "presentation/navigate": { presentationId: string; path: string };
  /** Either page: show a native alert. The host answers alert/action. */
  "alert/present": AlertPresentPayload;
  /** Either page: withdraw an alert this page presented. */
  "alert/cancel": { alertId: string };
  /** Main page: describe the native navigation bar for this page. */
  "navigation/chrome": NavigationChromePayload;
};

export type FrontendToNativeType = keyof FrontendToNativePayloads;

/** Messages a native host sends, keyed by type. */
export type NativeToFrontendPayloads = {
  "navigation/request": { destinationId: string };
  /** The host asks Studio to sign out with its normal logout. */
  "auth/sign-out-request": Record<string, never>;
  /** Main page: a presentation asked Studio to navigate here. */
  "navigation/open-path": { path: string };
  /** Presentation page: show this route for this presentation. */
  "presentation/show": { presentationId: string; path: string };
  /** Presentation page: the user chose a header action. */
  "presentation/action": { presentationId: string; actionId: string };
  /** Presentation page: the native sheet went away. */
  "presentation/dismissed": { presentationId: string };
  /** Main page: a presentation ended, so what it changed may be stale. */
  "presentation/ended": { presentationId: string };
  /** The user chose a button of an alert this page presented. */
  "alert/action": { alertId: string; actionId: string };
  /** Main page: the user tapped the native back button. */
  "navigation/back": Record<string, never>;
};

export type NativeToFrontendType = keyof NativeToFrontendPayloads;

export type NativeToFrontendMessage = {
  [Type in NativeToFrontendType]: {
    type: Type;
    id?: string;
    payload: NativeToFrontendPayloads[Type];
  };
}[NativeToFrontendType];

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

/** Presentation and action ids share the destination id pattern. */
export function isOpaqueId(value: unknown): value is string {
  return isBoundedString(value, 64) && destinationIdPattern.test(value);
}

// Whitespace, controls, and backslashes, which browsers read as slashes.
// eslint-disable-next-line no-control-regex
const unsafePathCharacter = /[\s\\\u0000-\u001f\u007f]/;

/** The path component, before any query or fragment. */
function pathComponent(value: string) {
  return value.split(/[?#]/, 1)[0] ?? "";
}

/** A . or .. segment, also percent-encoded, could leave a route tree. */
function hasDotSegment(path: string) {
  return path
    .split("/")
    .some((segment) =>
      [".", ".."].includes(segment.toLowerCase().replaceAll("%2e", ".")),
    );
}

function isSafeRelativePath(value: unknown, max: number): value is string {
  return (
    isBoundedString(value, max) &&
    value.startsWith("/") &&
    !value.startsWith("//") &&
    !unsafePathCharacter.test(value) &&
    !hasDotSegment(pathComponent(value))
  );
}

function isInTree(path: string, root: string) {
  return path === root || path.startsWith(`${root}/`);
}

/**
 * A same-origin path inside the reserved presentation tree. Hosts accept
 * nothing else in presentation/open and presentation/show.
 */
export function isPresentationPath(value: unknown): value is string {
  return (
    isSafeRelativePath(value, 1024) &&
    isInTree(pathComponent(value), PRESENTATION_ROOT)
  );
}

/**
 * An ordinary same-origin Studio path a presentation may navigate the main
 * page to. The reserved /__native tree is never a destination.
 */
export function isStudioPath(value: unknown): value is string {
  return (
    isSafeRelativePath(value, 2048) &&
    !isInTree(pathComponent(value), "/__native")
  );
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
  const withId = id !== undefined ? { id } : {};
  switch (type) {
    case "navigation/request":
      if (!isDestinationId(payload.destinationId)) {
        return { outcome: "malformed" };
      }
      return {
        outcome: "accept",
        message: {
          type,
          ...withId,
          payload: { destinationId: payload.destinationId },
        },
      };
    case "auth/sign-out-request":
      return { outcome: "accept", message: { type, ...withId, payload: {} } };
    case "navigation/open-path":
      if (!isStudioPath(payload.path)) return { outcome: "malformed" };
      return {
        outcome: "accept",
        message: { type, ...withId, payload: { path: payload.path } },
      };
    case "presentation/show":
      if (
        !isOpaqueId(payload.presentationId) ||
        !isPresentationPath(payload.path)
      ) {
        return { outcome: "malformed" };
      }
      return {
        outcome: "accept",
        message: {
          type,
          ...withId,
          payload: {
            presentationId: payload.presentationId,
            path: payload.path,
          },
        },
      };
    case "presentation/action":
      if (
        !isOpaqueId(payload.presentationId) ||
        !isOpaqueId(payload.actionId)
      ) {
        return { outcome: "malformed" };
      }
      return {
        outcome: "accept",
        message: {
          type,
          ...withId,
          payload: {
            presentationId: payload.presentationId,
            actionId: payload.actionId,
          },
        },
      };
    case "navigation/back":
      if (Object.keys(payload).length > 0) return { outcome: "malformed" };
      return { outcome: "accept", message: { type, ...withId, payload: {} } };
    case "alert/action":
      if (!isOpaqueId(payload.alertId) || !isOpaqueId(payload.actionId)) {
        return { outcome: "malformed" };
      }
      return {
        outcome: "accept",
        message: {
          type,
          ...withId,
          payload: {
            alertId: payload.alertId,
            actionId: payload.actionId,
          },
        },
      };
    case "presentation/dismissed":
    case "presentation/ended":
      if (!isOpaqueId(payload.presentationId)) return { outcome: "malformed" };
      return {
        outcome: "accept",
        message: {
          type,
          ...withId,
          payload: { presentationId: payload.presentationId },
        },
      };
    default:
      return { outcome: "unknownType", type };
  }
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
 * The bridge context and capabilities in a config/get reply payload. A
 * capability that is absent or not exactly true is unavailable. A host that
 * names no context predates presentations and is the main page; a context
 * Studio does not know refuses the negotiation, so Studio behaves as in a
 * browser rather than guess what kind of page it is.
 */
export function decodeHostConfig(
  payload: Record<string, unknown>,
): { context: BridgeContext; capabilities: NativeCapabilities } | null {
  const { protocolVersion, capabilities, context = "main" } = payload;
  if (
    typeof protocolVersion !== "number" ||
    !Number.isInteger(protocolVersion) ||
    protocolVersion < 1 ||
    !isObject(capabilities) ||
    (context !== "main" && context !== "presentation")
  ) {
    return null;
  }
  return {
    context,
    capabilities: {
      nativeNavigation: capabilities.nativeNavigation === true,
      authLifecycle: capabilities.authLifecycle === true,
      nativePresentations: capabilities.nativePresentations === true,
      nativeAlerts: capabilities.nativeAlerts === true,
    },
  };
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
