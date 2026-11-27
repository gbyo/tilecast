/**
 * Pure rules of the Studio connection pages: which consents a declaration
 * offers, what a request may change, and how a status reads. No React here.
 */
import type { ConnectionDeclaration } from "@tilecast/plugin-sdk/manifest";
import {
  DEFAULT_MAX_RESPONSE_BYTES,
  DEFAULT_TIMEOUT_SECONDS,
} from "@tilecast/plugin-sdk/connections";
import type { ConsentWrite, PluginConnection } from "./api";

export type ConsentKey = "privateNetwork" | "plainHttp" | "plaintextSecret";

/** The consents in the order an operator gives them. */
export const CONSENT_ORDER: readonly ConsentKey[] = [
  "privateNetwork",
  "plainHttp",
  "plaintextSecret",
];

export type ConsentDraft = Record<ConsentKey, boolean>;

export function consentDraft(connection: PluginConnection): ConsentDraft {
  return {
    privateNetwork: connection.consents.privateNetwork.given,
    plainHttp: connection.consents.plainHttp.given,
    plaintextSecret: connection.consents.plaintextSecret.given,
  };
}

/**
 * Applies one change to the draft and keeps the layers consistent: plain
 * HTTP needs the private network, and a plaintext secret needs plain HTTP.
 * Turning a lower layer off turns off what depends on it; turning a higher
 * one on never turns on a lower one by itself.
 */
export function toggleConsent(
  draft: ConsentDraft,
  key: ConsentKey,
  on: boolean,
): ConsentDraft {
  const next = { ...draft, [key]: on };
  if (!next.privateNetwork) next.plainHttp = false;
  if (!next.plainHttp) next.plaintextSecret = false;
  return next;
}

/** Whether a consent control can be turned on now. */
export function consentEnabled(draft: ConsentDraft, key: ConsentKey): boolean {
  if (key === "plainHttp") return draft.privateNetwork;
  if (key === "plaintextSecret") return draft.plainHttp;
  return true;
}

export function consentWrite(
  draft: ConsentDraft,
  revision: number,
): ConsentWrite {
  return { ...draft, expectedRevision: revision };
}

/** The consents this change turns on that were off. */
export function grantedConsents(
  before: ConsentDraft,
  after: ConsentDraft,
): ConsentKey[] {
  return CONSENT_ORDER.filter((key) => after[key] && !before[key]);
}

export function sameConsents(a: ConsentDraft, b: ConsentDraft): boolean {
  return CONSENT_ORDER.every((key) => a[key] === b[key]);
}

/** Whether the declaration offers any consent at all. */
export function offersConsents(connection: PluginConnection): boolean {
  return CONSENT_ORDER.some((key) => connection.consents[key].available);
}

/** The connections a connection field accepts, by declaration. */
export function acceptedConnections(
  connections: readonly PluginConnection[],
  accepted: readonly string[] | undefined,
): PluginConnection[] {
  const set = new Set(accepted ?? []);
  return connections.filter((connection) => set.has(connection.definition));
}

/** Declaration facts that differ from the defaults, for the review. */
export function declarationLimits(declaration: ConnectionDeclaration): {
  largerResponse: boolean;
  longerTimeout: boolean;
} {
  return {
    largerResponse:
      (declaration.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES) >
      DEFAULT_MAX_RESPONSE_BYTES,
    longerTimeout:
      (declaration.timeoutSeconds ?? DEFAULT_TIMEOUT_SECONDS) >
      DEFAULT_TIMEOUT_SECONDS,
  };
}

/** Bytes as whole mebibytes or kibibytes for review text. */
export function formatBytes(bytes: number): string {
  if (bytes >= 1 << 20 && bytes % (1 << 20) === 0)
    return `${bytes / (1 << 20)} MiB`;
  if (bytes >= 1 << 10) return `${Math.round(bytes / (1 << 10))} KiB`;
  return `${bytes} B`;
}

/** A configuration with one value set, or removed when it is undefined. */
export function withValue(
  values: Record<string, unknown>,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const next = { ...values };
  if (value === undefined) delete next[key];
  else next[key] = value;
  return next;
}
