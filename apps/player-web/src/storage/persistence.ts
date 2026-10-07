import { write } from "./database";

export interface StorageFacts {
  persistenceRequested: boolean;
  persistenceGranted: boolean;
  quotaBytes?: number;
  usageBytes?: number;
  availableBytes?: number;
}

/** A denied request is best-effort storage, never a claim of persistence. */
export async function storageFacts(
  storage: StorageManager,
  requestPersistence: boolean,
): Promise<StorageFacts> {
  const facts: StorageFacts = {
    persistenceRequested: requestPersistence,
    persistenceGranted: false,
  };
  try {
    facts.persistenceGranted = await storage.persisted();
    if (requestPersistence && !facts.persistenceGranted)
      facts.persistenceGranted = await storage.persist();
  } catch {
    /* Status stays best effort when the browser refuses the API. */
  }
  try {
    const estimate = await storage.estimate();
    if (
      estimate.quota !== undefined &&
      Number.isFinite(estimate.quota) &&
      estimate.quota >= 0
    )
      facts.quotaBytes = Math.floor(estimate.quota);
    if (
      estimate.usage !== undefined &&
      Number.isFinite(estimate.usage) &&
      estimate.usage >= 0
    )
      facts.usageBytes = Math.floor(estimate.usage);
    if (facts.quotaBytes !== undefined && facts.usageBytes !== undefined)
      facts.availableBytes = Math.max(0, facts.quotaBytes - facts.usageBytes);
  } catch {
    /* Missing measurements are omitted. */
  }
  return facts;
}

export async function requestManagedStorage(
  database: IDBDatabase,
  storage: StorageManager = navigator.storage,
): Promise<StorageFacts> {
  const facts = await storageFacts(storage, true);
  await write(database, "identity", "storage", facts);
  return facts;
}
