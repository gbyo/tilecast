import { missingCapabilities } from "./compatibility";
import { loadIdentity, type BrowserIdentity } from "./identity";
import { runExclusive } from "./lifecycle";
import { BrowserPlayer, compatibilityProblem } from "./player";
import { openDatabase } from "./storage/database";

/**
 * Starts a Browser Player in this page. The page holds an exclusive Web Lock
 * for its Screen for as long as it lives, so a second tab never acts as the
 * same Player.
 */
export async function start(recovery: string | null): Promise<void> {
  const missing = missingCapabilities();
  if (missing.length) {
    compatibilityProblem(
      `This browser needs ${missing.join(", ")}. Use current Chrome or Microsoft Edge over HTTPS.`,
    );
    return;
  }
  const pathSlot = /^\/player\/([a-f0-9-]{36})\/?$/.exec(
    location.pathname,
  )?.[1];
  const identitySlot = pathSlot ?? "unmanaged";
  const database = await openDatabase();
  const identity: BrowserIdentity = await navigator.locks.request(
    "tilecast-player-identity",
    () => loadIdentity(database, identitySlot),
  );
  await runExclusive(
    navigator.locks,
    identity.slotId ?? identitySlot,
    () =>
      new BrowserPlayer({ database, identity, identitySlot, recovery }).run(),
    () =>
      compatibilityProblem(
        "This Browser Player is already running in another window.",
      ),
  );
}
