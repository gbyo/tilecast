/**
 * The sandboxed Widget bridge: the narrow message protocol between a host
 * document and an external Widget running in a sandboxed browsing context.
 *
 * Security shape, fixed for the 5c spike and measured by the harness in
 * `test/sandbox-harness/`:
 *
 * - The frame is sandboxed with exactly `allow-scripts`: no same-origin
 *   access, no forms, no popups, no downloads, no pointer lock, no
 *   top navigation. Its origin is opaque, so every legitimate inbound
 *   message event carries the origin `"null"`, and anything else is
 *   rejected before its body is read.
 * - Every placement mints a 128-bit nonce. The parent sends it once with
 *   `init`; the frame echoes it on every report, and the parent drops
 *   anything that does not match. A stale or foreign frame cannot drive
 *   another placement's state.
 * - The parent sends only the Widget contract: bounded config, prepared
 *   data documents, host-authorized media URIs, and a serializable
 *   context snapshot. No credentials, no storage handles, no host
 *   capabilities cross the bridge in either direction.
 * - The frame sends only lifecycle states. Reasons and codes pass
 *   through the same bounded-code rules as trusted Widgets, so a
 *   compromised bundle cannot smuggle markup or unbounded text into
 *   host-rendered UI.
 *
 * This module is pure: no DOM, no network. Both sides of the bridge and
 * the unit tests share it.
 */
import { boundedCode } from "./identity.ts";
import type { WidgetMountState } from "./mount.ts";
import type { WidgetDataDocument, WidgetResources } from "./resources.ts";

/** Wire protocol tag. Bumped only with a frame bootstrap both sides ship. */
export const SANDBOX_BRIDGE_PROTOCOL = "tilecast.widget.bridge/1";

/** The exact `sandbox` attribute the executor sets. No more tokens. */
export const SANDBOX_FRAME_TOKENS = "allow-scripts";

/**
 * Outbound payload ceiling. Prepared documents are already bounded
 * server-side; this is defense in depth against a host bug handing the
 * bridge an unbounded object.
 */
export const MAX_BRIDGE_MESSAGE_BYTES = 4 * 1024 * 1024;

/** A media URI the host authorized for one declared variant. */
export interface SandboxMediaGrant {
  readonly assetId: string;
  readonly variantId: string;
  readonly uri: string;
}

/** The Widget contract, frozen for one frame lifetime or one update. */
export interface SandboxSnapshot {
  readonly component: {
    readonly type: string;
    readonly version: number;
    readonly config: unknown;
  };
  /** Declared data-source IDs to their prepared documents. */
  readonly documents: Readonly<Record<string, WidgetDataDocument>>;
  /** One grant per declared media variant. */
  readonly media: readonly SandboxMediaGrant[];
  readonly context: SandboxContextSnapshot;
}

/** The serializable half of WidgetContext, plus the clock projection. */
export interface SandboxContextSnapshot {
  /** Frame wall time is `Date.now() + wallClockOffsetMs`. */
  readonly wallClockOffsetMs: number;
  readonly locale: string;
  readonly timeZone: string;
  readonly hourCycle: "locale" | "h12" | "h23";
  readonly theme: {
    readonly scheme: "light" | "dark";
    readonly background: string;
    readonly foreground: string;
    readonly accent: string;
  };
  readonly reducedMotion: boolean;
  readonly mode: "playback" | "preview";
}

export type ParentToFrameKind = "init" | "update" | "dispose";

export interface ParentToFrameMessage {
  readonly protocol: typeof SANDBOX_BRIDGE_PROTOCOL;
  readonly nonce: string;
  readonly kind: ParentToFrameKind;
  readonly snapshot?: SandboxSnapshot;
}

export interface FrameStateReport {
  readonly protocol: typeof SANDBOX_BRIDGE_PROTOCOL;
  readonly nonce: string;
  readonly state: WidgetMountState;
}

/** 128 bits of base64url. Throws when no secure RNG is available. */
export function createBridgeNonce(): string {
  const bytes = new Uint8Array(16);
  const crypto = globalThis.crypto;
  if (!crypto?.getRandomValues) {
    throw new Error("sandbox bridge requires crypto.getRandomValues");
  }
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}

export interface DeclaredWidgetInputs {
  readonly dataSources: readonly string[];
  readonly media: ReadonlyArray<{ assetId: string; variantId: string }>;
}

/**
 * Freeze the declared slice of a resources object for one bridge send.
 * Undeclared documents and variants never cross, even when the host
 * object could answer them.
 */
export function snapshotDeclaredResources(
  resources: WidgetResources,
  declared: DeclaredWidgetInputs,
): Pick<SandboxSnapshot, "documents" | "media"> {
  const documents: Record<string, WidgetDataDocument> = {};
  for (const id of declared.dataSources) {
    const document = resources.dataDocument(id);
    if (document !== null) documents[id] = document;
  }
  const media: SandboxMediaGrant[] = [];
  for (const ref of declared.media) {
    const uri = resources.media(ref.assetId, ref.variantId);
    if (uri !== null) {
      media.push({ assetId: ref.assetId, variantId: ref.variantId, uri });
    }
  }
  return { documents, media };
}

/**
 * Enforce the outbound byte ceiling. Messages cross by structured clone,
 * which rejects unserializable values (functions, symbols) instead of
 * silently dropping them; the ceiling additionally bounds honest size.
 */
export function assertBridgeMessageSize(message: unknown): void {
  const encoded = JSON.stringify(message);
  if (encoded === undefined || encoded.length > MAX_BRIDGE_MESSAGE_BYTES) {
    throw new Error(
      `sandbox bridge message is over the ${MAX_BRIDGE_MESSAGE_BYTES} byte limit`,
    );
  }
}

export interface FrameMessageEvent {
  readonly origin: string;
  readonly data: unknown;
}

/**
 * Parse one inbound frame message. Anything from a non-opaque origin,
 * any protocol or nonce mismatch, or any malformed body answers null:
 * the caller drops it without touching placement state.
 */
export function parseFrameMessage(
  event: FrameMessageEvent,
  nonce: string,
): FrameStateReport | null {
  if (event.origin !== "null") return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  const report = data as Partial<FrameStateReport>;
  if (report.protocol !== SANDBOX_BRIDGE_PROTOCOL) return null;
  if (typeof report.nonce !== "string" || report.nonce !== nonce) {
    return null;
  }
  const state = report.state;
  if (typeof state !== "object" || state === null) return null;
  const kind = (state as Partial<WidgetMountState>).state;
  if (kind === "ready") {
    return {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      state: { state: "ready" },
    };
  }
  if (kind === "empty") {
    return {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      state: {
        state: "empty",
        reason: boundedCode(
          (state as { reason?: unknown }).reason,
          "unspecified",
        ),
      },
    };
  }
  if (kind === "error") {
    return {
      protocol: SANDBOX_BRIDGE_PROTOCOL,
      nonce,
      state: {
        state: "error",
        code: boundedCode((state as { code?: unknown }).code, "frame_error"),
      },
    };
  }
  return null;
}
