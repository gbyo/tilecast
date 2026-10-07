import type { RuntimeReadyV1 } from "@tilecast/player-runtime/host-contract";
import type { SelectionFacts } from "@tilecast/player-runtime/projection";
import type { BrowserPlayerStatus } from "./diagnostics";
import type { ForegroundState } from "./lifecycle";

const UUID = /^[a-f0-9-]{36}$/;

export interface HeartbeatInputs {
  screenWidth: number;
  screenHeight: number;
  hostVersion: string;
  uptimeSeconds: number;
  currentItemId?: string;
  playing: boolean;
  /** The screen rests outside active hours. */
  resting?: boolean;
  support: RuntimeReadyV1["support"];
  selection?: SelectionFacts | null;
  manifestVersion?: number;
  configRevision?: number;
  lastPlaybackError?: string;
  /** The generic reliability facts a browser can measure. */
  reliability?: BrowserReliability;
}

/**
 * Generic reliability fields keep their cross-platform meaning. A Browser
 * Player reports them only where that meaning is true, and sends the facts
 * with no generic equivalent in the bounded `browser` section.
 */
export interface BrowserReliability {
  foregroundState: ForegroundState;
  /** Fullscreen or an installed app: the effective unattended presentation. */
  immersiveModeActive: boolean;
  /** The screen wake lock is held. */
  keepScreenOn: boolean;
  activeHoursState: "active" | "off_hours";
  /** A verified activation is stored and can play without the server. */
  cachedFallbackAvailable: boolean;
  /** Corrected ISO times. Never the device clock of an unanchored page. */
  lastHealthyPlaybackAt?: string;
  lastSuccessfulSyncAt?: string;
  lastServerConnectionAt?: string;
  availableStorageBytes?: number;
  cacheUsedBytes?: number;
  cacheLimitBytes?: number;
  deviceClockOffsetSeconds?: number;
  browser: BrowserPlayerStatus;
}

/**
 * The Browser Player heartbeat. Capability fields come from the live Runtime
 * report, never from this host's name, and selection fields repeat what the
 * server chose rather than anything this host derived.
 */
export function heartbeatPayload(input: HeartbeatInputs) {
  const selection = input.selection;
  return {
    screenWidth: Math.max(1, input.screenWidth),
    screenHeight: Math.max(1, input.screenHeight),
    playerVersion: input.hostVersion,
    playerFamily: "browser",
    ...(input.currentItemId && UUID.test(input.currentItemId)
      ? { currentItemId: input.currentItemId }
      : {}),
    playbackState: input.resting ? "sleep" : input.playing ? "playing" : "idle",
    presentationSchemaVersions: input.support?.presentationSchemas,
    // Both namespaces already use the contract's capability names, for example
    // `content.text` and `widget.tilecast.clock`. They are reported as given.
    nativePresentationCapabilities: {
      ...input.support?.declarativeCapabilities,
      ...input.support?.widgetComponents,
    },
    uptimeSeconds: Math.floor(input.uptimeSeconds),
    ...(input.manifestVersion !== undefined
      ? { activeManifestVersion: input.manifestVersion }
      : {}),
    ...(input.configRevision !== undefined
      ? { activeConfigRevision: input.configRevision }
      : {}),
    ...(selection
      ? {
          selectionSource: selection.source,
          ...(selection.playlistId && UUID.test(selection.playlistId)
            ? { currentPlaylistId: selection.playlistId }
            : {}),
          ...(selection.nextTransitionAt
            ? { nextTransitionAt: selection.nextTransitionAt }
            : {}),
        }
      : {}),
    ...(input.lastPlaybackError
      ? { lastPlaybackError: input.lastPlaybackError.slice(0, 500) }
      : {}),
    ...(input.reliability ? reliabilityFields(input.reliability) : {}),
  };
}

function reliabilityFields(reliability: BrowserReliability) {
  const count = (value: number | undefined) =>
    value !== undefined && Number.isFinite(value) && value >= 0
      ? Math.floor(value)
      : undefined;
  const optional = (name: string, value: unknown) =>
    value === undefined ? {} : { [name]: value };
  return {
    // A Browser Player has no safe mode. Saying so is also what makes the
    // server store the reliability facts below.
    safeMode: false,
    foregroundState: reliability.foregroundState,
    immersiveModeActive: reliability.immersiveModeActive,
    keepScreenOn: reliability.keepScreenOn,
    activeHoursState: reliability.activeHoursState,
    cachedFallbackAvailable: reliability.cachedFallbackAvailable,
    ...optional("lastHealthyPlaybackAt", reliability.lastHealthyPlaybackAt),
    ...optional("lastSuccessfulSyncAt", reliability.lastSuccessfulSyncAt),
    ...optional("lastServerConnectionAt", reliability.lastServerConnectionAt),
    ...optional(
      "availableStorageBytes",
      count(reliability.availableStorageBytes),
    ),
    ...optional("cacheUsedBytes", count(reliability.cacheUsedBytes)),
    ...optional("cacheLimitBytes", count(reliability.cacheLimitBytes)),
    ...optional(
      "deviceClockOffsetSeconds",
      reliability.deviceClockOffsetSeconds === undefined
        ? undefined
        : Math.round(reliability.deviceClockOffsetSeconds),
    ),
    browser: reliability.browser,
  };
}
