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
  /**
   * An isolated host-owned web surface behind the typed `remoteWeb` members.
   * The host returns a render target: a media URI the runtime composites
   * itself (WPE), or a host layer the runtime positions (a future native
   * view). Behavior follows the target, never the host's name.
   */
  | "host-view";

/** The animated Tilecast logo that bounces outside active hours. */
export type OutsideHoursLogoV1 = "cast" | "pulse";

export interface RuntimeCapabilitiesV1 {
  /** Remote websites and YouTube, or `null` when they cannot be isolated. */
  readonly remoteWeb: RemoteWebMechanism | null;
  /** The host supplies shared-timeline anchors for synchronized groups. */
  readonly synchronizedPlayback: boolean;
  /** `setup.submitServerUrl` is available. */
  readonly setup: boolean;
  /** `discovery.list` and `discovered-server` messages are available. */
  readonly discovery: boolean;
  /**
   * The animated logo for the "Bouncing logo" display. Absent, or any value
   * the runtime does not know, means `"cast"`.
   */
  readonly outsideHoursLogo?: OutsideHoursLogoV1;
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
// ------------------------------------------------------------ remote web

export type RemoteWebCookiePolicyV1 =
  "disabled" | "first_party" | "first_and_third_party";

/** A remote page. The host enforces all of it; nothing here is a header. */
export interface RemoteWebPageContentV1 {
  kind: "page";
  url: string;
  /** Exact host names; the host refuses main-frame documents elsewhere. */
  allowedHosts: string[];
  javascriptEnabled: boolean;
  domStorageEnabled: boolean;
  cookiePolicy: RemoteWebCookiePolicyV1;
  /** Empty for the engine default. */
  userAgent: string;
  zoomPercent: number;
  scrollX: number;
  scrollY: number;
  backgroundColor: string;
}

/**
 * A YouTube video or playlist in the host's own player wrapper, with the
 * documented embed settings only. Exactly one of `videoId`, `playlistId`.
 */
export interface RemoteWebYouTubeContentV1 {
  kind: "youtube";
  videoId: string | null;
  playlistId: string | null;
  startSeconds: number;
  endSeconds: number | null;
  loop: boolean;
  /** The author's mute; the runtime's audio decision is `setMuted`. */
  muted: boolean;
  /** 0 to 100, applied by the player. */
  volume: number;
  captions: boolean;
  captionLanguage: string;
  controls: boolean;
}

export type RemoteWebContentV1 =
  RemoteWebPageContentV1 | RemoteWebYouTubeContentV1;

/**
 * Where the surface is, in CSS pixels of the trusted document's viewport,
 * and the device pixel ratio. A media-URI host needs only the size; a
 * host-layer host places its view here.
 */
export interface RemoteWebViewportV1 {
  x: number;
  y: number;
  width: number;
  height: number;
  deviceScale: number;
}

export interface RemoteWebSurfaceSpecV1 {
  /** Chosen by the runtime: [a-z0-9-]{1,48}, unique while the surface lives. */
  surfaceId: string;
  content: RemoteWebContentV1;
  viewport: RemoteWebViewportV1;
  muted: boolean;
  visible: boolean;
}

/**
 * How the runtime shows a created surface:
 *   - `media-uri`: an opaque URI the runtime puts in a <video> of its own
 *     DOM, so Layout clipping, transitions and preview capture apply;
 *   - `host-layer`: the host shows its own view at the viewport the runtime
 *     sends. No host needs to imitate another host's frame transport.
 */
export type RemoteWebRenderTargetV1 =
  { kind: "media-uri"; uri: string } | { kind: "host-layer" };

export type RemoteWebCreateResultV1 =
  { ok: true; target: RemoteWebRenderTargetV1 } | { ok: false; code: string };

export type RemoteWebEventKindV1 =
  /** The first frame of the surface is available to the runtime. */
  | "stream-ready"
  /** The page (or the YouTube player) finished loading. */
  | "loaded"
  /** The main frame tried to leave the allowlist. */
  | "navigation-blocked"
  | "failed"
  /** The host's remote web process ended; every live surface failed. */
  | "process-terminated"
  /** YouTube: the video (or playlist) ended. */
  | "media-ended"
  /** The host's remote web process is available again. */
  | "recovered";

export interface RemoteWebEventV1 {
  /** Null for host-wide events (`process-terminated`, `recovered`). */
  surfaceId: string | null;
  kind: RemoteWebEventKindV1;
  /** A stable reason token for failures. */
  code?: string;
}

/**
 * Runtime-side policy for one remote web surface. The runtime owns these
 * timers and decisions; the host never sees them.
 */
export interface RemoteWebPresentationV1 {
  loadTimeoutSeconds: number;
  reloadIntervalSeconds: number | null;
  lifecycle: "destroy_on_hide" | "keep_warm";
  warmSeconds: number;
  onlineOnly: boolean;
  /** placeholder | fallback_image | skip | last_success */
  failureBehavior: string;
  fallbackSrc: string | null;
  /** YouTube "play until the video ends": completion is `media-ended`. */
  playUntilEnd: boolean;
}

/** One remote web surface as projection produces it. */
export interface RuntimeRemoteWebSpecV1 {
  content: RemoteWebContentV1;
  presentation: RemoteWebPresentationV1;
}

export interface RenderNodeV1 {
  t: string;
  [key: string]: unknown;
}

export interface RuntimeWidgetPayload {
  background: string;
  root: RenderNodeV1;
  autoSkip?: boolean;
}

/**
 * A first-class Widget component (docs/widgets-v2.md), as a manifest v16
 * `kind: "component"` presentation describes it after projection.
 */
export interface RuntimeWidgetComponentV1 {
  type: string;
  version: number;
  /** Bounded configuration compiled by the Server. */
  config: unknown;
  /** Data Source IDs the component may read. */
  dataSources: string[];
  /** Media variants the component may display. */
  media: { assetId: string; variantId: string }[];
}

/**
 * A projected component: the reference plus the prepared resources it is
 * granted, and the regional formatting its context uses. It carries no
 * time-dependent value, so re-projection leaves it unchanged and a
 * ticking Widget keeps its own time from the corrected clock.
 */
export interface RuntimeWidgetComponentPayload {
  component: RuntimeWidgetComponentV1;
  /** Data Documents of `component.dataSources`, keyed by Data Source ID. */
  documents: Record<string, unknown>;
  /** URIs of `component.media`, keyed by `${assetId}/${variantId}`. */
  media: Record<string, string>;
  regional: {
    locale: string;
    timeZone: string;
    hourCycle: "locale" | "h12" | "h23";
  };
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
  videoStartOffsetMs?: number | null;
  videoEndOffsetMs?: number | null;
  radius?: number;
  transition?: "none" | "fade" | "crossfade";
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
  /** Playlist-zone behavior; omitted older manifests keep the historical defaults. */
  loop?: boolean;
  fallback?: "hide" | "background" | "previous";
  render?: RenderNodeV1;
  /** A Website or Web Widget placed in the zone. */
  remoteWeb?: RuntimeRemoteWebSpecV1;
  /** A first-class Widget component placed in this zone. */
  component?: RuntimeWidgetComponentPayload;
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
  /**
   * The normalized remote web spec of a website or youtube item. Hosts that
   * send only `website` (older Electron builds, Edge Website assets) are
   * normalized by the runtime (remote-web/spec.ts).
   */
  remoteWeb?: RuntimeRemoteWebSpecV1;
  widget?:
    RuntimeWidgetPayload | RuntimeWidgetComponentPayload | WidgetReference;
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
  /**
   * The accepted player configuration's playback section: regional
   * formatting and layout playlist-zone defaults. Optional and additive;
   * absent means the projection defaults.
   */
  playback?: Record<string, unknown>;
}

export interface PresentationMessage {
  type: "presentation";
  presentation: RuntimePresentation;
  activation?: ActivationRefV1;
  timing?: SynchronizedTimingV1;
  projection?: ProjectionContextV1;
}

/**
 * One Player manifest plugin entry. The runtime surface host routes each entry
 * to the runtime plugin that declares its type; an unknown type is ignored.
 */
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

/** A host remote web event (capability `remoteWeb: "host-view"`). */
export interface RemoteWebMessage {
  type: "remote-web";
  event: RemoteWebEventV1;
}

export type HostMessageV1 =
  | RemoteWebMessage
  | PresentationMessage
  | PluginsMessage
  | IdentifyMessage
  | CommandMessage
  | DiscoveredServerMessage;

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
  /** Live Runtime support, separate from the installed release profile.
   * Each namespace has at most 256 entries; versions are positive uint32.
   * Capability names use the existing bounded contract token syntax.
   */
  support?: RuntimeSupportV1;
}

export interface RuntimeSupportV1 {
  presentationSchemas: number[];
  declarativeCapabilities: Record<string, number>;
  widgetComponents: Record<string, number>;
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
  /**
   * Present when `capabilities.remoteWeb` is set. The surface members are
   * required when it is `"host-view"`: each is a closed, typed request, and
   * there is no member that runs script in, or sends a message to, a page.
   */
  readonly remoteWeb?: {
    reportRecovered(): void;
    create?(spec: RemoteWebSurfaceSpecV1): Promise<RemoteWebCreateResultV1>;
    /** Event-driven (a Layout or size change), never per animation frame. */
    updateViewport?(surfaceId: string, viewport: RemoteWebViewportV1): void;
    setVisible?(surfaceId: string, visible: boolean): void;
    setMuted?(surfaceId: string, muted: boolean): void;
    reload?(surfaceId: string): void;
    destroy?(surfaceId: string): void;
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

/** Required when `capabilities.remoteWeb === "host-view"`. */
export const HOST_VIEW_MEMBERS = [
  "create",
  "updateViewport",
  "setVisible",
  "setMuted",
  "reload",
  "destroy",
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
    ["remoteWeb", "remoteWeb", "reportRecovered"],
  ];
  for (const [capability, member, method] of optional) {
    if (!capabilities[capability]) continue;
    const group = host[member] as Record<string, unknown> | undefined;
    if (!group || typeof group[method] !== "function") {
      return `capability ${capability} is advertised without ${member}.${method}()`;
    }
  }
  if (capabilities["remoteWeb"] === "host-view") {
    const group = host["remoteWeb"] as Record<string, unknown>;
    for (const method of HOST_VIEW_MEMBERS) {
      if (typeof group[method] !== "function") {
        return `capability remoteWeb "host-view" is advertised without remoteWeb.${method}()`;
      }
    }
  }
  return null;
}
