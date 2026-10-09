import { sha256 } from "@noble/hashes/sha2.js";

export interface ResourceClaim {
  digest: string;
  size: number;
  mimeType: string;
}

export interface VerifiedObject extends ResourceClaim {
  verifiedAt: number;
  lastUsedAt: number;
  pins: string[];
}

/**
 * Owner prefix of the temporary pin a preparation holds until its activation
 * commits. The pin lives only while the CAS lock is held, so one that is still
 * recorded when reconciliation runs was left by a page that ended first.
 */
export const PREPARATION_OWNER_PREFIX = "preparing:";

/** Metadata persistence and OPFS are separate narrow adapters. */
export interface ObjectIndex {
  list(): Promise<VerifiedObject[]>;
  get(digest: string): Promise<VerifiedObject | undefined>;
  put(object: VerifiedObject): Promise<void>;
  remove(digest: string): Promise<void>;
}

export interface PartialObject {
  write(chunk: Uint8Array): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
  commit(digest: string): Promise<void>;
}

export interface ObjectFiles {
  partial(): Promise<PartialObject>;
  read(digest: string): Promise<Blob | undefined>;
  remove(digest: string): Promise<void>;
  /** Removes partial files and objects without index metadata. */
  reconcile?(indexedDigests: ReadonlySet<string>): Promise<void>;
}

/** The streaming digest the store uses. Tests count instances to prove reuse. */
export interface Hasher {
  update(chunk: Uint8Array): unknown;
  digest(): Uint8Array;
}

export interface StoreOptions {
  hasher?: () => Hasher;
  /**
   * Digests this page load has already hashed. Share one set between stores so
   * a later preparation does not rehash an object this session verified.
   */
  session?: Set<string>;
}

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");

function validateClaim(claim: ResourceClaim, limit: number): void {
  if (
    !/^[a-f0-9]{64}$/.test(claim.digest) ||
    !Number.isSafeInteger(claim.size) ||
    claim.size <= 0 ||
    claim.size > limit ||
    !/^[\w.+-]+\/[\w.+-]+$/.test(claim.mimeType)
  ) {
    throw new Error("Invalid Browser Player resource claim");
  }
}

/**
 * No activation consumes an object until prepare returns verified bytes.
 *
 * Trust has distinct levels. `prepare` and `verified` hash the complete
 * object. `trusted` is the cheap check an already-authorized read uses: the
 * index and the stored size agree. It never hashes, so serving a byte range is
 * proportional to the bytes served and not to the size of the object.
 */
export class VerifiedStore {
  private readonly newHasher: () => Hasher;
  private readonly session: Set<string>;

  constructor(
    private readonly index: ObjectIndex,
    private readonly files: ObjectFiles,
    readonly limitBytes: number,
    private readonly now: () => number = Date.now,
    options: StoreOptions = {},
  ) {
    this.newHasher = options.hasher ?? (() => sha256.create());
    this.session = options.session ?? new Set();
    if (!Number.isSafeInteger(limitBytes) || limitBytes <= 0)
      throw new Error("Invalid cache limit");
  }

  async verified(claim: ResourceClaim): Promise<Blob | undefined> {
    validateClaim(claim, this.limitBytes);
    const object = await this.index.get(claim.digest);
    if (!object || object.size !== claim.size) return undefined;
    const file = await this.files.read(claim.digest);
    if (!file || file.size !== claim.size) return this.corrupt(claim.digest);
    if (this.session.has(claim.digest)) return file;
    const hash = this.newHasher();
    const reader = file.stream().getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        hash.update(value);
      }
      if (hex(hash.digest()) !== claim.digest)
        return this.corrupt(claim.digest);
    } finally {
      reader.releaseLock();
    }
    this.session.add(claim.digest);
    await this.index.put({ ...object, lastUsedAt: this.now() });
    return file;
  }

  /**
   * The object for an already-authorized read, without hashing it. Metadata or
   * stored bytes that no longer agree invalidate the object so it can never
   * be served or counted as prepared again.
   */
  async trusted(claim: ResourceClaim): Promise<Blob | undefined> {
    validateClaim(claim, Number.MAX_SAFE_INTEGER);
    const object = await this.index.get(claim.digest);
    if (!object) return undefined;
    if (object.size !== claim.size) return this.corrupt(claim.digest);
    const file = await this.files.read(claim.digest);
    if (!file || file.size !== claim.size) return this.corrupt(claim.digest);
    return file;
  }

  /**
   * Startup reconciliation, under the CAS lock: drops index metadata whose
   * bytes are gone or the wrong size, releases preparation pins that no live
   * page can still hold, then drops bytes that have no metadata.
   */
  async reconcile(): Promise<void> {
    for (const object of await this.index.list()) {
      const file = await this.files.read(object.digest);
      if (!file || file.size !== object.size) await this.corrupt(object.digest);
    }
    for (const object of await this.index.list()) {
      const pins = object.pins.filter(
        (pin) => !pin.startsWith(PREPARATION_OWNER_PREFIX),
      );
      if (pins.length !== object.pins.length)
        await this.index.put({ ...object, pins });
    }
    await this.files.reconcile?.(
      new Set((await this.index.list()).map((object) => object.digest)),
    );
  }

  /** Called under the CAS Web Lock. Network 206 responses are never complete. */
  async prepare(
    claim: ResourceClaim,
    download: () => Promise<Response>,
  ): Promise<Blob> {
    validateClaim(claim, this.limitBytes);
    const previous = await this.index.get(claim.digest);
    const existing = await this.verified(claim);
    if (existing) return existing;
    await this.makeSpace(claim.size);
    const response = await download();
    if (response.status !== 200 || !response.body)
      throw new Error("Complete media download is required");
    const partial = await this.files.partial();
    const reader = response.body.getReader();
    const hash = this.newHasher();
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > claim.size)
          throw new Error("Media exceeds its expected size");
        hash.update(value);
        await partial.write(value);
      }
      if (size !== claim.size || hex(hash.digest()) !== claim.digest)
        throw new Error("Media integrity check failed");
      await partial.close();
      await partial.commit(claim.digest);
      const file = await this.files.read(claim.digest);
      if (!file || file.size !== claim.size)
        throw new Error("Verified media could not be committed");
      // Committed bytes can be orphaned by a crash here; metadata never gets
      // ahead of verified storage. Startup removes those unindexed objects.
      const now = this.now();
      this.session.add(claim.digest);
      await this.index.put({
        ...claim,
        verifiedAt: now,
        lastUsedAt: now,
        pins: previous?.pins ?? [],
      });
      return file;
    } catch (error) {
      await reader.cancel().catch(() => undefined);
      await partial.abort().catch(() => undefined);
      throw error;
    } finally {
      reader.releaseLock();
    }
  }

  private async corrupt(digest: string): Promise<undefined> {
    this.session.delete(digest);
    await this.index.remove(digest);
    await this.files.remove(digest);
    return undefined;
  }

  private async makeSpace(required: number): Promise<void> {
    const objects = await this.index.list();
    let used = objects.reduce((sum, object) => sum + object.size, 0);
    const evictable = objects
      .filter((object) => object.pins.length === 0)
      .sort(
        (a, b) =>
          a.lastUsedAt - b.lastUsedAt || a.digest.localeCompare(b.digest),
      );
    for (const object of evictable) {
      if (used + required <= this.limitBytes) break;
      // A crash can leave bytes without metadata, never usable metadata
      // without bytes. Reconciliation removes orphaned objects on boot.
      this.session.delete(object.digest);
      await this.index.remove(object.digest);
      await this.files.remove(object.digest);
      used -= object.size;
    }
    if (used + required > this.limitBytes)
      throw new Error("Active content fills the Browser Player cache");
  }
}
