/**
 * TilecastRuntimeHostV1 — the one contract between the shared Tilecast Player
 * Runtime and the process that hosts it (the Electron player, the WPE
 * renderer, the conformance fixture host, and any future host).
 *
 * The host exposes exactly one object, `globalThis.tilecastRuntimeHost`, with
 * the members below. There is no generic message or native-invocation escape
 * hatch: every capability is a named, typed member, and optional members are
 * gated by `capabilities`, never by the host's name.
 *
 * Everything that crosses this boundary is data. The runtime never receives a
 * credential, a filesystem path, a server response or an executable. Media is
 * addressed only by URIs the host has already authorized (`tcmedia:`).
 *
 * This file has no runtime dependencies so hosts that run in Node (the Electron
 * main process and preload) can share the exact types.
 */

export const RUNTIME_HOST_CONTRACT_VERSION = 1 as const;

/** The global name a host publishes its implementation under. */
export const RUNTIME_HOST_GLOBAL = "tilecastRuntimeHost" as const;

// ------------------------------------------------------------ capabilities

/**
 * How remote web content can be shown. Remote content never runs inside the
 * trusted runtime document; each mechanism names an isolated surface the host
 * owns. `null` means websites and YouTube are not available on this host.
 */
export type RemoteWebMechanism =
  /** Electron `<webview>` in its own partitioned, sandboxed session. */
  | "electron-webview"
  /** A separate host-owned web view positioned by the runtime (WPE, M11). */
  | "host-view";

/** Where the Noise Meter's level readings come from, if anywhere. */
export type NoiseMeterSource =
  /** The runtime opens the microphone itself (Electron). */
  | "renderer-microphone"
  /** The host measures and sends derived levels only (WPE via PipeWire). */
  | "host-levels";

export interface RuntimeCapabilitiesV1 {
  /** Remote websites and YouTube, or `null` when they cannot be isolated. */
  readonly remoteWeb: RemoteWebMechanism | null;
  /** The host supplies shared-timeline anchors for synchronized groups. */
  readonly synchronizedPlayback: boolean;
  /** `setup.submitServerUrl` is available. */
  readonly setup: boolean;
  /** `discovery.list` and `discovered-server` messages are available. */
  readonly discovery: boolean;
  readonly noiseMeter: NoiseMeterSource | null;
}

/** Diagnostics only. Behavior must never branch on these values. */
export interface RuntimeHostInfoV1 {
  readonly host: string;
  readonly hostVersion: string;
  readonly engine: string;
  readonly engineVersion: string;
}

// ------------------------------------------------------------ presentations

/** Opaque identity of one activation; echoed back on every report. */
export interface ActivationRefV1 {
  readonly activationId: string;
  readonly generation: number;
}

export type FitMode = string;

export interface RuntimeViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  order: number;
  canvasWidth: number;
  canvasHeight: number;
}

export interface RuntimeWebsiteConfig {
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
}

/** Compatibility render tree (see compat/render-tree). */
export interface RenderNodeV1 {
  t: string;
  [key: string]: unknown;
}

export interface RuntimeWidgetPayload {
  background: string;
  root: RenderNodeV1;
  autoSkip?: boolean;
}

export interface RuntimeLayoutZonePlaylistItem {
  id: string;
  kind: "image" | "video";
  src: string;
  durationMs: number | null;
  fit: string;
  muted: boolean;
  volume: number;
  loop: boolean;
}

export interface RuntimeLayoutZone {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  opacity: number;
  radius?: number;
  render?: RenderNodeV1;
  image?: { src: string; fit: string };
  playlistItems?: RuntimeLayoutZonePlaylistItem[];
}

export interface RuntimeLayoutPayload {
  canvasWidth: number;
  canvasHeight: number;
  background: string;
  backgroundImage?: string;
  backgroundImageViewport?: {
    x: number;
    y: number;
    width: number;
    height: number;
    canvasWidth: number;
    canvasHeight: number;
  };
  zones: RuntimeLayoutZone[];
}

/**
 * A widget or layout item may arrive already projected (a render tree), or as
 * a reference that the runtime projects from `ProjectionContextV1`.
 */
export interface WidgetReference {
  widgetAssetId: string;
}
export interface LayoutReference {
  layoutId: string;
}

export type ItemKind =
  "image" | "video" | "website" | "widget" | "layout" | "youtube";

export interface RuntimeItem {
  id: string;
  kind: ItemKind;
  src: string;
  durationMs: number | null;
  fitMode: FitMode;
  transition?: string;
  audioEnabled: boolean;
  volume: number;
  videoStartOffsetMs: number | null;
  videoEndOffsetMs: number | null;
  viewport?: RuntimeViewport;
  website?: RuntimeWebsiteConfig;
  widget?: RuntimeWidgetPayload | WidgetReference;
  layout?: RuntimeLayoutPayload | LayoutReference;
}

export interface BrandedSurfaceFields {
  title?: string;
  message?: string;
  backgroundColor?: string;
  textColor?: string;
  logoSrc?: string | null;
  footerText?: string;
  status?: string;
}

export type RuntimePresentation =
  | { state: "setup" }
  | {
      state: "pairing";
      code: string;
      approvalUrl: string;
      organizationName?: string;
    }
  | ({ state: "idle" | "disabled" | "unavailable" } & BrandedSurfaceFields)
  | { state: "safe-mode"; reason: string }
  | {
      state: "sleep";
      display?: "bouncing_logo" | "custom_text" | "black";
      text?: string;
      textColor?: string;
    }
  | {
      state: "playing";
      items: RuntimeItem[];
      generation: number;
      takeover?: boolean;
      /**
       * True when a group's shared timeline owns occurrence changes. The
       * timeline itself arrives as `timing` on the presentation message.
       */
      synchronized?: boolean;
    }
  | {
      state: "external-presentation";
      provider?: string;
      sessionId?: string;
      receiverName?: string;
      pin?: string;
      expiresAt?: string;
      connected?: boolean;
      role?: string;
      transport?: string;
      audioMode?: string;
      presentationNetwork?: "joining" | "connected" | "failed";
    };

/**
 * A synchronized group's shared timeline. The runtime anchors once at
 * activation, then advances with its own monotonic clock, so a later
 * wall-clock correction never jumps active playback.
 */
export interface SynchronizedTimingV1 {
  groupId: string;
  /** Anchor in corrected (server) Unix milliseconds. */
  anchorMs: number;
  durationsMs: number[];
  /** Corrected-minus-local wall offset at activation. */
  clockOffsetMs: number;
}

/**
 * Inputs for projecting widget and layout references into render trees at the
 * corrected clock: a subset of the verified manifest and a table from the
 * manifest's asset/variant identity to host-authorized media URIs.
 */
export interface ProjectionContextV1 {
  schema: number;
  clockOffsetMs: number;
  manifest: Record<string, unknown>;
  media: { assetId: string; variantId: string; uri: string }[];
}

export interface PresentationMessage {
  type: "presentation";
  presentation: RuntimePresentation;
  activation?: ActivationRefV1;
  timing?: SynchronizedTimingV1;
  projection?: ProjectionContextV1;
}

/** Built-in plugin surfaces (compatibility shapes; see compat/plugins). */
export interface RuntimePluginV1 {
  id: string;
  type: string;
  version: number;
  config: unknown;
}

export interface PluginsMessage {
  type: "plugins";
  plugins: RuntimePluginV1[];
  clockOffsetMs: number;
}

export interface IdentifyMessage {
  type: "identify";
  name: string;
  durationSeconds: number;
}

export interface CommandMessage {
  type: "command";
  command: "retry-item" | "skip-item";
}

export interface DiscoveredServerV1 {
  name: string;
  serverUrl: string;
}

export interface DiscoveredServerMessage {
  type: "discovered-server";
  server: DiscoveredServerV1;
}

/** A derived level reading from host-side capture. Never audio. */
export interface NoiseLevelMessage {
  type: "noise-level";
  /** Root-mean-square amplitude in [0, 1], or null while unavailable. */
  rms: number | null;
}

export type HostMessageV1 =
  | PresentationMessage
  | PluginsMessage
  | IdentifyMessage
  | CommandMessage
  | DiscoveredServerMessage
  | NoiseLevelMessage;

// ------------------------------------------------------------ runtime → host

/**
 * Playback evidence. The vocabulary is the Tilecast player's existing one; the
 * host's supervisor decides what counts as meaningful for each item kind.
 */
export const EVIDENCE_KINDS = [
  "item-started",
  "item-transition",
  "image-shown",
  "video-progress",
  "widget-shown",
  "widget-alive",
  "widget-empty",
  "layout-shown",
  "layout-alive",
  "layout-zone-rendered",
  "website-loaded",
  "website-alive",
  "surface-shown",
] as const;

export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

export interface EvidenceReportV1 {
  activation: ActivationRefV1 | null;
  itemId: string | null;
  kind: EvidenceKind;
  zoneId?: string;
}

export interface PlaybackErrorReportV1 {
  activation: ActivationRefV1 | null;
  itemId: string | null;
  message: string;
}

export interface PresentationResultV1 {
  activation: ActivationRefV1 | null;
  outcome: "accepted" | "rejected";
  /** Machine-readable reason for a rejection. */
  code?: string;
  message?: string;
}

export interface RuntimeReadyV1 {
  contractVersion: typeof RUNTIME_HOST_CONTRACT_VERSION;
  runtimeVersion: string;
}

export interface NoiseMeterReportV1 {
  status: string;
  level?: number | null;
  bucket?: unknown;
}

export interface SetupResultV1 {
  ok: boolean;
  error?: string;
}

export interface TilecastRuntimeHostV1 {
  readonly contractVersion: typeof RUNTIME_HOST_CONTRACT_VERSION;
  readonly info: RuntimeHostInfoV1;
  readonly capabilities: RuntimeCapabilitiesV1;

  /**
   * Receive host messages. The host replays its latest presentation and plugin
   * state to a new subscriber, so a reloaded runtime resumes where it was.
   */
  subscribe(listener: (message: HostMessageV1) => void): () => void;

  /** The runtime has painted its first frame and is accepting messages. */
  ready(ready: RuntimeReadyV1): void;
  presentationResult(result: PresentationResultV1): void;
  reportEvidence(report: EvidenceReportV1): void;
  reportPlaybackError(report: PlaybackErrorReportV1): void;

  /** Present when `capabilities.setup`. */
  readonly setup?: {
    submitServerUrl(url: string): Promise<SetupResultV1>;
  };
  /** Present when `capabilities.discovery`. */
  readonly discovery?: {
    list(): Promise<DiscoveredServerV1[]>;
  };
  /** Present when `capabilities.noiseMeter` is set. */
  readonly noiseMeter?: {
    report(report: NoiseMeterReportV1): void;
    diagnostic(message: string, detail?: Record<string, unknown>): void;
  };
  /** Present when `capabilities.remoteWeb` is set. */
  readonly remoteWeb?: {
    reportRecovered(): void;
  };
  /**
   * Deterministic-run controls for the conformance suite only. A production
   * host never sets this. When present, the runtime keeps time on a manual
   * clock starting at `wallClockMs` (advanced through the diagnostics probe)
   * and runs transitions and motion at `animationScale` (0 = instant).
   */
  readonly conformance?: RuntimeConformanceV1;
}

export interface RuntimeConformanceV1 {
  readonly wallClockMs: number;
  readonly animationScale: number;
}

// ------------------------------------------------------------ validation

const FUNCTION_MEMBERS = [
  "subscribe",
  "ready",
  "presentationResult",
  "reportEvidence",
  "reportPlaybackError",
] as const;

/**
 * Check that a value implements the V1 contract. Returns a reason when it
 * does not; the runtime then shows an explicit "bridge unavailable" surface
 * rather than failing silently.
 */
export function hostContractProblem(value: unknown): string | null {
  if (!value || typeof value !== "object") {
    return "host bridge is missing";
  }
  const host = value as Record<string, unknown>;
  if (host["contractVersion"] !== RUNTIME_HOST_CONTRACT_VERSION) {
    return `unsupported host contract version ${String(host["contractVersion"])}`;
  }
  for (const member of FUNCTION_MEMBERS) {
    if (typeof host[member] !== "function") {
      return `host bridge lacks ${member}()`;
    }
  }
  const capabilities = host["capabilities"] as
    Record<string, unknown> | undefined;
  if (!capabilities || typeof capabilities !== "object") {
    return "host bridge lacks capabilities";
  }
  const optional: [keyof RuntimeCapabilitiesV1, string, string][] = [
    ["setup", "setup", "submitServerUrl"],
    ["discovery", "discovery", "list"],
    ["noiseMeter", "noiseMeter", "report"],
    ["remoteWeb", "remoteWeb", "reportRecovered"],
  ];
  for (const [capability, member, method] of optional) {
    if (!capabilities[capability]) continue;
    const group = host[member] as Record<string, unknown> | undefined;
    if (!group || typeof group[method] !== "function") {
      return `capability ${capability} is advertised without ${member}.${method}()`;
    }
  }
  return null;
}
