/**
 * Widget identity rules shared by defineWidget(), discovery, widgetctl and
 * the Server's catalog validation (apps/server/internal/contentdefs). The
 * patterns are deliberately narrow: an identity is a capability name on the
 * wire and a custom-element tag in every host.
 */

/**
 * Qualified component identity. Built-in Widgets use the `tilecast`
 * namespace; a future plugin release contributes Widgets under its own
 * namespace. More than one dot-separated segment is allowed (for example
 * `gbyo.athletics.scoreboard`), subject to the heartbeat capability-name
 * bound enforced below.
 */
export const COMPONENT_TYPE_PATTERN =
  /^[a-z][a-z0-9]{1,31}(\.[a-z][a-z0-9-]{0,47})+$/;

/** A valid custom-element name without uppercase or unusual characters. */
export const TAG_NAME_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)+$/;

/** Tilecast's own Widgets use this prefix so they cannot collide with views. */
export const TILECAST_TAG_PREFIX = "tc-widget-";

/**
 * The heartbeat accepts capability names of at most 80 characters, so the
 * full `widget.<type>` capability must fit within that limit (the type
 * itself may be at most 73 characters).
 */
export const MAX_COMPONENT_CAPABILITY_LENGTH = 80;

/**
 * Component types may be at most this long, so the full `widget.<type>`
 * capability fits within MAX_COMPONENT_CAPABILITY_LENGTH.
 */
export const MAX_COMPONENT_TYPE_LENGTH =
  MAX_COMPONENT_CAPABILITY_LENGTH - "widget.".length;

/** Component versions share the capability version bounds of the heartbeat. */
export const MAX_COMPONENT_VERSION = 100;

/** Capability name a Player reports for a component type it can render. */
export function componentCapability(type: string): string {
  return `widget.${type}`;
}

/** Why an identity is invalid, or null. */
export function identityProblem(identity: {
  type: unknown;
  version: unknown;
  tagName: unknown;
}): string | null {
  const { type, version, tagName } = identity;
  if (typeof type !== "string" || !COMPONENT_TYPE_PATTERN.test(type)) {
    return `type ${String(type)} must be a qualified identity`;
  }
  const capability = componentCapability(type);
  if (capability.length > MAX_COMPONENT_CAPABILITY_LENGTH) {
    return `capability ${capability} is longer than ${MAX_COMPONENT_CAPABILITY_LENGTH} characters`;
  }
  if (
    typeof version !== "number" ||
    !Number.isInteger(version) ||
    version < 1 ||
    version > MAX_COMPONENT_VERSION
  ) {
    return `version ${String(version)} must be an integer from 1 to ${MAX_COMPONENT_VERSION}`;
  }
  if (typeof tagName !== "string" || !TAG_NAME_PATTERN.test(tagName)) {
    return `tag name ${String(tagName)} is not a valid custom-element name`;
  }
  if (type.startsWith("tilecast.")) {
    const expected =
      TILECAST_TAG_PREFIX + type.slice("tilecast.".length).replaceAll(".", "-");
    if (tagName !== expected) {
      return `tag name ${tagName} must be ${expected} for a tilecast Widget`;
    }
  }
  return null;
}

/** Bounded machine-readable codes for empty reasons and error codes. */
export const STATE_CODE_PATTERN = /^[a-z][a-z0-9_]{0,47}$/;

/** Coerce a code a Widget reported into the bounded vocabulary. */
export function boundedCode(value: unknown, fallback: string): string {
  return typeof value === "string" && STATE_CODE_PATTERN.test(value)
    ? value
    : fallback;
}
