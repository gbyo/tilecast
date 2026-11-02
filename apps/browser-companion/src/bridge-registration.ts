/**
 * The isolated content bridge is one dynamic registration whose matches
 * cover every granted origin's /player/* path. Connecting or
 * disconnecting one origin rewrites the registration from the full
 * granted list, so it never drops the bridge for another origin.
 */

export const BRIDGE_SCRIPT_ID = "tilecast-companion-bridge";

export interface BridgeScripting {
  registerContentScripts(
    scripts: chrome.scripting.RegisteredContentScript[],
  ): Promise<void>;
  unregisterContentScripts(options?: { ids?: string[] }): Promise<void>;
}

/** The registration for these origins, or null when none is granted. */
export function bridgeRegistration(
  origins: readonly string[],
): chrome.scripting.RegisteredContentScript | null {
  const unique = [...new Set(origins)];
  if (unique.length === 0) return null;
  return {
    id: BRIDGE_SCRIPT_ID,
    matches: unique.map((origin) => `${origin}/player/*`),
    js: ["content.js"],
    runAt: "document_start",
    world: "ISOLATED",
    allFrames: false,
  };
}

/** Replaces the bridge registration with one covering exactly these origins. */
export async function syncBridgeRegistration(
  scripting: BridgeScripting,
  origins: readonly string[],
): Promise<void> {
  try {
    await scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
  } catch {
    // Absent registration: nothing to clear.
  }
  const registration = bridgeRegistration(origins);
  if (registration) await scripting.registerContentScripts([registration]);
}
