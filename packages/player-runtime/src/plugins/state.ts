/**
 * Plugin API v2 `plugin_state` entries as the Player Plugin Host accepts
 * them. Native hosts validate the same bounds in Player Core; the Browser
 * Player has no Core, so the Runtime checks again. Anything malformed is
 * dropped with a diagnostic, never thrown.
 */
import type { PlayerStateEntry } from "@tilecast/plugin-sdk/player";

/** The manifest `plugins` array limit. */
export const MAX_STATE_ENTRIES = 64;
export const MAX_STATE_BYTES = 16 * 1024;
export const MAX_STATE_MEDIA = 16;

const ID = /^[A-Za-z0-9._:-]{1,64}$/;
const TYPE = /^[a-z][a-z0-9_]{0,79}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** One accepted entry, keyed for routing. */
export interface RoutedState {
  plugin: string;
  definitionVersion: number;
  validUntilMs: number | null;
  /** A Plugin API v1 entry a v2 plugin declares in v1ManifestTypes. */
  v1: boolean;
  entry: PlayerStateEntry;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function isPluginStateEntry(value: unknown): boolean {
  return isObject(value) && value["type"] === "plugin_state";
}

/**
 * Parse one entry. Returns a reason string when it is refused. Expired
 * entries are refused at `nowMs` (corrected server time).
 */
export function parseStateEntry(
  value: unknown,
  nowMs: number,
): RoutedState | string {
  if (!isObject(value) || value["type"] !== "plugin_state")
    return "not a plugin_state entry";
  if (value["version"] !== 1) return "unsupported plugin_state version";
  const { id, plugin, definitionVersion, stateType, stateVersion, state } =
    value;
  if (typeof id !== "string" || !ID.test(id)) return "invalid id";
  if (typeof plugin !== "string" || !TYPE.test(plugin)) return "invalid plugin";
  if (typeof stateType !== "string" || !TYPE.test(stateType))
    return "invalid stateType";
  for (const [name, number] of [
    ["definitionVersion", definitionVersion],
    ["stateVersion", stateVersion],
  ] as const) {
    if (!Number.isInteger(number) || (number as number) < 1)
      return `invalid ${name}`;
  }
  if (!isObject(state)) return "state is not an object";
  let encoded: string;
  try {
    encoded = JSON.stringify(state);
  } catch {
    return "state is not JSON";
  }
  if (encoded.length > MAX_STATE_BYTES) return "state is too large";
  const rawMedia = value["media"] ?? [];
  if (!Array.isArray(rawMedia) || rawMedia.length > MAX_STATE_MEDIA)
    return "invalid media";
  const media: { assetId: string; variantId: string }[] = [];
  for (const ref of rawMedia) {
    if (
      !isObject(ref) ||
      typeof ref["assetId"] !== "string" ||
      typeof ref["variantId"] !== "string" ||
      !UUID.test(ref["assetId"]) ||
      !UUID.test(ref["variantId"])
    )
      return "invalid media reference";
    media.push({ assetId: ref["assetId"], variantId: ref["variantId"] });
  }
  let validUntilMs: number | null = null;
  const validUntil = value["validUntil"];
  if (validUntil !== undefined && validUntil !== null) {
    if (typeof validUntil !== "string") return "invalid validUntil";
    validUntilMs = Date.parse(validUntil);
    if (!Number.isFinite(validUntilMs)) return "invalid validUntil";
    if (validUntilMs <= nowMs) return "expired";
  }
  return {
    plugin,
    definitionVersion: definitionVersion as number,
    validUntilMs,
    v1: false,
    entry: Object.freeze({
      id,
      type: stateType,
      version: stateVersion as number,
      state: JSON.parse(encoded) as Record<string, unknown>,
      media: Object.freeze(media),
      validUntil: typeof validUntil === "string" ? validUntil : null,
    }),
  };
}

/**
 * A Plugin API v1 entry for a v2 plugin that still accepts it. The entry's
 * `config` becomes the state; v1 entries declare no media and no expiry.
 */
export function parseV1Entry(
  value: unknown,
  plugin: string,
  definitionVersion: number,
): RoutedState | string {
  if (!isObject(value)) return "not an object";
  const { id, type, version, config } = value;
  if (typeof id !== "string" || !ID.test(id)) return "invalid id";
  if (typeof type !== "string" || !TYPE.test(type)) return "invalid type";
  if (!Number.isInteger(version) || (version as number) < 1)
    return "invalid version";
  if (!isObject(config)) return "config is not an object";
  let encoded: string;
  try {
    encoded = JSON.stringify(config);
  } catch {
    return "config is not JSON";
  }
  if (encoded.length > MAX_STATE_BYTES) return "config is too large";
  return {
    plugin,
    definitionVersion,
    validUntilMs: null,
    v1: true,
    entry: Object.freeze({
      id,
      type,
      version: version as number,
      state: JSON.parse(encoded) as Record<string, unknown>,
      media: Object.freeze([]),
      validUntil: null,
    }),
  };
}
