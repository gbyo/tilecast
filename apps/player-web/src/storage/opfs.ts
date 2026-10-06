import type { ObjectFiles, PartialObject } from "./verified-store";

/** OPFS filenames are generated or validated digests; never server paths. */
export class OPFSFiles implements ObjectFiles {
  private constructor(private readonly directory: FileSystemDirectoryHandle) {}

  static async open(
    storage: StorageManager = navigator.storage,
  ): Promise<OPFSFiles> {
    const root = await storage.getDirectory();
    return new OPFSFiles(
      await root.getDirectoryHandle("tilecast-media-v1", { create: true }),
    );
  }

  private name(digest: string): string {
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error("Invalid media digest");
    return digest;
  }

  async read(digest: string): Promise<Blob | undefined> {
    try {
      return await (
        await this.directory.getFileHandle(this.name(digest))
      ).getFile();
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotFoundError")
        return undefined;
      throw error;
    }
  }

  async remove(digest: string): Promise<void> {
    try {
      await this.directory.removeEntry(this.name(digest));
    } catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError"))
        throw error;
    }
  }

  async partial(): Promise<PartialObject> {
    const name = `partial-${crypto.randomUUID()}`;
    const handle = await this.directory.getFileHandle(name, { create: true });
    const writable = await handle.createWritable();
    let closed = false;
    return {
      write: async (chunk) => {
        await writable.write(chunk as Uint8Array<ArrayBuffer>);
      },
      close: async () => {
        await writable.close();
        closed = true;
      },
      abort: async () => {
        if (!closed) await writable.abort().catch(() => undefined);
        await this.directory.removeEntry(name).catch(() => undefined);
      },
      commit: async (digest) => {
        if (!closed) throw new Error("Media partial is still open");
        // createWritable atomically replaces the destination on close. A
        // browser without FileSystemHandle.move still gets safe publication.
        const destination = await this.directory.getFileHandle(
          this.name(digest),
          { create: true },
        );
        const output = await destination.createWritable();
        try {
          await (await handle.getFile()).stream().pipeTo(output);
        } catch (error) {
          await output.abort().catch(() => undefined);
          throw error;
        }
        await this.directory.removeEntry(name);
      },
    };
  }

  /** Called under the CAS Web Lock before restoration or new preparation. */
  async reconcile(indexedDigests: ReadonlySet<string>): Promise<void> {
    // FileSystemDirectoryHandle's async iteration is implemented by OPFS;
    // some TypeScript DOM versions do not declare the iterable extension.
    const directory = this.directory as FileSystemDirectoryHandle & {
      keys(): AsyncIterableIterator<string>;
    };
    for await (const name of directory.keys()) {
      if (
        name.startsWith("partial-") ||
        (/^[a-f0-9]{64}$/.test(name) && !indexedDigests.has(name))
      ) {
        await directory.removeEntry(name);
      }
    }
  }
}
