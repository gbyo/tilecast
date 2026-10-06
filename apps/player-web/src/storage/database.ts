export const DATABASE_NAME = "tilecast-browser-player-v1";
export const STORES = [
  "identity",
  "objects",
  "activations",
  "grants",
  "outbox",
] as const;
export type Store = (typeof STORES)[number];

export function openDatabase(
  factory: IDBFactory = indexedDB,
): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(DATABASE_NAME, 1);
    request.onupgradeneeded = () => {
      for (const name of STORES) request.result.createObjectStore(name);
    };
    request.onerror = () => reject(request.error);
    request.onblocked = () =>
      reject(new Error("Browser Player storage upgrade is blocked"));
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
  });
}

export function result<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

export function completed(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () =>
      reject(
        transaction.error ??
          new Error("Browser Player storage transaction aborted"),
      );
    transaction.onerror = () => reject(transaction.error);
  });
}

export async function read<T>(
  database: IDBDatabase,
  store: Store,
  key: IDBValidKey,
): Promise<T | undefined> {
  return result(
    database.transaction(store).objectStore(store).get(key),
  ) as Promise<T | undefined>;
}

export async function write<T>(
  database: IDBDatabase,
  store: Store,
  key: IDBValidKey,
  value: T,
): Promise<void> {
  const transaction = database.transaction(store, "readwrite", {
    durability: "strict",
  });
  const done = completed(transaction);
  transaction.objectStore(store).put(value, key);
  await done;
}
