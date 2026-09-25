/**
 * COMPATIBILITY CODE. The built-in plugin surfaces (Countdown Bar, Emergency
 * Alerts ticker, Noise Meter, Brand Bug) — the Electron renderer's plugin
 * channel, moved unchanged in behavior and split into a DOM-free controller
 * and a Lit view.
 *
 * This channel never touches playback: a bar can appear, tick, change mode and
 * disappear while the same media element or Layout stays mounted.
 *
 * The bottom strip holds one bar and three surfaces can want it. An emergency
 * ticker takes it whenever one is active; a room that is too loud comes next;
 * the countdown last. Nothing is lost by losing the strip — each surface keeps
 * resolving itself and returns the moment the one above it stops.
 */
import type { NoiseMeterSource, RuntimePluginV1 } from "../../host/contract";
import {
  TimerGroup,
  type RuntimeClock,
  type TimerHandle,
} from "../../clock/scheduler";
import {
  tilecastAlertTicker,
  type TilecastActiveAlertTicker,
} from "./alert-ticker-resolver";
import {
  tilecastBrandBug,
  type TilecastActiveBrandBug,
  type TilecastBrandBugPlugin,
} from "./brand-bug-resolver";
import {
  tilecastCountdownBar,
  type TilecastActiveCountdownBar,
  type TilecastManifestPluginEntry,
} from "./countdown-bar-resolver";
import {
  tilecastNoiseMeter,
  type TilecastNoiseHistoryAggregator,
  type TilecastNoiseHistoryBucket,
  type TilecastNoiseMeterCapture,
  type TilecastNoiseMeterMachine,
  type TilecastNoiseMeterReading,
  type TilecastNoiseMeterSettings,
} from "./noise-meter";

export const PLUGIN_TICK_MS = 1_000;
export const CONFETTI_MS = 11_500;

export interface OverlayModel {
  /** Which surface holds the bottom strip. */
  strip: "alert_ticker" | "noise_meter" | "countdown_bar" | null;
  ticker: TilecastActiveAlertTicker | null;
  noiseMeter: TilecastNoiseMeterSettings | null;
  countdown: TilecastActiveCountdownBar | null;
  /** Height of the strip that is showing, or null when none shows. */
  stripHeightPx: number | null;
  /** Whether the strip pushes content up rather than overlaying it. */
  push: boolean;
  marks: TilecastActiveBrandBug[];
  /** Bottom-corner marks ride above whatever holds the strip. */
  markLiftPx: number;
  /** A completion burst in flight, keyed by instance and target. */
  confettiKey: string | null;
}

export interface OverlayReports {
  noiseMeter(report: {
    status: string;
    level?: number | null;
    bucket?: TilecastNoiseHistoryBucket | null;
  }): void;
  noiseDiagnostic(message: string, detail?: Record<string, unknown>): void;
}

export interface OverlayOptions {
  clock: RuntimeClock;
  noiseSource: NoiseMeterSource | null;
  reports: OverlayReports;
  reducedMotion: () => boolean;
}

const EMPTY: OverlayModel = {
  strip: null,
  ticker: null,
  noiseMeter: null,
  countdown: null,
  stripHeightPx: null,
  push: false,
  marks: [],
  markLiftPx: 0,
  confettiKey: null,
};

export class PluginOverlayController {
  private plugins: RuntimePluginV1[] = [];
  private clockOffsetMs = 0;
  private tick: TimerHandle | null = null;
  private readonly timers: TimerGroup;
  private model: OverlayModel = EMPTY;
  private readonly listeners = new Set<(model: OverlayModel) => void>();
  private readonly levelListeners = new Set<(level: number) => void>();
  private lastConfettiKey = "";
  private confettiKey: string | null = null;
  private confettiTimer: TimerHandle | null = null;

  // Noise Meter state, torn down when no instance applies.
  private noiseSettings: TilecastNoiseMeterSettings | null = null;
  private noiseMachine: TilecastNoiseMeterMachine | null = null;
  private noiseCapture: { stop(): void } | null = null;
  private readonly smoother = tilecastNoiseMeter.createSmoother();
  private reading: TilecastNoiseMeterReading = {
    state: "unavailable",
    visible: false,
    level: 0,
  };
  private history: TilecastNoiseHistoryAggregator | null = null;
  /** `sleep` is the player's own off-hours state; the meter follows it. */
  private awake = true;
  private windowWasOpen = true;
  private lastReportedStatus = "";

  constructor(private readonly options: OverlayOptions) {
    this.timers = new TimerGroup(options.clock);
  }

  subscribe(listener: (model: OverlayModel) => void): () => void {
    this.listeners.add(listener);
    listener(this.model);
    return () => this.listeners.delete(listener);
  }

  /** The meter's marker moves at the sampling rate, outside the model. */
  onNoiseLevel(listener: (level: number) => void): () => void {
    this.levelListeners.add(listener);
    return () => this.levelListeners.delete(listener);
  }

  setPlugins(plugins: RuntimePluginV1[], clockOffsetMs: number): void {
    this.plugins = Array.isArray(plugins) ? plugins : [];
    this.clockOffsetMs = Number.isFinite(clockOffsetMs) ? clockOffsetMs : 0;
    // The meter owns hardware, so it is reconciled before the surface is
    // drawn: an instance that went away has to release the microphone.
    this.syncNoiseMeter();
    this.update();
    this.tick?.cancel();
    this.tick = this.timers.every(PLUGIN_TICK_MS, () => this.update());
  }

  setAwake(awake: boolean): void {
    if (awake === this.awake) return;
    this.awake = awake;
    this.applyNoiseLifecycle();
  }

  /** Host-measured level (the `host-levels` source). Never audio. */
  hostNoiseLevel(rms: number | null): void {
    if (this.options.noiseSource !== "host-levels") return;
    if (!this.noiseCapture) return;
    this.onNoiseSample(
      rms === null || !Number.isFinite(rms)
        ? null
        : Math.min(Math.max(rms, 0), 1),
    );
  }

  get current(): OverlayModel {
    return this.model;
  }

  stop(): void {
    this.timers.cancelAll();
    this.noiseCapture?.stop();
    this.noiseCapture = null;
  }

  // ------------------------------------------------------------ surfaces

  private update(): void {
    const localNow = new Date(this.options.clock.wallNow());
    const offset = this.clockOffsetMs;
    const entries = this.plugins as unknown as TilecastManifestPluginEntry[];
    const marks = tilecastBrandBug.resolve(
      this.plugins.filter(
        (plugin) => plugin.type === "brand_bug",
      ) as unknown as TilecastBrandBugPlugin[],
      localNow,
      offset,
    );
    const ticker = tilecastAlertTicker.resolve(entries, localNow, offset);
    const windowOpen = this.noiseWindowOpen(localNow);
    if (this.noiseSettings !== null && windowOpen !== this.windowWasOpen) {
      // Set first: applying the lifecycle re-enters this function, and the
      // second pass must see the state it is reconciling to.
      this.windowWasOpen = windowOpen;
      this.applyNoiseLifecycle();
      return;
    }
    this.windowWasOpen = windowOpen;
    const meter =
      this.reading.visible && windowOpen ? this.noiseSettings : null;
    const owner = tilecastNoiseMeter.stripOwner({
      alertTicker: ticker !== null,
      noiseMeter: meter !== null,
      countdownBar: true,
    });

    if (ticker) {
      this.publish({
        ...EMPTY,
        strip: "alert_ticker",
        ticker,
        stripHeightPx: ticker.heightPx,
        push: ticker.displayMode === "push",
        marks,
        markLiftPx: ticker.heightPx,
        confettiKey: this.confettiKey,
      });
      return;
    }
    if (owner === "noise_meter" && meter) {
      this.publish({
        ...EMPTY,
        strip: "noise_meter",
        noiseMeter: meter,
        stripHeightPx: meter.heightPx,
        push: meter.displayMode === "push",
        marks,
        markLiftPx: meter.heightPx,
        confettiKey: this.confettiKey,
      });
      return;
    }
    const selected = tilecastCountdownBar.resolve(entries, localNow, offset);
    // A completed instance stops holding the strip but still owes its burst.
    this.triggerConfetti(selected);
    const showBar = selected?.showBar === true;
    this.publish({
      ...EMPTY,
      strip: showBar ? "countdown_bar" : null,
      countdown: showBar ? selected : null,
      stripHeightPx: showBar ? selected!.heightPx : null,
      push: showBar && selected!.displayMode === "push",
      marks,
      markLiftPx: showBar ? selected!.heightPx : 0,
      confettiKey: this.confettiKey,
    });
  }

  private triggerConfetti(selected: TilecastActiveCountdownBar | null): void {
    if (!selected?.showConfetti) return;
    const key = `${selected.id}:${selected.targetAt}`;
    if (key === this.lastConfettiKey) return;
    this.lastConfettiKey = key;
    this.confettiTimer?.cancel();
    this.confettiKey = this.options.reducedMotion() ? null : key;
    this.confettiTimer = this.timers.after(CONFETTI_MS, () => {
      if (this.lastConfettiKey === key) {
        this.confettiKey = null;
        this.update();
      }
    });
  }

  private publish(model: OverlayModel): void {
    this.model = model;
    for (const listener of this.listeners) listener(model);
  }

  // ------------------------------------------------------------ noise meter

  private syncNoiseMeter(): void {
    const settings = tilecastNoiseMeter.resolve(
      this.plugins as unknown as TilecastManifestPluginEntry[],
    );
    if (
      settings === null &&
      this.noiseSettings === null &&
      !this.noiseCapture
    ) {
      return;
    }
    const same =
      settings !== null &&
      this.noiseSettings !== null &&
      JSON.stringify(settings) === JSON.stringify(this.noiseSettings);
    if (same) return;
    this.noiseSettings = settings;
    // Thresholds changed: the hysteresis and the open aggregate restart,
    // because a bucket measured against two thresholds is not one measurement.
    this.noiseMachine = settings
      ? tilecastNoiseMeter.createStateMachine(settings)
      : null;
    this.applyNoiseLifecycle();
  }

  private noiseWindowOpen(localNow: Date): boolean {
    const settings = this.noiseSettings;
    if (!settings) return false;
    return tilecastNoiseMeter.scheduleOpen(
      settings,
      new Date(localNow.getTime() + this.clockOffsetMs),
    );
  }

  private historyWanted(): boolean {
    const settings = this.noiseSettings;
    if (!settings || !settings.historyEnabled) return false;
    return this.awake || !settings.historyActiveHoursOnly;
  }

  /**
   * Start or stop listening to match what is wanted now. When neither the
   * live bar nor history wants the microphone, the player genuinely stops
   * listening rather than measuring and discarding.
   */
  private applyNoiseLifecycle(): void {
    const settings = this.noiseSettings;
    const source = this.options.noiseSource;
    const wantsHistory = this.historyWanted();
    const wantsLive =
      settings !== null &&
      this.awake &&
      this.noiseWindowOpen(new Date(this.options.clock.wallNow()));
    if (!settings || !source || (!wantsHistory && !wantsLive)) {
      this.flushHistory();
      this.history = null;
      this.noiseCapture?.stop();
      this.noiseCapture = null;
      this.smoother.reset();
      this.reading = { state: "unavailable", visible: false, level: 0 };
      this.reportState("inactive", null);
      this.update();
      return;
    }
    if (wantsHistory) {
      this.history ??= tilecastNoiseMeter.createHistoryAggregator(settings);
    } else if (this.history) {
      this.flushHistory();
      this.history = null;
    }
    if (!this.noiseCapture) {
      this.noiseCapture = this.openCapture(source);
    }
    this.update();
  }

  private openCapture(source: NoiseMeterSource): { stop(): void } {
    if (source === "host-levels") {
      // The host measures; levels arrive through hostNoiseLevel(). Saying
      // "active" is how the host learns to open its microphone, and the
      // "inactive" report on stop is how it learns to close it again.
      this.reportState("active", null);
      return { stop() {} };
    }
    const capture: TilecastNoiseMeterCapture = tilecastNoiseMeter.createCapture(
      {
        onLevel: (rms) => this.onNoiseSample(rms),
        // A microphone problem is a player diagnostic, not a playback error.
        onDiagnostic: (message, detail) =>
          this.options.reports.noiseDiagnostic(message, detail),
      },
    );
    capture.start();
    return capture;
  }

  private flushHistory(): void {
    const bucket = this.history?.flush() ?? null;
    if (bucket) {
      this.options.reports.noiseMeter({ status: this.noiseStatus(), bucket });
    }
  }

  private noiseStatus(): string {
    if (!this.noiseCapture) return "inactive";
    switch (this.reading.state) {
      case "unavailable":
        return "unavailable";
      case "loud":
      case "recovering":
        return "loud";
      default:
        return "normal";
    }
  }

  /**
   * Report on a state change and once per completed bucket — never at the
   * sampling rate.
   */
  private reportState(
    status: string,
    level: number | null,
    bucket: TilecastNoiseHistoryBucket | null = null,
  ): void {
    if (status === this.lastReportedStatus && bucket === null) return;
    this.lastReportedStatus = status;
    this.options.reports.noiseMeter({ status, level, bucket });
  }

  private onNoiseSample(rms: number | null): void {
    const settings = this.noiseSettings;
    const machine = this.noiseMachine;
    if (!settings || !machine) return;
    const at = this.options.clock.monotonicNow();
    const level =
      rms === null
        ? null
        : this.smoother.push(
            tilecastNoiseMeter.levelFromRms(rms, settings.sensitivity),
            at,
          );
    if (rms === null) this.smoother.reset();
    const previous = this.reading;
    this.reading = machine.update(level, at);
    // A trigger is counted where it happens: entering the loud state.
    const enteredLoud =
      this.reading.state === "loud" && previous.state !== "loud";
    if (this.history) {
      // Buckets sit on the fixed wall-clock grid, corrected by the same server
      // offset as the rest of the plugin surface.
      const bucket = this.history.push(
        level,
        this.options.clock.wallNow() + this.clockOffsetMs,
        enteredLoud,
      );
      if (bucket) {
        this.reportState(this.noiseStatus(), this.reading.level, bucket);
      }
    }
    this.reportState(this.noiseStatus(), this.reading.level);
    if (this.reading.visible !== previous.visible) {
      // Handing the strip over is worth doing now rather than on the next tick.
      this.update();
      return;
    }
    if (this.reading.visible) {
      for (const listener of this.levelListeners) listener(this.reading.level);
    }
  }
}

/** Deterministic confetti pieces for a burst key (same on every host). */
export function confettiPieces(key: string): {
  x: string;
  drift: string;
  spin: string;
  delay: string;
  duration: string;
  color: string;
  width: string;
  height: string;
  radius: string;
}[] {
  const colors = ["#F7C948", "#F45B69", "#4CC9F0", "#7BD389", "#A78BFA"];
  let seed = Array.from(key).reduce(
    (value, character) =>
      Math.imul(value ^ character.charCodeAt(0), 16_777_619) >>> 0,
    2_166_136_261,
  );
  const random = () => {
    seed = (Math.imul(seed, 1_664_525) + 1_013_904_223) >>> 0;
    return seed / 4_294_967_296;
  };
  const pieces = [];
  for (let index = 0; index < 220; index += 1) {
    pieces.push({
      x: `${random() * 100}%`,
      drift: `${random() * 28 - 14}vw`,
      spin: `${540 + random() * 1_080}deg`,
      delay: `${random() * 3.8}s`,
      duration: `${5 + random() * 2}s`,
      color: colors[index % colors.length] ?? "#F7C948",
      width: `${14 + random() * 14}px`,
      height: `${20 + random() * 20}px`,
      radius: random() > 0.75 ? "50%" : "2px",
    });
  }
  return pieces;
}
