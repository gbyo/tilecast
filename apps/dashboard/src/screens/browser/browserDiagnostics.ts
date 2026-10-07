import type { ReliabilityStatus } from "../../api/types";

/**
 * What Studio says about a Browser Player, as structured values. The words
 * belong to the component, which renders each `key` through i18n. This module
 * decides nothing a server did not already measure: it arranges reported
 * facts, and sorts the ones that need attention by how much they matter.
 *
 * - `info`: how this kind of Player works. Not a problem.
 * - `setup`: a recommended setting. Playback works today and could be more
 *   reliable.
 * - `degraded`: what viewers see is, or may be, affected now.
 */
export type FindingSeverity = "info" | "setup" | "degraded";

export interface Finding {
  id: string;
  severity: FindingSeverity;
}

export type FactTone = "ok" | "attention" | "muted";

export interface Fact {
  id: string;
  /** An i18n key under `screens:browser.diagnostics`. */
  value: string;
  params?: Record<string, string | number>;
  tone: FactTone;
}

export interface BrowserDiagnosticsInput {
  reliability: ReliabilityStatus | undefined;
  /** The computed Screen status: online, recent, stale, offline, ... */
  screenStatus: string;
  playbackState?: string;
  lastPlaybackError?: string;
  recoveryEnabled?: boolean;
  /** How long a Player may go without confirmed playback before it matters. */
  quietPlaybackMinutes?: number;
  now?: number;
}

const BYTE = 1;
export const MIB = 1024 * 1024 * BYTE;

const resting = (input: BrowserDiagnosticsInput) =>
  input.reliability?.activeHoursState === "off_hours" ||
  input.playbackState === "sleep";

export function browserFacts(
  input: BrowserDiagnosticsInput,
  format: { bytes(value: number): string },
): Fact[] {
  const reliability = input.reliability;
  const browser = reliability?.browser ?? undefined;
  const facts: Fact[] = [];
  const add = (fact: Fact) => facts.push(fact);

  add(
    browser?.browserName
      ? {
          id: "browser",
          value: `names.${browser.browserName}`,
          params: { version: browser.browserMajorVersion ?? 0 },
          tone: "ok",
        }
      : { id: "browser", value: "notReported", tone: "muted" },
  );
  add(
    browser?.displayMode
      ? {
          id: "display",
          value: `displayMode.${browser.displayMode}`,
          tone: browser.displayMode === "standalone_pwa" ? "ok" : "attention",
        }
      : { id: "display", value: "notReported", tone: "muted" },
  );

  const foreground = reliability?.foregroundState;
  add(
    foreground
      ? {
          id: "playerState",
          value: `playerState.${["foreground", "background", "frozen", "recovering"].includes(foreground) ? foreground : "unknown"}`,
          tone: foreground === "foreground" ? "ok" : "attention",
        }
      : { id: "playerState", value: "notReported", tone: "muted" },
  );

  if (browser?.displayMode === "standalone_pwa") {
    add({ id: "fullscreen", value: "fullscreen.notRequired", tone: "ok" });
  } else if (browser?.fullscreenActive !== undefined) {
    add({
      id: "fullscreen",
      value: browser.fullscreenActive
        ? "fullscreen.active"
        : "fullscreen.inactive",
      tone: browser.fullscreenActive ? "ok" : "attention",
    });
  } else {
    add({ id: "fullscreen", value: "notReported", tone: "muted" });
  }

  const wake = browser?.wakeLock;
  add(
    !wake
      ? { id: "awake", value: "notReported", tone: "muted" }
      : wake === "active"
        ? { id: "awake", value: "awake.active", tone: "ok" }
        : wake === "unsupported"
          ? { id: "awake", value: "awake.unsupported", tone: "attention" }
          : resting(input) && wake === "released"
            ? { id: "awake", value: "awake.resting", tone: "muted" }
            : { id: "awake", value: "awake.needsAttention", tone: "attention" },
  );

  add(
    browser?.audioUnlocked === undefined
      ? { id: "sound", value: "notReported", tone: "muted" }
      : browser.audioUnlocked
        ? { id: "sound", value: "sound.allowed", tone: "ok" }
        : { id: "sound", value: "sound.needsInteraction", tone: "attention" },
  );

  const persistence = browser?.storagePersistence;
  const usage = browser?.storageUsageBytes;
  const quota = browser?.storageQuotaBytes;
  const measured =
    usage !== undefined && quota !== undefined
      ? { used: format.bytes(usage), quota: format.bytes(quota) }
      : undefined;
  add(
    !persistence || persistence === "unknown"
      ? { id: "storage", value: "notReported", tone: "muted" }
      : {
          id: "storage",
          value: `${persistence === "persistent" ? "storage.persistent" : "storage.bestEffort"}${measured ? "Measured" : ""}`,
          ...(measured ? { params: measured } : {}),
          tone: persistence === "persistent" ? "ok" : "attention",
        },
  );

  const offline = browser?.offlineContent;
  add(
    offline
      ? {
          id: "offline",
          value: `offline.${offline}`,
          tone: offline === "ready" ? "ok" : "attention",
        }
      : { id: "offline", value: "notReported", tone: "muted" },
  );

  const worker = browser?.serviceWorker;
  add(
    worker
      ? {
          id: "worker",
          value: `worker.${worker}`,
          tone: worker === "controlling" ? "ok" : "attention",
        }
      : { id: "worker", value: "notReported", tone: "muted" },
  );

  add(
    input.recoveryEnabled === undefined
      ? { id: "recovery", value: "notReported", tone: "muted" }
      : {
          id: "recovery",
          value: input.recoveryEnabled
            ? "recovery.enabled"
            : "recovery.disabled",
          tone: input.recoveryEnabled ? "ok" : "attention",
        },
  );
  add({ id: "updates", value: "updates.managed", tone: "ok" });
  return facts;
}

const ACTIVE_STATUSES = new Set(["online", "recent"]);

export function browserFindings(input: BrowserDiagnosticsInput): Finding[] {
  const reliability = input.reliability;
  const browser = reliability?.browser ?? undefined;
  if (!browser && !reliability?.foregroundState) return [];
  const findings: Finding[] = [];
  const add = (id: string, severity: FindingSeverity) =>
    findings.push({ id, severity });
  const reporting = ACTIVE_STATUSES.has(input.screenStatus);
  const restNow = resting(input);

  // What viewers see.
  const foreground = reliability?.foregroundState;
  if (foreground === "background") add("background", "degraded");
  if (foreground === "frozen") add("frozen", "degraded");
  if (browser?.offlineContent === "repairing") add("repairing", "degraded");
  if (browser?.offlineContent === "not_prepared" && reporting && !restNow)
    add("notPrepared", "degraded");
  if (input.lastPlaybackError && reporting) add("playbackError", "degraded");
  const quiet = (input.quietPlaybackMinutes ?? 5) * 60_000;
  const healthy = reliability?.lastHealthyPlaybackAt
    ? Date.parse(reliability.lastHealthyPlaybackAt)
    : undefined;
  if (
    reporting &&
    !restNow &&
    foreground === "foreground" &&
    input.playbackState === "playing" &&
    healthy !== undefined &&
    (input.now ?? Date.now()) - healthy > quiet
  )
    add("noProgress", "degraded");

  // Settings that would make an unattended display more reliable.
  if (browser?.displayMode === "browser_tab") add("tab", "setup");
  if (browser?.storagePersistence === "best_effort") add("bestEffort", "setup");
  if (
    browser?.displayMode === "browser_tab" &&
    browser.fullscreenActive === false
  )
    add("fullscreen", "setup");
  if (
    browser?.wakeLock &&
    browser.wakeLock !== "active" &&
    !(restNow && browser.wakeLock === "released")
  )
    add("wakeLock", "setup");
  if (browser?.audioUnlocked === false) add("sound", "setup");
  if (browser?.serviceWorker === "update_waiting")
    add("updateWaiting", "setup");

  // How a Browser Player works.
  if (browser?.displayMode === "standalone_pwa") add("installed", "info");
  add("watchLive", "info");
  const rank: Record<FindingSeverity, number> = {
    degraded: 0,
    setup: 1,
    info: 2,
  };
  return findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
}
