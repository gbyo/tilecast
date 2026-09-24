/**
 * Player runtime orchestrator.
 *
 * Owns the full device lifecycle: identity verification, pairing, the
 * socket/reconnect loop, manifest/config/command synchronization, playlist
 * selection, item-boundary manifest activation, takeover, status
 * reporting, and the self-heal supervisor. Platform actions (windows,
 * renderer, relaunch) are behind the PlayerHost interface so the runtime
 * logic is independent of Electron.
 *
 * Reliability posture, in one place:
 *  - cached manifest and config apply at boot with zero network
 *  - the stored credential is sent only after the server's installation ID
 *    is verified, and cleared only on a confirmed invalid/revoked answer
 *  - socket reconnect uses jittered backoff that resets after health
 *  - commands poll on a timer independent of socket state
 *  - manifest reconciles on a timer independent of push notifications
 *  - a prepared manifest activates at the next item boundary; an active
 *    takeover interrupts immediately once prepared
 *  - playback health is judged by renderer-reported progress, with a
 *    persisted escalation ladder and safe mode behind it
 */

import { randomUUID } from "crypto";
import { promises as fs } from "fs";
import { ApiClient, ApiError, NetworkError } from "./api";
import { ActivityReporter } from "./activity";
import {
  PlaybackSessionTracker,
  type TerminalReason,
} from "./activity-sessions";
import {
  TelemetryReporter,
  TELEMETRY_INTERVAL_MS,
  type DisconnectReason,
  type TelemetryGauges,
} from "./telemetry";
import { LiveStream } from "./live-stream";
import {
  assessRenderProgress,
  initialRenderProgressState,
  onItemPresented,
  onPlaybackIdle,
  onRenderProgress,
  recordAssessment,
  renderProgressConfigFor,
  type ContentExpectation,
  type ProgressSignal,
  type RenderProgressState,
} from "./render-progress";
import { ReconnectBackoff } from "./backoff";
import {
  heartbeatItemId,
  layoutItemKey,
  uuidHeartbeatField,
} from "./identifiers";
import { CommandCoordinator } from "./commands";
import { ConfigSync } from "./config";
import { ServerClock } from "./clock";
import { shouldClearWebsiteDataAtStartup } from "./website-startup";
import {
  isAvailableAt,
  nextAvailabilityTransition,
  type AvailabilityWindow,
} from "@tilecast/player-runtime/projection";
import { cacheIdentityMatches, makeCacheIdentity } from "./cache-identity";
import { downloadVerified } from "./download";
import {
  readSystemDiagnostics,
  readWiredInterfaceStatus,
} from "./system-probe";
import { SelfUpdater, parseVersionCode, promoteAppImage } from "./self-update";
import {
  AutostartInstaller,
  coldBootLaunchVerified,
  parseProcUptime,
  systemAutostartDeps,
  type AutostartStatus,
} from "./autostart";
import { LivePreview, type PreviewHost } from "./preview";
import { logger } from "./log";
import { ManifestSync } from "./manifest";
import {
  buildDeviceMetadata,
  clearCredential,
  loadCredential,
  loadOrCreateInstallationId,
  pairUntilEnrolled,
  type CredentialRecord,
} from "./pairing";
import {
  takeoverActive,
  presentationOverrideActive,
  findPlaylist,
  resolveSelection,
  resolveDisplayPolicy,
  type Selection,
} from "./schedule";
import { PlayerSocket } from "./socket";
import { activeHoursFromConfig, evaluateActiveHours } from "./active-hours";
import { renderWidget } from "@tilecast/player-runtime/projection";
import { renderLayout } from "@tilecast/player-runtime/projection";
import { resolveRegionalFormatting } from "@tilecast/player-runtime/projection";
import {
  fallbackDurationMsFor,
  resolvePlaybackItemSettings,
} from "@tilecast/player-runtime/projection";
import type {
  ManifestDataSource,
  ManifestLayout,
  ManifestWidget,
} from "@tilecast/player-runtime/projection";
import type {
  LayoutRenderPayload,
  WidgetRenderPayload,
} from "@tilecast/player-runtime/projection";
import type { StateStore } from "./storage";
import {
  NOISE_HISTORY_BATCH,
  NoiseHistoryQueue,
  type NoiseHistoryBucket,
} from "./noise-history";
import type {
  AirplayAudioMode,
  AirplayCapabilities,
  ExternalPresentationConfig,
  ExternalPresentationStatus,
} from "./external-presentation";
import { parseExternalPresentationConfig } from "./external-presentation";
import {
  parsePresentationNetworkAssignment,
  type PresentationNetworkAssignment,
  type PresentationNetworkCapability,
} from "./presentation-network";
import {
  parseDisplayControlCommand,
  unsupportedDisplayControlStatus,
  type DisplayControlHost,
  type DisplayControlStatus,
} from "./display-control";
import {
  DEFAULT_SUPERVISOR_CONFIG,
  clearSafeMode,
  evaluate,
  initialSupervisorState,
  onProgress,
  type HealAction,
  type SupervisorConfig,
  type SupervisorState,
} from "./supervisor";
import type {
  CommandResultReport,
  Heartbeat,
  HeartbeatNoiseMeter,
  Manifest,
  ManifestPlugin,
  ManifestItem,
  ManifestPlaylist,
  PlayerCommand,
  PlayerConfig,
  SpanViewport,
} from "./types";

const log = logger("player");

const SUPERVISOR_FILE = "supervisor-state.json";
const PLAYBACK_FLAGS_FILE = "playback-flags.json";
const PLAYBACK_CHECKPOINT_FILE = "playback-checkpoint.json";
const SELECTION_EVAL_INTERVAL_MS = 30_000;
const SUPERVISOR_TICK_MS = 15_000;
const DEFAULT_STATUS_INTERVAL_S = 60;

export { resolvePlaybackItemSettings } from "@tilecast/player-runtime/projection";

function spanViewport(manifest: Manifest): SpanViewport | undefined {
  const canvas = manifest.canvas;
  const viewport = manifest.viewport;
  if (!canvas || !viewport) {
    return undefined;
  }
  return {
    ...viewport,
    canvasWidth: canvas.width,
    canvasHeight: canvas.height,
  };
}

export interface PresentationItem {
  id: string;
  kind: "image" | "video" | "website" | "widget" | "layout" | "youtube";
  /** tcmedia:// URL for media, https page URL for websites/youtube. */
  src: string;
  durationMs: number | null;
  fitMode: string;
  transition?: string;
  audioEnabled: boolean;
  volume: number;
  videoStartOffsetMs: number | null;
  videoEndOffsetMs: number | null;
  /** Logical wall viewport, present only for Span content. */
  viewport?: SpanViewport;
  website?: {
    loadTimeoutSeconds: number;
    refreshIntervalSeconds: number | null;
    zoomPercent: number;
    javascriptEnabled: boolean;
    domStorageEnabled: boolean;
    cookiePolicy: string;
    reloadPolicy: string;
    customUserAgent: string;
    scrollX: number;
    scrollY: number;
    backgroundColor: string;
    failureBehavior: string;
    fallbackSrc: string | null;
    allowedHosts: string[];
  };
  /** Pre-resolved render tree for widget / declarative-presentation items. */
  widget?: WidgetRenderPayload;
  /** Pre-resolved multi-zone layout. */
  layout?: LayoutRenderPayload;
}

export type Presentation =
  | { state: "setup" }
  | {
      state: "pairing";
      code: string;
      approvalUrl: string;
      organizationName?: string;
    }
  | {
      state: "idle";
      title: string;
      message: string;
      backgroundColor?: string;
      textColor?: string;
      logoSrc?: string | null;
      footerText?: string;
      status?: string;
    }
  | {
      state: "disabled";
      title: string;
      message: string;
      backgroundColor?: string;
      textColor?: string;
      logoSrc?: string | null;
      footerText?: string;
      status?: string;
    }
  | {
      state: "unavailable";
      title: string;
      message: string;
      backgroundColor?: string;
      textColor?: string;
      logoSrc?: string | null;
      footerText?: string;
      status?: string;
    }
  | { state: "safe-mode"; reason: string }
  | { state: "sleep" }
  | {
      state: "playing";
      items: PresentationItem[];
      takeover: boolean;
      generation: number;
    }
  | {
      state: "external-presentation";
      provider: "airplay";
      sessionId: string;
      receiverName: string;
      pin: string;
      expiresAt: string;
      connected: boolean;
      role: "single" | "gateway" | "receiver";
      transport: "unicast" | "multicast";
      audioMode: AirplayAudioMode;
      /**
       * Presentation Network progress, so the ready page says something useful
       * while the gateway authenticates instead of sitting on "Preparing".
       *
       * Deliberately generic: the TV shows "Connecting to the presentation
       * network…" rather than the network's name, and never the SSID or the
       * credential. Studio, where an operator is already authenticated, gets the
       * named version.
       */
      presentationNetwork?: "joining" | "connected" | "failed";
    };

export function presentationIdentity(presentation: Presentation): string {
  return JSON.stringify(presentation, (name, value) =>
    name === "generation" ? undefined : value,
  );
}

export function manifestActivationGraceMilliseconds(
  manifest: Manifest,
): number {
  return (
    Math.min(Math.max(manifest.activationGraceSeconds || 30, 1), 3_600) * 1_000
  );
}

export interface PlayerHost extends DisplayControlHost {
  /** Replace what the renderer is showing. */
  present(presentation: Presentation): void;
  /** Update built-in plugin surfaces without touching playlist playback. */
  presentPlugins?(plugins: ManifestPlugin[], clockOffsetMs: number): void;
  /** Apply platform-host settings when cached or synchronized config changes. */
  applyPlayerConfiguration?(config: PlayerConfig): void;
  /** Show a transient identify overlay. */
  identify(name: string, durationSeconds: number): void;
  /** Recreate the renderer view (heal rung / command). */
  recreateRenderer(): void;
  /** Recreate the whole kiosk window (heal rung). */
  recreateWindow(): void;
  /** Relaunch the entire process (heal rung / restart commands). */
  restartProcess(): void;
  /** Exit after replacing an AppImage so the systemd unit starts the new file. */
  exitForUpdate(): void;
  /** Clear website renderer storage. */
  clearWebsiteData(): Promise<void>;
  /** Ask the renderer to retry or skip the current item. */
  retryCurrentItem(): void;
  skipCurrentItem(): void;
  screenSize(): { width: number; height: number };
  /**
   * What the panel actually negotiated, which is not the same as the window
   * size the renderer was given. Optional because a preview host has no panel.
   */
  displayInfo?(): {
    connected: boolean;
    width: number;
    height: number;
    refreshHz?: number;
  } | null;
  availableStorageBytes(): Promise<number | null>;
  /** Capture the window for live preview, downscaled within limits. Returns
   * null in states that must not be uploaded (the runtime also gates this). */
  capturePreview(max: {
    width: number;
    height: number;
    bytes: number;
  }): Promise<{ jpeg: Buffer; width: number; height: number } | null>;
  /** Linux owns UxPlay/GStreamer; the generic runtime only owns policy/state. */
  prepareExternalPresentation?(
    config: ExternalPresentationConfig,
  ): Promise<ExternalPresentationStatus>;
  startExternalPresentation?(): Promise<ExternalPresentationStatus>;
  stopExternalPresentation?(reason: string): Promise<void>;
  recoverExternalPresentation?(): Promise<{
    config: ExternalPresentationConfig;
    status: ExternalPresentationStatus;
  } | null>;
  getExternalPresentationStatus?(): ExternalPresentationStatus | null;
  probeAirplayCapabilities?(): Promise<AirplayCapabilities>;
  /**
   * Presentation Networks are a Linux capability behind the root-owned helper.
   * The generic runtime owns only policy and reporting; the host owns the
   * NetworkManager lifecycle. All optional, so a host without them — a preview
   * host, or an Android build — simply reports nothing.
   */
  probePresentationNetwork?(): Promise<PresentationNetworkCapability>;
  applyPresentationNetworkAssignment?(
    assignment: PresentationNetworkAssignment | null,
  ): Promise<void>;
  /** Reported state for the heartbeat, without re-probing the helper. */
  getPresentationNetworkState?(): {
    state: string;
    networkId: string | null;
    activeNetworkId: string | null;
    installedNetworkId: string | null;
    installedRevision: number | null;
    failureCode?: string;
    lastConnectedAt?: string;
    lastFailureAt?: string;
  } | null;
  /** Reconcile provisioned profiles against the assignment, now. */
  reconcilePresentationNetwork?(): Promise<void>;
  /** Bounded connection test: join, verify, disconnect, restore radio state. */
  testPresentationNetwork?(
    networkId: string,
    timeoutSeconds: number,
  ): Promise<{
    success: boolean;
    code: string;
    message: string;
  }>;
}

interface PlaybackFlags {
  playbackDisabled: boolean;
}

interface PlaybackCheckpoint {
  installationId: string;
  screenId: string;
  normalizedServerUrl: string;
  manifestVersion: number;
  playlistId: string;
  itemId: string;
  savedAt: string;
}

export interface PlayerRuntimeOptions {
  serverUrl: string;
  playerVersion: string;
  fetchImpl?: typeof fetch;
}

export class PlayerRuntime {
  private client: ApiClient;
  private manifestSync: ManifestSync;
  private configSync: ConfigSync;
  private commands: CommandCoordinator | null = null;
  private selfUpdater: SelfUpdater | null = null;
  private autostart: AutostartInstaller | null = null;
  /**
   * Cached autostart facts. Autostart only changes through the two commands
   * below, so this is refreshed at startup and after each of them rather than
   * running subprocesses on every heartbeat.
   */
  private autostartStatus: AutostartStatus | null = null;
  /** System uptime when this process started; the boot-launch evidence. */
  private systemUptimeAtStartSeconds: number | null = null;
  private activity: ActivityReporter | null = null;
  private sessions: PlaybackSessionTracker | null = null;
  /** What the renderer is currently showing, so a child session can name it. */
  private presentedItems: PresentationItem[] = [];
  /**
   * Meaningful-progress tracking. The supervisor is fed from this rather than
   * from raw signals, so a legitimately motionless still image never looks
   * like a freeze.
   */
  private renderProgress: RenderProgressState = initialRenderProgressState(
    Date.now(),
  );
  private telemetry: TelemetryReporter | null = null;
  private lastTelemetryTickMs = Date.now();
  private preview: LivePreview | null = null;
  private liveStream: LiveStream | null = null;
  private socket: PlayerSocket | null = null;
  private readonly backoff = new ReconnectBackoff({
    baseDelayMs: 2_000,
    maxDelayMs: 5 * 60_000,
    healthyResetMs: 2 * 60_000,
  });

  private credential: CredentialRecord | null = null;
  private installationId = "";
  private config: PlayerConfig | null = null;
  private airplayCapabilities: AirplayCapabilities | null = null;
  private presentationNetworkCapability: PresentationNetworkCapability | null =
    null;
  private presentationNetworkAssignment: PresentationNetworkAssignment | null =
    null;
  private wiredInterface: { available: boolean; ipv4: string } | null = null;
  private displayControlStatus: DisplayControlStatus | null = null;
  private externalPresentation: ExternalPresentationConfig | null = null;
  private externalPresentationStatus: ExternalPresentationStatus | null = null;
  /**
   * Keep the last session identity on a clearing heartbeat. This lets the
   * server reconcile the session that actually stopped without allowing a
   * delayed `none` heartbeat from an old session to clear a newer one.
   */
  private lastExternalPresentationSessionId: string | null = null;

  private activeManifest: Manifest | null = null;
  private pendingManifest: Manifest | null = null;
  private selection: Selection | null = null;
  private generation = 0;
  private currentItemId: string | null = null;
  private playbackState = "starting";
  private lastHealthyPlaybackAt: string | null = null;
  /**
   * Noise Meter state, on the trusted side of the preload boundary.
   *
   * The renderer measures a room fifteen to twenty times a second and hands
   * over one completed aggregate every ten seconds. Nothing about that rate
   * reaches the network: the queue is drained by the ordinary heartbeat, and
   * only after the server has acknowledged a batch.
   */
  private readonly noiseHistory: NoiseHistoryQueue;
  private noiseMeterStatus: HeartbeatNoiseMeter["status"] = "inactive";
  private noiseMeterLevel: number | null = null;
  /** The batch attached to the heartbeat currently in flight, if any. */
  private noiseHistoryInFlight: NoiseHistoryBucket[] = [];
  private lastPlaybackError: string | null = null;
  private websiteRecoveryCount = 0;
  private playbackCheckpoint: PlaybackCheckpoint | null = null;
  private resumeCheckpointPending = true;
  private checkpointWrite = Promise.resolve();

  private supervisorState: SupervisorState = initialSupervisorState(Date.now());
  private flags: PlaybackFlags = { playbackDisabled: false };
  private lastCommand: {
    id: string;
    state: string;
    result: string;
    completedAt: string;
  } | null = null;

  private timers: NodeJS.Timeout[] = [];
  private statusTimer: NodeJS.Timeout | null = null;
  private configTimer: NodeJS.Timeout | null = null;
  private pairedTimersStarted = false;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private pendingActivationTimer: NodeJS.Timeout | null = null;
  private selectionTransitionTimer: NodeJS.Timeout | null = null;
  private selectionTransitionAt: string | null = null;
  private displayPolicyTransitionTimer: NodeJS.Timeout | null = null;
  private displayPolicyTransitionAt: string | null = null;
  private availabilityTransitionTimer: NodeJS.Timeout | null = null;
  private availabilityTransitionAt: string | null = null;
  private displayPolicyKey = "";
  private stopped = false;
  private socketOpen = false;
  private readonly startedAt = Date.now();
  /**
   * One corrected wall clock shared by scheduling, availability, takeovers,
   * transitions, plugins, and offline playback. The offset is restored from
   * the cached manifest before any cached selection is evaluated.
   */
  private readonly clock = new ServerClock();
  /** Refreshed on the telemetry cadence rather than per tick: sysfs reads. */
  private systemDiagnostics: TelemetryGauges = {};
  private lastDisconnectReason: DisconnectReason | undefined;
  /**
   * Startup phase durations for this process. Recorded once per boot, which is
   * what makes "it took four minutes to come back after the power cut"
   * attributable to a phase instead of a guess.
   */
  private startupTimings: {
    configMs?: number;
    manifestMs?: number;
    assetVerifyMs?: number;
    firstFrameMs?: number;
    totalMs?: number;
  } = {};

  constructor(
    private readonly store: StateStore,
    private readonly host: PlayerHost,
    private readonly options: PlayerRuntimeOptions,
  ) {
    this.client = new ApiClient(
      options.serverUrl,
      null,
      options.fetchImpl ?? fetch,
    );
    this.noiseHistory = new NoiseHistoryQueue(this.store);
    // Every request counts, from the client's own choke point, so the counters
    // describe all of the player's traffic and not the call sites that
    // remembered to measure.
    this.client.observeRequests((observation) =>
      this.telemetry?.recordRequest(observation),
    );
    this.manifestSync = new ManifestSync(
      this.store,
      this.client,
      {
        onManifestPrepared: (manifest, clockOffsetMs) =>
          this.onManifestPrepared(manifest, clockOffsetMs),
        onCredentialRejected: () => void this.onCredentialRejected(),
        onSyncError: (error) => log.warn("manifest sync error", { error }),
      },
      {
        onResumed: () => this.telemetry?.addCount("downloadResumeCount", 1),
        onBytes: (bytes, durationMs) => {
          this.telemetry?.addCount("downloadedBytes", bytes);
          // Throughput only. A media transfer is deliberately not counted as an
          // HTTP request: it does not go through the client's request path, so a
          // failed one would not be counted there either, and the request
          // failure rate would read lower than the truth.
          if (durationMs > 0 && bytes > 0) {
            this.telemetry?.recordSample(
              "throughput",
              (bytes / durationMs) * 1_000,
            );
          }
        },
        onIntegrityFailure: () =>
          this.telemetry?.addCount("integrityFailureCount", 1),
        onFailure: () => this.telemetry?.addCount("downloadFailureCount", 1),
      },
      this.clock,
    );
    this.configSync = new ConfigSync(this.store, this.client, {
      onConfigApplied: (config) => {
        this.config = config;
        this.manifestSync.applyPolicy(
          this.numberConfig(config.cache, "maximumBytes", 8 * 1024 ** 3),
          this.numberConfig(config.cache, "minimumFreeBytes", 1024 ** 3),
          this.numberConfig(
            config.cache,
            "automaticThresholdBytes",
            256 * 1024 ** 2,
          ),
          this.numberConfig(config.cache, "concurrentDownloads", 2),
          this.numberConfig(config.sync, "manifestReconciliationSeconds", 300),
        );
        this.host.applyPlayerConfiguration?.(config);
        // The Presentation Network assignment is durable configuration, so
        // applying it here is what makes an assignment change converge — including
        // for a player that was offline when the change happened. A section that
        // says "not assigned" is an instruction to remove any Tilecast-managed
        // Wi-Fi profile, not an absence of one.
        void this.applyPresentationNetworkConfiguration(config);
        if (this.pairedTimersStarted) {
          this.rescheduleRuntimeTimers();
          this.evaluatePresentation();
        }
        if (
          shouldClearWebsiteDataAtStartup(
            config.website["clearOnRestart"] === true,
          )
        ) {
          void this.host.clearWebsiteData().catch((error) =>
            log.warn("website startup data clear failed", {
              error: String(error),
            }),
          );
        }
      },
      onCredentialRejected: () => void this.onCredentialRejected(),
    });
  }

  // -------------------------------------------------------------- lifecycle

  async start(): Promise<void> {
    // Read before anything slow: how long the system had been up when this
    // process started is only meaningful if it is sampled at start.
    this.systemUptimeAtStartSeconds = await this.readSystemUptimeSeconds();
    await this.store.init();
    this.installationId = await loadOrCreateInstallationId(this.store);
    this.supervisorState =
      (await this.store.readJson<SupervisorState>(SUPERVISOR_FILE)) ??
      initialSupervisorState(Date.now());
    this.flags = (await this.store.readJson<PlaybackFlags>(
      PLAYBACK_FLAGS_FILE,
    )) ?? {
      playbackDisabled: false,
    };

    // Buckets accumulated before the last restart are still owed to the server.
    await this.noiseHistory.load();

    this.credential = await loadCredential(this.store);
    if (
      this.credential &&
      this.credential.serverUrl !== this.options.serverUrl
    ) {
      // Server address was reconfigured; the old credential targets another
      // installation and must not be sent to the new address.
      log.warn("server url changed; existing credential does not apply");
      this.credential = null;
    }

    if (this.credential) {
      const identity = makeCacheIdentity(
        this.options.serverUrl,
        this.credential.installationId,
        this.credential.screenId,
      );
      this.manifestSync.setIdentity(identity);
      this.configSync.setIdentity(identity);
      const checkpoint = await this.store.readJson<PlaybackCheckpoint>(
        PLAYBACK_CHECKPOINT_FILE,
      );
      if (
        identity &&
        checkpoint &&
        cacheIdentityMatches(identity, checkpoint)
      ) {
        this.playbackCheckpoint = checkpoint;
      } else {
        await this.store.delete(PLAYBACK_CHECKPOINT_FILE);
      }
      this.client.setCredential(this.credential.deviceCredential);
      await this.runPaired();
    } else {
      await this.store.delete(PLAYBACK_CHECKPOINT_FILE);
      await this.runPairing();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.configTimer) clearInterval(this.configTimer);
    this.statusTimer = null;
    this.configTimer = null;
    this.pairedTimersStarted = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }
    if (this.pendingActivationTimer) clearTimeout(this.pendingActivationTimer);
    if (this.selectionTransitionTimer)
      clearTimeout(this.selectionTransitionTimer);
    if (this.displayPolicyTransitionTimer)
      clearTimeout(this.displayPolicyTransitionTimer);
    if (this.availabilityTransitionTimer)
      clearTimeout(this.availabilityTransitionTimer);
    this.socket?.close();
    this.manifestSync.stop();
    this.commands?.stop();
    // Close open sessions before stopping the reporter, so playback that was
    // on screen at shutdown is reported with a real reason instead of being
    // left for the server's bounded timeout to guess at.
    this.telemetry?.stop();
    this.sessions?.shutdown("process_exit");
    await this.activity?.stop();
    this.preview?.stop();
    this.liveStream?.stop();
    // An orderly stop must not lose a queued bucket that was waiting for the
    // batched write.
    await this.noiseHistory.flush();
    await this.host.stopExternalPresentation?.("process_exit");
  }

  // ---------------------------------------------------------------- pairing

  private async runPairing(): Promise<void> {
    const serverIdentity = await this.waitForVerifiedIdentity(null);
    const size = this.host.screenSize();
    const metadata = buildDeviceMetadata({
      playerInstallationId: this.installationId,
      playerVersion: this.options.playerVersion,
      screenWidth: size.width,
      screenHeight: size.height,
    });

    const credential = await pairUntilEnrolled(
      this.store,
      this.client,
      serverIdentity.installationId,
      metadata,
      {
        onWaitingForApproval: (progress) => {
          this.host.present({
            state: "pairing",
            code: progress.code,
            approvalUrl: progress.approvalUrl,
            organizationName: progress.organizationName,
          });
        },
        onSessionEnded: (reason) => {
          log.info("pairing session ended", { reason });
        },
      },
      (ms) => this.sleep(ms),
    );

    this.credential = credential;
    this.playbackCheckpoint = null;
    await this.store.delete(PLAYBACK_CHECKPOINT_FILE);
    const identity = makeCacheIdentity(
      this.options.serverUrl,
      credential.installationId,
      credential.screenId,
    );
    this.manifestSync.setIdentity(identity);
    this.configSync.setIdentity(identity);
    this.client.setCredential(credential.deviceCredential);
    await this.runPaired();
  }

  /**
   * A configured player verifies the installation ID before sending any
   * stored device credential. Network failure retries forever; a mismatch
   * (for a paired player) keeps the credential safe and keeps retrying —
   * cached playback continues meanwhile.
   */
  private async waitForVerifiedIdentity(expected: string | null) {
    for (;;) {
      try {
        const identity = await this.client.identity();
        if (expected && identity.installationId !== expected) {
          log.error("installation identity mismatch; withholding credential", {
            expected,
            actual: identity.installationId,
          });
          await Promise.all([
            this.manifestSync.invalidateCachedState(),
            this.configSync.invalidateCachedState(),
            this.store.delete(PLAYBACK_CHECKPOINT_FILE),
          ]);
          this.playbackCheckpoint = null;
          await this.sleep(60_000);
          continue;
        }
        return identity;
      } catch (err) {
        log.warn("identity fetch failed; retrying", { error: String(err) });
        await this.sleep(err instanceof NetworkError ? 5_000 : 15_000);
      }
    }
  }

  // ----------------------------------------------------------------- paired

  private identityVerified = false;

  private async runPaired(): Promise<void> {
    // Cached content and configuration first — playback never waits for the
    // network. These emit onManifestPrepared/onConfigApplied from disk and
    // send nothing over the wire.
    const cachedConfigAt = Date.now();
    await this.configSync.loadCached();
    this.startupTimings.configMs = Date.now() - cachedConfigAt;
    const cachedManifestAt = Date.now();
    await this.manifestSync.loadCached();
    this.startupTimings.manifestMs = Date.now() - cachedManifestAt;

    // A power cut must not silently end an unexpired presentation. The Linux
    // host reconstructs UxPlay/GStreamer from its owner-only session file;
    // normal signage remains the fallback if the file is absent or expired.
    await this.recoverExternalPresentation();

    this.timers.push(
      setInterval(
        () => this.evaluatePresentation(),
        SELECTION_EVAL_INTERVAL_MS,
      ),
      setInterval(() => void this.supervisorTick(), SUPERVISOR_TICK_MS),
      setInterval(() => void this.externalPresentationTick(), 1_000),
    );
    this.pairedTimersStarted = true;
    this.rescheduleRuntimeTimers();

    this.selfUpdater = new SelfUpdater({
      appImagePath: process.env["APPIMAGE"] ?? null,
      stagePath: this.store.filePath("player-update.AppImage"),
      fetchMetadata: (releaseId) => this.client.fetchUpdateMetadata(releaseId),
      reportStatus: (deploymentId, body) =>
        this.client.reportUpdateStatus(deploymentId, body),
      download: (request) =>
        downloadVerified(request, this.options.fetchImpl ?? fetch),
      buildUrl: (path) => this.client.url(path),
      authHeaders: () => this.client.authHeaders(),
      promote: promoteAppImage,
      restart: () => this.host.exitForUpdate(),
      now: () => Date.now(),
    });

    this.autostart = new AutostartInstaller(
      systemAutostartDeps(process.env, {
        // Persist the effective values, not just the variables that happened
        // to be present when a legacy/manual AppImage was launched. This keeps
        // the unit on the same identity and state directory after handoff.
        dataDirectory: this.store.dataDir,
        serverUrl: this.options.serverUrl,
      }),
    );
    // Probed once here so the first heartbeat already carries autostart state;
    // Studio's Linux boot row is otherwise blank until an operator acts. Runs
    // alongside the startup syncs and is awaited before the socket opens, so
    // the probe's subprocesses never delay startup but always land in time.
    const autostartProbed = this.refreshAutostartStatus();

    this.commands = new CommandCoordinator(
      this.store,
      this.client,
      this.buildCommandHandlers(),
      // install_player_update is disruptive: the coordinator persists the
      // idempotency key and settles the command before the updater runs, so a
      // relaunch neither re-runs nor dangles it.
      new Set([
        "restart_player_process",
        "restart_activity",
        "install_player_update",
      ]),
      (command) => this.runDisruptiveCommand(command),
      {
        onCredentialRejected: () => void this.onCredentialRejected(),
        onPollError: (error) => log.debug("command poll error", { error }),
        onCommandCompleted: (command, result) => {
          this.lastCommand = {
            id: command.id,
            state: result.success ? "succeeded" : "failed",
            result: result.code,
            completedAt: new Date().toISOString(),
          };
        },
      },
    );

    // Identity gate: no stored credential leaves this device until the
    // server proves it is the installation we enrolled with. Cached playback
    // is already running above; this only delays network features.
    await this.waitForVerifiedIdentity(this.credential!.installationId);
    this.identityVerified = true;

    this.activity = new ActivityReporter(
      this.store,
      this.client,
      () => Date.now(),
      () => randomUUID(),
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    );
    await this.activity.start();
    // Contract v2: this player must open real playback sessions, not only
    // report terminal events the server cannot match to a start.
    // Bounded telemetry: gauges are read at flush time and counters are
    // accumulated by the tick below, so nothing high-frequency is uploaded.
    this.telemetry = new TelemetryReporter(
      this.client,
      () => this.telemetryGauges(),
      () => Date.now(),
    );
    this.telemetry.start();
    this.timers.push(
      setInterval(() => this.accumulateTelemetry(), 10_000),
      setInterval(
        () => void this.refreshSystemDiagnostics(),
        TELEMETRY_INTERVAL_MS,
      ),
    );
    // Read once now so the first sample already carries them.
    void this.refreshSystemDiagnostics();
    // Capability probing is intentionally asynchronous and infrequent: the
    // 2012-class target should not spawn vainfo/gst-inspect on every heartbeat.
    void this.refreshAirplayCapabilities().then(() => void this.reportStatus());
    void this.refreshDisplayControl().then(() => void this.reportStatus());
    // The Presentation Network probe is one unix-socket call, so it is cheap
    // enough for the reporting cadence on the 2012-class target. Studio cannot
    // offer the feature on a screen whose capability it has never seen, which is
    // why the first heartbeat should already carry it.
    void this.refreshPresentationNetwork().then(() => void this.reportStatus());

    this.sessions = new PlaybackSessionTracker(
      (event) => void this.activity?.record(event),
      () => Date.now(),
      () => randomUUID(),
    );

    this.preview = new LivePreview(
      this.client,
      {
        capture: (max) =>
          // Protected states never upload an image.
          this.playbackState === "pairing" ||
          this.playbackState === "setup" ||
          this.playbackState === "external-presentation" ||
          this.supervisorState.safeMode
            ? Promise.resolve(null)
            : this.host.capturePreview(max),
        playerVersion: this.options.playerVersion,
      } satisfies PreviewHost,
      () => Date.now(),
    );
    this.preview.start();
    this.liveStream = new LiveStream(
      this.client,
      {
        capture: (max) =>
          this.playbackState === "pairing" ||
          this.playbackState === "setup" ||
          this.playbackState === "external-presentation" ||
          this.supervisorState.safeMode
            ? Promise.resolve(null)
            : this.host.capturePreview(max),
        send: (sessionId, capturedAtMs, capture) =>
          this.socket?.sendLiveStreamFrame(
            sessionId,
            capturedAtMs,
            capture.width,
            capture.height,
            capture.jpeg,
          ) ?? false,
      },
      () => Date.now(),
    );
    this.liveStream.start();

    await this.configSync.syncNow("startup");
    await this.manifestSync.start();
    // Caught up with the server, which is a different milestone from having
    // content on screen: cached playback starts long before this.
    this.startupTimings.totalMs = Date.now() - this.startedAt;
    await this.commands.start();
    await autostartProbed;
    this.connectSocket();
  }

  private connectSocket(): void {
    if (this.stopped || !this.credential) {
      return;
    }
    const socketUrl =
      this.options.serverUrl.replace(/^http/, "ws").replace(/\/+$/, "") +
      "/api/v1/player/socket";
    this.socket = new PlayerSocket(
      socketUrl,
      this.credential.deviceCredential,
      this.options.playerVersion,
      {
        onOpen: () => {
          const wasDown = !this.socketOpen && this.backoff.failureStreak > 0;
          this.socketOpen = true;
          this.backoff.onConnected(Date.now());
          log.info("connected");
          if (wasDown) {
            void this.activity?.record({
              eventType: "connection.restored",
              category: "connectivity",
              result: "recovered",
            });
          }
          // Reconcile everything immediately: any push lost while offline is
          // recovered right here.
          void this.manifestSync.syncNow("socket-open");
          void this.configSync.syncNow("socket-open");
          void this.commands?.pollNow("socket-open");
          this.liveStream?.sessionChanged();
          void this.reportStatus();
        },
        onClose: (reason, policyViolation, category) => {
          const wasOpen = this.socketOpen;
          this.socketOpen = false;
          const delay = this.backoff.onDisconnected(Date.now());
          // The category is safe to report; the text stays in this log.
          this.lastDisconnectReason = category;
          if (wasOpen) {
            this.telemetry?.addCount("socketReconnectCount", 1);
          }
          log.warn("socket closed", { reason, category, retryInMs: delay });
          if (wasOpen) {
            void this.activity?.record({
              eventType: "connection.lost",
              category: "connectivity",
              severity: "warning",
              failureMessage: reason,
            });
          }
          if (policyViolation) {
            // Revoked or disabled — an authenticated HTTP call decides which
            // (only a confirmed invalid/revoked clears the credential).
            void this.probeCredential();
          }
          if (!this.stopped) {
            this.reconnectTimer = setTimeout(() => this.connectSocket(), delay);
          }
        },
        onManifestChanged: () => void this.manifestSync.syncNow("push"),
        onConfigChanged: () => void this.configSync.syncNow("push"),
        onCommandsAvailable: () => void this.commands?.pollNow("push"),
        onLiveStreamSessionChanged: () => this.liveStream?.sessionChanged(),
      },
    );
    this.socket.connect();
  }

  /** Distinguish revoked credential from a merely disabled screen. */
  private async probeCredential(): Promise<void> {
    try {
      await this.client.fetchCommands();
    } catch (err) {
      if (err instanceof ApiError && err.credentialRejected) {
        await this.onCredentialRejected();
      } else if (err instanceof ApiError && err.screenDisabled) {
        log.info("screen is administratively disabled");
      }
    }
  }

  private async onCredentialRejected(): Promise<void> {
    if (!this.credential) {
      return;
    }
    log.error("device credential confirmed invalid or revoked; re-pairing");
    this.credential = null;
    this.client.setCredential(null);
    await clearCredential(this.store);
    // Relaunch into a clean pairing state rather than juggling half-stopped
    // sync loops in-process. The relaunched player shows the pairing code and
    // needs only a Studio approval — never a visit to the device.
    this.host.restartProcess();
  }

  // ------------------------------------------------------------- activation

  private onManifestPrepared(manifest: Manifest, clockOffsetMs = 0): void {
    this.clock.restore(clockOffsetMs);
    // Plugin state is independent of presentation activation. Sending it on
    // its own channel makes create/update/hide immediate and guarantees that
    // the current item, decoder, timeline, and proof-of-play session remain
    // untouched.
    this.host.presentPlugins?.(
      this.externalPresentation ? [] : (manifest.plugins ?? []),
      clockOffsetMs,
    );
    // The local queue prunes with the same window the server prunes with, so a
    // player that has been offline for a fortnight does not arrive carrying
    // history the server would delete on receipt.
    for (const plugin of manifest.plugins ?? []) {
      if (plugin.type === "noise_meter") {
        this.noiseHistory.setRetentionDays(
          plugin.config.historyRetentionDays ?? 7,
        );
      }
    }
    const takeoverNow = takeoverActive(manifest, this.clock.now());
    const quickPresentNow = presentationOverrideActive(
      manifest,
      this.clock.now(),
    );
    if (
      this.activeManifest === null ||
      this.playbackState !== "playing" ||
      takeoverNow ||
      quickPresentNow
    ) {
      // Nothing on screen yet, or a takeover: activate immediately.
      if (this.pendingActivationTimer) {
        clearTimeout(this.pendingActivationTimer);
        this.pendingActivationTimer = null;
      }
      this.activeManifest = manifest;
      this.pendingManifest = null;
      this.evaluatePresentation(true);
      return;
    }
    // Seamless: hold until the next item boundary.
    this.pendingManifest = manifest;
    if (this.pendingActivationTimer) clearTimeout(this.pendingActivationTimer);
    const graceMilliseconds = manifestActivationGraceMilliseconds(manifest);
    this.pendingActivationTimer = setTimeout(() => {
      this.pendingActivationTimer = null;
      if (!this.pendingManifest) return;
      this.activeManifest = this.pendingManifest;
      this.pendingManifest = null;
      log.warn("activated pending manifest after boundary grace elapsed", {
        manifestVersion: this.activeManifest.manifestVersion,
        graceSeconds: graceMilliseconds / 1_000,
      });
      this.evaluatePresentation(true);
    }, graceMilliseconds);
    this.pendingActivationTimer.unref?.();
    log.info("manifest prepared; will activate at next item boundary", {
      manifestVersion: manifest.manifestVersion,
      graceSeconds: graceMilliseconds / 1_000,
    });
  }

  private externalPresentationView(): Presentation | null {
    const config = this.externalPresentation;
    const status = this.externalPresentationStatus;
    if (!config || !status) return null;
    return {
      state: "external-presentation",
      provider: "airplay",
      sessionId: config.sessionId,
      receiverName: config.receiverName,
      pin: config.pin,
      expiresAt: config.expiresAt,
      connected: status.connected,
      role: config.role,
      transport: config.transport,
      audioMode: config.audioMode,
      ...(status.presentationNetwork
        ? { presentationNetwork: status.presentationNetwork }
        : {}),
    };
  }

  private renderExternalPresentation(): void {
    const view = this.externalPresentationView();
    if (!view) return;
    this.playbackState = "external-presentation";
    this.presentedItems = [];
    // Manifest plugins are part of normal signage and must not remain over a
    // user's mirrored device. They are restored from the current manifest as
    // soon as the external session ends.
    this.host.presentPlugins?.([], this.clock.offsetMs);
    this.sessions?.stopPresentation("external_presentation", "partial");
    this.host.present(view);
  }

  private async recoverExternalPresentation(): Promise<void> {
    if (!this.host.recoverExternalPresentation) return;
    try {
      const recovered = await this.host.recoverExternalPresentation();
      if (!recovered) return;
      const takeoverNow =
        this.activeManifest !== null &&
        takeoverActive(this.activeManifest, this.clock.now());
      if (takeoverNow) {
        await this.host.stopExternalPresentation?.("emergency_takeover");
        return;
      }
      this.externalPresentation = recovered.config;
      this.externalPresentationStatus = recovered.status;
      this.lastExternalPresentationSessionId = recovered.config.sessionId;
      this.renderExternalPresentation();
      log.info("recovered unexpired AirPlay session", {
        sessionId: recovered.config.sessionId,
        role: recovered.config.role,
      });
    } catch (error) {
      log.warn("AirPlay session recovery failed; signage remains available", {
        error: String(error),
      });
    }
  }

  /** Called by the Linux host callback and also polled for crash recovery. */
  onExternalPresentationStatus(
    status: ExternalPresentationStatus | null,
  ): void {
    if (!this.externalPresentation) return;
    if (!status || status.sessionId !== this.externalPresentation.sessionId) {
      this.lastExternalPresentationSessionId =
        this.externalPresentation.sessionId;
      this.externalPresentation = null;
      this.externalPresentationStatus = null;
      this.lastPresentedKey = "";
      this.host.presentPlugins?.(
        this.activeManifest?.plugins ?? [],
        this.clock.offsetMs,
      );
      this.evaluatePresentation(true);
      void this.reportStatus();
      return;
    }
    const previous = this.externalPresentationStatus;
    const changed = JSON.stringify(status) !== JSON.stringify(previous);
    // lastRtpAt is intentionally high-frequency process health data. Keep it
    // locally so the manager can detect a stalled stream, but do not turn every
    // fpsdisplaysink line into an Electron repaint and immediate heartbeat.
    const presentationChanged =
      !previous ||
      previous.state !== status.state ||
      previous.connected !== status.connected ||
      previous.receiverAlive !== status.receiverAlive ||
      previous.gatewayAlive !== status.gatewayAlive ||
      previous.failureCode !== status.failureCode ||
      previous.failureMessage !== status.failureMessage ||
      previous.presentationNetwork !== status.presentationNetwork;
    this.externalPresentationStatus = status;
    if (changed && presentationChanged) {
      this.renderExternalPresentation();
      void this.reportStatus();
    }
  }

  private async externalPresentationTick(): Promise<void> {
    const config = this.externalPresentation;
    if (!config) return;
    if (Date.parse(config.expiresAt) <= this.clock.nowMs()) {
      await this.stopExternalPresentation("expired");
      return;
    }
    const status = this.host.getExternalPresentationStatus?.() ?? null;
    this.onExternalPresentationStatus(status);
  }

  /**
   * Apply the Presentation Network section of a configuration document.
   *
   * A malformed section is logged and ignored rather than being coerced: acting
   * on a half-understood assignment would provision a profile that does not match
   * what Studio displays. Ignoring it leaves the previous state in place and the
   * next sync corrects it.
   */
  private async applyPresentationNetworkConfiguration(
    config: PlayerConfig,
  ): Promise<void> {
    if (!this.host.applyPresentationNetworkAssignment) return;
    let assignment: PresentationNetworkAssignment | null = null;
    const section = (config as unknown as Record<string, unknown>)[
      "presentationNetwork"
    ];
    // An absent section means a server that predates the feature. Leave whatever
    // the player has alone rather than deleting a profile a newer server assigned.
    if (section === undefined) return;
    try {
      assignment = parsePresentationNetworkAssignment(section);
    } catch (error) {
      log.warn("presentation network configuration was rejected", {
        error: String(error),
      });
      return;
    }
    this.presentationNetworkAssignment = assignment;
    try {
      await this.host.applyPresentationNetworkAssignment(assignment);
    } catch (error) {
      log.warn("failed to apply the presentation network assignment", {
        error: String(error),
      });
    }
    await this.refreshPresentationNetwork();
  }

  private async refreshPresentationNetwork(): Promise<PresentationNetworkCapability | null> {
    if (!this.host.probePresentationNetwork) return null;
    try {
      this.presentationNetworkCapability =
        await this.host.probePresentationNetwork();
      return this.presentationNetworkCapability;
    } catch (error) {
      log.warn("presentation network probe failed", { error: String(error) });
      return null;
    }
  }

  private async refreshAirplayCapabilities(): Promise<AirplayCapabilities | null> {
    if (!this.host.probeAirplayCapabilities) return null;
    try {
      this.airplayCapabilities = await this.host.probeAirplayCapabilities();
      return this.airplayCapabilities;
    } catch (error) {
      log.warn("AirPlay capability probe failed", { error: String(error) });
      return null;
    }
  }

  private async refreshDisplayControl(): Promise<DisplayControlStatus> {
    if (!this.host.probeDisplayControl) {
      this.displayControlStatus = unsupportedDisplayControlStatus();
      return this.displayControlStatus;
    }
    try {
      this.displayControlStatus = await this.host.probeDisplayControl();
    } catch (error) {
      this.displayControlStatus = unsupportedDisplayControlStatus(
        `Display Control probe failed: ${String(error).slice(0, 180)}`,
      );
    }
    return this.displayControlStatus;
  }

  private async prepareExternalPresentation(
    command: PlayerCommand,
    startGateway: boolean,
  ): Promise<CommandResultReport> {
    if (!this.host.prepareExternalPresentation) {
      return {
        success: false,
        code: "airplay_unsupported",
        message: "AirPlay is not available on this player.",
      };
    }
    const config = parseExternalPresentationConfig(command.payload);
    const takeoverNow =
      this.activeManifest !== null &&
      takeoverActive(this.activeManifest, this.clock.now());
    if (takeoverNow) {
      return {
        success: false,
        code: "emergency_takeover_active",
        message: "AirPlay cannot start while an emergency takeover is active.",
      };
    }
    if (this.externalPresentation?.sessionId !== config.sessionId) {
      await this.stopExternalPresentation("replaced");
      const capabilities = await this.refreshAirplayCapabilities();
      const roleReady =
        config.role === "receiver"
          ? capabilities?.groupAirplaySupported
          : capabilities?.airplaySupported;
      if (!roleReady) {
        return {
          success: false,
          code: "airplay_not_ready",
          message:
            capabilities?.limitation ??
            "This Linux player is not ready for AirPlay Present.",
        };
      }
    }
    const status = await this.host.prepareExternalPresentation(config);
    this.externalPresentation = config;
    this.externalPresentationStatus = status;
    this.lastExternalPresentationSessionId = config.sessionId;
    this.lastPresentedKey = "";
    this.renderExternalPresentation();
    if (startGateway) {
      if (!this.host.startExternalPresentation) {
        await this.stopExternalPresentation("gateway_start_unsupported");
        return {
          success: false,
          code: "airplay_gateway_unsupported",
          message: "This player cannot start the AirPlay gateway.",
        };
      }
      this.externalPresentationStatus =
        await this.host.startExternalPresentation();
      this.renderExternalPresentation();
    }
    void this.reportStatus();
    return {
      success: true,
      code: startGateway ? "airplay_started" : "airplay_prepared",
      message: startGateway
        ? "AirPlay receiver is advertised."
        : "AirPlay display receiver is prepared.",
    };
  }

  private async stopExternalPresentation(
    reason: string,
    reportCleared = true,
  ): Promise<void> {
    if (this.externalPresentation) {
      this.lastExternalPresentationSessionId = reportCleared
        ? this.externalPresentation.sessionId
        : null;
    } else if (!reportCleared) {
      this.lastExternalPresentationSessionId = null;
    }
    if (this.host.stopExternalPresentation) {
      await this.host.stopExternalPresentation(reason).catch((error) => {
        log.warn("failed to stop AirPlay processes", { error: String(error) });
      });
    }
    this.externalPresentation = null;
    this.externalPresentationStatus = null;
    this.lastPresentedKey = "";
    this.host.presentPlugins?.(
      this.activeManifest?.plugins ?? [],
      this.clock.offsetMs,
    );
    this.evaluatePresentation(true);
    if (reportCleared) void this.reportStatus();
  }

  /**
   * Fetch Presentation Network provisioning material over the authenticated
   * player channel.
   *
   * Exposed on the runtime rather than given to the host directly so the request
   * uses the same credential, timeout, and telemetry path as every other player
   * call. The response is not stored, not cached, and not logged; the caller hands
   * it straight to the root helper and drops it.
   */
  fetchPresentationNetworkProvisioning(): Promise<Record<string, unknown>> {
    return this.client.presentationNetworkProvisioning();
  }

  /** Renderer reported an item boundary. */
  onItemBoundary(): void {
    if (this.pendingManifest) {
      if (this.pendingActivationTimer) {
        clearTimeout(this.pendingActivationTimer);
        this.pendingActivationTimer = null;
      }
      this.activeManifest = this.pendingManifest;
      this.pendingManifest = null;
      log.info("activated pending manifest at item boundary", {
        manifestVersion: this.activeManifest.manifestVersion,
      });
      this.evaluatePresentation(true);
    }
  }

  /** Renderer progress: item transitions, video advancement, image shown. */
  onPlaybackProgress(
    itemId: string | null,
    kind: string,
    zoneId?: string,
  ): void {
    const now = Date.now();
    const signal = progressSignalFor(kind);
    if (kind === "item-started" && itemId) {
      const item = this.presentedItems.find(
        (candidate) => candidate.id === itemId,
      );
      const zones = layoutZoneExpectations(item);
      this.renderProgress = onItemPresented(this.renderProgress, now, {
        itemId,
        expectation: contentExpectationFor(item?.kind),
        expectedDurationMs: item?.durationMs ?? null,
        zoneIds: zones.zoneIds,
        recurringZoneIds: zones.recurringZoneIds,
      });
    } else if (signal) {
      this.renderProgress = onRenderProgress(this.renderProgress, now, {
        signal,
        itemId,
        zoneId,
      });
    }
    // The supervisor only sees progress the content was actually expected to
    // produce; feeding it every raw signal is how a frozen screen keeps a
    // player looking healthy.
    if (
      assessRenderProgress(
        this.renderProgress,
        now,
        renderProgressConfigFor(this.config?.reliability),
      ).progressing
    ) {
      this.supervisorState = onProgress(
        this.supervisorState,
        now,
        this.supervisorConfig(),
      );
    }
    if (kind === "item-started") {
      // The first item on screen is the milestone an operator watching a screen
      // power on actually sees, so it is recorded once and never overwritten.
      this.startupTimings.firstFrameMs ??= Date.now() - this.startedAt;
      // The renderer reports the item it is about to show, which is what opens
      // the child session. Without this the server would only ever see a
      // terminal event and could not derive a real playback interval.
      this.currentItemId = itemId;
      if (itemId && this.selection?.playlistId && this.activeManifest) {
        const identity = makeCacheIdentity(
          this.options.serverUrl,
          this.credential?.installationId,
          this.credential?.screenId,
        );
        if (identity) {
          const checkpoint: PlaybackCheckpoint = {
            ...identity,
            manifestVersion: this.activeManifest.manifestVersion,
            playlistId: this.selection.playlistId,
            itemId,
            savedAt: this.clock.now().toISOString(),
          };
          this.playbackCheckpoint = checkpoint;
          this.checkpointWrite = this.checkpointWrite
            .then(() =>
              this.store.writeJson(PLAYBACK_CHECKPOINT_FILE, checkpoint),
            )
            .catch((error) => {
              log.warn("playback checkpoint persistence failed", {
                error: String(error),
              });
            });
        }
      }
      if (itemId) this.sessions?.startContent(this.contentContextFor(itemId));
      return;
    }
    this.currentItemId = itemId;
    if (kind === "widget-empty") {
      this.sessions?.finishContent("skipped", "empty_content");
      return;
    }
    if (kind === "item-transition") {
      this.sessions?.finishContent("completed", "expected_item_boundary");
      this.onItemBoundary();
    }
  }

  /**
   * The latest value of each telemetry gauge. Read at flush time so the
   * snapshot is genuinely current rather than whatever was last pushed.
   */
  private telemetryGauges(): TelemetryGauges {
    const assessment = this.renderProgressStatus();
    const progress = this.renderProgress;
    return {
      currentItemId: this.currentItemId ?? undefined,
      itemStartedAt:
        progress.itemStartedAtMs == null
          ? undefined
          : new Date(progress.itemStartedAtMs).toISOString(),
      lastMeaningfulProgressAt:
        assessment.lastMeaningfulProgressAt == null
          ? undefined
          : new Date(assessment.lastMeaningfulProgressAt).toISOString(),
      playbackStallDurationMs: assessment.stallDurationMs,
      stallReason: assessment.stallReason ?? undefined,
      rendererState: this.playbackState,
      rendererResponding: assessment.rendererResponding,
      expectedMotion: assessment.expectedMotion,
      // Download and cache gauges are omitted rather than guessed: this
      // player does not yet expose them, and a fabricated zero would read as
      // an empty cache.
      processUptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      deviceUptimeSeconds: this.deviceUptimeSeconds() ?? undefined,
      // Link type, signal, clock, and power, refreshed on the reporting
      // cadence rather than read here: these are sysfs files, not variables.
      ...this.systemDiagnostics,
      lastDisconnectReason: this.lastDisconnectReason,
      clockOffsetSeconds: Math.round(this.clock.offsetMs / 1_000),
      ...this.displayGauges(),
      startupTotalMs: this.startupTimings.totalMs,
      startupConfigMs: this.startupTimings.configMs,
      startupManifestMs: this.startupTimings.manifestMs,
      startupFirstFrameMs: this.startupTimings.firstFrameMs,
      // startupAssetVerifyMs is omitted: manifest verification is not timed
      // separately from the download it follows, and a figure that actually
      // measured both phases would be read as the verify cost alone.
    };
  }

  /**
   * What the panel reports, when the host can see it. A window size is not a
   * substitute: the two differ exactly when the display is the problem.
   */
  private displayGauges(): TelemetryGauges {
    const info = this.host.displayInfo?.();
    if (!info) return {};
    const gauges: TelemetryGauges = {
      displayConnected: info.connected,
      displayPowerState: info.connected ? "on" : "unknown",
    };
    if (info.width > 0 && info.height > 0) {
      gauges.displayResolution = `${Math.round(info.width)}x${Math.round(info.height)}`;
    }
    if (info.refreshHz !== undefined && info.refreshHz > 0) {
      gauges.displayRefreshHz = info.refreshHz;
    }
    return gauges;
  }

  /**
   * Accumulates the counters the server rolls up. Runs on a short tick and
   * adds elapsed seconds, so a sample is always a delta over a known span
   * rather than an instantaneous reading.
   */
  private accumulateTelemetry(): void {
    if (!this.telemetry) return;
    const now = Date.now();
    const seconds = Math.max(
      0,
      Math.round((now - this.lastTelemetryTickMs) / 1_000),
    );
    this.lastTelemetryTickMs = now;
    if (seconds === 0) return;

    this.telemetry.addSeconds(
      this.socketOpen ? "connectedSeconds" : "disconnectedSeconds",
      seconds,
    );
    const assessment = assessRenderProgress(
      this.renderProgress,
      now,
      renderProgressConfigFor(this.config?.reliability),
    );
    // Healthy and stalled seconds come from meaningful progress, not from
    // whether a renderer object exists.
    this.telemetry.addSeconds(
      assessment.progressing
        ? "healthyPlaybackSeconds"
        : "stalledPlaybackSeconds",
      seconds,
    );
  }

  /** The current render-progress assessment, for the heartbeat and telemetry. */
  renderProgressStatus() {
    const assessment = assessRenderProgress(
      this.renderProgress,
      Date.now(),
      renderProgressConfigFor(this.config?.reliability),
    );
    this.renderProgress = recordAssessment(this.renderProgress, assessment);
    return assessment;
  }

  /**
   * The render-progress fields the server records. Reported every heartbeat so
   * "the process is answering" and "the screen is actually working" stay
   * visibly different facts.
   */
  private renderProgressHeartbeatFields() {
    const assessment = this.renderProgressStatus();
    return {
      lastMeaningfulProgressAt:
        assessment.lastMeaningfulProgressAt == null
          ? undefined
          : new Date(assessment.lastMeaningfulProgressAt).toISOString(),
      stallStartedAt:
        assessment.stallStartedAt == null
          ? undefined
          : new Date(assessment.stallStartedAt).toISOString(),
      stallDurationMs: assessment.stallDurationMs,
      stallReason: assessment.stallReason ?? undefined,
      expectedMotion: assessment.expectedMotion,
      rendererResponding: assessment.rendererResponding,
      currentItemStartedAt:
        this.renderProgress.itemStartedAtMs == null
          ? undefined
          : new Date(this.renderProgress.itemStartedAtMs).toISOString(),
    };
  }

  /** Describes the item now rendering, so its session carries its identity. */
  private contentContextFor(itemId: string) {
    const item = this.presentedItems.find(
      (candidate) => candidate.id === itemId,
    );
    return {
      contentId: itemId,
      contentType: item?.kind ?? "media",
      playlistItemId: itemId,
      expectedDurationMs: item?.durationMs ?? undefined,
    };
  }

  onPlaybackError(itemId: string | null, message: string): void {
    this.lastPlaybackError = message.slice(0, 240);
    log.warn("playback error reported", { itemId, message });
    // A failure must be visible even when no child session is open, so the
    // tracker's close is followed by an unconditional renderer failure event.
    this.sessions?.finishContent("failed", "renderer_failure", {
      code: "renderer_failure",
      message,
    });
    void this.activity?.record({
      eventType: "renderer.failure",
      category: "playback",
      severity: "error",
      result: "failed",
      contentId: itemId ?? undefined,
      failureCode: "renderer_failure",
      failureMessage: message,
      manifestVersion: this.activeManifest?.manifestVersion,
    });
  }

  onWebsiteRecovered(): void {
    this.websiteRecoveryCount += 1;
  }

  /** Recompute what should be on screen; presents only when it changed. */
  evaluatePresentation(force = false): void {
    void this.applyDisplayPolicy();
    const next = this.buildPresentation();
    // generation is a renderer transport counter, not presentation content.
    // Including it here restarted otherwise-unchanged playback every 30s.
    const key = presentationIdentity(next);
    this.scheduleSelectionTransition();
    if (!force && key === this.lastPresentedKey) {
      return;
    }
    this.lastPresentedKey = key;
    if (next.state === "external-presentation") {
      this.generation += 1;
      this.playbackState = "external-presentation";
      this.presentedItems = [];
      this.renderProgress = onPlaybackIdle(this.renderProgress, Date.now());
      this.sessions?.stopPresentation("external_presentation", "partial");
      this.host.present(next);
    } else if (next.state === "playing") {
      this.generation += 1;
      this.playbackState = "playing";
      this.presentedItems = next.items;
      this.openPresentationSession(next);
      this.host.present({ ...next, generation: this.generation });
    } else {
      this.playbackState = next.state;
      this.presentedItems = [];
      this.renderProgress = onPlaybackIdle(this.renderProgress, Date.now());
      // Nothing is playing any more, so the root session ends here rather than
      // being left open for the server's bounded timeout to guess at.
      this.sessions?.stopPresentation(
        next.state === "safe-mode" ? "recovery_action" : "schedule_transition",
        next.state === "safe-mode" ? "failed" : "partial",
      );
      this.host.present(next);
    }
  }

  /**
   * Opens the root session for what is now on screen. The presentation
   * identity, not the generation counter, decides whether this is new content:
   * a re-evaluation resolving to the same playlist must not restart the session
   * and truncate its measured duration.
   */
  private openPresentationSession(next: Presentation & { state: "playing" }) {
    const selection = this.selection;
    const presentationId =
      selection?.layoutId ?? selection?.playlistId ?? next.items[0]?.id ?? "";
    this.sessions?.startPresentation(
      {
        key: `${selection?.source ?? ""}:${presentationId}:${this.activeManifest?.manifestVersion ?? ""}`,
        presentationType: selection?.layoutId ? "layout" : "playlist",
        presentationId,
        trigger: selection?.source,
        scheduleId: selection?.scheduleId ?? undefined,
        takeoverId: selection?.takeoverId ?? undefined,
        manifestVersion: this.activeManifest?.manifestVersion,
      },
      this.replacementReason(),
    );
  }

  /** Why the outgoing presentation is being replaced, from what selected it. */
  private replacementReason(): TerminalReason {
    if (this.selection?.takeoverId) return "takeover";
    if (this.selection?.scheduleId) return "schedule_transition";
    if (this.selection?.source === "direct") return "direct_assignment_change";
    return "manifest_replacement";
  }
  private lastPresentedKey = "";

  private async applyDisplayPolicy(): Promise<void> {
    const manifest = this.activeManifest;
    if (!manifest) return;
    const resolved = resolveDisplayPolicy(manifest, this.clock.now());
    this.scheduleDisplayPolicyTransition(resolved.nextTransitionAt);
    const key = resolved.action
      ? `${resolved.scheduleId}:${JSON.stringify(resolved.action)}`
      : "none";
    if (key === this.displayPolicyKey) return;
    this.displayPolicyKey = key;
    if (!resolved.action) {
      if (this.displayControlStatus) {
        this.displayControlStatus = {
          ...this.displayControlStatus,
          policyState: "normal",
        };
        void this.reportStatus();
      }
      return;
    }
    if (!this.host.executeDisplayControl) {
      this.displayControlStatus = {
        ...(this.displayControlStatus ?? unsupportedDisplayControlStatus()),
        policyState: resolved.policyState,
        error: "This player does not provide Display Control.",
      };
      void this.reportStatus();
      return;
    }
    try {
      const result = await this.host.executeDisplayControl(resolved.action);
      this.displayControlStatus = {
        ...(result.status ??
          this.displayControlStatus ??
          unsupportedDisplayControlStatus()),
        policyState: resolved.policyState,
        error: result.success ? result.status?.error : result.message,
      };
    } catch (error) {
      this.displayControlStatus = {
        ...(this.displayControlStatus ?? unsupportedDisplayControlStatus()),
        policyState: resolved.policyState,
        error: String(error).slice(0, 240),
      };
    }
    void this.reportStatus();
  }

  private scheduleDisplayPolicyTransition(at: string | null): void {
    if (at === this.displayPolicyTransitionAt) return;
    if (this.displayPolicyTransitionTimer) {
      clearTimeout(this.displayPolicyTransitionTimer);
      this.displayPolicyTransitionTimer = null;
    }
    this.displayPolicyTransitionAt = at;
    if (!at) return;
    const delay = Date.parse(at) - this.clock.nowMs();
    if (!Number.isFinite(delay)) return;
    this.displayPolicyTransitionTimer = setTimeout(
      () => {
        this.displayPolicyTransitionTimer = null;
        this.displayPolicyTransitionAt = null;
        this.evaluatePresentation();
      },
      Math.min(Math.max(delay + 100, 0), 2_147_000_000),
    );
    this.displayPolicyTransitionTimer.unref?.();
  }

  private scheduleSelectionTransition(): void {
    const at = this.selection?.nextTransitionAt ?? null;
    if (at === this.selectionTransitionAt) return;
    if (this.selectionTransitionTimer) {
      clearTimeout(this.selectionTransitionTimer);
      this.selectionTransitionTimer = null;
    }
    this.selectionTransitionAt = at;
    if (!at) return;
    const delay = Date.parse(at) - this.clock.nowMs();
    if (!Number.isFinite(delay)) return;
    this.selectionTransitionTimer = setTimeout(
      () => {
        this.selectionTransitionTimer = null;
        this.selectionTransitionAt = null;
        this.evaluatePresentation();
      },
      Math.min(Math.max(delay + 100, 0), 2_147_000_000),
    );
    this.selectionTransitionTimer.unref?.();
  }

  private scheduleAvailabilityTransition(
    manifest: Manifest,
    at: Date,
    values: readonly AvailabilityWindow[] = this.availabilityWindows(manifest),
  ): void {
    const next = nextAvailabilityTransition(values, at)?.toISOString() ?? null;
    if (next === this.availabilityTransitionAt) return;
    if (this.availabilityTransitionTimer) {
      clearTimeout(this.availabilityTransitionTimer);
      this.availabilityTransitionTimer = null;
    }
    this.availabilityTransitionAt = next;
    if (!next) return;
    const delay = Date.parse(next) - this.clock.nowMs();
    if (!Number.isFinite(delay)) return;
    this.availabilityTransitionTimer = setTimeout(
      () => {
        this.availabilityTransitionTimer = null;
        this.availabilityTransitionAt = null;
        this.evaluatePresentation();
      },
      Math.min(Math.max(delay + 100, 0), 2_147_000_000),
    );
    this.availabilityTransitionTimer.unref?.();
  }

  /**
   * Availability is a property of every manifest item, not just top-level
   * assets. Include nested playlist items here so an item that enters or
   * leaves its window while a Layout or takeover is already on screen causes
   * the same boundary re-evaluation as Android.
   */
  private availabilityWindows(manifest: Manifest): AvailabilityWindow[] {
    return [
      ...manifest.assets,
      ...(manifest.playlist?.items ?? []),
      ...(manifest.directFallbackPlaylist?.items ?? []),
      ...(manifest.playlists ?? []).flatMap((playlist) => playlist.items),
    ];
  }

  private buildPresentation(): Presentation {
    const manifest = this.activeManifest;
    const branding = this.config?.branding ?? {};
    const now = this.clock.now();
    const takeoverNow = manifest !== null && takeoverActive(manifest, now);
    const quickPresentNow =
      manifest !== null && presentationOverrideActive(manifest, now);

    // Emergency takeover outranks AirPlay. The server normally sends an
    // explicit stop command as well; this local check closes the race when a
    // manifest arrives first or the server connection is briefly delayed.
    if (this.externalPresentation && takeoverNow) {
      void this.stopExternalPresentation("emergency_takeover");
    } else if (this.externalPresentation) {
      const view = this.externalPresentationView();
      if (view) return view;
    }

    // AirPlay is an explicit external presentation and therefore outranks the
    // normal playback recovery surface as well as scheduling. Once the session
    // is active, a prior signage safe-mode state must not cover the sender's
    // presentation; the session's own process health monitor remains in charge
    // of recovering or ending it.
    if (this.supervisorState.safeMode) {
      return {
        state: "safe-mode",
        reason: this.supervisorState.safeModeReason ?? "repeated failures",
      };
    }

    // Outside active hours the screen rests (true black), unless a takeover
    // is active — takeover always overrides off-hours sleep.
    if (!takeoverNow && !quickPresentNow) {
      const activeHours = activeHoursFromConfig(this.config?.power);
      if (!evaluateActiveHours(activeHours, now).active) {
        return { state: "sleep" };
      }
    }

    if (this.flags.playbackDisabled && !takeoverNow && !quickPresentNow) {
      return this.brandingFallback({
        state: "disabled",
        title: String(branding["disabledTitle"] ?? "Screen disabled"),
        message: String(branding["disabledMessage"] ?? ""),
        manifest,
      });
    }

    if (!manifest) {
      return {
        state: "idle",
        title: "Connecting to Tilecast",
        message: "Content status will appear when the server is available.",
        backgroundColor: this.brandingColor(
          branding["backgroundColor"],
          "#0E141B",
        ),
        textColor: this.brandingColor(branding["textColor"], "#F5F7FA"),
        footerText: String(branding["footerText"] ?? ""),
        status: "connecting",
      };
    }

    this.selection = resolveSelection(manifest, now);

    // A directly-assigned or scheduled Layout: render it as a single
    // fullscreen presentation item.
    if (this.selection.layoutId && !this.selection.playlistId) {
      this.scheduleAvailabilityTransition(manifest, now);
      const layoutItem = this.buildItem(
        manifest,
        {
          id: layoutItemKey(this.selection.layoutId),
          assetId: "",
          layoutId: this.selection.layoutId,
          assetType: "layout",
          fitMode: "contain",
          transition: "none",
          audioEnabled: false,
          volume: 0,
          deliveryPolicy: "download",
        } as ManifestItem,
        now,
      );
      if (layoutItem) {
        return {
          state: "playing",
          items: [layoutItem],
          takeover: false,
          generation: this.generation,
        };
      }
      return this.brandingFallback({
        state: "unavailable",
        title: "Content unavailable",
        message: "The assigned Layout is not currently renderable.",
        manifest,
      });
    }

    const playlist = findPlaylist(manifest, this.selection.playlistId);
    if (!playlist) {
      return this.brandingFallback({
        state: "idle",
        title: String(branding["noContentTitle"] ?? "No content assigned"),
        message: String(branding["noContentMessage"] ?? ""),
        manifest,
      });
    }
    if (playlist.items.length === 0) {
      return this.brandingFallback({
        state: "unavailable",
        title: "Content unavailable",
        message: "Assigned content is not currently available.",
        manifest,
      });
    }

    this.scheduleAvailabilityTransition(manifest, now);
    const items = this.buildItems(manifest, playlist, now);
    if (items.length === 0) {
      return this.brandingFallback({
        state: "unavailable",
        title: "Content unavailable",
        message: "Assigned content is not currently available.",
        manifest,
      });
    }
    const resumedItems = this.applyResumeCheckpoint(items);
    return {
      state: "playing",
      items: resumedItems,
      takeover: this.selection.source === "takeover",
      generation: this.generation,
    };
  }

  private brandingColor(value: unknown, fallback: string): string {
    return typeof value === "string" && /^#[0-9a-fA-F]{6}$/.test(value)
      ? value
      : fallback;
  }

  private brandingFallback(input: {
    state: "idle" | "disabled" | "unavailable";
    title: string;
    message: string;
    manifest: Manifest | null;
  }): Presentation {
    const branding = this.config?.branding ?? {};
    const logoAssetId = input.manifest?.branding?.logoAssetId;
    const logoVariantId = input.manifest?.branding?.logoVariantId;
    const logo =
      logoAssetId &&
      logoVariantId &&
      input.manifest?.assets.some(
        (asset) =>
          asset.assetId === logoAssetId &&
          asset.variantId === logoVariantId &&
          isAvailableAt(asset, this.clock.now()),
      )
        ? `tcmedia://variant/${logoAssetId}/${logoVariantId}`
        : null;
    return {
      state: input.state,
      title: input.title,
      message: input.message,
      backgroundColor: this.brandingColor(
        branding["backgroundColor"],
        "#0E141B",
      ),
      textColor: this.brandingColor(branding["textColor"], "#F5F7FA"),
      logoSrc: logo,
      footerText: String(branding["footerText"] ?? ""),
      status:
        input.state === "disabled"
          ? "disabled"
          : input.state === "unavailable"
            ? "unavailable"
            : "no_content",
    };
  }

  private buildItems(
    manifest: Manifest,
    playlist: ManifestPlaylist,
    at: Date,
  ): PresentationItem[] {
    const items: PresentationItem[] = [];
    for (const item of playlist.items) {
      if (!isAvailableAt(item, at)) continue;
      const built = this.buildItem(manifest, item, at);
      if (built) {
        items.push(built);
      }
    }
    return items;
  }

  private applyResumeCheckpoint(items: PresentationItem[]): PresentationItem[] {
    if (!this.config || !this.resumeCheckpointPending) return items;
    this.resumeCheckpointPending = false;
    if (this.config.playback["resumeAfterRestart"] === false) return items;
    const checkpoint = this.playbackCheckpoint;
    if (
      !checkpoint ||
      checkpoint.manifestVersion !== this.activeManifest?.manifestVersion ||
      checkpoint.playlistId !== this.selection?.playlistId
    ) {
      return items;
    }
    const index = items.findIndex((item) => item.id === checkpoint.itemId);
    if (index <= 0) return items;
    return [...items.slice(index), ...items.slice(0, index)];
  }

  /** Widget/data-source/layout lookup maps, rebuilt when the manifest swaps. */
  private lookup: {
    manifestVersion: number;
    widgets: Map<string, ManifestWidget>;
    dataSources: Map<string, ManifestDataSource>;
    layouts: Map<string, ManifestLayout>;
  } | null = null;

  private lookups(manifest: Manifest): NonNullable<PlayerRuntime["lookup"]> {
    if (
      this.lookup &&
      this.lookup.manifestVersion === manifest.manifestVersion
    ) {
      return this.lookup;
    }
    const widgets = new Map<string, ManifestWidget>();
    for (const w of (manifest.widgets ?? []) as ManifestWidget[]) {
      widgets.set(w.assetId, w);
    }
    const dataSources = new Map<string, ManifestDataSource>();
    for (const s of (manifest.dataSources ?? []) as ManifestDataSource[]) {
      dataSources.set(s.id, s);
    }
    const layouts = new Map<string, ManifestLayout>();
    for (const l of (manifest.layouts ?? []) as ManifestLayout[]) {
      layouts.set(l.id, l);
    }
    if (manifest.layout) {
      const rootLayout = manifest.layout as unknown as ManifestLayout;
      layouts.set(rootLayout.id, rootLayout);
    }
    this.lookup = {
      manifestVersion: manifest.manifestVersion,
      widgets,
      dataSources,
      layouts,
    };
    return this.lookup;
  }

  private buildItem(
    manifest: Manifest,
    item: ManifestItem,
    at: Date = this.clock.now(),
  ): PresentationItem | null {
    const maps = this.lookups(manifest);
    const settings = this.itemSettings(
      item,
      fallbackDurationMsFor(
        item.assetType,
        this.numberConfig(
          this.config?.playback,
          "defaultImageDurationSeconds",
          10,
        ) * 1_000,
      ),
    );

    if (item.layoutId) {
      const layout = maps.layouts.get(item.layoutId);
      if (!layout) {
        return null;
      }
      const viewport = spanViewport(manifest);
      const payload = renderLayout(
        layout.document,
        {
          manifest,
          widgets: maps.widgets,
          dataSources: maps.dataSources,
          at,
          playback: this.config?.playback,
          regionalFormat: resolveRegionalFormatting(
            this.config?.playback?.["regionalFormat"],
          ),
        },
        viewport,
      );
      if (!payload) {
        return null; // invalid layout: skip this item, keep the rest
      }
      return {
        id: item.id,
        kind: "layout",
        src: "",
        durationMs: settings.durationMs,
        fitMode: settings.fitMode,
        transition: settings.transition,
        audioEnabled: settings.audioEnabled,
        volume: settings.volume,
        videoStartOffsetMs: null,
        videoEndOffsetMs: null,
        layout: payload,
        viewport,
      };
    }

    // Widget item: the item's assetId references a manifest widget.
    const widget = maps.widgets.get(item.assetId);
    if (widget) {
      if (widget.provider === "youtube") {
        return this.buildYouTubeItem(item, widget);
      }
      if (widget.presentation?.kind === "web") {
        const web = widget.presentation.web;
        if (!web || web.mode !== "remote" || !web.url) {
          return null;
        }
        const interval =
          web.reload?.mode === "periodic" &&
          Number.isInteger(web.reload.intervalSeconds) &&
          web.reload.intervalSeconds >= 30 &&
          web.reload.intervalSeconds <= 86_400
            ? web.reload.intervalSeconds
            : null;
        return {
          id: item.id,
          kind: "website",
          src: web.url,
          durationMs: settings.durationMs,
          fitMode: settings.fitMode,
          transition: settings.transition,
          audioEnabled: settings.audioEnabled,
          volume: settings.volume,
          videoStartOffsetMs: null,
          videoEndOffsetMs: null,
          website: {
            loadTimeoutSeconds: web.loadTimeoutSeconds ?? 20,
            refreshIntervalSeconds: interval,
            zoomPercent: 100,
            javascriptEnabled: true,
            domStorageEnabled: true,
            cookiePolicy: "first_party",
            reloadPolicy: interval === null ? "on_each_activation" : "interval",
            customUserAgent: "",
            scrollX: 0,
            scrollY: 0,
            backgroundColor: "#0E141B",
            failureBehavior: web.fallbackBehavior ?? "placeholder",
            fallbackSrc: null,
            allowedHosts: web.allowedHosts ?? [],
          },
        };
      }
      const payload = renderWidget(widget, {
        dataSources: maps.dataSources,
        at,
        assets: manifest.assets,
        regionalFormat: resolveRegionalFormatting(
          this.config?.playback?.["regionalFormat"],
        ),
      });
      if (!payload) {
        return null;
      }
      return {
        id: item.id,
        kind: "widget",
        src: "",
        durationMs: settings.durationMs,
        fitMode: settings.fitMode,
        transition: settings.transition,
        audioEnabled: settings.audioEnabled,
        volume: settings.volume,
        videoStartOffsetMs: null,
        videoEndOffsetMs: null,
        widget: payload,
      };
    }

    if (item.assetType === "website") {
      const website = (manifest.websites ?? []).find(
        (w) => w.assetId === item.assetId,
      );
      if (!website) {
        return null;
      }
      let fallbackSrc: string | null = null;
      if (website.fallbackImageAssetId) {
        const fallbackAsset = manifest.assets.find(
          (a) =>
            a.assetId === website.fallbackImageAssetId &&
            (!website.fallbackVariantId ||
              a.variantId === website.fallbackVariantId) &&
            isAvailableAt(a, at),
        );
        if (fallbackAsset) {
          fallbackSrc = `tcmedia://variant/${fallbackAsset.assetId}/${fallbackAsset.variantId}`;
        }
      }
      return {
        id: item.id,
        kind: "website",
        src: website.url,
        durationMs: settings.durationMs,
        fitMode: settings.fitMode,
        transition: settings.transition,
        audioEnabled: settings.audioEnabled,
        volume: settings.volume,
        videoStartOffsetMs: null,
        videoEndOffsetMs: null,
        website: {
          loadTimeoutSeconds: this.numberConfig(
            this.config?.website,
            "timeoutSeconds",
            website.loadTimeoutSeconds > 0 ? website.loadTimeoutSeconds : 20,
          ),
          refreshIntervalSeconds: website.refreshIntervalSeconds ?? null,
          zoomPercent:
            website.zoomPercent > 0
              ? website.zoomPercent
              : this.numberConfig(
                  this.config?.website,
                  "defaultZoomPercent",
                  100,
                ),
          javascriptEnabled: website.javascriptEnabled,
          domStorageEnabled: website.domStorageEnabled,
          cookiePolicy: this.stringConfig(
            this.config?.website,
            "cookiePolicy",
            website.cookiePolicy,
          ),
          reloadPolicy: website.reloadPolicy || "on_each_activation",
          customUserAgent: website.customUserAgent ?? "",
          scrollX: website.scrollX ?? 0,
          scrollY: website.scrollY ?? 0,
          backgroundColor: website.backgroundColor,
          failureBehavior:
            website.failureBehavior ||
            String(
              this.config?.website?.["defaultFailureBehavior"] ?? "placeholder",
            ),
          fallbackSrc,
          allowedHosts: website.allowedHosts,
        },
      };
    }

    const asset = manifest.assets.find(
      (a) =>
        a.assetId === item.assetId &&
        a.variantId === item.variantId &&
        isAvailableAt(a, at),
    );
    if (!asset) {
      return null;
    }
    const kind = asset.mimeType.startsWith("video/")
      ? "video"
      : asset.mimeType.startsWith("image/")
        ? "image"
        : null;
    if (!kind) {
      return null;
    }
    return {
      id: item.id,
      kind,
      src: `tcmedia://variant/${asset.assetId}/${asset.variantId}`,
      durationMs: settings.durationMs,
      fitMode: settings.fitMode,
      transition: settings.transition,
      audioEnabled: settings.audioEnabled,
      volume: settings.volume,
      videoStartOffsetMs: item.videoStartOffsetMs ?? null,
      videoEndOffsetMs: item.videoEndOffsetMs ?? null,
      viewport: kind === "image" ? spanViewport(manifest) : undefined,
    };
  }

  private itemSettings(
    item: ManifestItem,
    fallbackDurationMs: number | null,
  ): {
    durationMs: number | null;
    fitMode: string;
    transition: string;
    audioEnabled: boolean;
    volume: number;
  } {
    return resolvePlaybackItemSettings(
      item,
      this.config?.playback,
      fallbackDurationMs,
    );
  }

  /**
   * YouTube widget → a website item pointed at the privacy-preserving
   * youtube-nocookie embed. Uses the stream delivery path (requires
   * connectivity); a fallback image shows on failure like any website.
   */
  private buildYouTubeItem(
    item: ManifestItem,
    widget: ManifestWidget,
  ): PresentationItem | null {
    const config = widget.configuration ?? {};
    const videoId = String(config["videoId"] ?? config["video"] ?? "");
    const playlistId = String(config["playlistId"] ?? config["playlist"] ?? "");
    if (!videoId && !playlistId) {
      return null;
    }
    const params = new URLSearchParams({
      autoplay: "1",
      controls: "0",
      rel: "0",
      modestbranding: "1",
      mute: this.itemSettings(item, 60_000).audioEnabled ? "0" : "1",
      loop: "1",
    });
    const settings = this.itemSettings(item, 60_000);
    if (config["startSeconds"]) {
      params.set("start", String(config["startSeconds"]));
    }
    if (config["endSeconds"]) {
      params.set("end", String(config["endSeconds"]));
    }
    let url: string;
    if (playlistId) {
      params.set("listType", "playlist");
      params.set("list", playlistId);
      url = `https://www.youtube-nocookie.com/embed?${params.toString()}`;
    } else {
      params.set("playlist", videoId); // required for single-video loop
      url = `https://www.youtube-nocookie.com/embed/${videoId}?${params.toString()}`;
    }
    return {
      id: item.id,
      kind: "youtube",
      src: url,
      durationMs: settings.durationMs,
      fitMode: "cover",
      transition: settings.transition,
      audioEnabled: settings.audioEnabled,
      volume: settings.volume,
      videoStartOffsetMs: null,
      videoEndOffsetMs: null,
      website: {
        loadTimeoutSeconds: this.numberConfig(
          this.config?.website,
          "timeoutSeconds",
          20,
        ),
        refreshIntervalSeconds: null,
        zoomPercent: this.numberConfig(
          this.config?.website,
          "defaultZoomPercent",
          100,
        ),
        javascriptEnabled: true,
        domStorageEnabled: true,
        cookiePolicy: this.stringConfig(
          this.config?.website,
          "cookiePolicy",
          "first_party",
        ),
        reloadPolicy: this.stringConfig(
          this.config?.website,
          "defaultReloadPolicy",
          "on_each_activation",
        ),
        customUserAgent: "",
        scrollX: 0,
        scrollY: 0,
        backgroundColor: "#000000",
        failureBehavior: "placeholder",
        fallbackSrc: null,
        allowedHosts: [
          "www.youtube-nocookie.com",
          "www.youtube.com",
          "i.ytimg.com",
        ],
      },
    };
  }

  /** Resolve a tcmedia asset reference for the protocol handler. */
  async resolveMedia(
    assetId: string,
    variantId: string,
  ): Promise<
    | { kind: "file"; path: string; mimeType: string }
    | { kind: "remote"; url: string; headers: Record<string, string> }
    | null
  > {
    const manifest = this.activeManifest ?? this.pendingManifest;
    const asset = manifest?.assets.find(
      (a) =>
        a.assetId === assetId &&
        a.variantId === variantId &&
        isAvailableAt(a, this.clock.now()),
    );
    if (!asset) {
      return null;
    }
    const cached = await this.manifestSync.cachedPath(asset);
    if (cached) {
      return { kind: "file", path: cached, mimeType: asset.mimeType };
    }
    return {
      kind: "remote",
      url: this.client.url(asset.downloadPath),
      headers: this.client.authHeaders(),
    };
  }

  // -------------------------------------------------------------- self-heal

  private async supervisorTick(): Promise<void> {
    // Only supervise when something should actually be rendering.
    if (this.playbackState !== "playing") {
      return;
    }
    const decision = evaluate(
      this.supervisorState,
      // Reliability intervals are elapsed local-process time. Server-clock
      // offsets belong to content policy and would make a device with a
      // skewed RTC look stalled immediately after a clock sync.
      Date.now(),
      this.supervisorConfig(),
    );
    if (decision.state !== this.supervisorState) {
      this.supervisorState = decision.state;
      await this.store.writeJson(SUPERVISOR_FILE, this.supervisorState);
    }
    if (decision.action !== "none") {
      log.warn("self-heal action", {
        action: decision.action,
        escalationStep: this.supervisorState.escalationStep,
      });
      // Report the attempt; confirmed recovery is the separate
      // connection.recovered / content progress event.
      void this.activity?.record({
        eventType:
          decision.action === "enter_safe_mode"
            ? "safe_mode.entered"
            : "self_heal.attempted",
        category: "reliability",
        severity:
          decision.action === "enter_safe_mode" ? "critical" : "warning",
        failureCode: decision.action,
        metadata: { escalationStep: this.supervisorState.escalationStep },
      });
      // Flush reliability events promptly so Studio sees an outage even if the
      // action about to run restarts the process.
      void this.activity?.flush();
      this.applyHealAction(decision.action);
    }
  }

  private applyHealAction(action: HealAction): void {
    switch (action) {
      case "reactivate_content":
        // Local first: re-present cached content without server contact.
        this.evaluatePresentation(true);
        break;
      case "recreate_renderer":
        this.host.recreateRenderer();
        break;
      case "recreate_window":
        this.host.recreateWindow();
        break;
      case "restart_process":
        this.host.restartProcess();
        break;
      case "enter_safe_mode":
        this.evaluatePresentation(true);
        break;
      case "none":
        break;
    }
  }

  // ---------------------------------------------------------------- status

  private numberConfig(
    values: Record<string, unknown> | undefined,
    key: string,
    fallback: number,
  ): number {
    const value = Number(values?.[key]);
    return Number.isFinite(value) ? value : fallback;
  }

  private stringConfig(
    values: Record<string, unknown> | undefined,
    key: string,
    fallback: string,
  ): string {
    const value = values?.[key];
    return typeof value === "string" && value.trim() !== "" ? value : fallback;
  }

  private statusIntervalSeconds(): number {
    const value = this.numberConfig(
      this.config?.sync,
      "statusReportSeconds",
      DEFAULT_STATUS_INTERVAL_S,
    );
    return Number.isFinite(value) && value >= 15
      ? value
      : DEFAULT_STATUS_INTERVAL_S;
  }

  private manifestIntervalSeconds(): number {
    const value = this.numberConfig(
      this.config?.sync,
      "manifestReconciliationSeconds",
      300,
    );
    return Number.isFinite(value) && value >= 60 ? value : 300;
  }

  private rescheduleRuntimeTimers(): void {
    if (!this.pairedTimersStarted) return;
    if (this.statusTimer) clearInterval(this.statusTimer);
    if (this.configTimer) clearInterval(this.configTimer);
    this.statusTimer = setInterval(
      () => void this.reportStatus(),
      this.statusIntervalSeconds() * 1_000,
    );
    this.configTimer = setInterval(
      () => void this.configSync.syncNow("reconcile-timer"),
      this.manifestIntervalSeconds() * 1_000,
    );
    this.statusTimer.unref?.();
    this.configTimer.unref?.();
  }

  private supervisorConfig(): SupervisorConfig {
    const reliability = this.config?.reliability ?? {};
    const stallSeconds = this.numberConfig(
      reliability,
      "playbackStallSeconds",
      DEFAULT_SUPERVISOR_CONFIG.stallThresholdMs / 1_000,
    );
    const restartWindowMinutes = this.numberConfig(
      reliability,
      "restartWindowMinutes",
      DEFAULT_SUPERVISOR_CONFIG.ladderRunWindowMs / 60_000,
    );
    const maximumRestarts = this.numberConfig(
      reliability,
      "maximumProcessRestarts",
      DEFAULT_SUPERVISOR_CONFIG.maxLadderRunsBeforeSafeMode,
    );
    return {
      ...DEFAULT_SUPERVISOR_CONFIG,
      stallThresholdMs: Math.max(10_000, stallSeconds * 1_000),
      ladderRunWindowMs: Math.max(60_000, restartWindowMinutes * 60_000),
      maxLadderRunsBeforeSafeMode: Math.max(1, Math.floor(maximumRestarts)),
      safeModeEnabled: reliability["safeModeEnabled"] !== false,
    };
  }

  /**
   * Device uptime derived from the reading taken at start, rather than by
   * re-reading procfs on every sample. An unexpected reboot is visible as this
   * dropping, which the server sees as a new uptime, not as a gap.
   */
  private deviceUptimeSeconds(): number | null {
    if (this.systemUptimeAtStartSeconds === null) return null;
    return Math.floor(
      this.systemUptimeAtStartSeconds + (Date.now() - this.startedAt) / 1_000,
    );
  }

  /** Refreshed on the reporting cadence: every field here is a sysfs read. */
  private async refreshSystemDiagnostics(): Promise<void> {
    // The wired Ethernet facts are read on the same cadence, from procfs and
    // sysfs with no subprocess. This is the fallback for a box with no helper;
    // when the helper is present its own view of NetworkManager wins, because it
    // is what actually manages the interfaces.
    try {
      this.wiredInterface = await readWiredInterfaceStatus();
    } catch {
      // Nothing is guessed. An unreadable probe means the fields go absent, and
      // the server then gives a precise AirPlay readiness error rather than being
      // handed an address that cannot work.
      this.wiredInterface = null;
    }
    try {
      this.systemDiagnostics = await readSystemDiagnostics();
    } catch (error) {
      // A probe failure is not a player failure. Keeping the previous reading
      // is wrong too, so the gauges simply go absent.
      this.systemDiagnostics = {};
      log.debug("system probe failed", { error: String(error) });
    }
  }

  private async readSystemUptimeSeconds(): Promise<number | null> {
    try {
      return parseProcUptime(await fs.readFile("/proc/uptime", "utf8"));
    } catch {
      // No procfs (a non-Linux dev host): no boot evidence, reported as such.
      return null;
    }
  }

  private async refreshAutostartStatus(): Promise<void> {
    if (!this.autostart) {
      return;
    }
    // A successfully launched update gets one chance to repair an older
    // Tilecast-owned service before the next reboot returns it to the legacy
    // FUSE mount path. Missing and operator-owned units remain untouched.
    await this.autostart.repairLegacyGeneratedUnit();
    this.autostartStatus = await this.autostart.probe();
  }

  /**
   * Autostart facts for the heartbeat, including the Linux equivalent of the
   * Android boot receiver's verification. `bootLaunchVerified` is reported only
   * on real evidence — systemd started us, close to boot — so Studio's "Launch
   * after boot" row means the same thing on both platforms.
   */
  private autostartHeartbeatFields(): Partial<Heartbeat> {
    const status = this.autostartStatus;
    if (!status) {
      return {};
    }
    const fields: Partial<Heartbeat> = {
      autostartState: status.state,
      autostartSupervised: status.supervised,
      autostartLingerEnabled: status.lingerEnabled,
      bootLaunchVerified: coldBootLaunchVerified({
        supervised: status.supervised,
        systemUptimeSecondsAtStart: this.systemUptimeAtStartSeconds,
      }),
    };
    if (status.target) {
      fields.autostartTarget = status.target;
    }
    if (status.detail) {
      fields.autostartError = status.detail.slice(0, 240);
    }
    if (fields.bootLaunchVerified) {
      fields.lastSuccessfulColdBootAt = new Date(this.startedAt).toISOString();
    }
    return fields;
  }

  /**
   * `includeHistory` is false for the socket fast path. The socket is
   * fire-and-forget, and history that nobody acknowledges is history that gets
   * dropped or sent twice, so buckets travel only on the HTTP heartbeat that
   * answers.
   */
  private async buildHeartbeat(includeHistory = false): Promise<Heartbeat> {
    const size = this.host.screenSize();
    const manifest = this.activeManifest;
    // Playback is "healthy" when content is actually on screen and no safe-mode
    // recovery is active; the server uses the latest healthy timestamp (paired
    // with a higher version code) to settle a completed self-update.
    if (this.playbackState === "playing" && !this.supervisorState.safeMode) {
      this.lastHealthyPlaybackAt = new Date().toISOString();
    }
    const heartbeat: Heartbeat = {
      screenWidth: size.width,
      screenHeight: size.height,
      playerVersion: this.options.playerVersion,
      playerVersionCode: parseVersionCode(this.options.playerVersion),
      presentationSchemaVersions: [1],
      nativePresentationCapabilities: {
        "layout.surface": 1,
        "layout.box": 1,
        "layout.row": 1,
        "layout.column": 1,
        "layout.stack": 1,
        "layout.grid": 1,
        "layout.spacer": 1,
        "layout.divider": 1,
        "content.text": 1,
        "content.icon": 2,
        "content.asset_image": 2,
        "content.badge": 1,
        "content.progress": 2,
        "content.qr_code": 1,
        "content.marquee": 1,
        "content.line_chart": 2,
        "content.bar_chart": 2,
        "content.donut_chart": 2,
        "collection.repeat": 2,
        "collection.conditional": 2,
        "collection.grouped_sections": 1,
        "binding.core": 2,
        "format.typed": 2,
        "selection.relative_date": 1,
        "selection.temporal": 1,
        "playback.auto_skip": 1,
        // The shared projection keeps Clock, Countdown and World Clock
        // ticking in place, so time-bound widgets are supported.
        "environment.time": 1,
      },
      webRuntimeVersion: 2,
      webBundleLimitBytes: 20 * 1024 * 1024,
      uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1_000),
      playbackState: this.playbackState,
      playbackDisabled: this.flags.playbackDisabled,
      safeMode: this.supervisorState.safeMode,
      recoveryLevel: this.supervisorState.escalationStep,
      recoveryCount: this.supervisorState.ladderRunsAtMs.length,
      websiteRendererRecoveryCount: this.websiteRecoveryCount,
      ...this.renderProgressHeartbeatFields(),
      ...this.autostartHeartbeatFields(),
    };
    const noiseMeter = this.noiseMeterHeartbeat(includeHistory);
    if (noiseMeter) {
      heartbeat.noiseMeter = noiseMeter;
    }
    if (this.airplayCapabilities) {
      heartbeat.airplaySupported = this.airplayCapabilities.airplaySupported;
      heartbeat.airplayUxPlayInstalled =
        this.airplayCapabilities.uxplayInstalled;
      heartbeat.airplayUxPlayVersion =
        this.airplayCapabilities.uxplayVersion ?? undefined;
      heartbeat.airplayGstreamerInstalled =
        this.airplayCapabilities.gstreamerInstalled;
      heartbeat.airplayH264DecoderAvailable =
        this.airplayCapabilities.h264DecoderAvailable;
      heartbeat.airplayHardwareDecode =
        this.airplayCapabilities.hardwareH264Decode;
      heartbeat.airplayDecoder = this.airplayCapabilities.decoder ?? undefined;
      heartbeat.airplayMaxProfile = this.airplayCapabilities.maxProfile;
      heartbeat.airplayGroupSupported =
        this.airplayCapabilities.groupAirplaySupported;
      heartbeat.airplayAudioAvailable = this.airplayCapabilities.audioAvailable;
      heartbeat.airplayAvahiAvailable = this.airplayCapabilities.avahiAvailable;
      heartbeat.airplayMdnsAdvertisementAvailable =
        this.airplayCapabilities.mdnsAdvertisementAvailable;
      heartbeat.airplayMulticastSupported =
        this.airplayCapabilities.multicastSupported ?? undefined;
      heartbeat.airplayMulticastTestStatus =
        this.airplayCapabilities.multicastTestStatus;
      // The probe already knows which dependency failed and why. Without this
      // Studio can only say "not AirPlay-ready" and leave an operator guessing
      // between UxPlay, GStreamer, the H.264 decoder, Avahi, and VA-API.
      if (this.airplayCapabilities.limitation) {
        heartbeat.airplayLimitation = this.airplayCapabilities.limitation.slice(
          0,
          240,
        );
      }
    }
    // Presentation Network capability and the wired address group AirPlay RTP
    // uses. Reported unconditionally when probed, like AirPlay capability: Studio
    // cannot offer the feature on a screen whose capability it has never seen.
    if (this.presentationNetworkCapability) {
      const capability = this.presentationNetworkCapability;
      heartbeat.presentationNetworkSupported = capability.supported;
      heartbeat.presentationNetworkHelperState = capability.helperState;
      heartbeat.presentationNetworkManagerAvailable =
        capability.networkManagerAvailable;
      heartbeat.presentationNetworkWifiAdapter = capability.wifiAdapter;
      heartbeat.presentationNetworkRadioEnabled = capability.radioEnabled;
      if (capability.limitation) {
        heartbeat.presentationNetworkLimitation = capability.limitation.slice(
          0,
          240,
        );
      }
      // The wired facts come from the helper's own view of NetworkManager, with
      // the direct procfs/sysfs reading below as the fallback for a box where the
      // helper is absent. Ordinary telemetry's networkLinkType is untouched and
      // still describes the default-route path.
      if (capability.wiredInterfaceAvailable) {
        heartbeat.wiredInterfaceAvailable = true;
        if (capability.wiredIpv4) heartbeat.wiredIpv4 = capability.wiredIpv4;
      }
    }
    if (this.wiredInterface && heartbeat.wiredIpv4 === undefined) {
      heartbeat.wiredInterfaceAvailable = this.wiredInterface.available;
      if (this.wiredInterface.ipv4)
        heartbeat.wiredIpv4 = this.wiredInterface.ipv4;
    }
    const networkState = this.host.getPresentationNetworkState?.() ?? null;
    if (networkState) {
      heartbeat.presentationNetworkState = networkState.state;
      if (networkState.installedNetworkId) {
        heartbeat.presentationNetworkInstalledId =
          networkState.installedNetworkId;
      }
      if (networkState.installedRevision !== null) {
        heartbeat.presentationNetworkInstalledRevision =
          networkState.installedRevision;
      }
      if (networkState.activeNetworkId) {
        heartbeat.presentationNetworkActiveId = networkState.activeNetworkId;
      }
      if (networkState.failureCode) {
        heartbeat.presentationNetworkLastFailureCode = networkState.failureCode;
      }
      if (networkState.lastConnectedAt) {
        heartbeat.presentationNetworkLastConnectedAt =
          networkState.lastConnectedAt;
      }
      if (networkState.lastFailureAt) {
        heartbeat.presentationNetworkLastFailureAt = networkState.lastFailureAt;
      }
    }
    if (this.displayControlStatus) {
      heartbeat.displayControlProvider = this.displayControlStatus.provider;
      heartbeat.displayControlProviders = this.displayControlStatus.providers;
      heartbeat.displayControlCapabilities =
        this.displayControlStatus.capabilities;
      heartbeat.displayPowerState = this.displayControlStatus.powerState;
      heartbeat.displayPowerStateConfirmed =
        this.displayControlStatus.powerStateConfirmed;
      heartbeat.displayPowerStateObservedAt =
        this.displayControlStatus.observedAt;
      heartbeat.displayControlPolicyState =
        this.displayControlStatus.policyState;
      heartbeat.displayControlError = this.displayControlStatus.error;
    }
    if (this.externalPresentation && this.externalPresentationStatus) {
      heartbeat.externalPresentationState =
        this.externalPresentationStatus.state;
      heartbeat.externalPresentationSessionId =
        this.externalPresentation.sessionId;
      heartbeat.externalPresentationRole = this.externalPresentation.role;
      heartbeat.airplayReceiverState = this.externalPresentationStatus.state;
      heartbeat.airplayTransport = this.externalPresentation.transport;
      heartbeat.airplayConnected = this.externalPresentationStatus.connected;
      heartbeat.externalPresentationExpiresAt =
        this.externalPresentation.expiresAt;
    } else {
      // Explicitly clear the server's last external-presentation snapshot
      // after a local expiry, restart, or manual stop.
      heartbeat.externalPresentationState = "none";
      if (this.lastExternalPresentationSessionId) {
        heartbeat.externalPresentationSessionId =
          this.lastExternalPresentationSessionId;
      }
    }
    if (this.lastHealthyPlaybackAt) {
      heartbeat.lastHealthyPlaybackAt = this.lastHealthyPlaybackAt;
    }
    if (manifest) {
      heartbeat.activeManifestVersion = manifest.manifestVersion;
    }
    if (this.pendingManifest) {
      heartbeat.pendingManifestVersion = this.pendingManifest.manifestVersion;
    }
    // Every UUID-typed field below is validated before it is set: the server
    // rejects an entire heartbeat over one malformed identifier, and the
    // lifecycle fields in this same message are what settle a self-update.
    const itemId = heartbeatItemId(this.currentItemId);
    if (itemId) {
      heartbeat.currentItemId = itemId;
    }
    if (this.selection) {
      heartbeat.selectionSource = this.selection.source;
      const scheduleId = uuidHeartbeatField(
        "currentScheduleId",
        this.selection.scheduleId,
      );
      if (scheduleId) {
        heartbeat.currentScheduleId = scheduleId;
      }
      const playlistId = uuidHeartbeatField(
        "currentPlaylistId",
        this.selection.playlistId,
      );
      if (playlistId) {
        heartbeat.currentPlaylistId = playlistId;
      }
      if (this.selection.takeoverId) {
        // The takeover is genuinely active even if its identifier is unusable,
        // so the state is still reported; only the UUID field is withheld.
        const takeoverId = uuidHeartbeatField(
          "activeTakeoverId",
          this.selection.takeoverId,
        );
        if (takeoverId) {
          heartbeat.activeTakeoverId = takeoverId;
        }
        heartbeat.takeoverState = "active";
      }
      if (this.selection.nextTransitionAt) {
        heartbeat.nextTransitionAt = this.selection.nextTransitionAt;
      }
    }
    if (this.config) {
      heartbeat.activeConfigRevision = this.config.configRevision;
    }
    if (this.manifestSync.lastSyncError) {
      heartbeat.lastSynchronizationError =
        this.manifestSync.lastSyncError.slice(0, 240);
    }
    if (this.lastPlaybackError) {
      heartbeat.lastPlaybackError = this.lastPlaybackError;
    }
    if (this.lastCommand) {
      const commandId = uuidHeartbeatField(
        "lastCommandId",
        this.lastCommand.id,
      );
      if (commandId) {
        heartbeat.lastCommandId = commandId;
      }
      heartbeat.lastCommandState = this.lastCommand.state;
      heartbeat.lastCommandResult = this.lastCommand.result;
      heartbeat.lastCommandCompletedAt = this.lastCommand.completedAt;
    }
    const storage = await this.host.availableStorageBytes();
    if (storage !== null) {
      heartbeat.availableStorageBytes = storage;
    }
    return heartbeat;
  }

  private async reportStatus(): Promise<void> {
    if (!this.credential || !this.identityVerified) {
      return;
    }
    // Pending history takes the HTTP heartbeat, because that is the one that
    // answers. This is the same endpoint on the same cadence — nothing here
    // adds a request or shortens the interval to drain a backlog faster.
    const draining = this.noiseHistory.size() > 0;
    const heartbeat = await this.buildHeartbeat(draining);
    // Socket is the fast path; HTTP heartbeat is the fallback so presence
    // degrades to "recent"/"stale" honestly rather than flapping.
    if (!draining && this.socket?.isOpen && this.socket.sendStatus(heartbeat)) {
      return;
    }
    const sent = this.noiseHistoryInFlight;
    try {
      const acknowledgement = await this.client.heartbeat(heartbeat);
      // Only now, and only for what the server said it took. A timeout, a 5xx,
      // or a server that stored nothing leaves the batch exactly where it was.
      const accepted = acknowledgement.noiseHistory?.accepted ?? 0;
      if (sent.length > 0 && accepted > 0) {
        await this.noiseHistory.acknowledge(sent, accepted);
      }
    } catch (err) {
      if (err instanceof ApiError && err.credentialRejected) {
        await this.onCredentialRejected();
      }
    } finally {
      this.noiseHistoryInFlight = [];
    }
  }

  // ------------------------------------------------------------ noise meter

  /**
   * One report from the renderer's Noise Meter: its current state, and at most
   * one completed ten-second aggregate.
   *
   * This is the only path noise data takes out of the renderer, and it carries
   * derived numbers. Persistence happens here, in trusted code, so the queue
   * survives a renderer reload rather than living in the page that produced it.
   */
  async onNoiseMeterReport(report: {
    status?: string;
    level?: number | null;
    bucket?: NoiseHistoryBucket | null;
  }): Promise<void> {
    const status = report.status;
    if (
      status === "active" ||
      status === "normal" ||
      status === "loud" ||
      status === "unavailable" ||
      status === "inactive"
    ) {
      this.noiseMeterStatus = status;
    }
    this.noiseMeterLevel =
      typeof report.level === "number" && Number.isFinite(report.level)
        ? Math.min(100, Math.max(0, report.level))
        : null;
    if (report.bucket) {
      await this.noiseHistory.add(report.bucket);
    }
  }

  /**
   * The Noise Meter section of a heartbeat. The batch is remembered so the
   * response can acknowledge exactly what was sent; a heartbeat that never
   * completes leaves every one of those records queued.
   */
  private noiseMeterHeartbeat(
    includeHistory: boolean,
  ): HeartbeatNoiseMeter | null {
    const pending = includeHistory
      ? this.noiseHistory.peekBatch(NOISE_HISTORY_BATCH)
      : [];
    this.noiseHistoryInFlight = pending;
    if (this.noiseMeterStatus === "inactive" && pending.length === 0) {
      return null;
    }
    const section: HeartbeatNoiseMeter = { status: this.noiseMeterStatus };
    if (this.noiseMeterLevel !== null) {
      section.currentLevel = Math.round(this.noiseMeterLevel * 10) / 10;
    }
    if (pending.length > 0) {
      section.pendingHistory = pending;
    }
    return section;
  }

  // --------------------------------------------------------------- commands

  /**
   * Executor for commands that may end the process. The coordinator has already
   * persisted the idempotency key and reported the result before this runs.
   * install_player_update hands off to the self-updater (which restarts only
   * after the AppImage is replaced); every other disruptive command is a plain
   * process relaunch.
   */
  private runDisruptiveCommand(command: PlayerCommand): void {
    if (command.type === "install_player_update") {
      void this.selfUpdater?.run(command);
      return;
    }
    this.host.restartProcess();
  }

  private buildCommandHandlers(): Map<
    string,
    (command: PlayerCommand) => Promise<CommandResultReport>
  > {
    const ok = (code: string, message = ""): CommandResultReport => ({
      success: true,
      code,
      message,
    });
    const handlers = new Map<
      string,
      (command: PlayerCommand) => Promise<CommandResultReport>
    >();

    handlers.set("sync_now", async () => {
      await this.manifestSync.syncNow("command");
      await this.configSync.syncNow("command");
      return ok("synchronized");
    });
    handlers.set("resynchronize_player", async () => {
      await this.manifestSync.syncNow("command");
      await this.configSync.syncNow("command");
      this.evaluatePresentation(true);
      return ok("synchronized");
    });
    handlers.set("reload_playback", async () => {
      this.evaluatePresentation(true);
      return ok("playback_reloaded");
    });
    handlers.set("identify_screen", async (command) => {
      const duration = Number(command.payload?.["durationSeconds"] ?? 15);
      const showLocation =
        this.config?.playback["identifyShowsLocation"] !== false;
      const location = showLocation
        ? this.stringConfig(this.config?.playback, "screenLocation", "")
        : "";
      const name = [this.credential?.screenName ?? "Tilecast Player", location]
        .filter(Boolean)
        .join("\n");
      this.host.identify(name, Math.min(Math.max(duration, 5), 120));
      return ok("identified");
    });
    handlers.set("clear_media_cache", async () => {
      await this.manifestSync.clearMediaCache();
      return ok("cache_cleared");
    });
    handlers.set("clear_website_data", async () => {
      await this.host.clearWebsiteData();
      return ok("website_data_cleared");
    });
    handlers.set("disable_playback", async () => {
      this.flags.playbackDisabled = true;
      await this.store.writeJson(PLAYBACK_FLAGS_FILE, this.flags);
      this.evaluatePresentation(true);
      return ok("playback_disabled");
    });
    handlers.set("enable_playback", async () => {
      this.flags.playbackDisabled = false;
      await this.store.writeJson(PLAYBACK_FLAGS_FILE, this.flags);
      this.evaluatePresentation(true);
      return ok("playback_enabled");
    });
    handlers.set("retry_current_item", async () => {
      this.host.retryCurrentItem();
      return ok("retried");
    });
    handlers.set("skip_current_item", async () => {
      this.host.skipCurrentItem();
      return ok("skipped");
    });
    handlers.set("recreate_renderer", async () => {
      this.host.recreateRenderer();
      return ok("renderer_recreated");
    });
    handlers.set("recreate_playback_session", async () => {
      this.host.recreateRenderer();
      return ok("playback_session_recreated");
    });
    handlers.set("retry_player_recovery", async () => {
      this.supervisorState = {
        ...this.supervisorState,
        lastActionAtMs: null,
      };
      await this.supervisorTick();
      return ok("recovery_retried");
    });
    handlers.set("exit_safe_mode", async () => {
      this.supervisorState = clearSafeMode(this.supervisorState, Date.now());
      await this.store.writeJson(SUPERVISOR_FILE, this.supervisorState);
      this.evaluatePresentation(true);
      return ok("safe_mode_cleared");
    });
    // Autostart is the Linux answer to the Android boot receiver: the player
    // installs and enables its own systemd user unit instead of an operator
    // hand-writing one on the device. Neither command is disruptive — install
    // deliberately does not start the unit, and remove deliberately does not
    // stop it, because this process is the one the unit supervises.
    handlers.set("install_autostart", async () => {
      const result = (await this.autostart?.install()) ?? {
        success: false,
        code: "autostart_unsupported",
        message: "Autostart is unavailable before pairing completes.",
      };
      await this.refreshAutostartStatus();
      void this.reportStatus();
      return result;
    });
    handlers.set("remove_autostart", async () => {
      const result = (await this.autostart?.remove()) ?? {
        success: false,
        code: "autostart_unsupported",
        message: "Autostart is unavailable before pairing completes.",
      };
      await this.refreshAutostartStatus();
      void this.reportStatus();
      return result;
    });
    handlers.set("run_player_self_test", async () => {
      const results: string[] = [];
      results.push(this.activeManifest ? "manifest:ok" : "manifest:none");
      results.push(this.socketOpen ? "socket:open" : "socket:closed");
      results.push(`autostart:${this.autostartStatus?.state ?? "unknown"}`);
      try {
        await this.store.writeJson("self-test.json", { at: Date.now() });
        await this.store.delete("self-test.json");
        results.push("storage:ok");
      } catch {
        results.push("storage:failed");
      }
      const failed = results.some((r) => r.endsWith(":failed"));
      return {
        success: !failed,
        code: failed ? "self_test_failed" : "self_test_passed",
        message: results.join(" "),
      };
    });
    for (const type of [
      "display_power_on",
      "display_power_off",
      "display_set_input",
      "display_set_volume",
      "display_mute",
      "display_unmute",
      "display_set_brightness",
      "display_probe",
    ]) {
      handlers.set(type, async (command) => {
        const parsed = parseDisplayControlCommand(command);
        if (!parsed) {
          return {
            success: false,
            code: "display_invalid_payload",
            message: "Display command payload is invalid.",
          };
        }
        if (!this.host.executeDisplayControl) {
          return {
            success: false,
            code: "display_unsupported",
            message: "This player does not provide Display Control.",
          };
        }
        try {
          const result = await this.host.executeDisplayControl(parsed);
          if (result.status) this.displayControlStatus = result.status;
          void this.reportStatus();
          return result;
        } catch (error) {
          return {
            success: false,
            code: "display_command_failed",
            message: String(error).slice(0, 240),
          };
        }
      });
    }
    handlers.set("test_airplay_support", async () => {
      const capabilities = await this.refreshAirplayCapabilities();
      if (!capabilities) {
        return {
          success: false,
          code: "airplay_probe_unavailable",
          message:
            "This player does not expose a Linux AirPlay capability probe.",
        };
      }
      void this.reportStatus();
      return {
        success: capabilities.airplaySupported,
        code: capabilities.airplaySupported
          ? "airplay_supported"
          : "airplay_not_ready",
        message:
          capabilities.limitation ??
          (capabilities.airplaySupported
            ? `AirPlay ready with ${capabilities.decoder}.`
            : "Required UxPlay or GStreamer support is unavailable."),
      };
    });
    handlers.set("provision_presentation_network", async () => {
      if (!this.host.reconcilePresentationNetwork) {
        return {
          success: false,
          code: "presentation_network_unsupported",
          message: "This player does not support Presentation Networks.",
        };
      }
      await this.host.reconcilePresentationNetwork();
      const capability = await this.refreshPresentationNetwork();
      void this.reportStatus();
      const state = this.host.getPresentationNetworkState?.() ?? null;
      if (capability && !capability.networkManagerAvailable) {
        return {
          success: false,
          code: "presentation_network_unsupported",
          message:
            capability.limitation ??
            "NetworkManager is not available on this player.",
        };
      }
      if (state?.state === "failed") {
        return {
          success: false,
          code: state.failureCode ?? "presentation_network_failed",
          message: "The Presentation Network could not be provisioned.",
        };
      }
      return {
        success: true,
        code: "presentation_network_reconciled",
        message: "Presentation Network configuration is up to date.",
      };
    });
    handlers.set("test_presentation_network", async (command) => {
      if (!this.host.testPresentationNetwork) {
        return {
          success: false,
          code: "presentation_network_unsupported",
          message: "This player does not support Presentation Networks.",
        };
      }
      // An AirPlay session must not be interrupted by a test of the network it is
      // using. The server refuses this too; checking locally covers the race where
      // a session started between the two.
      if (this.externalPresentation) {
        return {
          success: false,
          code: "presentation_network_airplay_active",
          message:
            "An AirPlay session is active on this player. Stop it before testing.",
        };
      }
      const networkId = command.payload["presentationNetworkId"];
      const timeout = command.payload["timeoutSeconds"];
      if (typeof networkId !== "string") {
        return {
          success: false,
          code: "presentation_network_invalid",
          message: "The Presentation Network test payload is invalid.",
        };
      }
      const result = await this.host.testPresentationNetwork(
        networkId,
        typeof timeout === "number" ? timeout : 90,
      );
      await this.refreshPresentationNetwork();
      void this.reportStatus();
      return result;
    });
    handlers.set("prepare_airplay_session", async (command) => {
      const phase = command.payload["phase"];
      const startGateway = phase === undefined || phase === "start";
      try {
        return await this.prepareExternalPresentation(command, startGateway);
      } catch (error) {
        return {
          success: false,
          code: "airplay_prepare_failed",
          message: String(error).slice(0, 240),
        };
      }
    });
    handlers.set("stop_airplay_session", async (command) => {
      const requested = command.payload["sessionId"];
      if (
        typeof requested === "string" &&
        this.externalPresentation &&
        requested !== this.externalPresentation.sessionId
      ) {
        return {
          success: true,
          code: "airplay_already_stopped",
          message:
            "The requested AirPlay session is not active on this player.",
        };
      }
      const reason =
        typeof command.payload["reason"] === "string"
          ? command.payload["reason"]
          : "remote_stop";
      // Multicast fallback deliberately reuses the same server session while
      // replacing the local process pair. Do not report a terminal `none`
      // heartbeat for that transition; the following prepare command owns the
      // same assignment and the server expiry path remains the backstop if it
      // never arrives.
      await this.stopExternalPresentation(
        reason,
        reason !== "multicast_fallback",
      );
      return {
        success: true,
        code: "airplay_stopped",
        message: "AirPlay stopped and current signage state was evaluated.",
      };
    });

    return handlers;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * What progress looks like for each kind of item. Getting this wrong in either
 * direction is costly: too strict calls a valid still image frozen, too loose
 * lets a genuinely frozen video pass.
 */
export function contentExpectationFor(
  kind: string | undefined,
): ContentExpectation {
  switch (kind) {
    case "video":
      return "video";
    case "image":
      return "still";
    case "website":
    case "youtube":
      return "website";
    case "layout":
      return "layout";
    case "widget":
      // A widget renders once and may then sit still, like a website.
      return "website";
    default:
      return "indefinite";
  }
}

/**
 * Maps the renderer's own progress vocabulary onto contract progress signals.
 *
 * The `*-alive` kinds are liveness pings, not evidence that anything is
 * happening on screen, so they map to a renderer health confirmation rather
 * than to progress. Treating them as progress is exactly how a player keeps
 * reporting healthy over a frozen display.
 */
function progressSignalFor(kind: string): ProgressSignal | null {
  switch (kind) {
    case "item-transition":
      return "item_transition";
    case "video-progress":
      return "video_position_advanced";
    case "image-shown":
      return "image_displayed";
    case "website-loaded":
    case "widget-shown":
    case "layout-shown":
      return "website_first_render";
    case "layout-zone-rendered":
      return "layout_child_rendered";
    case "frame-changed":
      return "frame_fingerprint_changed";
    case "website-alive":
    case "widget-alive":
    case "layout-alive":
      return "renderer_health_confirmed";
    default:
      return null;
  }
}

/**
 * The zones a layout owes render evidence for, split by what each one can be
 * held to. Every zone owes a first render; only a rotating playlist zone owes
 * continuing evidence, because a static widget or image zone renders once and
 * legitimately holds — the same reasoning that protects a still image.
 */
export function layoutZoneExpectations(item: PresentationItem | undefined): {
  zoneIds: string[];
  recurringZoneIds: string[];
} {
  if (!item || item.kind !== "layout" || !item.layout) {
    return { zoneIds: [], recurringZoneIds: [] };
  }
  const zoneIds: string[] = [];
  const recurringZoneIds: string[] = [];
  for (const zone of item.layout.zones) {
    if (!zone.id) continue;
    zoneIds.push(zone.id);
    if (zone.playlistItems && zone.playlistItems.length > 1) {
      // A single-item zone loops in place and does not advance, so it is not
      // owed continuing evidence either.
      recurringZoneIds.push(zone.id);
    }
  }
  return { zoneIds, recurringZoneIds };
}
