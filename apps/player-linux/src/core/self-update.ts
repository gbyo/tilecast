/**
 * Server-driven self-update for the Linux (AppImage) player.
 *
 * The Android player installs a signed APK; the Linux player instead replaces
 * its own AppImage. On an `install_player_update` command the updater fetches
 * the release metadata, downloads and verifies the AppImage (SHA-256 + size,
 * reusing the resumable `downloadVerified` helper), atomically renames it over
 * the running AppImage (`process.env.APPIMAGE`), then exits so the systemd unit
 * starts the new version. Progress is reported to the server's
 * update-deployment status endpoint; the terminal `succeeded` transition is
 * derived server-side from the next heartbeat's higher version code.
 *
 * The command is dispatched as a "disruptive" command, so the coordinator has
 * already persisted the idempotency key and reported the command result before
 * this runs — a restart therefore neither re-runs nor dangles the command, and
 * a failed update is surfaced purely through the status endpoint (a retry gets a
 * fresh command).
 */

import { access, chmod, rename, stat } from "node:fs/promises";
import { verifyFileIntegrity, type DownloadRequest } from "./download";
import { logger } from "./log";
import type {
  PlayerCommand,
  UpdateMetadata,
  UpdateStatusReport,
} from "./types";

const log = logger("self-update");

/** Longest we will hold a maintenance-window install pending before giving up. */
const MAX_WINDOW_DELAY_MS = 24 * 60 * 60 * 1_000;

/**
 * Least time between two download-progress reports. Without one of these the
 * dashboard shows a download frozen at 0% for its whole run; with one per chunk
 * it would post hundreds of times a second, so the rate is set to what a person
 * watching the drawer can actually read.
 */
const PROGRESS_INTERVAL_MS = 2_000;

/** One exclusive update execution per staging path, even across updater instances. */
const stagePathLocks = new Map<string, Promise<void>>();

async function withStagePathLock<T>(
  stagePath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = stagePathLocks.get(stagePath) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  stagePathLocks.set(stagePath, current);

  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (stagePathLocks.get(stagePath) === current) {
      stagePathLocks.delete(stagePath);
    }
  }
}

/**
 * Make the verified download executable before atomically replacing the
 * running AppImage. Downloads intentionally start as mode 0600; renaming that
 * file without this chmod leaves systemd unable to execute the replacement.
 */
export async function promoteAppImage(from: string, to: string): Promise<void> {
  await chmod(from, 0o755);
  await rename(from, to);
}

async function existingFileSize(filePath: string): Promise<number> {
  try {
    return (await stat(filePath)).size;
  } catch {
    return 0;
  }
}

export interface SelfUpdateDeps {
  /** The running AppImage path (process.env.APPIMAGE), or null when not packaged. */
  appImagePath: string | null;
  /** Absolute path the AppImage is staged to before it is promoted. */
  stagePath: string;
  fetchMetadata(releaseId: string): Promise<UpdateMetadata>;
  reportStatus(deploymentId: string, body: UpdateStatusReport): Promise<void>;
  download(request: DownloadRequest): Promise<void>;
  /** Build an absolute server URL from a server-relative path. */
  buildUrl(path: string): string;
  /** Device credential headers for the artifact download. */
  authHeaders(): Record<string, string>;
  /** Atomically promote the staged AppImage over the running one. */
  promote(from: string, to: string): Promise<void>;
  /** End the process so systemd starts the new AppImage. */
  restart(): void;
  now(): number;
}

/**
 * Derive a monotonic numeric version code from a semantic version string, the
 * same formula the Linux release build bakes into the signed manifest. Extra
 * pre-release/build metadata is ignored. Returns 0 for an unparseable version.
 */
export function parseVersionCode(version: string): number {
  const core = version.trim().split(/[-+]/, 1)[0] ?? "";
  const parts = core.split(".");
  if (parts.length !== 3 || parts.some((part) => !/^\d+$/.test(part))) {
    return 0;
  }

  const [major = Number.NaN, minor = Number.NaN, patch = Number.NaN] =
    parts.map(Number);
  if (![major, minor, patch].every(Number.isSafeInteger)) {
    return 0;
  }

  const code = major * 1_000_000 + minor * 1_000 + patch;
  return Number.isSafeInteger(code) ? code : 0;
}

interface UpdatePayload {
  deploymentId: string;
  releaseId: string;
  installationMode: string;
  expectedArtifactSha256?: string;
  maintenanceWindowStart?: string;
}

function readPayload(command: PlayerCommand): UpdatePayload | null {
  const payload = command.payload ?? {};
  const deploymentId = String(payload["deploymentId"] ?? "");
  const releaseId = String(payload["releaseId"] ?? "");
  const installationMode = String(payload["installationMode"] ?? "");
  if (!deploymentId || !releaseId || !installationMode) {
    return null;
  }
  const sha =
    (payload["expectedArtifactSha256"] as string | undefined) ??
    (payload["expectedApkSha256"] as string | undefined);
  return {
    deploymentId,
    releaseId,
    installationMode,
    expectedArtifactSha256: typeof sha === "string" ? sha : undefined,
    maintenanceWindowStart:
      typeof payload["maintenanceWindowStart"] === "string"
        ? (payload["maintenanceWindowStart"] as string)
        : undefined,
  };
}

export class SelfUpdater {
  constructor(private readonly deps: SelfUpdateDeps) {}

  /** Execute an install_player_update command. Never throws. */
  async run(command: PlayerCommand): Promise<void> {
    const payload = readPayload(command);
    if (!payload) {
      log.warn("ignoring malformed install_player_update payload", {
        id: command.id,
      });
      return;
    }

    await withStagePathLock(this.deps.stagePath, () =>
      this.runExclusive(payload),
    );
  }

  private async runExclusive(payload: UpdatePayload): Promise<void> {
    const { deploymentId } = payload;

    // Progress serialization belongs to this run. Two disruptive commands may
    // overlap briefly, and neither deployment should throttle or await the
    // other's status request.
    let progressReportedAt = 0;
    let latestProgressReport: Promise<void> = Promise.resolve();
    const reportProgress = (downloadedBytes: number): void => {
      const now = this.deps.now();
      if (now - progressReportedAt < PROGRESS_INTERVAL_MS) {
        return;
      }
      progressReportedAt = now;
      latestProgressReport = latestProgressReport.then(() =>
        this.report(deploymentId, {
          state: "downloading",
          downloadedBytes,
        }),
      );
    };

    try {
      if (!this.deps.appImagePath) {
        // Not packaged as an AppImage (dev run or unmanaged install): the
        // systemd/AppImage self-update channel does not apply here.
        await this.report(deploymentId, {
          state: "failed",
          error: "player is not running as a managed AppImage",
        });
        return;
      }

      const resumedBytes = await existingFileSize(
        `${this.deps.stagePath}.part`,
      );
      await this.report(deploymentId, {
        state: "downloading",
        downloadedBytes: resumedBytes,
      });
      progressReportedAt = this.deps.now();
      const meta = await this.deps.fetchMetadata(payload.releaseId);
      if (
        meta.platform !== "linux" ||
        !meta.artifactPath ||
        !meta.artifactSha256 ||
        !meta.artifactSizeBytes
      ) {
        throw new Error("release metadata is not a Linux AppImage");
      }
      if (
        payload.expectedArtifactSha256 &&
        meta.artifactSha256.toLowerCase() !==
          payload.expectedArtifactSha256.toLowerCase()
      ) {
        throw new Error("artifact hash does not match the deployment");
      }

      await this.deps.download({
        url: this.deps.buildUrl(meta.artifactPath),
        headers: this.deps.authHeaders(),
        destination: this.deps.stagePath,
        expectedSha256: meta.artifactSha256,
        expectedSizeBytes: meta.artifactSizeBytes,
        etag: `"sha256-${meta.artifactSha256}"`,
        onProgress: reportProgress,
      });
      // The downloader callback cannot await network telemetry. Drain its
      // serialized tail before advancing, so a late downloading report cannot
      // overwrite downloaded/verifying or any later state.
      await latestProgressReport;
      await this.report(deploymentId, {
        state: "downloaded",
        downloadedBytes: meta.artifactSizeBytes,
      });
      // Re-read the staged file immediately before it can be promoted. The
      // downloader verifies it too, but this closes the gap where another
      // process could replace a staged artifact between download and install.
      const present = await access(this.deps.stagePath)
        .then(() => true)
        .catch(() => false);
      if (
        !present ||
        !(await verifyFileIntegrity(
          this.deps.stagePath,
          meta.artifactSha256,
          meta.artifactSizeBytes,
        ))
      ) {
        throw new Error("staged AppImage failed final integrity verification");
      }
      // The download already verified size + SHA-256; surface the state anyway
      // so the dashboard mirrors the Android progression.
      await this.report(deploymentId, { state: "verifying" });
      await this.report(deploymentId, { state: "ready" });

      const delay = this.installDelayMs(payload);
      if (delay === null) {
        // download_only: staged and verified; a later install completes it.
        log.info("update staged; awaiting a separate install trigger", {
          deploymentId,
        });
        return;
      }
      if (delay > 0) {
        log.info("update staged; installing at maintenance window", {
          deploymentId,
          delayMs: delay,
        });
        await new Promise<void>((resolve) => setTimeout(resolve, delay));
      }

      // A maintenance window may leave the staged file unattended for hours.
      // Verify again at the last possible moment; a same-sized replacement
      // must never become the executable AppImage.
      if (
        !(await verifyFileIntegrity(
          this.deps.stagePath,
          meta.artifactSha256,
          meta.artifactSizeBytes,
        ))
      ) {
        throw new Error(
          "staged AppImage failed pre-promotion integrity verification",
        );
      }
      await this.report(deploymentId, { state: "installing" });
      await this.deps.promote(this.deps.stagePath, this.deps.appImagePath);
      // Signal that a supervised restart is imminent; the next heartbeat's
      // higher version code is what the server settles to "succeeded".
      await this.report(deploymentId, { state: "reconnecting" });
      log.info("update installed; exiting for systemd restart", {
        deploymentId,
      });
      this.deps.restart();
    } catch (err) {
      log.warn("self-update failed", { deploymentId, error: String(err) });
      // A failed terminal state must also stay ahead of any callback already
      // queued by the downloader.
      await latestProgressReport;
      await this.report(deploymentId, {
        state: "failed",
        error: String(err).slice(0, 240),
      });
    }
  }

  /**
   * Milliseconds to wait before installing, or null when the mode does not
   * install now (download_only). install_now installs immediately (0);
   * maintenance_window installs when the window arrives (clamped).
   */
  private installDelayMs(payload: UpdatePayload): number | null {
    if (payload.installationMode === "install_now") {
      return 0;
    }
    if (payload.installationMode === "maintenance_window") {
      const start = payload.maintenanceWindowStart
        ? Date.parse(payload.maintenanceWindowStart)
        : NaN;
      if (!Number.isFinite(start)) {
        return 0;
      }
      const delta = start - this.deps.now();
      if (delta <= 0) {
        return 0;
      }
      return Math.min(delta, MAX_WINDOW_DELAY_MS);
    }
    // download_only (and any unknown mode): stage only, do not restart.
    return null;
  }

  private async report(
    deploymentId: string,
    body: UpdateStatusReport,
  ): Promise<void> {
    try {
      await this.deps.reportStatus(deploymentId, body);
    } catch (err) {
      // Status is best-effort telemetry; the server reconciles from heartbeats.
      log.debug("update status report failed", {
        deploymentId,
        state: body.state,
        error: String(err),
      });
    }
  }
}
