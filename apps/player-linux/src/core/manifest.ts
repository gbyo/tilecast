/**
 * Manifest synchronization.
 *
 * The manifest is fetched conditionally (ETag / 304) on connect, whenever the
 * socket announces `manifest.changed`, and on a five-minute reconciliation
 * timer that runs regardless of socket state — so content updates flow even
 * if every push notification is lost.
 *
 * A new manifest is prepared off to the side: every required media variant is
 * downloaded (resumable), size- and SHA-256-verified, and only then is the
 * manifest persisted as *pending* and offered to playback, which swaps at the
 * next item boundary. Failed preparation never disturbs the active manifest
 * or its cached files. At boot the persisted active manifest plays
 * immediately with no network.
 */

import { promises as fs } from "fs";
import * as path from "path";
import { ApiError, NetworkError, type ApiClient } from "./api";
import {
  downloadVerified,
  DownloadError,
  verifyFileIntegrity,
  type DownloadObserver,
} from "./download";
import { logger } from "./log";
import type { StateStore } from "./storage";
import type { Manifest, ManifestAsset } from "./types";
import { ServerClock } from "./clock";
import { cacheIdentityMatches, type CacheIdentity } from "./cache-identity";

const log = logger("manifest");

const ACTIVE_FILE = "manifest-active.json";
export const RECONCILE_INTERVAL_MS = 5 * 60_000;
const DEFAULT_MAX_CONCURRENT_DOWNLOADS = 2;
/** "automatic" policy downloads video up to this size, else streams. */
const DEFAULT_AUTOMATIC_VIDEO_LIMIT_BYTES = 256 * 1024 * 1024;

export interface StoredManifest {
  manifest: Manifest;
  etag: string | null;
  storedAt: string;
  clockOffsetMs?: number;
  installationId?: string;
  screenId?: string;
  normalizedServerUrl?: string;
}

export interface ManifestSyncEvents {
  /** A fully verified manifest is ready; playback swaps at item boundary. */
  onManifestPrepared(manifest: Manifest, clockOffsetMs: number): void;
  onCredentialRejected(): void;
  onSyncError(error: string): void;
}

export function mediaFileName(asset: ManifestAsset): string {
  return `${asset.assetId}-${asset.variantId}`;
}

/** Variants that must be fully cached before the manifest may activate. */
export function requiredDownloads(
  manifest: Manifest,
  automaticVideoLimitBytes = DEFAULT_AUTOMATIC_VIDEO_LIMIT_BYTES,
): ManifestAsset[] {
  const byAsset = new Map<string, ManifestAsset>();
  for (const asset of manifest.assets) {
    byAsset.set(`${asset.assetId}:${asset.variantId}`, asset);
  }

  const wanted = new Map<string, ManifestAsset>();
  const addAsset = (assetId: string, variantId: string | null | undefined) => {
    if (!variantId) {
      // Layouts, fallbacks, and branding must carry an exact variant
      // reference. Guessing here can make two players render different files
      // when an asset has more than one ready variant.
      return;
    }
    const asset = byAsset.get(`${assetId}:${variantId}`);
    if (asset) {
      wanted.set(`${asset.assetId}:${asset.variantId}`, asset);
    }
  };

  const playlists = [
    manifest.playlist,
    manifest.directFallbackPlaylist,
    ...(manifest.playlists ?? []),
  ];
  for (const playlist of playlists) {
    if (!playlist) {
      continue;
    }
    for (const item of playlist.items) {
      if (item.assetType === "website" || item.layoutId) {
        continue; // no media variant; websites stream, layouts are skipped
      }
      const asset = item.variantId
        ? byAsset.get(`${item.assetId}:${item.variantId}`)
        : undefined;
      if (!asset) {
        continue;
      }
      const isVideo = asset.mimeType.startsWith("video/");
      const policy = item.deliveryPolicy;
      const download =
        policy === "download" ||
        (policy === "automatic" &&
          (!isVideo || asset.fileSize <= automaticVideoLimitBytes));
      if (download) {
        wanted.set(`${asset.assetId}:${asset.variantId}`, asset);
      }
    }
  }

  // Website fallback images must be verified before activation.
  for (const website of manifest.websites ?? []) {
    if (website.fallbackImageAssetId) {
      addAsset(website.fallbackImageAssetId, website.fallbackVariantId);
    }
  }

  if (manifest.branding?.logoAssetId) {
    addAsset(manifest.branding.logoAssetId, manifest.branding.logoVariantId);
  }

  // Layout-referenced images (asset placements and canvas backgrounds) must
  // be cached so a Layout renders correctly offline. Videos inside layout
  // zones follow their own playlist item's delivery policy, handled above.
  const layouts = [
    ...(manifest.layouts ?? []),
    ...(manifest.layout ? [manifest.layout] : []),
  ] as Array<{
    document?: {
      canvas?: {
        backgroundAssetId?: string | null;
        backgroundVariantId?: string | null;
      };
      placements?: Array<{
        type: string;
        assetId?: string | null;
        variantId?: string | null;
      }>;
    };
  }>;
  for (const layout of layouts) {
    const document = layout?.document;
    if (!document) {
      continue;
    }
    if (document.canvas?.backgroundAssetId) {
      addAsset(
        document.canvas.backgroundAssetId,
        document.canvas.backgroundVariantId,
      );
    }
    for (const placement of document.placements ?? []) {
      if (placement.type === "asset" && placement.assetId) {
        // Only images are required upfront; a zone video may stream.
        // The manifest contract carries an exact variant reference. Do not
        // choose an arbitrary ready variant when a legacy or malformed layout
        // omits it; rendering and caching must make the same decision.
        addAsset(placement.assetId, placement.variantId);
      }
    }
  }

  return [...wanted.values()];
}

export class ManifestSync {
  private syncing = false;
  private syncQueued = false;
  private stored: StoredManifest | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;
  private started = false;
  private reconciliationIntervalMs = RECONCILE_INTERVAL_MS;
  private maximumBytes = 8 * 1024 * 1024 * 1024;
  private minimumFreeBytes = 1024 * 1024 * 1024;
  private automaticVideoLimitBytes = DEFAULT_AUTOMATIC_VIDEO_LIMIT_BYTES;
  private concurrentDownloads = DEFAULT_MAX_CONCURRENT_DOWNLOADS;
  private identity: CacheIdentity | null = null;
  lastSyncError: string | null = null;

  constructor(
    private readonly store: StateStore,
    private readonly client: ApiClient,
    private readonly events: ManifestSyncEvents,
    /** Counts transfer facts for telemetry. Absent in tests and previews. */
    private readonly downloadObserver?: DownloadObserver,
    private readonly clock: ServerClock = new ServerClock(),
  ) {}

  setIdentity(identity: CacheIdentity | null): void {
    this.identity = identity;
  }

  /** Apply the authoritative server cache/download policy. */
  applyPolicy(
    maximumBytes: number,
    minimumFreeBytes: number,
    automaticVideoLimitBytes: number,
    concurrentDownloads: number,
    reconciliationSeconds: number,
  ): void {
    if (Number.isFinite(maximumBytes) && maximumBytes > 0) {
      this.maximumBytes = maximumBytes;
    }
    if (Number.isFinite(minimumFreeBytes) && minimumFreeBytes >= 0) {
      this.minimumFreeBytes = minimumFreeBytes;
    }
    if (
      Number.isFinite(automaticVideoLimitBytes) &&
      automaticVideoLimitBytes > 0
    ) {
      this.automaticVideoLimitBytes = automaticVideoLimitBytes;
    }
    if (Number.isFinite(concurrentDownloads) && concurrentDownloads >= 1) {
      this.concurrentDownloads = Math.min(8, Math.floor(concurrentDownloads));
    }
    if (Number.isFinite(reconciliationSeconds) && reconciliationSeconds >= 60) {
      this.reconciliationIntervalMs = Math.min(
        86_400_000,
        Math.floor(reconciliationSeconds * 1_000),
      );
    }
    if (this.started) {
      this.scheduleReconciliation();
    }
  }

  async invalidateCachedState(): Promise<void> {
    this.stored = null;
    await this.store.delete(ACTIVE_FILE);
    await this.store.clearMedia();
  }

  /**
   * Activate the persisted manifest from disk with zero network. Safe to
   * call before any credential is sent; boot playback never waits.
   */
  async loadCached(): Promise<void> {
    this.stored = await this.store.readJson<StoredManifest>(ACTIVE_FILE);
    if (
      this.stored &&
      (!this.identity || !cacheIdentityMatches(this.identity, this.stored))
    ) {
      await this.invalidateCachedState();
      return;
    }
    if (this.stored) {
      log.info("activating cached manifest at boot", {
        manifestVersion: this.stored.manifest.manifestVersion,
      });
      const storedAt = Date.parse(this.stored.storedAt);
      const serverTime = Date.parse(this.stored.manifest.serverTime);
      const clockOffsetMs =
        typeof this.stored.clockOffsetMs === "number" &&
        Number.isFinite(this.stored.clockOffsetMs)
          ? this.stored.clockOffsetMs
          : Number.isFinite(storedAt) && Number.isFinite(serverTime)
            ? serverTime - storedAt
            : 0;
      this.clock.restore(clockOffsetMs);
      this.events.onManifestPrepared(this.stored.manifest, clockOffsetMs);
    }
  }

  /** Begin network reconciliation. Call only after the identity gate. */
  async start(): Promise<void> {
    this.started = true;
    this.scheduleReconciliation();
    await this.syncNow("startup");
  }

  private scheduleReconciliation(): void {
    if (this.timer) {
      clearInterval(this.timer);
    }
    this.timer = setInterval(() => {
      void this.syncNow("reconcile-timer");
    }, this.reconciliationIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    this.started = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  get activeManifest(): Manifest | null {
    return this.stored?.manifest ?? null;
  }

  /** Serialized; a request during a sync queues one follow-up pass. */
  async syncNow(trigger: string): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.syncing) {
      this.syncQueued = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncQueued = false;
        await this.runOnce(trigger);
      } while (this.syncQueued && !this.stopped);
    } finally {
      this.syncing = false;
    }
  }

  private async runOnce(trigger: string): Promise<void> {
    let result;
    try {
      result = await this.client.manifest(this.stored?.etag ?? null);
    } catch (err) {
      if (err instanceof ApiError && err.credentialRejected) {
        this.events.onCredentialRejected();
        return;
      }
      this.lastSyncError = String(err);
      if (!(err instanceof NetworkError)) {
        this.events.onSyncError(this.lastSyncError);
      }
      return;
    }

    if (result.notModified || !result.value) {
      this.lastSyncError = null;
      return;
    }

    const manifest = result.value;
    log.info("manifest changed; preparing", {
      trigger,
      manifestVersion: manifest.manifestVersion,
      schemaVersion: manifest.schemaVersion,
    });

    try {
      await this.prepare(manifest);
    } catch (err) {
      this.lastSyncError = `preparation failed: ${String(err)}`;
      this.events.onSyncError(this.lastSyncError);
      // Active manifest stays untouched; the reconcile timer retries.
      return;
    }

    const storedAt = Date.now();
    const clockOffsetMs = this.clock.sync(manifest.serverTime, storedAt);
    this.stored = {
      manifest,
      etag: result.etag,
      storedAt: new Date(storedAt).toISOString(),
      clockOffsetMs,
      installationId: this.identity?.installationId,
      screenId: this.identity?.screenId,
      normalizedServerUrl: this.identity?.normalizedServerUrl,
    };
    await this.store.writeJson(ACTIVE_FILE, this.stored);
    this.lastSyncError = null;
    this.events.onManifestPrepared(manifest, clockOffsetMs);
    await this.cleanupCache();
  }

  /** Download and verify everything the manifest requires. */
  private async prepare(manifest: Manifest): Promise<void> {
    const required = requiredDownloads(manifest, this.automaticVideoLimitBytes);
    await this.ensureSpace(required);
    const mediaDir = this.store.mediaDir();
    const queue = [...required];
    const failures: string[] = [];

    const worker = async () => {
      for (;;) {
        const asset = queue.shift();
        if (!asset) {
          return;
        }
        const destination = path.join(mediaDir, mediaFileName(asset));
        try {
          await downloadVerified(
            {
              url: this.client.url(asset.downloadPath),
              headers: this.client.authHeaders(),
              destination,
              expectedSha256: asset.sha256,
              expectedSizeBytes: asset.fileSize,
              etag: `"${asset.sha256}"`,
            },
            undefined,
            this.downloadObserver,
          );
        } catch (err) {
          if (err instanceof DownloadError && !err.retryable) {
            failures.push(`${asset.assetId}: ${err.message}`);
          } else {
            failures.push(`${asset.assetId}: ${String(err)}`);
          }
        }
      }
    };

    await Promise.all(
      Array.from(
        { length: Math.min(this.concurrentDownloads, required.length) },
        worker,
      ),
    );

    if (failures.length > 0) {
      throw new Error(failures.join("; "));
    }
  }

  private async ensureSpace(required: ManifestAsset[]): Promise<void> {
    const requiredNames = new Set(required.map(mediaFileName));
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.store.mediaDir());
    } catch {
      return;
    }
    // Evict files outside the candidate manifest before enforcing the server
    // policy. A stale cache must not make a valid new manifest impossible.
    await Promise.all(
      entries
        .filter(
          (entry) => !entry.endsWith(".part") && !requiredNames.has(entry),
        )
        .map((entry) =>
          fs.rm(path.join(this.store.mediaDir(), entry), { force: true }),
        ),
    );
    const files = await Promise.all(
      (await fs.readdir(this.store.mediaDir())).map(async (entry) => {
        try {
          return (await fs.stat(path.join(this.store.mediaDir(), entry))).size;
        } catch {
          return 0;
        }
      }),
    );
    const used = files.reduce((sum, size) => sum + size, 0);
    const missingBytes = (
      await Promise.all(
        required.map(async (asset) => {
          const file = path.join(this.store.mediaDir(), mediaFileName(asset));
          return (await verifyFileIntegrity(file, asset.sha256, asset.fileSize))
            ? 0
            : asset.fileSize;
        }),
      )
    ).reduce((sum, size) => sum + size, 0);
    const filesystem = await fs.statfs(this.store.mediaDir());
    const diskFree = filesystem.bavail * filesystem.bsize;
    if (
      used + missingBytes > this.maximumBytes ||
      diskFree - missingBytes < this.minimumFreeBytes
    ) {
      throw new Error("insufficient cache space for the configured policy");
    }
  }

  /** Local media path for a cached variant, or null if not cached. */
  async cachedPath(asset: ManifestAsset): Promise<string | null> {
    const filePath = path.join(this.store.mediaDir(), mediaFileName(asset));
    try {
      if (await verifyFileIntegrity(filePath, asset.sha256, asset.fileSize)) {
        return filePath;
      }
      // Do not allow an invalid file to be served offline or to block a later
      // verified download because it happens to have the expected size.
      await fs.rm(filePath, { force: true });
      return null;
    } catch {
      return null;
    }
  }

  /** Remove cached media no longer referenced by the active manifest. */
  private async cleanupCache(): Promise<void> {
    const manifest = this.stored?.manifest;
    if (!manifest) {
      return;
    }
    const keep = new Set(manifest.assets.map((a) => mediaFileName(a)));
    let entries: string[];
    try {
      entries = await fs.readdir(this.store.mediaDir());
    } catch {
      return;
    }
    for (const entry of entries) {
      const base = entry.endsWith(".part") ? entry.slice(0, -5) : entry;
      if (!keep.has(base)) {
        await fs
          .rm(path.join(this.store.mediaDir(), entry), { force: true })
          .catch(() => {});
      }
    }
  }

  async clearMediaCache(): Promise<void> {
    let entries: string[] = [];
    try {
      entries = await fs.readdir(this.store.mediaDir());
    } catch {
      return;
    }
    for (const entry of entries) {
      await fs
        .rm(path.join(this.store.mediaDir(), entry), { force: true })
        .catch(() => {});
    }
    // Force a full re-download and re-verification on the next sync.
    this.stored = null;
    await this.store.delete(ACTIVE_FILE);
    await this.syncNow("clear_media_cache");
  }
}
