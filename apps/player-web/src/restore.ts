import {
  discardActivation,
  loadActivation,
  setActivationTrust,
  type PreparedActivation,
} from "./storage/activation";
import type { VerifiedStore } from "./storage/verified-store";

/** Who the saved identity says this installation is bound to. */
export interface LocalBinding {
  serverInstallationId?: string;
  slotId?: string;
  bindingId?: string;
}

/**
 * Restores the most recently committed activation without the server.
 *
 * The activation must belong to the same server installation, slot and binding
 * this browser last confirmed, and every resource must match the bytes on disk.
 * It is all or nothing: one missing or corrupt object discards the activation
 * rather than showing part of it. The caller holds the profile CAS lock.
 *
 * Restoration shows the last committed content. It does not evaluate a
 * schedule and it does not claim the server still agrees.
 */
export async function restoreLocalActivation(
  database: IDBDatabase,
  store: VerifiedStore,
  binding: LocalBinding,
): Promise<PreparedActivation | undefined> {
  const { serverInstallationId, slotId, bindingId } = binding;
  if (!serverInstallationId || !slotId || !bindingId) return undefined;
  await store.reconcile();
  const saved = await loadActivation(database, slotId);
  if (!saved) return undefined;
  if (
    saved.slotId !== slotId ||
    saved.bindingId !== bindingId ||
    saved.serverInstallationId !== serverInstallationId
  ) {
    await discardActivation(database, slotId);
    return undefined;
  }
  // Nothing the page has not itself verified may be served.
  await setActivationTrust(database, slotId, saved.activationId, false);
  for (const resource of saved.resources) {
    if (!(await store.verified(resource))) {
      await discardActivation(database, slotId);
      return undefined;
    }
  }
  await setActivationTrust(database, slotId, saved.activationId, true);
  return saved;
}
