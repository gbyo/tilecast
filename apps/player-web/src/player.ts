import type {
  EvidenceReportV1,
  PlaybackErrorReportV1,
  PresentationResultV1,
  RuntimeReadyV1,
} from "@tilecast/player-runtime/host-contract";
import {
  statusSurface,
  type DeviceMetadata,
  type StatusKind,
} from "@tilecast/player-runtime/projection";
import { stopForState } from "@tilecast/player-activity";
import { ActivityEngine } from "./activity/engine";
import { PlayerAPI, PlayerAPIError, serverUnreachable } from "./api";
import {
  assertSameServer,
  authenticate,
  fetchServerIdentity,
  IdentityMismatch,
  pause,
  PairingEnded,
  type BrowserSession,
} from "./authentication";
import {
  browserCommandHandlers,
  CommandRunner,
  CommandStore,
} from "./commands";
import {
  browserStatus,
  controllingShellVersion,
  describeBrowser,
  serviceWorkerStatus,
  type OfflineContent,
} from "./diagnostics";
import {
  browserDisplayEnvironment,
  DisplayController,
  startControlLabel,
} from "./display";
import { runtimeHost } from "./host";
import { heartbeatPayload } from "./heartbeat";
import type { BrowserIdentity } from "./identity";
import {
  clockDiscontinuity,
  foregroundEligible,
  foregroundStateOf,
  initialHostState,
  markClockDiscontinuity,
  markReconciled,
  meaningfulEvidence,
  proofEligible,
  requireReconfirmation,
  revokeLocalAuthority,
  type HostState,
} from "./lifecycle";
import { installMediaAuthorization } from "./media-authorization";
import { decideRest } from "./policy";
import { reconcileSelection, type ReconcileMemory } from "./reconcile";
import { restoreLocalActivation } from "./restore";
import { loadRuntime, registerShell } from "./runtime-boot";
import {
  discardActivation,
  type PreparedActivation,
} from "./storage/activation";
import { IndexedObjects } from "./storage/index";
import { OPFSFiles } from "./storage/opfs";
import {
  requestManagedStorage,
  storageFacts,
  type StorageFacts,
} from "./storage/persistence";
import { VerifiedStore } from "./storage/verified-store";

declare const __HOST_VERSION__: string;

const POLL_MS = 10_000;
// A server that cannot be reached is retried sooner at first, then settles.
const UNREACHABLE_FIRST_MS = 2_000;
const MAX_BACKOFF_MS = 15_000;
const STORAGE_REFRESH_MS = 60_000;
const INTEGRITY_CHECK_MS = 30_000;
/** The longest the rest policy waits before it looks at the clock again. */
const REST_RECHECK_MS = 30_000;

export interface PlayerEnvironment {
  database: IDBDatabase;
  identity: BrowserIdentity;
  identitySlot: string;
  recovery: string | null;
}

/** A Browser Player: the browser host of the shared Player Runtime. */
export class BrowserPlayer {
  private readonly abort = new AbortController();
  private readonly state: HostState;
  private readonly api = new PlayerAPI();
  private readonly session = new Set<string>();
  private readonly display = new DisplayController(browserDisplayEnvironment());
  private readonly wake = new EventTarget();
  private readonly browser = describeBrowser(navigator);
  private readonly bridge;
  private readonly memory: ReconcileMemory = {
    key: "",
    generation: 0,
    validUntilMs: null,
    clockOffsetMs: 0,
  };

  private database: IDBDatabase;
  private identity: BrowserIdentity;
  private recovery: string | null;
  private readonly identitySlot: string;

  private active: PreparedActivation | undefined;
  private ready: RuntimeReadyV1 | undefined;
  private resolveReady!: () => void;
  private readonly readiness = new Promise<void>((resolve) => {
    this.resolveReady = resolve;
  });
  private files!: OPFSFiles;
  private index!: IndexedObjects;
  private activity: ActivityEngine | undefined;
  private commands: CommandRunner | undefined;
  private link:
    { server: { installationId: string }; bound: BrowserSession } | undefined;
  private registration: ServiceWorkerRegistration | undefined;
  private restTimer: ReturnType<typeof setTimeout> | undefined;
  private startControl: HTMLButtonElement | undefined;
  private everStarted = false;
  private updateRequested = false;

  private currentItemId: string | undefined;
  private lastPlaybackError: string | undefined;
  private lastHealthyAtMs: number | undefined;
  private lastSyncAtMs: number | undefined;
  private storage: StorageFacts | undefined;
  private storageReadAt = 0;
  private shellVersion: string | undefined;
  private integrityCheckedAt = 0;
  private preparing = false;
  private activeHoursState: "active" | "off_hours" = "active";

  constructor(environment: PlayerEnvironment) {
    this.database = environment.database;
    this.identity = environment.identity;
    this.identitySlot = environment.identitySlot;
    this.recovery = environment.recovery;
    this.state = initialHostState(
      !document.hidden,
      (document as { wasDiscarded?: boolean }).wasDiscarded === true,
    );
    this.bridge = runtimeHost({
      info: {
        host: "browser",
        hostVersion: __HOST_VERSION__,
        engine: this.browser.browserName,
        engineVersion: String(this.browser.browserMajorVersion),
      },
      ready: (value) => {
        this.ready = value;
        this.resolveReady();
      },
      result: (value) => this.onResult(value),
      evidence: (value) => this.onEvidence(value),
      error: (value) => this.onPlaybackError(value),
    });
  }

  /** The Player stops: its page is going away or the host is shutting down. */
  stop(): void {
    this.abort.abort();
  }

  // ----------------------------------------------------------- Runtime reports

  private onResult(value: PresentationResultV1): void {
    if (value.activation?.activationId !== this.active?.activationId) return;
    this.state.runtimeActivationAccepted = value.outcome === "accepted";
    if (value.outcome === "accepted") this.lastPlaybackError = undefined;
    else this.lastPlaybackError = value.message ?? value.code;
    this.activity?.proof.sync();
  }

  private onEvidence(value: EvidenceReportV1): void {
    if (value.activation?.activationId !== this.active?.activationId) return;
    this.activity?.proof.evidence(value.kind, value.itemId);
    if (!meaningfulEvidence(this.state)) return;
    this.lastHealthyAtMs = this.correctedNow();
    if (value.kind === "item-started" && value.itemId) {
      this.currentItemId = value.itemId.startsWith("layout-")
        ? value.itemId.slice("layout-".length)
        : value.itemId;
    }
  }

  private onPlaybackError(value: PlaybackErrorReportV1): void {
    if (value.activation?.activationId !== this.active?.activationId) return;
    // The Runtime accepted this activation. One item failing is a failure to
    // report, not a reason to stop counting every item that plays after it.
    this.lastPlaybackError = value.message;
    this.activity?.proof.failure(value.itemId, value.message);
  }

  // ------------------------------------------------------------------ clocks

  /** The device clock corrected by the last server reconciliation. */
  private correctedNow(): number {
    return Date.now() + this.memory.clockOffsetMs;
  }

  // ----------------------------------------------------------------- surfaces

  /**
   * The status surface shown until an activation exists. It carries no
   * content decision: connection wording belongs to the host, and branding
   * and layout belong to the shared resolver.
   */
  private surface(kind: StatusKind, title?: string, message?: string): void {
    this.bridge.send({
      type: "presentation",
      presentation: statusSurface(kind, undefined, {
        ...(title ? { title } : {}),
        ...(message ? { message } : {}),
      }),
    });
  }

  private screenName(): string {
    return this.link?.bound.screenName ?? "Tilecast Player";
  }

  // --------------------------------------------------------------- activation

  /** Sends an activation to the Runtime and tells the proof what it presents. */
  private publish(next: PreparedActivation, restart?: "recovery_action"): void {
    this.state.runtimeActivationAccepted = false;
    // The Runtime reports its first evidence while it handles the
    // presentation, so the proof must know what is presented before it is sent.
    const presentation = next.presentation.presentation;
    if (presentation.state === "playing") {
      const items = presentation.items.map((item) => ({
        id: item.id,
        kind: item.kind,
        durationMs: item.durationMs,
      }));
      this.activity?.proof.activate({
        selection: next.policy?.selection ?? null,
        manifestVersion: next.policy?.manifestVersion,
        items,
      });
      if (restart) this.activity?.proof.restart(restart);
    } else {
      const stop = stopForState(presentation.state);
      this.activity?.proof.deactivate(stop.reason, stop.result);
    }
    this.bridge.send(next.plugins);
    this.bridge.send(next.presentation);
  }

  /** Shows the rest surface or the activation, whichever the policy says now. */
  private applyRest(): void {
    if (this.restTimer) clearTimeout(this.restTimer);
    const decision = decideRest(this.active?.policy, Date.now());
    this.activeHoursState = decision.state;
    const was = this.state.resting;
    this.state.resting = decision.resting;
    if (decision.resting && !was) {
      // Nothing plays while the screen rests: end what was counted, show the
      // configured surface, and let the display sleep.
      const stop = stopForState("sleep");
      this.activity?.proof.deactivate(stop.reason, stop.result);
      this.bridge.send({
        type: "presentation",
        presentation: decision.presentation,
      });
      void this.display.setAwakeWanted(false);
    } else if (!decision.resting && was) {
      void this.display.setAwakeWanted(true);
      if (this.active) this.publish(this.active);
      else this.surface("connecting");
    }
    if (decision.reevaluateInMs !== null) {
      this.restTimer = setTimeout(
        () => this.applyRest(),
        Math.min(Math.max(decision.reevaluateInMs, 1_000), REST_RECHECK_MS),
      );
    }
    this.updateStartControl();
  }

  // ----------------------------------------------------------------- startup

  /**
   * Online and offline start share these steps. The Runtime starts and the
   * last committed activation is revalidated before the network is consulted,
   * so a server outage never prevents playback.
   */
  async run(): Promise<void> {
    (globalThis as Record<string, unknown>).tilecastRuntimeHost =
      this.bridge.host;
    const cleanMedia = installMediaAuthorization(
      this.database,
      () => this.active,
      // Local media is served for any activation this page authorized, with
      // or without the server. The server revokes it by saying so.
      () => this.state.localActivationAuthorized,
    );
    this.surface("connecting");
    this.files = await OPFSFiles.open();
    this.index = new IndexedObjects(this.database);
    this.mountStartControl();
    addEventListener("pagehide", () => this.onPageHide(), { once: true });
    try {
      const [shell] = await Promise.all([
        registerShell().then((value) => {
          loadRuntime();
          return value;
        }),
        this.restoreAtStartup(),
      ]);
      this.registration = shell;
      await this.readiness;
      this.memory.generation = this.active?.generation ?? 0;
      this.memory.clockOffsetMs = this.active?.policy?.clockOffsetMs ?? 0;
      // A restored activation is shown only if the policy allows it now.
      this.applyRest();
      if (this.active && !this.state.resting) this.publish(this.active);
      void this.refreshStorage(true);
      this.listenForWakes();
      await this.loop();
    } catch {
      this.recovery = null;
      revokeLocalAuthority(this.state);
      this.surface(
        "unavailable",
        "Browser Player could not start",
        "Reload this Browser Player to reconnect.",
      );
      await this.untilStopped();
    } finally {
      if (this.restTimer) clearTimeout(this.restTimer);
      cleanMedia();
      this.startControl?.remove();
      this.display.dispose();
      this.database.close();
      // Waiting workers activate naturally when all old pages close, or while
      // the screen rests. This Host never forces one during playback.
    }
  }

  private async restoreAtStartup(): Promise<void> {
    const slot = this.identity.slotId;
    if (slot) await this.openActivity(slot);
    const restored = await this.exclusively(() =>
      restoreLocalActivation(
        this.database,
        new VerifiedStore(
          this.index,
          this.files,
          Number.MAX_SAFE_INTEGER,
          Date.now,
          { session: this.session },
        ),
        this.identity,
      ),
    );
    if (restored) {
      this.active = restored;
      this.state.localActivationAuthorized = true;
    }
  }

  private exclusively<T>(run: () => Promise<T>): Promise<T> {
    return navigator.locks.request("tilecast-player-cas", run);
  }

  private async openActivity(slotId: string): Promise<void> {
    if (this.activity?.outbox.slotId === slotId) return;
    const start = performance.now();
    this.activity = await ActivityEngine.open(
      this.database,
      slotId,
      {
        wallNow: () => Date.now(),
        monotonicNow: () => performance.now() - start,
        offsetMs: () => this.memory.clockOffsetMs,
      },
      {
        eligible: () => proofEligible(this.state),
        // A write the browser refuses must be visible, not silent.
        onStorageError: (error) =>
          console.error("Browser Player could not store Activity", error),
      },
    );
    this.commands = new CommandRunner(
      this.api,
      new CommandStore(this.database, slotId),
      browserCommandHandlers({
        syncNow: () => this.syncNow(),
        reloadPlayback: async () => this.reloadPlayback(),
        retryItem: () => this.retryItem(),
        skipItem: () => this.skipItem(),
        identify: (seconds) => this.identify(seconds),
      }),
    );
  }

  // --------------------------------------------------------------- operations

  private async syncNow(): Promise<void> {
    if (!this.link) throw new Error("This Browser Player is not connected.");
    await this.reconcile(this.link.server, this.link.bound);
  }

  private reloadPlayback(): boolean {
    if (
      !this.active ||
      this.state.resting ||
      !this.state.localActivationAuthorized
    )
      return false;
    this.publish(this.active, "recovery_action");
    return true;
  }

  private retryItem(): boolean {
    if (!this.canPlay()) return false;
    this.bridge.send({ type: "command", command: "retry-item" });
    return true;
  }

  private skipItem(): boolean {
    if (!this.canPlay()) return false;
    this.activity?.proof.skipRequested();
    this.bridge.send({ type: "command", command: "skip-item" });
    return true;
  }

  private identify(durationSeconds: number): boolean {
    if (!this.ready) return false;
    this.bridge.send({
      type: "identify",
      name: this.screenName(),
      durationSeconds,
    });
    return true;
  }

  private canPlay(): boolean {
    return (
      this.active !== undefined &&
      this.state.runtimeActivationAccepted &&
      !this.state.resting &&
      this.active.presentation.presentation.state === "playing"
    );
  }

  // --------------------------------------------------------------- the cycle

  private listenForWakes(): void {
    const signal = this.abort.signal;
    const wakeNow = () => this.wake.dispatchEvent(new Event("wake"));
    const visibility = () => {
      this.state.visible = !document.hidden;
      requireReconfirmation(this.state);
      this.activity?.proof.sync();
      this.updateStartControl();
      // Report a page that is going to the background before the browser
      // slows it down, and reconcile as soon as it is visible again.
      wakeNow();
    };
    addEventListener("online", wakeNow, { signal });
    document.addEventListener("visibilitychange", visibility, { signal });
    document.addEventListener(
      "freeze",
      () => {
        this.state.frozen = true;
        requireReconfirmation(this.state);
        this.activity?.proof.sync();
      },
      { signal },
    );
    document.addEventListener(
      "resume",
      () => {
        this.state.frozen = false;
        // A page that was frozen may have slept: nothing it measured since
        // its last timer can be trusted until it is re-anchored.
        markClockDiscontinuity(this.state);
        this.activity?.proof.sync();
        wakeNow();
      },
      { signal },
    );
    window.addEventListener(
      "pageshow",
      (event: PageTransitionEvent) => {
        if (event.persisted) {
          markClockDiscontinuity(this.state);
          this.activity?.proof.sync();
          wakeNow();
        }
      },
      { signal },
    );
    this.display.subscribe(() => this.updateStartControl());
  }

  private async loop(): Promise<void> {
    let sample = { wallMs: Date.now(), monotonicMs: performance.now() };
    let backoff = POLL_MS;
    while (!this.abort.signal.aborted) {
      const now = { wallMs: Date.now(), monotonicMs: performance.now() };
      if (clockDiscontinuity(sample, now)) {
        markClockDiscontinuity(this.state);
        this.activity?.proof.sync();
      }
      sample = now;
      try {
        await this.cycle();
        backoff = POLL_MS;
      } catch (error) {
        if (this.abort.signal.aborted) break;
        const outcome = await this.onCycleError(error, backoff);
        if (outcome === "end") break;
        backoff = outcome;
      }
      try {
        await waitForPoll(this.wake, backoff, this.abort.signal);
      } catch {
        break;
      }
    }
    // Keep the slot lock while disconnected so a second window cannot act.
    await this.untilStopped();
  }

  private untilStopped(): Promise<void> {
    if (this.abort.signal.aborted) return Promise.resolve();
    return new Promise<void>((resolve) =>
      this.abort.signal.addEventListener("abort", () => resolve(), {
        once: true,
      }),
    );
  }

  /** One pass: confirm the server, reconcile, report, run commands, upload. */
  private async cycle(): Promise<void> {
    const server = await fetchServerIdentity(this.api);
    assertSameServer(this.identity, server);
    const authenticated = await authenticate(
      this.api,
      this.database,
      server,
      this.identity,
      this.identitySlot,
      this.recovery,
      this.metadata(),
      this.bridge.send,
      this.abort.signal,
    );
    this.recovery = null;
    this.identity = authenticated.identity;
    const bound = authenticated.session;
    await this.openActivity(bound.slotId);
    if (
      this.active &&
      (this.active.bindingId !== bound.bindingId ||
        this.active.serverInstallationId !== server.installationId)
    ) {
      // A different binding must never inherit this one's content.
      await discardActivation(this.database, this.active.slotId);
      this.active = undefined;
      revokeLocalAuthority(this.state);
      this.memory.key = "";
      this.activity?.proof.deactivate("manifest_replacement");
      this.surface("connecting");
    }
    this.state.serverBindingConfirmed = true;
    this.link = { server, bound };
    if (foregroundEligible(this.state)) {
      await this.reconcile(server, bound);
    }
    await this.refreshStorage();
    await this.refreshShellVersion();
    await this.heartbeat();
    // Commands and Activity follow the heartbeat, so an operator sees the
    // Player's current state before its answer.
    await this.commands?.poll();
    await this.activity?.flush(
      this.api,
      () =>
        this.state.serverBindingConfirmed &&
        this.link?.bound.bindingId === bound.bindingId,
    );
    await this.display.maintain();
    await this.finishUpdate();
  }

  private async reconcile(
    server: { installationId: string },
    bound: BrowserSession,
  ): Promise<void> {
    await this.verifyActivation();
    this.preparing = true;
    try {
      const result = await reconcileSelection(
        {
          api: this.api,
          database: this.database,
          files: this.files,
          index: this.index,
          binding: {
            slotId: bound.slotId,
            bindingId: bound.bindingId,
            serverInstallationId: server.installationId,
          },
          support: () => this.ready?.support,
          signal: this.abort.signal,
          storeOptions: { session: this.session },
          exclusively: (run) => this.exclusively(run),
        },
        this.memory,
      );
      if (result.changed) {
        this.active = result.activation;
        this.state.localActivationAuthorized = true;
        if (!this.state.resting) this.publish(this.active);
      }
      markReconciled(this.state);
      this.lastSyncAtMs = this.correctedNow();
      // A fresh policy may move the rest boundary: evaluate it now.
      this.applyRest();
    } finally {
      this.preparing = false;
    }
  }

  /**
   * The browser may remove downloaded content under storage pressure. A
   * missing or resized object ends trust in the activation that needs it, and
   * the next reconciliation prepares it again.
   */
  private async verifyActivation(): Promise<void> {
    const active = this.active;
    if (!active || Date.now() - this.integrityCheckedAt < INTEGRITY_CHECK_MS)
      return;
    this.integrityCheckedAt = Date.now();
    const intact = await this.exclusively(async () => {
      const store = new VerifiedStore(
        this.index,
        this.files,
        Number.MAX_SAFE_INTEGER,
        Date.now,
        { session: this.session },
      );
      for (const resource of active.resources) {
        if (!(await store.trusted(resource))) return false;
      }
      return true;
    });
    if (!intact) {
      this.state.localActivationAuthorized = false;
      this.memory.key = "";
      this.activity?.proof.sync();
    }
  }

  private offlineContent(): OfflineContent {
    if (
      this.preparing ||
      (this.active && !this.state.localActivationAuthorized)
    )
      return "repairing";
    return this.active && this.state.localActivationAuthorized
      ? "ready"
      : "not_prepared";
  }

  private async refreshShellVersion(): Promise<void> {
    if (this.shellVersion) return;
    this.shellVersion = await controllingShellVersion(
      navigator.serviceWorker.controller,
    );
  }

  private async refreshStorage(force = false): Promise<void> {
    if (!force && Date.now() - this.storageReadAt < STORAGE_REFRESH_MS) return;
    this.storageReadAt = Date.now();
    this.storage = await storageFacts(navigator.storage, force);
  }

  private async heartbeat(): Promise<void> {
    const plan = this.memory.plan;
    const display = this.display.facts();
    const iso = (ms: number | undefined) =>
      ms === undefined ? undefined : new Date(ms).toISOString();
    const playing =
      meaningfulEvidence(this.state) &&
      this.active?.presentation.presentation.state === "playing";
    await this.api.request(
      "/api/v1/player/heartbeat",
      heartbeatPayload({
        screenWidth: innerWidth,
        screenHeight: innerHeight,
        hostVersion: __HOST_VERSION__,
        uptimeSeconds: performance.now() / 1000,
        ...(this.currentItemId ? { currentItemId: this.currentItemId } : {}),
        playing,
        resting: this.state.resting,
        support: this.ready?.support,
        selection: plan?.selection,
        manifestVersion: this.memory.manifestVersion,
        configRevision: this.memory.configRevision,
        lastPlaybackError:
          this.lastPlaybackError ??
          plan?.compatibility.failures
            .map((failure) => failure.component)
            .join(", "),
        reliability: {
          foregroundState: foregroundStateOf(this.state),
          immersiveModeActive: display.unattendedPresentation,
          keepScreenOn: display.wakeLock === "active",
          activeHoursState: this.activeHoursState,
          cachedFallbackAvailable:
            this.active !== undefined && this.state.localActivationAuthorized,
          ...(iso(this.lastHealthyAtMs)
            ? { lastHealthyPlaybackAt: iso(this.lastHealthyAtMs) }
            : {}),
          ...(iso(this.lastSyncAtMs)
            ? { lastSuccessfulSyncAt: iso(this.lastSyncAtMs) }
            : {}),
          lastServerConnectionAt: new Date(this.correctedNow()).toISOString(),
          ...(this.storage?.availableBytes !== undefined
            ? { availableStorageBytes: this.storage.availableBytes }
            : {}),
          deviceClockOffsetSeconds: this.memory.clockOffsetMs / 1000,
          browser: browserStatus({
            browser: this.browser,
            display,
            storage: this.storage,
            offlineContent: this.offlineContent(),
            serviceWorker: serviceWorkerStatus(
              this.registration,
              navigator.serviceWorker.controller !== null,
            ),
            hostVersion: this.shellVersion ?? __HOST_VERSION__,
            wasDiscarded:
              (document as { wasDiscarded?: boolean }).wasDiscarded === true,
          }),
        },
      }),
    );
  }

  /**
   * A waiting Host update is taken only while the screen rests outside active
   * hours, never during playback. It then reloads, so the new Host and the
   * Runtime it names start together.
   */
  private async finishUpdate(): Promise<void> {
    const waiting = this.registration?.waiting;
    if (!waiting || !this.state.resting || this.updateRequested) return;
    this.updateRequested = true;
    navigator.serviceWorker.addEventListener(
      "controllerchange",
      () => location.reload(),
      { once: true },
    );
    waiting.postMessage({ type: "skip-waiting" });
  }

  // ------------------------------------------------------------------ errors

  /** Returns the next backoff, or `"end"` when this page must stop. */
  private async onCycleError(
    error: unknown,
    backoff: number,
  ): Promise<number | "end"> {
    // The server may be down; the last verified activation continues. While
    // it is, nothing counts as confirmed against the server.
    requireReconfirmation(this.state);
    if (serverUnreachable(error)) {
      if (!this.active)
        this.surface(
          "connecting",
          "Waiting for the Tilecast server",
          "This Browser Player will connect when the server is available.",
        );
      return Math.min(
        MAX_BACKOFF_MS,
        backoff === POLL_MS ? UNREACHABLE_FIRST_MS : backoff * 2,
      );
    }
    if (
      error instanceof IdentityMismatch ||
      (error instanceof PlayerAPIError && [401, 403].includes(error.status))
    ) {
      // The server said this binding is revoked, replaced, disabled or is a
      // different installation. Local content is no longer trusted.
      revokeLocalAuthority(this.state);
      const disabled = error instanceof PlayerAPIError && error.status === 403;
      if (!disabled && this.active) {
        await discardActivation(this.database, this.active.slotId);
        this.active = undefined;
      }
      if (!disabled) await this.activity?.discard();
      this.memory.key = "";
      this.surface(
        disabled ? "disabled" : "unavailable",
        disabled ? undefined : "Browser Player disconnected",
        disabled
          ? undefined
          : error instanceof IdentityMismatch
            ? error.message
            : "The administrator changed this Player's authorization. Open a current launch link to reconnect.",
      );
      return disabled ? MAX_BACKOFF_MS : "end";
    }
    if (error instanceof PairingEnded) {
      this.surface("unavailable", "Pairing ended", error.message);
      return "end";
    }
    this.lastPlaybackError =
      error instanceof Error ? error.message : "Reconcile failed";
    return Math.min(MAX_BACKOFF_MS, backoff * 2);
  }

  private onPageHide(): void {
    this.activity?.proof.shutdown("process_exit");
    this.abort.abort();
  }

  // ----------------------------------------------------------- device identity

  private metadata(): DeviceMetadata {
    const family = this.browser.browserName;
    return {
      playerInstallationId: this.identity.installationId,
      platform: "browser",
      manufacturer: "Browser",
      model:
        family === "edge"
          ? "Edge"
          : family === "chrome"
            ? "Chrome"
            : "Chromium",
      androidVersion: "Not applicable",
      playerVersion: __HOST_VERSION__,
      screenWidth: Math.max(1, innerWidth),
      screenHeight: Math.max(1, innerHeight),
      density: devicePixelRatio,
      locale: navigator.language,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    };
  }

  // ------------------------------------------------------------ operator control

  /**
   * One control, shown only while an operator action can still fix something:
   * audible playback, or a presentation without browser chrome. It is not
   * shown forever, and it never repeats a request that needs a gesture.
   */
  private mountStartControl(): void {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "player-start";
    Object.assign(button.style, {
      position: "fixed",
      right: "24px",
      bottom: "24px",
      zIndex: "2147483647",
      padding: "14px 22px",
      border: "1px solid rgba(255,255,255,0.35)",
      borderRadius: "8px",
      background: "rgba(17,24,39,0.92)",
      color: "#f5f7fa",
      font: "600 16px system-ui, sans-serif",
      cursor: "pointer",
    });
    button.addEventListener("click", () => {
      this.everStarted = true;
      void this.display.start().then(async () => {
        await requestManagedStorage(this.database);
        await this.refreshStorage(true);
        this.updateStartControl();
      });
    });
    document.body.append(button);
    this.startControl = button;
    this.updateStartControl();
  }

  private updateStartControl(): void {
    const button = this.startControl;
    if (!button) return;
    // A resting screen shows nothing but its rest surface.
    const label = this.state.resting
      ? null
      : startControlLabel(this.display.operatorNeeds(), this.everStarted);
    button.hidden = label === null;
    if (label !== null) button.textContent = label;
  }
}

/** The message a page shows when it cannot run a Browser Player at all. */
export function compatibilityProblem(message: string): void {
  const main = document.createElement("main");
  const title = document.createElement("h1");
  title.textContent = "Tilecast Browser Player";
  const copy = document.createElement("p");
  copy.textContent = message;
  main.append(title, copy);
  document.body.replaceChildren(main);
}

/**
 * Waits for the next poll: the interval, an early wake, or abort. The wake
 * listener is removed on every exit path. A timeout that wins would otherwise
 * leave one callback behind per poll until the next wake event.
 */
export async function waitForPoll(
  wake: EventTarget,
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  const waiter = new AbortController();
  const stop = () => waiter.abort(signal.reason);
  signal.addEventListener("abort", stop, { once: true });
  try {
    await Promise.race([
      pause(milliseconds, waiter.signal),
      new Promise<void>((resolve) =>
        wake.addEventListener("wake", () => resolve(), {
          once: true,
          signal: waiter.signal,
        }),
      ),
    ]);
  } finally {
    signal.removeEventListener("abort", stop);
    waiter.abort();
  }
}
