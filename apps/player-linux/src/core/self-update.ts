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

/**
 * Longest single sleep while waiting for a maintenance window. The wait is
 * repeated until the window start has actually passed, so this only bounds how
 * long the updater goes without rechecking the clock.
 */
const MAX_WINDOW_WAIT_STEP_MS = 60 * 60 * 1_000;

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
  /** Resolve after the given delay. Defaults to a timer. */
  sleep?(ms: number): Promise<void>;
  /**
   * Durable record of an update that is staged and waiting for its maintenance
   * window. Without it a process restart loses the in-memory wait: the command
   * already ran, so nothing would ever install the staged file. Optional so
   * tests and unmanaged hosts can omit it.
   */
  stagedJob?: StagedJobStore;
}

/** What is needed to finish a staged install without the network. */
export interface StagedUpdateJob {
  deploymentId: string;
  maintenanceWindowStart?: string;
  artifactSha256: string;
  artifactSizeBytes: number;
}

export interface StagedJobStore {
  load(): Promise<unknown>;
  save(job: StagedUpdateJob): Promise<void>;
  clear(): Promise<void>;
}

function readStagedJob(value: unknown): StagedUpdateJob | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const { deploymentId, artifactSha256, artifactSizeBytes } = record;
  const windowStart = record["maintenanceWindowStart"];
  if (
    typeof deploymentId !== "string" ||
    !deploymentId ||
    typeof artifactSha256 !== "string" ||
    !artifactSha256 ||
    typeof artifactSizeBytes !== "number" ||
    !Number.isSafeInteger(artifactSizeBytes) ||
    artifactSizeBytes <= 0 ||
    (windowStart !== undefined && typeof windowStart !== "string")
  ) {
    return null;
  }
  return {
    deploymentId,
    maintenanceWindowStart: windowStart,
    artifactSha256,
    artifactSizeBytes,
  };
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

/** The Player release family this updater installs (the server's name). */
export const PLAYER_FAMILY = "electron-linux";

interface UpdatePayload {
  deploymentId: string;
  releaseId: string;
  playerFamily?: string;
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
  const family = payload["playerFamily"];
  return {
    deploymentId,
    releaseId,
    playerFamily: typeof family === "string" ? family : undefined,
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

      // A Tilecast Edge release is also a "linux" release, but it is a signed
      // archive for another installer. The server never targets this player
      // with one; refusing here keeps a mistake from reaching the AppImage.
      if (payload.playerFamily && payload.playerFamily !== PLAYER_FAMILY) {
        await this.report(deploymentId, {
          state: "failed",
          error: `release family ${payload.playerFamily.slice(0, 32)} is not installable by this player`,
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
        (meta.playerFamily !== undefined &&
          meta.playerFamily !== PLAYER_FAMILY) ||
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

      const delay = this.installDelayMs(
        payload.installationMode,
        payload.maintenanceWindowStart,
      );
      if (delay === null) {
        // download_only: staged and verified; a later install completes it.
        log.info("update staged; awaiting a separate install trigger", {
          deploymentId,
        });
        return;
      }
      await this.installStaged(
        {
          deploymentId,
          maintenanceWindowStart: payload.maintenanceWindowStart,
          artifactSha256: meta.artifactSha256,
          artifactSizeBytes: meta.artifactSizeBytes,
        },
        payload.installationMode,
      );
    } catch (err) {
      log.warn("self-update failed", { deploymentId, error: String(err) });
      // A failed terminal state must also stay ahead of any callback already
      // queued by the downloader.
      await latestProgressReport;
      await this.clearStagedJob(deploymentId);
      await this.report(deploymentId, {
        state: "failed",
        error: String(err).slice(0, 240),
      });
    }
  }

  /**
   * Finish an update that was staged before the process restarted. The file
   * was fully verified before it was recorded, so this needs no network: it
   * re-verifies the staged file, waits out the rest of the window, and installs.
   * Never throws.
   */
  async resume(): Promise<void> {
    let job: StagedUpdateJob | null;
    try {
      const stored = await this.deps.stagedJob?.load();
      if (stored === undefined || stored === null) {
        return;
      }
      job = readStagedJob(stored);
      if (!job) {
        log.warn("discarding unreadable staged update record");
        await this.deps.stagedJob?.clear();
        return;
      }
    } catch (err) {
      log.warn("could not read staged update record", { error: String(err) });
      return;
    }

    const staged = job;
    await withStagePathLock(this.deps.stagePath, async () => {
      const { deploymentId } = staged;
      log.info("resuming staged update after restart", { deploymentId });
      try {
        if (!this.deps.appImagePath) {
          throw new Error("player is not running as a managed AppImage");
        }
        if (
          !(await verifyFileIntegrity(
            this.deps.stagePath,
            staged.artifactSha256,
            staged.artifactSizeBytes,
          ))
        ) {
          throw new Error("staged AppImage failed integrity verification");
        }
        await this.installStaged(staged, "maintenance_window");
      } catch (err) {
        log.warn("resumed self-update failed", {
          deploymentId,
          error: String(err),
        });
        await this.clearStagedJob(deploymentId);
        await this.report(deploymentId, {
          state: "failed",
          error: String(err).slice(0, 240),
        });
      }
    });
  }

  /**
   * Wait for the maintenance window, then promote the staged AppImage and
   * restart. The caller has already verified the staged file and reported
   * `ready`. Throws on failure; the caller reports it.
   */
  private async installStaged(
    job: StagedUpdateJob,
    installationMode: string,
  ): Promise<void> {
    const { deploymentId } = job;
    const appImagePath = this.deps.appImagePath;
    if (!appImagePath) {
      throw new Error("player is not running as a managed AppImage");
    }
    const delay = this.installDelayMs(
      installationMode,
      job.maintenanceWindowStart,
    );
    if (delay !== null && delay > 0) {
      log.info("update staged; installing at maintenance window", {
        deploymentId,
        delayMs: delay,
      });
      await this.saveStagedJob(job);
      await this.waitForWindow(job.maintenanceWindowStart);
    }

    // A maintenance window may leave the staged file unattended for hours.
    // Verify again at the last possible moment; a same-sized replacement
    // must never become the executable AppImage.
    if (
      !(await verifyFileIntegrity(
        this.deps.stagePath,
        job.artifactSha256,
        job.artifactSizeBytes,
      ))
    ) {
      throw new Error(
        "staged AppImage failed pre-promotion integrity verification",
      );
    }
    // Forget the job before promoting so a crash between the two steps can
    // never install the same release again after the restart.
    await this.clearStagedJob(deploymentId);
    await this.report(deploymentId, { state: "installing" });
    await this.deps.promote(this.deps.stagePath, appImagePath);
    // Signal that a supervised restart is imminent; the next heartbeat's
    // higher version code is what the server settles to "succeeded".
    await this.report(deploymentId, { state: "reconnecting" });
    log.info("update installed; exiting for systemd restart", {
      deploymentId,
    });
    this.deps.restart();
  }

  private async saveStagedJob(job: StagedUpdateJob): Promise<void> {
    try {
      await this.deps.stagedJob?.save(job);
    } catch (err) {
      // The wait still proceeds in memory; only a restart would lose it.
      log.warn("could not record staged update", {
        deploymentId: job.deploymentId,
        error: String(err),
      });
    }
  }

  private async clearStagedJob(deploymentId: string): Promise<void> {
    try {
      await this.deps.stagedJob?.clear();
    } catch (err) {
      log.warn("could not clear staged update record", {
        deploymentId,
        error: String(err),
      });
    }
  }

  /**
   * Milliseconds to wait before installing, or null when the mode does not
   * install now (download_only). install_now installs immediately (0);
   * maintenance_window installs when the window arrives.
   */
  private installDelayMs(
    installationMode: string,
    maintenanceWindowStart: string | undefined,
  ): number | null {
    if (installationMode === "install_now") {
      return 0;
    }
    if (installationMode === "maintenance_window") {
      const start = maintenanceWindowStart
        ? Date.parse(maintenanceWindowStart)
        : NaN;
      if (!Number.isFinite(start)) {
        return 0;
      }
      const delta = start - this.deps.now();
      if (delta <= 0) {
        return 0;
      }
      return delta;
    }
    // download_only (and any unknown mode): stage only, do not restart.
    return null;
  }

  /**
   * Sleep in bounded steps until the maintenance window has started. The
   * start is re-read from the clock after every step, so a window further away
   * than one step is never promoted early.
   */
  private async waitForWindow(
    maintenanceWindowStart: string | undefined,
  ): Promise<void> {
    const sleep =
      this.deps.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    for (;;) {
      const remaining = this.installDelayMs(
        "maintenance_window",
        maintenanceWindowStart,
      );
      if (remaining === null || remaining <= 0) {
        return;
      }
      await sleep(Math.min(remaining, MAX_WINDOW_WAIT_STEP_MS));
    }
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
