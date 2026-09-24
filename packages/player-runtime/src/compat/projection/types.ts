/**
 * Tilecast server API contract types (the subset this player uses).
 * Field names mirror the Go server structs exactly.
 */

export interface Identity {
  product: string;
  installationId: string;
  organizationName: string;
  apiVersion: string;
  pairingEnabled: boolean;
}

export interface DeviceMetadata {
  playerInstallationId: string;
  platform: string;
  manufacturer: string;
  model: string;
  androidVersion: string;
  playerVersion: string;
  screenWidth: number;
  screenHeight: number;
  density: number;
  locale: string;
  timezone: string;
}

export interface PairingCreated {
  id: string;
  code: string;
  pollSecret: string;
  expiresAt: string;
  serverTime: string;
  pollingIntervalSeconds: number;
  approvalUrl: string;
  organizationName: string;
}

export type PairingStatus =
  "pending" | "approved" | "claimed" | "rejected" | "expired";

export interface PairingPollResult {
  status: PairingStatus;
  expiresAt: string;
  screenId?: string;
  enrollmentToken?: string;
  failureReason?: string;
}

export interface EnrollmentResult {
  screenId: string;
  screenName: string;
  deviceCredential: string;
}

// ---------------------------------------------------------------------------
// Manifest

export interface ManifestItem {
  id: string;
  assetId: string;
  layoutId?: string | null;
  variantId?: string | null;
  assetType: string; // "image" | "video" | "website" | "widget" | ...
  durationMs?: number | null;
  fitMode: string;
  transition: string;
  audioEnabled: boolean;
  volume: number;
  videoStartOffsetMs?: number | null;
  videoEndOffsetMs?: number | null;
  deliveryPolicy: string; // "download" | "stream" | "automatic"
  usePlayerDefaults?: boolean;
  availableFrom?: string | null;
  expiresAt?: string | null;
}

export interface ManifestPlaylist {
  id: string;
  revision: number;
  name: string;
  items: ManifestItem[];
}

export interface ManifestAsset {
  assetId: string;
  variantId: string;
  mimeType: string;
  sha256: string;
  fileSize: number;
  width?: number | null;
  height?: number | null;
  durationSeconds?: number | null;
  downloadPath: string;
  availableFrom?: string | null;
  expiresAt?: string | null;
}

export interface ManifestBranding {
  logoAssetId?: string | null;
  logoVariantId?: string | null;
}

export interface ManifestCanvas {
  width: number;
  height: number;
}

export interface ManifestViewport {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
  order: number;
  bezelLeft?: number;
  bezelTop?: number;
  bezelRight?: number;
  bezelBottom?: number;
}

export interface SpanViewport extends ManifestViewport {
  canvasWidth: number;
  canvasHeight: number;
}

export interface ManifestCountdownBarConfig {
  name: string;
  message: string;
  scheduleType: "weekly" | "one_time";
  targetTime?: string | null;
  daysOfWeek?: number[];
  oneTimeAt?: string | null;
  timezone: string;
  leadTimeSeconds: number;
  completionText?: string;
  showConfetti?: boolean;
  displayMode: "overlay" | "push";
  heightPx: number;
  /** Absent on manifests published before the fill existed. */
  progressFill?: "none" | "drain" | null;
  /** Percentage of the bar width kept as a gutter on each side. */
  contentPadding?: number | null;
  /** Percentage applied to the height-derived type size. */
  textScale?: number | null;
  priority: number;
}

export interface ManifestCountdownBarPlugin {
  id: string;
  type: "countdown_bar";
  version: 1;
  config: ManifestCountdownBarConfig;
}

export interface ManifestBrandBugConfig {
  name: string;
  corner: "top_left" | "top_right" | "bottom_left" | "bottom_right";
  imageAssetId?: string | null;
  imageVariantId?: string | null;
  imageAvailableFrom?: string | null;
  imageExpiresAt?: string | null;
  text?: string;
  widthPercent: number;
  textSizePercent: number;
  opacityPercent: number;
  marginPercent: number;
  textColor: string;
  backgroundStyle: "none" | "scrim";
  startsAt?: string | null;
  endsAt?: string | null;
  priority: number;
}

export interface ManifestBrandBugPlugin {
  id: string;
  type: "brand_bug";
  version: 1;
  config: ManifestBrandBugConfig;
}

/**
 * Thresholds for the Player-local room noise bar. Levels are the normalized
 * 0-100 Tilecast scale, relative to this Player's own microphone rather than
 * decibels of any kind, and no device or input identifier travels here: the
 * Player uses its default system microphone and keeps every sample local.
 */
export interface ManifestNoiseMeterConfig {
  name: string;
  message?: string;
  warningLevel: number;
  loudLevel: number;
  sensitivity: number;
  triggerHoldMs: number;
  clearHoldMs: number;
  displayMode: "overlay" | "push";
  heightPx: number;
  /**
   * History settings. `historyEnabled` decides whether the Player aggregates at
   * all, the retention window is the same one the server prunes with, and
   * `historyActiveHoursOnly` stops the microphone outside active hours instead
   * of merely discarding what it hears.
   */
  historyEnabled?: boolean;
  historyRetentionDays?: number;
  historyActiveHoursOnly?: boolean;
}

export interface ManifestNoiseMeterPlugin {
  id: string;
  type: "noise_meter";
  version: 1;
  config: ManifestNoiseMeterConfig;
}

export type ManifestPlugin =
  | ManifestCountdownBarPlugin
  | ManifestBrandBugPlugin
  | ManifestNoiseMeterPlugin;

export interface ManifestWebsite {
  assetId: string;
  name: string;
  url: string;
  allowedHosts: string[];
  javascriptEnabled: boolean;
  domStorageEnabled: boolean;
  cookiePolicy: string;
  reloadPolicy: string;
  refreshIntervalSeconds?: number | null;
  loadTimeoutSeconds: number;
  zoomPercent: number;
  scrollX: number;
  scrollY: number;
  customUserAgent?: string;
  backgroundColor: string;
  failureBehavior: string; // "fallback_image" | "placeholder" | "skip"
  fallbackImageAssetId?: string | null;
  fallbackVariantId?: string | null;
}

export interface ManifestSchedule {
  id: string;
  playlistId?: string | null;
  layoutId?: string | null;
  displayAction?: {
    type: string;
    input?: string;
    volume?: number;
    brightness?: number;
  } | null;
  type: string; // "weekly" | "one_time"
  timezone: string;
  priority: number;
  specificity: number;
  startDate?: string | null;
  endDate?: string | null;
  oneTimeStart?: string | null;
  oneTimeEnd?: string | null;
  dailyStart?: string | null;
  dailyEnd?: string | null;
  daysOfWeek?: number[] | null;
}

export interface ManifestTakeover {
  id: string;
  playlistId: string;
  activatedAt: string;
  expiresAt: string;
}

export interface ManifestPresentationOverride {
  id: string;
  contentType: "playlist" | "layout" | "asset";
  contentId: string;
  contentName: string;
  startedAt: string;
  expiresAt?: string | null;
  playlistId?: string | null;
  layoutId?: string | null;
  wakeDisplay?: boolean;
}

export interface Manifest {
  schemaVersion: number;
  manifestVersion: number;
  screenId: string;
  generatedAt: string;
  mode: string;
  playlist?: ManifestPlaylist | null;
  directFallbackPlaylist?: ManifestPlaylist | null;
  playlists: ManifestPlaylist[];
  schedules: ManifestSchedule[];
  assets: ManifestAsset[];
  branding?: ManifestBranding | null;
  plugins?: ManifestPlugin[];
  serverTime: string;
  prefetchHorizonDays: number;
  activationGraceSeconds: number;
  websites: ManifestWebsite[];
  presentationOverride?: ManifestPresentationOverride | null;
  takeover?: ManifestTakeover | null;
  /** Pre-rename manifest key accepted during staggered upgrades. */
  emergency?: ManifestTakeover | null;
  // Layouts, widgets, and data sources are typed in content-types.ts; kept
  // loose here to avoid a manifest↔content type cycle. The runtime narrows
  // them via the content-types interfaces when projecting.
  layout?: unknown | null;
  directFallbackLayout?: unknown | null;
  layouts?: unknown[];
  widgets?: unknown[];
  dataSources?: unknown[];
  syncGroup?: { id: string; playbackEpoch?: string } | null;
  canvas?: ManifestCanvas | null;
  viewport?: ManifestViewport | null;
}

// ---------------------------------------------------------------------------
// Config

export interface PlayerConfig {
  schemaVersion: number;
  configRevision: number;
  generatedAt: string;
  branding: Record<string, unknown>;
  playback: Record<string, unknown>;
  cache: Record<string, unknown>;
  sync: Record<string, unknown>;
  website: Record<string, unknown>;
  reliability: Record<string, unknown>;
  power: Record<string, unknown>;
  managedKiosk: Record<string, unknown>;
  /** Absent in configurations generated before Linux kiosk policy existed. */
  linuxKiosk?: Record<string, unknown>;
  /**
   * The Linux Presentation Network assignment. Absent from a server that predates
   * the feature; a section saying `assigned: false` is the instruction to remove
   * any Tilecast-managed Wi-Fi profile. Never contains a credential — this
   * document is cached on disk.
   */
  presentationNetwork?: Record<string, unknown>;
  accessibility: Record<string, unknown>;
  updates: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Commands

export interface PlayerCommand {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  state: string;
  createdAt: string;
  expiresAt: string;
}

export interface CommandResultReport {
  success: boolean;
  code: string; // <= 80 chars
  message: string; // <= 240 chars
}

// ---------------------------------------------------------------------------
// Player self-update (server-driven AppImage updates)

export interface UpdateMetadata {
  releaseId: string;
  /** Stable artifact identity; never infer the artifact from directory order. */
  artifactId?: string;
  platform: string; // "linux" for this player
  versionCode: number;
  versionName: string;
  artifactSizeBytes?: number;
  artifactSha256?: string;
  artifactPath?: string;
}

export interface UpdateStatusReport {
  state: string; // downloading | downloaded | verifying | ready | installing | reconnecting | failed
  downloadedBytes?: number;
  error?: string;
}

// ---------------------------------------------------------------------------
// Heartbeat (subset of the server's flat Heartbeat struct that this player
// reports; screenWidth, screenHeight, and playerVersion are required)

/**
 * The Noise Meter's optional heartbeat section.
 *
 * It rides the ordinary heartbeat because a room's noise is measured fifteen to
 * twenty times a second and none of that rate may reach the network. What
 * travels is the current state and completed ten-second aggregates: numbers
 * only, never audio, a waveform, or anything replayable.
 */
export interface HeartbeatNoiseMeter {
  status: "active" | "normal" | "loud" | "unavailable" | "inactive";
  currentLevel?: number;
  pendingHistory?: {
    startedAt: string;
    averageLevel: number;
    peakLevel: number;
    monitoredMs: number;
    warningMs: number;
    loudMs: number;
    triggerCount: number;
  }[];
}

/** What the server acknowledged for one heartbeat. */
export interface HeartbeatAck {
  accepted: boolean;
  ignoredFields?: string[];
  /**
   * How many of the submitted history records the server has taken
   * responsibility for. Absent when none were sent, when the server predates
   * the field, or when storing them failed — in every one of those cases the
   * Player keeps its batch.
   */
  noiseHistory?: { accepted: number };
}

export interface Heartbeat {
  screenWidth: number;
  screenHeight: number;
  playerVersion: string;
  noiseMeter?: HeartbeatNoiseMeter;
  presentationSchemaVersions?: number[];
  nativePresentationCapabilities?: Record<string, number>;
  webRuntimeVersion?: number;
  webBundleLimitBytes?: number;
  /**
   * Render-progress facts. Deliberately separate from `playbackState`: a
   * player can be running, with a live renderer, over a frozen screen.
   */
  lastMeaningfulProgressAt?: string;
  stallStartedAt?: string;
  stallDurationMs?: number;
  stallReason?: string;
  /** Whether the content on screen is supposed to be moving at all. */
  expectedMotion?: boolean;
  /** The renderer answers. Weaker than, and not a substitute for, progress. */
  rendererResponding?: boolean;
  currentItemStartedAt?: string;
  /** Numeric version code derived from playerVersion; drives update completion. */
  playerVersionCode?: number;
  /** ISO timestamp of the last healthy playback tick; required for update success. */
  lastHealthyPlaybackAt?: string;
  currentUpdateDeploymentId?: string;
  updateState?: string;
  updateDownloadedBytes?: number;
  updateExpectedBytes?: number;
  updateError?: string;
  uptimeSeconds?: number;
  availableStorageBytes?: number;
  activeManifestVersion?: number;
  pendingManifestVersion?: number;
  currentItemId?: string;
  currentAssetId?: string;
  playbackState?: string;
  downloadQueueCount?: number;
  cacheUsedBytes?: number;
  lastSynchronizationError?: string;
  lastPlaybackError?: string;
  currentScheduleId?: string;
  currentPlaylistId?: string;
  selectionSource?: string;
  nextTransitionAt?: string;
  activeTakeoverId?: string;
  takeoverState?: string;
  playbackDisabled?: boolean;
  lastCommandId?: string;
  lastCommandState?: string;
  lastCommandResult?: string;
  lastCommandCompletedAt?: string;
  activeConfigRevision?: number;
  configurationError?: string;
  safeMode?: boolean;
  recoveryLevel?: number;
  recoveryCount?: number;
  currentWebsiteAssetId?: string;
  websiteState?: string;
  websiteFailureCategory?: string;
  websiteFallbackShown?: boolean;
  websiteRendererRecoveryCount?: number;
  /**
   * Linux autostart. `bootLaunchVerified` and `lastSuccessfulColdBootAt` are
   * the same fields the Android player reports from its boot receiver; here
   * they are derived from systemd supervision plus proximity to boot, so the
   * Studio row carries one meaning across both platforms.
   */
  autostartState?: string;
  autostartTarget?: string;
  autostartSupervised?: boolean;
  autostartLingerEnabled?: boolean;
  autostartError?: string;
  bootLaunchVerified?: boolean;
  lastSuccessfulColdBootAt?: string;
  /** External AirPlay presentation capability and live process state. */
  airplaySupported?: boolean;
  airplayUxPlayInstalled?: boolean;
  airplayUxPlayVersion?: string;
  airplayGstreamerInstalled?: boolean;
  airplayH264DecoderAvailable?: boolean;
  airplayHardwareDecode?: boolean;
  airplayDecoder?: string;
  airplayMaxProfile?: string;
  airplayGroupSupported?: boolean;
  airplayAudioAvailable?: boolean;
  airplayAvahiAvailable?: boolean;
  airplayMdnsAdvertisementAvailable?: boolean;
  airplayMulticastSupported?: boolean;
  airplayMulticastTestStatus?: string;
  airplayLimitation?: string;
  externalPresentationState?: string;
  externalPresentationSessionId?: string;
  externalPresentationRole?: string;
  airplayReceiverState?: string;
  airplayTransport?: string;
  airplayConnected?: boolean;
  externalPresentationExpiresAt?: string;
  displayControlProvider?: string;
  displayControlProviders?: string[];
  displayControlCapabilities?: Record<string, string>;
  displayPowerState?:
    "unknown" | "on" | "off" | "transitioning" | "unsupported";
  displayPowerStateConfirmed?: boolean;
  displayPowerStateObservedAt?: string;
  displayControlPolicyState?: "normal" | "powered_off_by_policy" | "unknown";
  displayControlError?: string;

  // Presentation Network capability and state. Booleans, enumerated states,
  // identifiers, and revisions only: nothing here can carry a Wi-Fi credential.
  presentationNetworkSupported?: boolean;
  presentationNetworkHelperState?: string;
  presentationNetworkManagerAvailable?: boolean;
  presentationNetworkWifiAdapter?: boolean;
  presentationNetworkRadioEnabled?: boolean;
  presentationNetworkState?: string;
  presentationNetworkInstalledId?: string;
  presentationNetworkInstalledRevision?: number;
  presentationNetworkActiveId?: string;
  presentationNetworkLastConnectedAt?: string;
  presentationNetworkLastFailureAt?: string;
  presentationNetworkLastFailureCode?: string;
  presentationNetworkLimitation?: string;
  /**
   * The explicitly reported Ethernet facts group AirPlay RTP fan-out needs.
   * Deliberately narrower than the server's last_known_ip, which stops being an
   * unambiguous answer once this player can hold a temporary Wi-Fi address too.
   */
  wiredInterfaceAvailable?: boolean;
  wiredIpv4?: string;
}

// ---------------------------------------------------------------------------
// Socket messages

export interface SocketEnvelope {
  type: string;
  protocolVersion?: number;
  playerVersion?: string;
  timestamp?: string;
  payload?: unknown;
  // server.hello / notification extras arrive as flat fields
  [key: string]: unknown;
}
