/**
 * The display privileges an unattended Browser Player needs: a screen that
 * stays awake, a presentation without browser chrome, and audio. Each is
 * tracked on its own, because each can be lost for its own reason:
 *
 * - the browser releases a wake lock when the page is hidden;
 * - the operator or the browser can leave fullscreen at any moment;
 * - audible playback needs a user gesture before it is allowed.
 *
 * The goal is an effective unattended presentation, not the Fullscreen API
 * for its own sake. An installed app already supplies one. The controller
 * never repeats a request that needs a gesture. It reports what is missing and
 * lets one operator action restore all of it.
 */

export type WakeLockState = "active" | "released" | "denied" | "unsupported";
export type DisplayMode = "browser_tab" | "standalone_pwa";

export interface DisplayFacts {
  displayMode: DisplayMode;
  fullscreenActive: boolean;
  wakeLock: WakeLockState;
  audioUnlocked: boolean;
  /** Fullscreen or an installed app: nothing of the browser shows. */
  unattendedPresentation: boolean;
}

export interface WakeLockSentinelLike {
  release(): Promise<void>;
  addEventListener(type: "release", listener: () => void): void;
}

/** The browser surface the controller reads and drives. */
export interface DisplayEnvironment {
  requestWakeLock?: () => Promise<WakeLockSentinelLike>;
  requestFullscreen(): Promise<void>;
  fullscreenActive(): boolean;
  /** True when the page runs as an installed app. */
  installedApp(): boolean;
  visible(): boolean;
  /** True once the user has interacted, which permits audible playback. */
  userActivated(): boolean;
  onFullscreenChange(listener: () => void): () => void;
  onVisibilityChange(listener: () => void): () => void;
}

export function browserDisplayEnvironment(): DisplayEnvironment {
  const standalone = [
    "standalone",
    "fullscreen",
    "minimal-ui",
    "window-controls-overlay",
  ];
  return {
    ...("wakeLock" in navigator
      ? { requestWakeLock: () => navigator.wakeLock.request("screen") }
      : {}),
    requestFullscreen: () => document.documentElement.requestFullscreen(),
    fullscreenActive: () => document.fullscreenElement !== null,
    installedApp: () =>
      // `fullscreen` also matches a tab in browser fullscreen, which is not an
      // install, so a fullscreen element rules that reading out.
      standalone.some(
        (mode) =>
          mode !== "fullscreen" &&
          matchMedia(`(display-mode: ${mode})`).matches,
      ) ||
      (matchMedia("(display-mode: fullscreen)").matches &&
        document.fullscreenElement === null),
    visible: () => document.visibilityState === "visible",
    userActivated: () => navigator.userActivation?.hasBeenActive === true,
    onFullscreenChange(listener) {
      document.addEventListener("fullscreenchange", listener);
      return () => document.removeEventListener("fullscreenchange", listener);
    },
    onVisibilityChange(listener) {
      document.addEventListener("visibilitychange", listener);
      return () => document.removeEventListener("visibilitychange", listener);
    },
  };
}

/** A denied wake lock is not asked again before this long. */
export const WAKE_LOCK_RETRY_MS = 30_000;

export class DisplayController {
  private wakeLock: WakeLockState;
  private sentinel: WakeLockSentinelLike | null = null;
  private awakeWanted = true;
  private acquiring = false;
  private lastDeniedAt: number | null = null;
  private readonly listeners = new Set<(facts: DisplayFacts) => void>();
  private readonly detach: (() => void)[] = [];

  constructor(
    private readonly env: DisplayEnvironment,
    private readonly now: () => number = Date.now,
  ) {
    this.wakeLock = env.requestWakeLock ? "released" : "unsupported";
    this.detach.push(
      env.onFullscreenChange(() => this.changed()),
      env.onVisibilityChange(() => {
        // The browser dropped any lock when the page was hidden. A visible
        // page asks for it again, which needs no gesture where it is allowed.
        void this.maintain();
        this.changed();
      }),
    );
  }

  facts(): DisplayFacts {
    const displayMode: DisplayMode = this.env.installedApp()
      ? "standalone_pwa"
      : "browser_tab";
    const fullscreenActive = this.env.fullscreenActive();
    return {
      displayMode,
      fullscreenActive,
      wakeLock: this.wakeLock,
      audioUnlocked: this.env.userActivated(),
      unattendedPresentation:
        displayMode === "standalone_pwa" || fullscreenActive,
    };
  }

  subscribe(listener: (facts: DisplayFacts) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * What one operator action can still fix. A wake lock is not listed: it
   * needs no gesture, and a denial is reported rather than prompted for.
   */
  operatorNeeds(): { audio: boolean; presentation: boolean } {
    const facts = this.facts();
    return {
      audio: !facts.audioUnlocked,
      presentation: !facts.unattendedPresentation,
    };
  }

  /** False while the Player rests outside active hours. */
  async setAwakeWanted(wanted: boolean): Promise<void> {
    this.awakeWanted = wanted;
    await this.maintain();
  }

  /**
   * One operator action attempts every privilege. Audio unlocks because the
   * click is a user activation. Fullscreen is skipped when the install already
   * provides it, and a refusal leaves the Player running.
   */
  async start(): Promise<DisplayFacts> {
    if (!this.facts().unattendedPresentation) {
      await this.env.requestFullscreen().catch(() => undefined);
    }
    await this.maintain();
    this.changed();
    return this.facts();
  }

  /** Called on every Host cycle. Holds or releases the wake lock as wanted. */
  async maintain(): Promise<void> {
    if (!this.env.requestWakeLock) return;
    if (!this.awakeWanted) {
      await this.release();
      return;
    }
    if (this.sentinel || this.acquiring || !this.env.visible()) return;
    if (
      this.lastDeniedAt !== null &&
      this.now() - this.lastDeniedAt < WAKE_LOCK_RETRY_MS
    ) {
      return;
    }
    this.acquiring = true;
    try {
      const sentinel = await this.env.requestWakeLock();
      this.sentinel = sentinel;
      this.wakeLock = "active";
      this.lastDeniedAt = null;
      // Never assume a granted lock lasts. The browser says when it ends it.
      sentinel.addEventListener("release", () => {
        if (this.sentinel === sentinel) this.sentinel = null;
        this.wakeLock = "released";
        this.changed();
        if (this.awakeWanted && this.env.visible()) void this.maintain();
      });
    } catch {
      this.wakeLock = "denied";
      this.lastDeniedAt = this.now();
    } finally {
      this.acquiring = false;
      this.changed();
    }
  }

  async release(): Promise<void> {
    const sentinel = this.sentinel;
    this.sentinel = null;
    if (sentinel) await sentinel.release().catch(() => undefined);
    if (this.wakeLock === "active") this.wakeLock = "released";
    this.changed();
  }

  dispose(): void {
    for (const detach of this.detach) detach();
    void this.release();
    this.listeners.clear();
  }

  private changed(): void {
    const facts = this.facts();
    for (const listener of this.listeners) listener(facts);
  }
}

/** What the single operator control says, from what is still missing. */
export function startControlLabel(
  needs: { audio: boolean; presentation: boolean },
  everStarted: boolean,
): string | null {
  if (!needs.audio && !needs.presentation) return null;
  if (!everStarted) return "Start player";
  return needs.presentation ? "Enter fullscreen" : "Enable sound";
}
