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
  getRegisteredContentScripts(options?: {
    ids?: string[];
  }): Promise<chrome.scripting.RegisteredContentScript[]>;
  updateContentScripts(
    scripts: chrome.scripting.RegisteredContentScript[],
  ): Promise<void>;
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
  const registration = bridgeRegistration(origins);
  const existing = await scripting.getRegisteredContentScripts({
    ids: [BRIDGE_SCRIPT_ID],
  });
  if (registration === null) {
    if (existing.length > 0) {
      await scripting.unregisterContentScripts({ ids: [BRIDGE_SCRIPT_ID] });
    }
    return;
  }
  if (existing.length > 0) {
    await scripting.updateContentScripts([registration]);
  } else {
    await scripting.registerContentScripts([registration]);
  }
}
