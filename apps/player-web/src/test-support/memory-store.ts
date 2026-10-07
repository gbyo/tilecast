import type {
  ObjectFiles,
  ObjectIndex,
  VerifiedObject,
} from "../storage/verified-store";

/** Test-only adapters. Production storage is OPFS plus IndexedDB. */
export function memoryStore() {
  const metadata = new Map<string, VerifiedObject>();
  const bytes = new Map<string, Blob>();
  const index: ObjectIndex = {
    list: async () => [...metadata.values()],
    get: async (digest) => metadata.get(digest),
    put: async (object) => {
      metadata.set(object.digest, object);
    },
    remove: async (digest) => {
      metadata.delete(digest);
    },
  };
  const files: ObjectFiles = {
    read: async (digest) => bytes.get(digest),
    remove: async (digest) => {
      bytes.delete(digest);
    },
    reconcile: async (indexed) => {
      for (const digest of [...bytes.keys()])
        if (!indexed.has(digest)) bytes.delete(digest);
    },
    partial: async () => {
      const chunks: Uint8Array<ArrayBuffer>[] = [];
      let closed = false;
      return {
        write: async (chunk) => {
          chunks.push(new Uint8Array(chunk));
        },
        close: async () => {
          closed = true;
        },
        abort: async () => undefined,
        commit: async (digest) => {
          if (!closed) throw new Error("partial still open");
          bytes.set(digest, new Blob(chunks));
        },
      };
    },
  };
  return { index, files, metadata, bytes };
}
