import { completed, read, result, write } from "./database";
import type { ObjectIndex, VerifiedObject } from "./verified-store";

export class IndexedObjects implements ObjectIndex {
  constructor(private readonly database: IDBDatabase) {}

  async list(): Promise<VerifiedObject[]> {
    return result(
      this.database.transaction("objects").objectStore("objects").getAll(),
    );
  }

  get(digest: string): Promise<VerifiedObject | undefined> {
    return read(this.database, "objects", digest);
  }

  put(object: VerifiedObject): Promise<void> {
    return write(this.database, "objects", object.digest, object);
  }

  async remove(digest: string): Promise<void> {
    const transaction = this.database.transaction("objects", "readwrite", {
      durability: "strict",
    });
    const done = completed(transaction);
    transaction.objectStore("objects").delete(digest);
    await done;
  }
}
