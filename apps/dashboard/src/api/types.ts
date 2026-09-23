export type User = {
  id: string;
  name: string;
  username: string;
  role: "owner" | "administrator" | "editor" | "contributor" | "viewer";
  active: boolean;
  createdAt: string;
  lastLoginAt?: string;
};

export type AuthStatus = {
  setupRequired: boolean;
  authenticated: boolean;
  user?: User;
  csrfToken?: string;
  authMethod?: AuthMethod;
  /** The organization requires a second factor this account has not enrolled. */
  mfaEnrollmentRequired?: boolean;
  /**
   * Passkeys need a secure context and a registrable domain, which a
   * plain-HTTP LAN installation does not have.
   */
  passkeysAvailable?: boolean;
  passkeysUnavailableReason?: string;
};

export type AuthMethod = "password" | "totp" | "passkey" | "recovery_code";

export type MFAMethod = "totp" | "passkey" | "recovery_code";

export type MFAPolicy = "none" | "administrators" | "all";

/** A password was accepted but a second factor is still owed. */
export type MFAChallenge = {
  mfaRequired: true;
  challengeToken: string;
  methods: MFAMethod[];
};

export type SessionResult = {
  user: User;
  csrfToken: string;
  authMethod?: AuthMethod;
  mfaEnrollmentRequired?: boolean;
};

export type LoginResult = MFAChallenge | SessionResult;

export type Passkey = {
  id: string;
  /** Derived from the authenticator at enrollment; the user never types one. */
  name: string;
  /** Public credential handle, used to signal accepted credentials. */
  credentialId: string;
  createdAt: string;
  lastUsedAt?: string;
};

export type SecurityStatus = {
  relyingPartyId: string;
  /** Empty until the account enrolls its first passkey. */
  userHandle: string;
  totpEnrolled: boolean;
  totpConfirmedAt?: string;
  passkeys: Passkey[];
  recoveryCodesRemaining: number;
  enrolled: boolean;
  passkeysAvailable: boolean;
  passkeysUnavailableReason: string;
  /** This account's role is covered by the organization policy. */
  required: boolean;
  policy: MFAPolicy;
  authMethod: AuthMethod;
};

export type TOTPEnrollment = {
  provisioningUri: string;
  secret: string;
};

/**
 * The WebAuthn ceremony options exactly as the server produced them. They are
 * decoded from base64url into the ArrayBuffers the browser API requires.
 */
export type PublicKeyOptions = Record<string, unknown>;

export type PasskeyCeremony = {
  challengeToken: string;
  options: PublicKeyOptions;
};

export type SetupInput = {
  organizationName: string;
  ownerName: string;
  username: string;
  password: string;
};

export type LoginInput = { username: string; password: string };

export type ScreenStatus =
  "online" | "recent" | "stale" | "offline" | "disabled" | "revoked";

export type Location = {
  id: string;
  name: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  postalCode: string;
  country: string;
  latitude?: number;
  longitude?: number;
  screenCount: number;
  createdAt: string;
  updatedAt: string;
};

export type LocationInput = Omit<
  Location,
  "id" | "screenCount" | "createdAt" | "updatedAt"
>;

export type PresentationNetworkSecurity = "wpa_psk" | "wpa_eap_peap_mschapv2";

export type PresentationNetworkAuth = {
  identity?: string;
  anonymousIdentity?: string;
  caCertificatePem?: string;
  domainSuffixMatch?: string;
};

/** Public Presentation Network data. Credentials are never part of this type. */
export type PresentationNetwork = {
  id: string;
  name: string;
  ssid: string;
  hidden: boolean;
  security: PresentationNetworkSecurity;
  securityLabel: string;
  auth: PresentationNetworkAuth;
  credentialSet: boolean;
  secretUpdatedAt?: string;
  configRevision: number;
  assignedScreens: number;
  createdAt: string;
  updatedAt: string;
};

export type PresentationNetworkAssignment = {
  screenId: string;
  screenName: string;
  platform: string;
  presentationNetworkId?: string;
  presentationNetworkName?: string;
  assignedAt?: string;
};

export type PresentationNetworkSecurityOption = {
  value: PresentationNetworkSecurity;
  label: string;
  enterprise: boolean;
};

export type PresentationNetworkList = {
  items: PresentationNetwork[];
  credentialsAvailable: boolean;
  credentialsUnavailableReason: string;
  supportedSecurity: PresentationNetworkSecurityOption[];
};

export type PresentationNetworkDetail = {
  network: PresentationNetwork;
  assignments: PresentationNetworkAssignment[];
};

export type PresentationNetworkInput = {
  name: string;
  ssid: string;
  hidden: boolean;
  security: PresentationNetworkSecurity;
  /** Write-only. Omit to retain the stored credential while editing. */
  secret?: string;
  identity?: string;
  anonymousIdentity?: string;
  caCertificatePem?: string;
  domainSuffixMatch?: string;
};

export type PresentationNetworkReadinessStatus =
  | "not_applicable"
  | "network_manager_unavailable"
  | "helper_missing"
  | "helper_unhealthy"
  | "unsupported"
  | "wifi_adapter_unavailable"
  | "unassigned"
  | "reporting_pending"
  | "connected"
  | "failed"
  | "configuration_pending"
  | "ready";

export type PresentationNetworkReadiness = {
  screenId: string;
  platform: string;
  presentationNetworkId?: string;
  presentationNetworkName?: string;
  assignedAt?: string;
  applicable: boolean;
  status: PresentationNetworkReadinessStatus;
  detail: string;
  helperState?: string;
  networkManagerAvailable?: boolean;
  wifiAdapterPresent?: boolean;
  radioEnabled?: boolean;
  reportedState?: string;
  installedNetworkId?: string;
  installedRevision?: number;
  activeNetworkId?: string;
  lastConnectedAt?: string;
  lastFailureAt?: string;
  lastFailureCode?: string;
  limitation?: string;
  wiredInterfaceAvailable?: boolean;
  wiredIpv4?: string;
  credentialsAvailable: boolean;
};

export type PresentationNetworkTestResult = {
  commandId: string;
  screenId: string;
  timeoutSeconds: number;
};

export type Screen = {
  id: string;
  name: string;
  description: string;
  /** Derived from locationDetails for compatibility with compact screen references. */
  location: string;
  locationId?: string;
  locationDetails?: Location;
  roomName?: string;
  roomNumber?: string;
  syncGroupId?: string;
  syncGroupName?: string;
  nowPlayingName?: string;
  nowPlayingType?: "playlist" | "presentation";
  platform: string;
  deviceManufacturer: string;
  deviceModel: string;
  androidVersion: string;
  playerVersion: string;
  playerVersionCode?: number;
  androidSdk?: number;
  installerSource?: string;
  installPermissionStatus?: string;
  currentUpdateDeploymentId?: string;
  updateState?: string;
  updateDownloadedBytes?: number;
  updateExpectedBytes?: number;
  updateError?: string;
  screenWidth: number;
  screenHeight: number;
  density: number;
  locale: string;
  timezone: string;
  availableStorageBytes?: number;
  uptimeSeconds?: number;
  enabled: boolean;
  pairedAt: string;
  lastContactAt?: string;
  lastKnownIp?: string;
  status: ScreenStatus;
  hasActiveCredential: boolean;
};

export type PlaylistItem = {
  id: string;
  assetId: string;
  layoutId?: string;
  position: number;
  durationMs?: number;
  fitMode: "contain" | "cover" | "stretch";
  transition: "none" | "fade" | "crossfade";
  audioEnabled: boolean;
  volume: number;
  videoStartOffsetMs?: number;
  videoEndOffsetMs?: number;
  deliveryPolicy: "download" | "stream" | "automatic";
  usePlayerDefaults?: boolean;
  assetName: string;
  assetType: "image" | "video" | "widget" | "layout";
  widgetProvider?: WidgetProvider;
  assetStatus: AssetStatus;
  assetDurationSeconds?: number;
  thumbnailUrl: string;
  variantId?: string;
  availableFrom?: string;
  expiresAt?: string;
  dynamic?: boolean;
};

export type PlaylistPreviewItem = {
  id: string;
  name: string;
  type: "image" | "video" | "widget" | "layout";
  thumbnailUrl?: string;
};

export type Playlist = {
  id: string;
  name: string;
  description: string;
  revision: number;
  draftRevision?: number;
  publishedRevision?: number;
  hasUnpublishedChanges?: boolean;
  createdAt: string;
  updatedAt: string;
  items: PlaylistItem[];
  itemCount: number;
  warnings: string[];
  layoutUsage: { id: string; name: string; published: boolean }[];
  // Screens and schedules that play this playlist. Populated on the detail read only, and
  // shaped like Layout.usage so one panel renders both.
  usage?: {
    screens: { id: string; name: string }[];
    schedules: { id: string; name: string }[];
    campaigns: { id: string; name: string }[];
  };
  /** Compact visual metadata returned by playlist list requests. */
  previewItems?: PlaylistPreviewItem[];
  // Data Sources reached through this playlist's items — those its Widgets read plus those any
  // embedded Layout depends on. Only IDs; names and refresh status come from the Data Source list.
  dataSourceIds?: string[];
  sourceType?: "static" | "tag";
  tagRule?: {
    match: "any" | "all";
    imageDurationMs: number;
    tags: ContentTag[];
  };
};

export type PlaylistList = {
  items: Playlist[];
  total: number;
  page: number;
  pageSize: number;
};

export type LayoutOrientation = "landscape" | "portrait" | "custom";
export type LayoutPlacementType =
  "widget" | "asset" | "playlistZone" | "primitive";
export type LayoutBinding = {
  dataSourceId: string;
  field: string;
  prefix?: string;
  suffix?: string;
  fallbackText?: string;
  hideWhenEmpty?: boolean;
  format?:
    "text" | "date-short" | "date-long" | "number" | "integer" | "currency";
};
export type LayoutPrimitive = {
  kind: "text" | "rectangle" | "circle" | "line" | "group";
  text?: string;
  fontFamily?: "Inter" | "Roboto" | "Source Sans 3" | "Noto Sans";
  fontSize?: number;
  fontWeight?: 400 | 500 | 600 | 700 | 800;
  textAlign?: "left" | "center" | "right";
  verticalAlign?: "top" | "center" | "bottom";
  color?: string;
  backgroundColor?: string;
  lineHeight?: number;
  letterSpacing?: number;
  padding?: number;
  borderWidth?: number;
  borderColor?: string;
  cornerRadius?: number;
  maximumLines?: number;
  overflow?: "clip" | "ellipsis";
  autoFit?: boolean;
  minimumFontSize?: number;
  fillColor?: string;
  strokeColor?: string;
  strokeWidth?: number;
  binding?: LayoutBinding;
};
export type LayoutPlayback = {
  fit?: "contain" | "cover" | "stretch";
  muted?: boolean;
  loop?: boolean;
  fallback?: "hide" | "background" | "previous";
  cornerRadius?: number;
};
export type LayoutPlacement = {
  id: string;
  type: LayoutPlacementType;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  layer: number;
  opacity: number;
  visible: boolean;
  locked: boolean;
  groupId?: string;
  widgetId?: string;
  assetId?: string;
  variantId?: string;
  playlistId?: string;
  overrides?: Record<string, unknown>;
  primitive?: LayoutPrimitive;
  playback?: LayoutPlayback;
};
export type LayoutDocument = {
  schemaVersion: 2;
  canvas: {
    width: number;
    height: number;
    orientation: LayoutOrientation;
    backgroundColor: string;
    backgroundAssetId?: string;
    backgroundVariantId?: string;
    safeAreaPercent: number;
  };
  placements: LayoutPlacement[];
};
export type LayoutDependency = {
  type: "widget" | "asset" | "playlist" | "data_source";
  id: string;
};
export type Layout = {
  id: string;
  name: string;
  description: string;
  orientation: LayoutOrientation;
  canvasWidth: number;
  canvasHeight: number;
  draft: LayoutDocument;
  draftRevision: number;
  publishedRevisionId?: string;
  publishedRevision?: number;
  publishedAt?: string;
  hasUnpublishedChanges: boolean;
  createdAt: string;
  updatedAt: string;
  previewImageUrl?: string;
  dependencies: LayoutDependency[];
  usage: {
    screens: { id: string; name: string }[];
    schedules: { id: string; name: string }[];
    campaigns: { id: string; name: string }[];
  };
};
export type LayoutSummary = Omit<
  Layout,
  "draft" | "dependencies" | "usage" | "publishedRevisionId"
>;
export type LayoutList = {
  items: LayoutSummary[];
  total: number;
  page: number;
  pageSize: number;
};
export type LayoutRevision = {
  id: string;
  layoutId: string;
  revision: number;
  document: LayoutDocument;
  documentSha256: string;
  publishedBy?: string;
  publishedAt: string;
};
export type LayoutRevisionList = {
  items: LayoutRevision[];
  total: number;
  page: number;
  pageSize: number;
};
export type PlaylistItemInput = {
  assetId?: string;
  layoutId?: string;
  durationMs?: number;
  fitMode: PlaylistItem["fitMode"];
  transition: PlaylistItem["transition"];
  audioEnabled: boolean;
  volume: number;
  videoStartOffsetMs?: number;
  videoEndOffsetMs?: number;
  deliveryPolicy: PlaylistItem["deliveryPolicy"];
  usePlayerDefaults?: boolean;
};
export type PlaylistBulkItemUpdateInput =
  | {
      /** Empty or omitted means every item in a static playlist. */
      itemIds?: string[];
      transition: PlaylistItem["transition"];
      durationMs?: never;
    }
  | {
      /** Empty or omitted means every item in a static playlist. */
      itemIds?: string[];
      transition?: never;
      durationMs: number;
    };
export type PlaylistAssignment = {
  screenId: string;
  playlistId?: string;
  playlistName?: string;
  playlistRevision?: number;
  layoutId?: string;
  layoutName?: string;
  layoutRevision?: number;
  presentationType?: "playlist" | "layout";
  manifestVersion: number;
  playerActiveManifestVersion?: number;
  playerPendingManifestVersion?: number;
  synchronizationStatus:
    "not_reported" | "current" | "preparing" | "out_of_date";
  downloadQueueCount?: number;
  downloadedBytes?: number;
  requiredBytes?: number;
  cacheUsedBytes?: number;
  cacheLimitBytes?: number;
  currentItemId?: string;
  currentAssetId?: string;
  playbackState?: string;
  lastSynchronizationError?: string;
  lastPlaybackError?: string;
  currentScheduleId?: string;
  currentPlaylistId?: string;
  selectionSource?: "takeover" | "schedule" | "direct_fallback" | "none";
  nextTransitionAt?: string;
  deviceClockOffsetSeconds?: number;
  scheduleEvaluationError?: string;
  scheduleManifestVersion?: number;
  groups: { id: string; name: string }[];
  relevantSchedules: {
    id: string;
    name: string;
    playlistName: string;
    presentationType: "playlist" | "layout" | "display_control";
    priority: number;
    enabled: boolean;
  }[];
  clockSkewWarningSeconds: number;
  currentWebsiteAssetId?: string;
  websiteState?: string;
  websiteLoadStartedAt?: string;
  websiteLoadCompletedAt?: string;
  websiteFailureCategory?: string;
  websiteBlockedNavigationCount?: number;
  websiteCurrentHost?: string;
  websiteFallbackShown?: boolean;
  websiteRendererRecoveryCount?: number;
  activeTakeoverId?: string;
  takeoverState?: string;
  takeoverPreparationProgress?: number;
  playbackDisabled: boolean;
  lastCommandId?: string;
  lastCommandState?: string;
  lastCommandResult?: string;
  lastCommandCompletedAt?: string;
  activeConfigRevision?: number;
  configurationError?: string;
};

export type PlayerCommand = {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  state: string;
  createdAt: string;
  expiresAt: string;
  deliveredAt?: string;
  acknowledgedAt?: string;
  completedAt?: string;
  resultCode?: string;
  resultMessage?: string;
};

export type ReliabilityStatus = {
  configuredMode?: string;
  effectiveMode?: string;
  foregroundState?: string;
  lastForegroundExitAt?: string;
  lastForegroundPackage?: string;
  bootRecoveryResult?: string;
  lastSuccessfulColdBootAt?: string;
  immersiveModeActive?: boolean;
  keepScreenOn?: boolean;
  managedKioskCapability?: string;
  deviceOwnerState?: string;
  lockTaskState?: string;
  accessibilityServiceState?: string;
  accessibilityReturnState?: string;
  accessibilityReturnAttempts?: number;
  activeHoursState?: string;
  sleepCapability?: string;
  lastSleepRequestResult?: string;
  lastWakeResult?: string;
  recoveryLevel?: number;
  recoveryCount?: number;
  safeMode?: boolean;
  lastWatchdogFailure?: string;
  lastWatchdogRecoveryAt?: string;
  maintenanceSessionExpiresAt?: string;
  commissioningState?: string;
  commissioningStep?: string;
  commissioningCompletedAt?: string;
  cachedFallbackAvailable?: boolean;
  lastHealthyPlaybackAt?: string;
  lastPlaylistTransitionAt?: string;
  lastSuccessfulSyncAt?: string;
  lastServerConnectionAt?: string;
  bootAttemptCount?: number;
  bootLastAttemptAt?: string;
  bootLaunchVerified?: boolean;
  updateReadiness?: string;
  selfTestResult?: string;
  selfTestCompletedAt?: string;
  /** Linux systemd autostart; absent on Android players. */
  autostartState?: string;
  autostartTarget?: string;
  autostartSupervised?: boolean;
  autostartLingerEnabled?: boolean;
  autostartError?: string;
  airplaySupported?: boolean;
  airplayUxPlayInstalled?: boolean;
  airplayUxPlayVersion?: string;
  airplayGstreamerInstalled?: boolean;
  airplayH264DecoderAvailable?: boolean;
  airplayHardwareDecode?: boolean;
  airplayDecoder?: string;
  airplayMaxProfile?: AirplayString<"1080p30" | "720p30" | "unsupported">;
  airplayGroupSupported?: boolean;
  airplayAudioAvailable?: boolean;
  airplayAvahiAvailable?: boolean;
  airplayMdnsAdvertisementAvailable?: boolean;
  airplayMulticastSupported?: boolean;
  airplayMulticastTestStatus?: string;
  airplayLimitation?: string;
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
  wiredInterfaceAvailable?: boolean;
  wiredIpv4?: string;
  externalPresentationState?: string;
  externalPresentationSessionId?: string;
  externalPresentationRole?: string;
  airplayReceiverState?: string;
  airplayTransport?: AirplayString<"unicast" | "multicast">;
  airplayConnected?: boolean;
  externalPresentationExpiresAt?: string;
  displayControlProvider?: string;
  displayControlProviders?: string[];
  displayControlCapabilities?: Record<string, string>;
  displayPowerState?: AirplayString<
    "unknown" | "on" | "off" | "transitioning" | "unsupported"
  >;
  displayPowerStateConfirmed?: boolean;
  displayPowerStateObservedAt?: string;
  displayControlPolicyState?: AirplayString<
    "normal" | "powered_off_by_policy" | "unknown"
  >;
  displayControlLastCommandId?: string;
  displayControlLastCommandState?: string;
  displayControlLastCommandResult?: string;
  displayControlLastCommandSentAt?: string;
  displayControlLastStateConfirmedAt?: string;
  displayControlError?: string;
  powerAssist: PowerAssistResults;
};

type AirplayString<T extends string> = T | (string & {});

export type AirplaySessionScreenState = {
  screenId: string;
  screenName: string;
  role: AirplayString<"single" | "gateway" | "receiver">;
  state: AirplayString<
    | "preparing"
    | "ready"
    | "waiting"
    | "connected"
    | "degraded"
    | "failed"
    | "stopped"
  >;
  lastUpdatedAt: string;
  failureCode?: string;
  failureMessage?: string;
  presentationNetworkState?: string;
};

export type AirplaySession = {
  id: string;
  provider: "airplay";
  status: AirplayString<
    | "preparing"
    | "waiting"
    | "active"
    | "stopping"
    | "ended"
    | "expired"
    | "failed"
  >;
  targetType: "screen" | "group";
  targetId: string;
  gatewayScreenId: string;
  audioScreenId?: string;
  receiverName: string;
  pin?: string;
  expiresAt: string;
  transport: AirplayString<"unicast" | "multicast">;
  videoProfile: AirplayString<"1080p30" | "720p30">;
  audioMode: AirplayString<"gateway_only" | "none">;
  presentationNetworkId?: string;
  presentationNetworkName?: string;
  screenCount: number;
  readyCount: number;
  connectedCount: number;
  failedCount: number;
  createdAt?: string;
  endedAt?: string;
  endReason?: string;
  screens: AirplaySessionScreenState[];
};
export type UptimeWindow = "24h" | "7d" | "30d";
/** A screen spends every measured second in exactly one of these states. */
export type UptimeState = "up" | "impaired" | "down" | "unknown";
export type UptimeBucket = {
  start: string;
  upPercent: number;
  impairedPercent: number;
  downPercent: number;
  unknownPercent: number;
  uptimePercent: number | null;
  screensDown: number;
};
export type UptimeScreen = {
  screenId: string;
  screenName: string;
  uptimePercent: number | null;
  trackedSeconds: number;
  upSeconds: number;
  impairedSeconds: number;
  downSeconds: number;
  buckets: UptimeState[];
};
export type UptimeReport = {
  range: { from: string; to: string };
  window: UptimeWindow;
  windowLabel: string;
  bucketSeconds: number;
  screensTracked: number;
  screensWithDowntime: number;
  /** Screens with no recorded state in the window, excluded from the percent. */
  screensUnmeasured: number;
  trackedSeconds: number;
  upSeconds: number;
  impairedSeconds: number;
  downSeconds: number;
  /** Null until at least one screen has recorded state in the window. */
  uptimePercent: number | null;
  previousUptimePercent: number | null;
  buckets: UptimeBucket[];
  screens: UptimeScreen[];
};

export type PowerAssistResults = {
  deviceSleep: string;
  tvStandby: string;
  deviceWake: string;
  tvWake: string;
  inputSelection: string;
  tilecastStartup: string;
  lastTestedAt?: string;
};

export type Takeover = {
  id: string;
  name: string;
  description: string;
  playlistId: string;
  playlistName: string;
  status: string;
  activatedAt?: string;
  expiresAt: string;
  cancelledAt?: string;
  cancellationReason?: string;
  affectedCount: number;
  activeCount: number;
  preparingCount: number;
  failedCount: number;
};

export type PresentationOverride = {
  id: string;
  targetType: "screen" | "group";
  targetId: string;
  targetName: string;
  contentType: "playlist" | "layout" | "asset";
  contentId: string;
  contentName: string;
  durationSeconds: number;
  startedAt: string;
  expiresAt?: string;
  afterAction: "resume";
  wakeDisplay: boolean;
  stoppedAt?: string;
  stopReason?: string;
};

export type NWSAlertMonitor = {
  enabled: boolean;
  areas: string[];
  zones: string[];
  pollIntervalSeconds: number;
  lastPolledAt?: string;
  lastSuccessAt?: string;
  lastErrorCode?: string;
  lastMatchedCount: number;
  updatedAt: string;
};

export type NWSAlertRule = {
  id: string;
  name: string;
  enabled: boolean;
  eventNames: string[];
  minimumSeverity: "Minor" | "Moderate" | "Severe" | "Extreme";
  minimumUrgency: "Unknown" | "Future" | "Expected" | "Immediate";
  /**
   * How a matching alert reaches the screen: `takeover` replaces what is playing
   * and restores it afterwards, `ticker` leaves playback running and shows the
   * alert as a bar along the bottom.
   */
  responseMode: "takeover" | "ticker";
  presentationMode: "builtin" | "playlist";
  playlistId?: string;
  playlistName?: string;
  tickerDisplayMode: "overlay" | "push";
  tickerHeightPx: number;
  tickerSpeed: "slow" | "medium" | "fast";
  maximumDurationMinutes: number;
  screenIds: string[];
  groupIds: string[];
  createdAt: string;
  updatedAt: string;
};

export type NWSZone = {
  id: string;
  name: string;
  state: string;
  type: "county" | "forecast";
};

export type NWSAlertRuleInput = Omit<
  NWSAlertRule,
  "id" | "playlistName" | "createdAt" | "updatedAt"
>;

export type NWSAlertActivation = {
  alertId: string;
  ruleId: string;
  ruleName: string;
  event: string;
  headline: string;
  severity: string;
  urgency: string;
  areaDescription: string;
  expiresAt?: string;
  takeoverId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
};

export type NWSAlertSettings = {
  monitor: NWSAlertMonitor;
  rules: NWSAlertRule[];
  activeAlerts: NWSAlertActivation[];
};

export type SettingDefinition = {
  key: string;
  category: string;
  type: string;
  title: string;
  description?: string;
  default: unknown;
  min?: number;
  max?: number;
  allowed?: string[];
  scope: "organization" | "policy" | "preference";
  sensitive: boolean;
  restartRequired: boolean;
  immediate: boolean;
  futureOnly: boolean;
};
export type SettingsDocument = {
  schemaVersion: number;
  revision: number;
  values: Record<string, unknown>;
  definitions: SettingDefinition[];
  updatedAt: string;
};
export type PolicyDocument = {
  schemaVersion: number;
  revision: number;
  priority?: number;
  values: Record<string, unknown>;
  updatedAt?: string;
};
export type EffectivePolicy = {
  values: Record<string, { value: unknown; source: string; sourceId?: string }>;
  organizationRevision: number;
  groupRevisions: Record<string, number>;
  screenRevision: number;
  configRevision: number;
  hash: string;
};
export type SystemStatus = {
  tilecastVersion: string;
  buildCommit: string;
  buildDate: string;
  uptimeSeconds: number;
  goVersion: string;
  database: {
    status: string;
    migrationVersion: string;
    postgresVersion: string;
  };
  media: Record<string, unknown>;
  activeProcessingJobs: number;
  pendingCommands: number;
  connectedScreens: number;
  serverTimezone: string;
  deployment: Record<string, unknown>;
};
export type BackupComponent = {
  name: string;
  fileCount: number;
  totalBytes: number;
};
export type BackupArchive = {
  id: string;
  fileName: string;
  kind: string;
  status: string;
  sizeBytes: number;
  archiveSha256: string;
  tilecastVersion: string;
  schemaVersion: number;
  installationId: string;
  organizationName: string;
  components: BackupComponent[];
  verification: string;
  verifiedAt?: string;
  createdAt: string;
};
export type BackupJob = {
  id: string;
  kind: "backup" | "verify" | "restore";
  trigger: string;
  archiveId?: string;
  status: string;
  phase: string;
  progressPercent: number;
  errorCode?: string;
  errorMessage?: string;
  createdAt: string;
  completedAt?: string;
};
export type BackupScheduleState = {
  lastRunAt?: string;
  nextRunAt?: string;
};
export type BackupList = {
  backups: BackupArchive[];
  currentJob?: BackupJob | null;
  recentJobs: BackupJob[];
  lastSuccessful?: BackupArchive | null;
  schedule: BackupScheduleState;
};
export type BackupRestorePlan = {
  archive: BackupArchive;
  organizationName: string;
  installationId: string;
  tilecastVersion: string;
  schemaVersion: number;
  createdAt: string;
  sizeBytes: number;
  components: BackupComponent[];
  identityMismatch: boolean;
  currentInstallationId: string;
};
export type ScreenGroup = {
  id: string;
  name: string;
  description: string;
  /** Added by the Display Groups migration; old servers are normalized to Mirror. */
  displayMode: "mirror" | "span";
  playlistId?: string;
  playlistName?: string;
  layoutId?: string;
  layoutName?: string;
  presentationType?: "playlist" | "layout";
  presentationGatewayScreenId?: string;
  playbackEpoch: string;
  membershipCount: number;
  screens: { id: string; name: string; location: string }[];
  createdAt: string;
  updatedAt: string;
};
export type SpanPanel = {
  screenId: string;
  screenName?: string;
  order: number;
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: 0 | 90 | 180 | 270;
  bezelLeft: number;
  bezelTop: number;
  bezelRight: number;
  bezelBottom: number;
};
export type SpanStatus = {
  groupId: string;
  displayMode: "mirror" | "span";
  geometry: {
    canvas: { width: number; height: number };
    panels: SpanPanel[];
  };
  preparations: {
    id: string;
    screenId: string;
    sourceAssetId: string;
    sourceVariantId: string;
    status: "queued" | "processing" | "ready" | "failed";
    progress?: number;
    width?: number;
    height?: number;
    durationSeconds?: number;
    frameRate?: number;
    errorCode?: string;
    errorMessage?: string;
    updatedAt: string;
  }[];
};
export type DisplayControlGroupScreen = {
  screenId: string;
  name: string;
  provider: string;
  capabilities: Record<string, string>;
  supported: boolean;
  eligible: boolean;
  reason?: string;
};
export type DisplayControlGroupPreview = {
  groupId: string;
  groupName: string;
  commandType:
    | "display_power_on"
    | "display_power_off"
    | "display_mute"
    | "display_unmute";
  selectedCount: number;
  supportedCount: number;
  unsupportedCount: number;
  eligibleCount: number;
  fingerprint: string;
  screens: DisplayControlGroupScreen[];
};
export type DisplayControlGroupApplyResult = {
  groupId: string;
  commandType: DisplayControlGroupPreview["commandType"];
  selectedCount: number;
  supportedCount: number;
  queuedCount: number;
  failedCount: number;
  unsupportedCount: number;
  results: {
    screenId: string;
    name: string;
    state: "queued" | "skipped" | "failed";
    reason?: string;
    id?: string;
  }[];
};
export type ScreenGroupList = {
  items: ScreenGroup[];
  total: number;
  page: number;
  pageSize: number;
};

export type PluginSummary = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  instanceCount: number;
};

export type DependencyNodeType =
  | "data_source"
  | "asset"
  | "widget"
  | "layout"
  | "playlist"
  | "campaign"
  | "schedule"
  | "screen_group"
  | "screen";

export type DependencyNode = {
  id: string;
  type: DependencyNodeType;
  name: string;
};

export type DependencyEdge = {
  fromType: DependencyNodeType;
  fromId: string;
  toType: DependencyNodeType;
  toId: string;
  relationship: string;
};

export type DependencyGraph = {
  nodes: DependencyNode[];
  edges: DependencyEdge[];
};

export type PluginTargetScope = "all" | "screens" | "sync_groups" | "locations";

export type PluginTargeting = {
  targetScope: PluginTargetScope;
  targetIds: string[];
};

export type CountdownBarInput = {
  name: string;
  message: string;
  scheduleType: "weekly" | "one_time";
  targetTime?: string;
  daysOfWeek: number[];
  oneTimeAt?: string;
  timezone: string;
  leadTimeSeconds: number;
  completionText: string;
  showConfetti: boolean;
  displayMode: "overlay" | "push";
  heightPx: number;
  progressFill: "none" | "drain";
  contentPadding: number;
  textScale: number;
  urgencyEnabled: boolean;
  startingSoonSeconds: number;
  urgentSeconds: number;
  pulseSeconds: number;
  enabled: boolean;
  priority: number;
} & PluginTargeting;

export type CountdownBar = CountdownBarInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type BrandBugCorner =
  "top_left" | "top_right" | "bottom_left" | "bottom_right";

export type BrandBugInput = {
  name: string;
  corner: BrandBugCorner;
  imageAssetId?: string | null;
  text: string;
  /** Logo width as a percentage of screen width. */
  widthPercent: number;
  /** Caption size as a percentage of screen height. */
  textSizePercent: number;
  opacityPercent: number;
  /** Corner inset as a percentage of the screen's shorter edge. */
  marginPercent: number;
  textColor: string;
  backgroundStyle: "none" | "scrim";
  startsAt?: string | null;
  endsAt?: string | null;
  enabled: boolean;
  priority: number;
} & PluginTargeting;

export type BrandBug = BrandBugInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type NoiseMeterInput = {
  name: string;
  /** Replaces the bar's own TOO LOUD label when set. */
  message: string;
  /**
   * Points on the relative 0-100 noise scale. They are measured against the
   * Player's own microphone and are not calibrated decibels of any kind.
   */
  warningLevel: number;
  loudLevel: number;
  /** Percentage applied to the captured signal before it is normalized. */
  sensitivity: number;
  triggerHoldMs: number;
  clearHoldMs: number;
  displayMode: "overlay" | "push";
  heightPx: number;
  /**
   * History keeps derived ten-second measurements for graphs and reports.
   * Microphone audio is never recorded or uploaded, so nothing here can turn
   * it on.
   */
  historyEnabled: boolean;
  historyRetentionDays: number;
  historyActiveHoursOnly: boolean;
  /**
   * The optional window during which the bar may appear. It governs the bar
   * alone — measurement and history keep their own rules — and an end at or
   * before the start is an overnight window.
   */
  scheduleEnabled: boolean;
  /** Sunday 0 through Saturday 6. */
  scheduleDaysOfWeek: number[];
  scheduleStartTime?: string | null;
  scheduleEndTime?: string | null;
  scheduleTimezone: string;
  enabled: boolean;
} & PluginTargeting;

export type NoiseMeter = NoiseMeterInput & {
  id: string;
  createdAt: string;
  updatedAt: string;
};

export type NoiseHistoryRange = "today" | "yesterday" | "7d" | "30d";

export type NoiseHistoryScreen = {
  screenId: string;
  name: string;
  buckets: number;
  firstAt?: string;
  lastAt?: string;
};

export type NoiseHistoryPoint = {
  at: string;
  averageLevel: number;
  peakLevel: number;
  monitoredMs: number;
  warningMs: number;
  loudMs: number;
  triggerCount: number;
};

export type NoiseHistoryDay = {
  date: string;
  averageLevel: number;
  peakLevel: number;
  monitoredMs: number;
  warningMs: number;
  loudMs: number;
  triggerCount: number;
};

/** Descriptive statistics only: no score, grade, or ranking. */
export type NoiseHistorySummary = {
  buckets: number;
  averageLevel: number | null;
  peakLevel: number | null;
  monitoredMs: number;
  normalMs: number;
  warningMs: number;
  loudMs: number;
  warningEvents: number;
  longestLoudMs: number;
  loudestWindowAt?: string;
  loudestWindowLevel?: number;
  firstAt?: string;
  lastAt?: string;
};

export type NoiseHistoryWindow = {
  key: NoiseHistoryRange;
  from: string;
  to: string;
};
export type ScheduleTarget = {
  type: "screen" | "group";
  id: string;
  name?: string;
};
export type DisplayControlAction = {
  type:
    | "display_power_on"
    | "display_power_off"
    | "display_set_input"
    | "display_set_volume"
    | "display_mute"
    | "display_unmute"
    | "display_set_brightness";
  input?: string;
  volume?: number;
  brightness?: number;
};
export type Schedule = {
  id: string;
  name: string;
  description: string;
  playlistId?: string;
  playlistName: string;
  layoutId?: string;
  layoutName?: string;
  presentationType: "playlist" | "layout" | "display_control";
  type: "one_time" | "weekly";
  timezone: string;
  priority: number;
  specificity: number;
  enabled: boolean;
  startDate?: string;
  endDate?: string;
  oneTimeStart?: string;
  oneTimeEnd?: string;
  dailyStart?: string;
  dailyEnd?: string;
  daysOfWeek: number[];
  displayAction?: DisplayControlAction;
  targets: ScheduleTarget[];
  createdAt: string;
  updatedAt: string;
};
export type ScheduleInput = Omit<
  Schedule,
  | "id"
  | "playlistName"
  | "layoutName"
  | "presentationType"
  | "specificity"
  | "createdAt"
  | "updatedAt"
>;
export type ScheduleList = {
  items: Schedule[];
  total: number;
  page: number;
  pageSize: number;
  defaultTimezone: string;
};
export type SchedulePreview = {
  screenId: string;
  at: string;
  winningSchedule?: Schedule;
  winningPlaylistId?: string;
  directFallbackPlaylistId?: string;
  applicableSchedules: Schedule[];
  nextTransition?: string;
  conflicts: string[];
};

export type PlayerPlatform = "android" | "linux";
export type PlayerRelease = {
  id: string;
  tag: string;
  platform: PlayerPlatform;
  source: "github" | "upload";
  channel: "stable" | "beta";
  versionCode: number;
  versionName: string;
  minimumSdk: number | null;
  releaseNotes: string;
  publishedAt: string;
  apkSizeBytes: number;
  downloadedBytes: number;
  apkSha256: string;
  signingCertificateSha256: string;
  manifestSignature: string;
  cacheStatus: "missing" | "downloading" | "cached" | "failed";
  verificationStatus: "verified_manifest" | "verified" | "failed";
  verificationError?: string;
  // Deployment history holds a reference to the release, so a release that has
  // ever been deployed can only give up its cached artifact, never its record.
  deploymentCount: number;
  activeDeploymentCount: number;
};
export type PlayerReleaseImport = Pick<
  PlayerRelease,
  | "id"
  | "platform"
  | "source"
  | "versionCode"
  | "versionName"
  | "channel"
  | "apkSizeBytes"
  | "releaseNotes"
  | "cacheStatus"
  | "verificationStatus"
> & { duplicate: boolean };
export type PlayerReleaseList = {
  repository: string;
  lastCheckedAt?: string;
  providerError?: string;
  manifestKeyConfigured: boolean;
  githubAuth: GitHubAuthStatus;
  items: PlayerRelease[];
};
export type GitHubAuthStatus = {
  available: boolean;
  connected: boolean;
  source: "anonymous" | "device" | "environment";
  login?: string;
  canDisconnect: boolean;
};
export type GitHubDeviceStart = {
  flowId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  pollIntervalSeconds: number;
};
export type GitHubDevicePoll = {
  status: "pending" | "connected" | "denied" | "expired";
  login?: string;
  retryAfterSeconds?: number;
};
export type UpdateDeployment = {
  id: string;
  name: string;
  mode: string;
  status: string;
  createdAt: string;
  platform: PlayerPlatform;
  versionCode: number;
  versionName: string;
  targetCount: number;
  succeededCount: number;
  failedCount: number;
  waitingForUserCount: number;
  rolloutMode?: string;
  rolloutPhase?: string;
  canarySize?: number;
  pauseReason?: string;
  lastFailure?: string;
};
export type UpdateDeploymentScreenState =
  | "held"
  | "pending"
  | "offline"
  | "downloading"
  | "downloaded"
  | "verifying"
  | "ready"
  | "waiting_for_permission"
  | "waiting_for_user"
  | "installing"
  | "reconnecting"
  | "succeeded"
  | "failed"
  | "cancelled"
  | "incompatible"
  | "already_current";
export type UpdateDeploymentScreen = {
  screenId: string;
  screenName: string;
  previousVersionCode: number | null;
  expectedVersionCode: number;
  downloadedBytes: number;
  permissionStatus?: string;
  installerStatus?: string;
  state: UpdateDeploymentScreenState;
  safeError?: string;
  updatedAt: string;
  isCanary: boolean;
  downloadStartedAt?: string;
  downloadedAt?: string;
  installStartedAt?: string;
  completedAt?: string;
};
// The detail read repeats the deployment header so a drawer can render without
// the list row, and adds the artifact size that turns reported bytes into a
// download percentage.
export type UpdateDeploymentDetail = {
  id: string;
  name: string;
  mode: string;
  status: string;
  createdAt: string;
  completedAt?: string;
  platform: PlayerPlatform;
  versionCode: number;
  versionName: string;
  artifactSizeBytes: number;
  rolloutMode: string;
  rolloutPhase: string;
  canarySize: number;
  pauseReason?: string;
  screens: UpdateDeploymentScreen[];
};

export type PairingRequest = {
  id: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  previouslyPaired: boolean;
  existingScreenId?: string;
  existingScreenName?: string;
  hasActiveCredential: boolean;
  credentialReplacementAuthorized: boolean;
  pairingMode?: "new_screen" | "credential_repair" | "hardware_replacement";
  metadata: {
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
    approximateAddress?: string;
  };
};

export type PlayerHistory = {
  id: string;
  screenId: string;
  credentialId?: string;
  installationId: string;
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
  pairedAt: string;
  retiredAt?: string;
  retirementReason?: string;
};

export type AssetStatus =
  | "uploading"
  | "uploaded"
  | "queued"
  | "inspecting"
  | "processing"
  | "ready"
  | "failed"
  | "deleting"
  | "deleted";

export type AssetVariant = {
  id: string;
  kind: "original" | "playback" | "thumbnail" | "poster";
  mimeType: string;
  fileSize: number;
  sha256: string;
  width?: number;
  height?: number;
  durationSeconds?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  playerCompatible: boolean;
  createdAt: string;
};

export type Asset = {
  id: string;
  name: string;
  description: string;
  type: "image" | "video" | "widget";
  originalFilename: string;
  declaredMimeType: string;
  detectedMimeType: string;
  sha256: string;
  originalSize: number;
  width?: number;
  height?: number;
  durationSeconds?: number;
  frameRate?: number;
  videoCodec?: string;
  audioCodec?: string;
  audioChannels?: number;
  metadata: Record<string, unknown>;
  processingStatus: AssetStatus;
  processingProgress?: number;
  errorCode?: string;
  errorMessage?: string;
  creator?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  availableFrom?: string;
  expiresAt?: string;
  archivedAt?: string;
  variants: AssetVariant[];
  thumbnailUrl?: string;
  website?: WebsiteConfig;
  widget?: Widget;
  playlistUsage?: number;
  // Identified playlists containing this asset. The list endpoint reports only the
  // playlistUsage count; the detail endpoint populates this so Studio can link through.
  playlistsUsing?: { id: string; name: string }[];
  layoutUsage?: { id: string; name: string; published: boolean }[];
  folderId?: string;
  tags?: ContentTag[];
  collectionIds?: string[];
};
export type ContentFolder = {
  id: string;
  parentId?: string;
  name: string;
  description: string;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
};
export type ContentCollection = {
  id: string;
  name: string;
  description: string;
  assetCount: number;
  createdAt: string;
  updatedAt: string;
};
export type ContentTag = {
  id: string;
  name: string;
  color: string;
  assetCount?: number;
};
export type BulkOrganizeInput = {
  assetIds: string[];
  setFolder?: boolean;
  folderId?: string;
  addTagIds?: string[];
  removeTagIds?: string[];
  addCollectionIds?: string[];
  removeCollectionIds?: string[];
};
// Legacy provider IDs are the Widgets whose Studio editors and Player renderers predate
// the release-defined content catalog. New release-defined Widgets arrive through the
// catalog at runtime and must NOT be added here; the open `string` member keeps their IDs
// assignable without editing this file.
export type LegacyWidgetProvider =
  | "website"
  | "youtube"
  | "clock"
  | "date"
  | "qrcode"
  | "countdown"
  | "ticker"
  | "menu"
  | "list"
  | "table"
  | "agenda"
  | "metric"
  | "cards"
  | "weather"
  | "spotlight"
  | "stat_grid"
  | "chart"
  | "progress"
  | "timeline"
  | "world_clock";
// WidgetProvider accepts any catalog-provided ID while preserving autocomplete for the
// known legacy IDs. `(string & {})` keeps the legacy literals in editor suggestions.
export type WidgetProvider = LegacyWidgetProvider | (string & {});
export type LegacyDataSourceProvider =
  | "calendar"
  | "rss"
  | "atom"
  | "json"
  | "csv"
  | "manual"
  | "weather"
  | "transit"
  | "cap_alerts"
  | "air_quality";
export type DataSourceProvider = LegacyDataSourceProvider | (string & {});

// --- Form Data Sources ---
// These mirror the server JSON contracts in apps/server/internal/forms/types.go.

export type FormCapability =
  "manage" | "submit" | "view_own" | "view_all" | "review" | "approve";

export type FormFieldControl =
  | "short_text"
  | "long_text"
  | "number"
  | "integer"
  | "boolean"
  | "select"
  | "multi_select"
  | "date"
  | "datetime"
  | "url"
  | "image"
  | "section"
  | "help_text";

export type FormSelectOption = { value: string; label: string };

export type FormField = {
  key: string;
  label: string;
  description?: string;
  control: FormFieldControl;
  required?: boolean;
  default?: string;
  options?: FormSelectOption[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
};

export type FormSchema = {
  title?: string;
  description?: string;
  fields: FormField[];
};

export type FormRevision = {
  id: string;
  dataSourceId: string;
  revisionNumber: number;
  title: string;
  description: string;
  schema: FormSchema;
  publishedAt: string;
};

export type FormWorkflowState = {
  key: string;
  label: string;
  position: number;
  eligibleForOutput: boolean;
  initial: boolean;
  terminal: boolean;
  // Read-only usage decoration from GetForm: how many records are in the state, and whether the
  // state key may still be renamed/removed (false once any record references it).
  recordCount?: number;
  removable?: boolean;
};

export type FormWorkflowTransition = {
  from: string;
  to: string;
  label: string;
  requiredCapability: FormCapability;
  position: number;
};

export type FormWorkflow = {
  states: FormWorkflowState[];
  transitions: FormWorkflowTransition[];
};

export type FormFilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "empty"
  | "not_empty"
  | "greater_than"
  | "less_than";

export type FormSortDirection = "asc" | "desc";

export type FormView = {
  id: string;
  key: string;
  name: string;
  includedStates: string[];
  fieldFilters: {
    field: string;
    operator: FormFilterOperator;
    value: string;
  }[];
  timeFilter: {
    enabled: boolean;
    startField?: string;
    endField?: string;
    startBeforeNow?: boolean;
    endAfterNow?: boolean;
  };
  sort: { field: string; direction: FormSortDirection }[];
  outputFields: string[];
  recordLimit: number;
  position: number;
};

export type FormDataSource = {
  id: string;
  name: string;
  description: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  draftSchema: FormSchema;
  publishedRevision?: FormRevision;
  workflow: FormWorkflow;
  views: FormView[];
  grantedCapabilities: FormCapability[];
};

// --- Studio 2C: views, outputs, access ---

// FormViewInput is the create/update/preview payload for a saved view.
export type FormViewInput = {
  key: string;
  name: string;
  includedStates: string[];
  fieldFilters: {
    field: string;
    operator: FormFilterOperator;
    value: string;
  }[];
  timeFilter: {
    enabled: boolean;
    startField?: string;
    endField?: string;
    startBeforeNow?: boolean;
    endAfterNow?: boolean;
  };
  sort: { field: string; direction: FormSortDirection }[];
  outputFields: string[];
  recordLimit: number;
  position: number;
};

// FormTypedField / FormTypedRecord / FormTypedDataset mirror the server's typed-dataset shapes
// returned by the view preview and the Outputs tab.
export type FormTypedField = { key: string; label: string; type: string };
export type FormTypedRecord = { id: string; values: Record<string, string> };
export type FormTypedDataset = {
  id: string;
  kind: string;
  fields?: FormTypedField[];
  records?: FormTypedRecord[];
};

export type FormOutputUsage = {
  widgets: number;
  layouts: number;
  names: string[];
};

export type FormOutputView = {
  key: string;
  name: string;
  fields: FormTypedField[];
  recordCount: number;
  previewRecords: FormTypedRecord[];
  usage: FormOutputUsage;
};

export type FormOutputs = {
  views: FormOutputView[];
  lastSuccessAt?: string | null;
  nextRefreshAt?: string | null;
  usingCachedData: boolean;
  errorCode?: string | null;
  stale: boolean;
};

export type FormAccessEntry = {
  userId: string;
  name: string;
  username: string;
  role: string;
  capabilities: FormCapability[];
  isCreator: boolean;
  isGlobalOwner: boolean;
};

export type FormDirectoryUser = {
  id: string;
  name: string;
  username: string;
  role: string;
};

export type CreateFormInput = {
  name: string;
  description: string;
  draftSchema: FormSchema;
};

export type FormMetadataInput = { name: string; description: string };

// --- Form submissions, records, approvals (Studio 2B) ---

// SubmissionCounts buckets a user's own submissions by workflow-derived meaning.
export type FormSubmissionCounts = {
  draft: number;
  submitted: number;
  changesRequested: number;
  total: number;
};

// FormSummary is a lightweight accessible-form entry for the Forms portal and navigation.
export type FormSummary = {
  id: string;
  name: string;
  description: string;
  publishedRevisionNumber?: number;
  grantedCapabilities: FormCapability[];
  submissionCounts: FormSubmissionCounts;
};

// FormRecord is one submission row.
export type FormRecord = {
  id: string;
  dataSourceId: string;
  revisionId: string;
  state: string;
  values: Record<string, unknown>;
  submittedBy?: string;
  submitterName: string;
  displayTitle: string;
  priority: number;
  displayAt?: string | null;
  expiresAt?: string | null;
  eligible: boolean;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type FormRecordPage = {
  items: FormRecord[];
  total: number;
  page: number;
  pageSize: number;
};

export type FormRecordEvent = {
  id: string;
  eventType: string;
  fromState?: string;
  toState?: string;
  actorName?: string;
  note?: string;
  createdAt: string;
};

export type FormRecordComment = {
  id: string;
  authorName: string;
  body: string;
  createdAt: string;
};

export type FormAttachment = {
  id: string;
  assetId: string;
  fieldKey: string;
};

// FormAvailableTransition is a workflow transition the server has authorized for the viewer.
export type FormAvailableTransition = {
  to: string;
  toLabel: string;
  label: string;
  requiredCapability: FormCapability;
  requiresNote: boolean;
};

// FormRecordDetail is a record decorated server-side with its immutable revision and the exact
// actions the viewer may take, so the UI never re-implements authorization.
export type FormRecordDetail = FormRecord & {
  revision?: FormRevision;
  events: FormRecordEvent[];
  comments: FormRecordComment[];
  attachments: FormAttachment[];
  canEdit: boolean;
  canComment: boolean;
  canDelete: boolean;
  availableTransitions: FormAvailableTransition[];
};

export type FormApprovalItem = {
  recordId: string;
  dataSourceId: string;
  formName: string;
  title: string;
  submitterName: string;
  state: string;
  stateLabel: string;
  displayAt?: string | null;
  expiresAt?: string | null;
  submittedAt: string;
};

export type FormApprovalPage = {
  items: FormApprovalItem[];
  total: number;
  page: number;
  pageSize: number;
};

// Tri-state display-metadata fields for record create/update. `undefined` (omitted) preserves the
// stored value, `null` clears it, and a value sets it — mirroring the server's Optional[T] contract.
export type FormRecordInput = {
  values: Record<string, unknown>;
  displayTitle?: string | null;
  priority?: number | null;
  displayAt?: string | null;
  expiresAt?: string | null;
  version?: number;
};

export type FormRecordListParams = {
  states?: string[];
  search?: string;
  sort?: "newest" | "oldest" | "priority" | "updated";
  // mine scopes the list to the caller's own submissions server-side (used by the Forms portal).
  mine?: boolean;
  page?: number;
  pageSize?: number;
};

export type ContentDefinitionField = {
  key: string;
  label: string;
  description?: string;
  control:
    | "text"
    | "multiline_text"
    | "number"
    | "integer"
    | "boolean"
    | "select"
    | "color"
    | "date"
    | "datetime"
    | "timezone"
    | "url"
    | "data_source"
    | "data_source_field"
    | "media_asset"
    | "repeating_group";
  required?: boolean;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  options?: { value: string; label: string }[];
  acceptedDataSourceKinds?: string[];
  requiredFields?: Record<string, string>;
  dataSourceFieldTypes?: string[];
  // For a `data_source_field` control: the key of the `data_source` control whose selected
  // source supplies this field list. A definition with exactly one `data_source` field may omit
  // it. Required to disambiguate when a definition references more than one Data Source.
  dataSourceKey?: string;
  mediaTypes?: string[];
  maximumItems?: number;
  itemFields?: ContentDefinitionField[];
};
export type WidgetDefinition = {
  id: WidgetProvider;
  version: number;
  name: string;
  description: string;
  category: string;
  icon: string;
  /**
   * Names the catalog preview drawn for this Widget. Unknown and missing names fall back
   * to a generic preview, so a new definition never breaks the gallery.
   */
  thumbnail?: string;
  kind?: "widget" | "app";
  featured?: boolean;
  keywords?: string[];
  availability?: { enabled?: boolean; reason?: string };
  runtime: "native" | "web";
  configurationSchema: { fields: ContentDefinitionField[] };
  defaultConfiguration: Record<string, unknown>;
  presentationSchemaVersion: number;
  requiredCapabilities: Record<string, number>;
  emptyStateBehavior: string;
  legacyEditor?: boolean;
  requiresManifestV13?: boolean;
  setup?: ContentDefinitionSetup;
};
export type ContentDefinitionSetup = {
  eyebrow?: string;
  tip?: string;
  steps?: string[];
  emptyState?: string;
};
export type DataSourceDefinition = {
  id: DataSourceProvider;
  version: number;
  name: string;
  description: string;
  category: string;
  icon: string;
  configurationSchema: { fields: ContentDefinitionField[] };
  defaultConfiguration: Record<string, unknown>;
  outputSchema: {
    kind: "scalar" | "records" | "time_series" | "list" | "object";
    fields: { key: string; label: string; type: string; required?: boolean }[];
  };
  adapterId: string;
  refreshBehavior: string;
  attribution?: string;
  legacyEditor?: boolean;
  requiresManifestV13?: boolean;
  setup?: ContentDefinitionSetup;
};
export type ContentDefinitionCatalog = {
  revision: string;
  compilerVersion: string;
  fingerprint: string;
  widgets: WidgetDefinition[];
  dataSources: DataSourceDefinition[];
};
export type ProviderCatalogEntry = {
  id: WidgetProvider | DataSourceProvider;
  role: "widget" | "data_source";
  label: string;
  group: string;
  description: string;
  presentationKind?: "native" | "web";
  capabilities: Record<string, boolean>;
  requiredCapabilities?: Record<string, number>;
  uiHints: Record<string, string>;
};
export type ProviderCatalog = {
  revision: number;
  providers: ProviderCatalogEntry[];
};
export type PresentationBinding = {
  source: "literal" | "dataset" | "repeat" | "repeat_index" | "environment";
  dataset?: string;
  path?: string;
  selector?: "all" | "current" | "next" | "upcoming" | "current_or_next";
  startField?: string;
  endField?: string;
  value?: string;
  fields?: string[];
  format?: string;
  precision?: number;
  prefix?: string;
  suffix?: string;
  fallback?: string;
  separator?: string;
};
export type PresentationNode = {
  id?: string;
  type: string;
  props?: Record<string, unknown>;
  binding?: PresentationBinding;
  repeat?: {
    dataset: string;
    limit: number;
    offset?: number;
    selector?: "all" | "current" | "next" | "upcoming" | "current_or_next";
    startField?: string;
    endField?: string;
  };
  condition?: {
    binding: PresentationBinding;
    op:
      | "equals"
      | "not_equals"
      | "empty"
      | "not_empty"
      | "greater_than"
      | "greater_or_equal"
      | "less_than"
      | "less_or_equal"
      | "before"
      | "after";
    value?: string;
  };
  children?: PresentationNode[];
};
export type WidgetPresentation = {
  schemaVersion: 1;
  kind: "native" | "web";
  requiredCapabilities: Record<string, number>;
  native?: { root: PresentationNode };
  web?: {
    mode: "remote" | "bundle";
    url?: string;
    allowedHosts: string[];
    onlineOnly: boolean;
    lifecycle: "destroy_on_hide" | "keep_warm";
  };
};
export type Widget = {
  provider: WidgetProvider;
  presetId?: WidgetPreset;
  configVersion: number;
  authorConfiguration?: Record<string, unknown>;
  managedDataSourceId?: string;
  configuration:
    | WebsiteConfig
    | YouTubeConfig
    | ClockWidgetConfig
    | DateWidgetConfig
    | QRCodeWidgetConfig
    | CountdownWidgetConfig
    | TickerWidgetConfig
    | DisplayWidgetConfig
    | MetricWidgetConfig
    | CardsWidgetConfig
    | WeatherWidgetConfig
    | SpotlightWidgetConfig
    | StatGridWidgetConfig
    | ChartWidgetConfig
    | ProgressWidgetConfig
    | TimelineWidgetConfig
    | WorldClockWidgetConfig
    | Record<string, unknown>;
};
export type WidgetPreset =
  | "leaderboard"
  | "status_board"
  | "queue_board"
  | "schedule_departures"
  | "opening_hours"
  | "directory";
export type WidgetInput = {
  provider: WidgetProvider;
  presetId?: WidgetPreset;
  name: string;
  description: string;
  configuration:
    | WebsiteConfigInput
    | YouTubeConfig
    | ClockWidgetConfig
    | DateWidgetConfig
    | QRCodeWidgetConfig
    | CountdownWidgetConfig
    | TickerWidgetConfig
    | DisplayWidgetConfig
    | MetricWidgetConfig
    | CardsWidgetConfig
    | WeatherWidgetConfig
    | SpotlightWidgetConfig
    | StatGridWidgetConfig
    | ChartWidgetConfig
    | ProgressWidgetConfig
    | TimelineWidgetConfig
    | WorldClockWidgetConfig
    | Record<string, unknown>;
};
export type DataSourceField = {
  key: string;
  label: string;
  type: string;
};
export type DataSource = {
  id: string;
  provider: DataSourceProvider;
  name: string;
  description: string;
  configVersion: number;
  configuration:
    | CalendarConfig
    | StructuredSourceConfig
    | ManualSourceConfig
    | WeatherSourceConfig
    | TransitSourceConfig
    | CAPAlertsSourceConfig
    | AirQualitySourceConfig
    | Record<string, unknown>;
  status: string;
  cachedRecordCount: number;
  createdAt: string;
  updatedAt: string;
  creator?: { id: string; name: string };
};
export type DataSourceDetail = {
  id: string;
  provider: DataSourceProvider;
  name: string;
  description: string;
  configVersion: number;
  configuration:
    | CalendarConfig
    | StructuredSourceConfig
    | ManualSourceConfig
    | WeatherSourceConfig
    | TransitSourceConfig
    | CAPAlertsSourceConfig
    | AirQualitySourceConfig
    | Record<string, unknown>;
  creator?: { id: string; name: string };
  createdAt: string;
  updatedAt: string;
  status: string;
  diagnostics: SourceRefreshDiagnostics;
  fields: DataSourceField[];
  dateSelection?: DateSelection;
  cachedRecordCount: number;
  widgetUsage: { id: string; name: string; provider: WidgetProvider }[];
  bindingUsage: { layoutId: string; layoutName: string; field: string }[];
};
export type DataSourceInput = {
  provider: DataSourceProvider;
  name: string;
  description: string;
  configuration:
    | CalendarConfig
    | StructuredSourceConfig
    | ManualSourceConfig
    | WeatherSourceConfig
    | TransitSourceConfig
    | CAPAlertsSourceConfig
    | AirQualitySourceConfig
    | Record<string, unknown>;
};
export type DataSourceListResult = {
  items: DataSource[];
  total: number;
  page: number;
  pageSize: number;
};
export type StructuredSourceConfig = {
  url?: string;
  uploadedContent?: string;
  uploaded?: boolean;
  presentation: "list" | "agenda" | "cards" | "ticker";
  maxItems: number;
  fields: {
    title: boolean;
    subtitle: boolean;
    date: boolean;
    author: boolean;
    description: boolean;
    image: boolean;
    link: boolean;
  };
  filterKeyword?: string;
  sort: "newest" | "oldest" | "title" | "source";
  mapping?: {
    rootList: string;
    title: string;
    subtitle: string;
    date: string;
    imageUrl: string;
    link: string;
    valueFields?: Record<string, string>;
    // The type of each mapped value, keyed by its label. A Widget field picker offers a
    // field only where its type fits the slot, so a mapped timestamp left as text is a
    // field no time-based Widget can select.
    valueFieldTypes?: Record<string, StructuredValueType>;
  };
  delimiter?: "" | "," | ";" | "\t" | "|";
  filters?: { field: string; operator: "equals" | "contains"; value: string }[];
  refreshIntervalSeconds: number;
  stalenessLimitHours: number;
  emptyState: string;
  dateSelection: DateSelection;
};
export type StructuredValueType =
  "text" | "number" | "date" | "datetime" | "url";
// The fields a connected RSS, Atom, JSON, or CSV Source was found to contain, and what
// each holds. Studio maps display slots to these instead of asking an author to recall
// column names or pointers, and stores the type so a Widget picker can filter on it.
export type StructuredField = {
  key: string;
  label: string;
  samples: string[];
  type: StructuredValueType;
};
export type StructuredInspection = {
  provider: DataSourceProvider;
  fields: StructuredField[];
  rowCount: number;
  delimiter?: string;
  suggested: NonNullable<StructuredSourceConfig["mapping"]>;
  available: StructuredSourceConfig["fields"];
};
export type DateSelection = {
  enabled: boolean;
  dateFormat:
    "auto" | "iso_date" | "us_date" | "us_short" | "day_month_name" | "rfc3339";
  timezone: string;
  mode:
    "today" | "tomorrow" | "next_available" | "current_week" | "custom_range";
  customStartDate?: string;
  customEndDate?: string;
  excludePast: boolean;
  noMatchBehavior:
    "fallback_text" | "next_available" | "empty" | "hide" | "last_known_good";
  fallbackText?: string;
};
export type ManualColumn = {
  key: string;
  label: string;
  type:
    | "text"
    | "number"
    | "integer"
    | "percent"
    | "currency"
    | "boolean"
    | "date"
    | "datetime"
    | "url";
  currency?: string;
};
export type ManualSourceConfig = {
  columns: ManualColumn[];
  rows: { id: string; values: Record<string, string> }[];
  dateField?: string;
  dateSelection: DateSelection;
};
export type WeatherSourceConfig = {
  locationLabel: string;
  latitude: number;
  longitude: number;
  timezone: string;
  units: "metric" | "imperial";
  forecastDays: number;
  contact: string;
  refreshIntervalSeconds: number;
  stalenessLimitHours: number;
};
export type TransitSourceConfig = {
  staticUrl: string;
  tripUpdatesUrl: string;
  serviceAlertsUrl?: string;
  stopIds: string[];
  routeIds?: string[];
  timezone: string;
  maximumDepartures: number;
  realtimeRefreshSeconds: number;
  staticRefreshHours: number;
  stalenessLimitMinutes: number;
};
export type CAPAlertsSourceConfig = {
  url: string;
  feedMode: "auto" | "cap" | "index";
  preferredLanguage?: string;
  minimumSeverity: "unknown" | "minor" | "moderate" | "severe" | "extreme";
  includeAreaKeywords?: string[];
  excludeAreaKeywords?: string[];
  maximumAlerts: number;
  refreshIntervalSeconds: number;
  stalenessLimitHours: number;
};
export type AirQualitySourceConfig = {
  locationLabel: string;
  latitude: number;
  longitude: number;
  timezone: string;
  aqiStandard: "us" | "european";
  pollutants: string[];
  forecastHours: number;
  nonCommercialAccepted: boolean;
  refreshIntervalSeconds: number;
  stalenessLimitHours: number;
};
export type TypedRecordData = {
  fields: DataSourceField[];
  records: { id: string; values: Record<string, string> }[];
  cachedAt?: string;
  staleAt?: string;
  usingCachedData: boolean;
  unavailable: boolean;
  dateSelection?: DateSelection;
  dateField?: string;
  attribution?: string;
};
export type TypedDatasetPayload = {
  datasets: {
    id: string;
    kind: "records" | "time_series" | "object";
    fields?: DataSourceField[];
    records?: { id: string; values: Record<string, string> }[];
    points?: { at: string; values: Record<string, string> }[];
    values?: Record<string, string>;
    attribution?: string;
  }[];
};
export type ClockWidgetConfig = {
  timezone: string;
  format: "12" | "24";
  showSeconds: boolean;
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type DateWidgetConfig = {
  timezone: string;
  format: "full" | "long" | "medium" | "short";
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type QRCodeWidgetConfig = {
  value: string;
  label?: string;
  errorCorrection: "low" | "medium" | "quartile" | "high";
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type CountdownWidgetConfig = {
  target: string;
  timezone: string;
  mode: "countdown" | "count_up";
  recurrence: "none" | "daily" | "weekly" | "monthly" | "yearly";
  layout: "stacked" | "horizontal" | "countdown_only";
  label?: string;
  completionText?: string;
  completionAction: "completed_text" | "hide" | "count_up";
  showDays: boolean;
  showHours: boolean;
  showMinutes: boolean;
  showSeconds: boolean;
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type TickerWidgetConfig = {
  dataSourceId: string;
  field: string;
  fields?: string[];
  separator: string;
  fieldSeparator?: string;
  direction: "left" | "right";
  emptyState?: string;
  speed: "slow" | "normal" | "fast";
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type DisplayWidgetConfig = {
  dataSourceId: string;
  fields: string[];
  maximumItems: number;
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
  emptyState?: string;
  primaryField?: string;
  secondaryField?: string;
  leadingField?: string;
  trailingField?: string;
  showDividers?: boolean;
  rowSpacing?: "compact" | "comfortable";
  mode?: "single_record" | "records";
  labelField?: string;
  valueField?: string;
  columns?: FieldFormat[];
  showHeader?: boolean;
  alternatingRows?: boolean;
  dateField?: string;
  timeField?: string;
  titleField?: string;
  locationField?: string;
  descriptionField?: string;
  groupByDay?: boolean;
};
export type FieldFormat = {
  field: string;
  label?: string;
  format?:
    | "text"
    | "number"
    | "integer"
    | "percent"
    | "currency"
    | "date-short"
    | "date-long";
  precision?: number;
  prefix?: string;
  suffix?: string;
  alignment?: "left" | "center" | "right";
  width?: number;
};
export type MetricWidgetConfig = {
  dataSourceId: string;
  valueField: string;
  label?: string;
  labelField?: string;
  secondaryField?: string;
  format: "number" | "integer" | "percent" | "currency";
  precision: number;
  prefix?: string;
  suffix?: string;
  alignment: "left" | "center" | "right";
  emptyState: string;
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type CardsWidgetConfig = {
  dataSourceId: string;
  titleField: string;
  subtitleField?: string;
  bodyField?: string;
  badgeField?: string;
  columns: number;
  maximumItems: number;
  density: "compact" | "comfortable";
  emptyState: string;
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type WeatherWidgetConfig = {
  dataSourceId: string;
  showLocation: boolean;
  showCurrent: boolean;
  showHumidity: boolean;
  showWind: boolean;
  showPrecipitation: boolean;
  forecastDays: number;
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
};
export type WidgetVisualConfig = {
  foregroundColor: string;
  backgroundColor: string;
  textScale?: number;
  contentPadding?: number;
  emptyState?: string;
};
export type SpotlightWidgetConfig = WidgetVisualConfig & {
  dataSourceId: string;
  titleField: string;
  subtitleField?: string;
  bodyField?: string;
  badgeField?: string;
  dateField?: string;
  imageAssetId?: string;
};
export type StatGridWidgetConfig = WidgetVisualConfig & {
  dataSourceId: string;
  metrics: {
    label?: string;
    labelField?: string;
    valueField: string;
    format?: "number" | "integer" | "percent" | "currency";
    precision?: number;
    prefix?: string;
    suffix?: string;
  }[];
  columns: number;
};
export type ChartWidgetConfig = WidgetVisualConfig & {
  dataSourceId: string;
  dataset?: string;
  chartType: "line" | "bar" | "donut";
  categoryField?: string;
  timeField?: string;
  series: { field: string; label?: string; color?: string }[];
  showLegend: boolean;
  showAxes: boolean;
  minimum?: number;
  maximum?: number;
};
export type ProgressWidgetConfig = WidgetVisualConfig & {
  dataSourceId: string;
  valueField: string;
  targetField?: string;
  staticTarget?: number;
  label?: string;
  labelField?: string;
  showPercent: boolean;
  completionText?: string;
};
export type TimelineWidgetConfig = WidgetVisualConfig & {
  dataSourceId: string;
  dateField: string;
  titleField: string;
  bodyField?: string;
  statusField?: string;
  orientation: "vertical" | "horizontal";
  maximumItems: number;
};
export type WorldClockWidgetConfig = WidgetVisualConfig & {
  zones: { label: string; timezone: string }[];
  format: "12" | "24";
  showSeconds: boolean;
  showDate: boolean;
  columns: number;
};
export type StructuredRecord = {
  id: string;
  title: string;
  subtitle?: string;
  date?: string;
  author?: string;
  description?: string;
  imageUrl?: string;
  link?: string;
  values?: Record<string, string>;
};
export type StructuredPreview = {
  configuration: {
    presentation: StructuredSourceConfig["presentation"];
    fields: StructuredSourceConfig["fields"];
    emptyState: string;
    dateSelection: DateSelection;
    data: {
      records: StructuredRecord[];
      cachedAt: string;
      staleAt: string;
      usingCachedData: boolean;
    };
  };
  diagnostics: SourceRefreshDiagnostics;
};
export type WebsiteConfig = {
  url: string;
  displayUrl: string;
  allowedHosts: string[];
  javascriptEnabled: boolean;
  domStorageEnabled: boolean;
  cookiePolicy: "disabled" | "first_party" | "first_and_third_party";
  reloadPolicy: "load_once" | "on_each_activation" | "interval";
  refreshIntervalSeconds?: number;
  loadTimeoutSeconds: number;
  zoomPercent: number;
  scrollX: number;
  scrollY: number;
  customUserAgent: string;
  backgroundColor: string;
  failureBehavior: "last_success" | "placeholder" | "fallback_image" | "skip";
  fallbackImageAssetId?: string;
  createdAt?: string;
  updatedAt?: string;
};
export type WebsiteInput = {
  name: string;
  description: string;
  url: string;
  allowedHosts: string[];
  /** Omitted values use the organization website defaults when authored. */
  javascriptEnabled?: boolean;
  domStorageEnabled?: boolean;
  cookiePolicy?: WebsiteConfig["cookiePolicy"];
  reloadPolicy?: WebsiteConfig["reloadPolicy"];
  refreshIntervalSeconds?: number;
  loadTimeoutSeconds?: number;
  zoomPercent?: number;
  scrollX: number;
  scrollY: number;
  customUserAgent: string;
  backgroundColor: string;
  failureBehavior?: WebsiteConfig["failureBehavior"];
  fallbackImageAssetId?: string;
};
export type WebsiteConfigInput = Omit<
  WebsiteConfig,
  "displayUrl" | "createdAt" | "updatedAt"
>;
export type YouTubeConfig = {
  url: string;
  kind?: "video" | "playlist";
  videoId?: string;
  playlistId?: string;
  startSeconds: number;
  endSeconds?: number;
  loop: boolean;
  muted: boolean;
  volume: number;
  captions: boolean;
  captionLanguage: string;
  controls: boolean;
  failureBehavior: "placeholder" | "fallback_image" | "skip";
  fallbackImageAssetId?: string;
  playlistPlaybackMode: "until_end" | "fixed_duration";
  fixedDurationSeconds?: number;
};
export type CalendarConfig = {
  calendars: { name: string; url: string }[];
  displayMode: "today" | "upcoming" | "this_week" | "agenda";
  maxEvents: number;
  fields: {
    title: boolean;
    startTime: boolean;
    endTime: boolean;
    date: boolean;
    location: boolean;
    descriptionExcerpt: boolean;
  };
  filterKeyword?: string;
  filterCalendars?: string[];
  timezone: string;
  refreshIntervalSeconds: number;
  stalenessLimitHours: number;
  emptyState: string;
};
export type CalendarEvent = {
  id: string;
  calendar: string;
  title: string;
  start: string;
  end: string;
  allDay: boolean;
  location?: string;
  descriptionExcerpt?: string;
};
export type SourceRefreshDiagnostics = {
  assetId: string;
  lastSuccessfulRefresh?: string;
  lastAttemptedRefresh?: string;
  httpResultCategory?: string;
  parseStatus: string;
  availableEventCount: number;
  availableItemCount: number;
  usingCachedData: boolean;
  cacheUpdatedAt?: string;
  cacheExpiresAt?: string;
  errorCode?: string;
};
export type CalendarPreview = {
  configuration: CalendarConfig & {
    data: {
      events: CalendarEvent[];
      cachedAt: string;
      staleAt: string;
      usingCachedData: boolean;
    };
  };
  diagnostics: SourceRefreshDiagnostics;
};
export type WebsiteDiagnostics = {
  assetId: string;
  configuredUrl: string;
  allowedHosts: string[];
  lastSuccessfulLoad?: string;
  lastFailure?: string;
  lastFailureCategory?: string;
  reportingScreens: {
    id: string;
    name: string;
    state: string;
    host?: string;
  }[];
  fallbackImageAssetId?: string;
};

export type AssetList = {
  items: Asset[];
  total: number;
  page: number;
  pageSize: number;
};

export type UploadSession = {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  offset: number;
  status:
    | "pending"
    | "uploading"
    | "finalizing"
    | "finalized"
    | "failed"
    | "expired"
    | "cancelled";
  expiresAt: string;
  assetId?: string;
  uploadEndpoint: string;
  maximumSizeBytes: number;
};

export type NotificationStatus = {
  emailConfigured: boolean;
  emailUnavailableReason: string;
  pendingCount: number;
  recentFailureCount: number;
  hasDeliveryHistory: boolean;
};

export type NotificationCategory =
  "incident" | "content_health" | "backup" | "update";

export type NotificationWebhook = {
  id: string;
  name: string;
  url: string;
  enabled: boolean;
  categories: NotificationCategory[];
  lastAttemptAt?: string;
  lastSuccessAt?: string;
  lastError?: string;
  createdAt: string;
};

export type NotificationWebhookCreated = {
  webhook: NotificationWebhook;
  signingSecret: string;
  secretNotice: string;
};

export type NotificationDelivery = {
  id: string;
  eventKey: string;
  category: NotificationCategory;
  severity: "info" | "warning" | "error" | "critical";
  channel: "email" | "webhook";
  target: string;
  subject: string;
  status: "pending" | "sent" | "failed" | "cancelled";
  attempts: number;
  lastError?: string;
  createdAt: string;
  sentAt?: string;
};

export type ContentHealthReport = {
  staleSources: {
    id: string;
    name: string;
    provider: string;
    lastSuccessAt?: string;
    errorCode?: string;
    usingCachedData: boolean;
  }[];
  expiringAssets: {
    id: string;
    name: string;
    expiresAt: string;
    inUse: boolean;
  }[];
  emptyPlaylists: { id: string; name: string; screenCount: number }[];
  unassignedScreens: { id: string; name: string }[];
  thresholds: { staleSourceHours: number; expiringMediaDays: number };
  generatedAt: string;
};

export type BulkAction =
  | "assign_playlist"
  | "assign_layout"
  | "clear_assignment"
  | "set_enabled"
  | "send_command";

export type BulkScreenChange = {
  screenId: string;
  name: string;
  location?: string;
  current: string;
  next: string;
  changes: boolean;
  blocked?: string;
  fromGroup?: string;
  selected: boolean;
  applied?: boolean;
  error?: string;
};

export type BulkPreview = {
  action: BulkAction;
  screens: BulkScreenChange[];
  changeCount: number;
  unchangedCount: number;
  blockedCount: number;
  groupAddedCount: number;
  warnings: string[];
  reversible: boolean;
  undoWindowMinutes: number;
};

export type BulkOperation = {
  id: string;
  action: BulkAction;
  screenCount: number;
  appliedCount: number;
  skippedCount: number;
  failedCount: number;
  results: BulkScreenChange[];
  reversible: boolean;
  undoExpiresAt?: string;
  undoneAt?: string;
  createdAt: string;
};

export type BulkOperationRequest = {
  screenIds: string[];
  action: BulkAction;
  playlistId?: string;
  layoutId?: string;
  enabled?: boolean;
  commandType?: string;
};

export type IntegrationScope = "data_source:write" | "activity:read";

export type IntegrationToken = {
  id: string;
  name: string;
  publicId: string;
  scopes: IntegrationScope[];
  dataSourceIds: string[];
  createdAt: string;
  createdBy?: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
};

export type IntegrationTokenCreated = {
  token: IntegrationToken;
  secret: string;
  notice: string;
};

export type ContentReviewState = "pending" | "approved" | "rejected";

export type ContentReviewItem = {
  contentType: "playlist" | "layout";
  contentId: string;
  name: string;
  revision: number;
  state: ContentReviewState;
  assignedScreens: number;
  updatedAt: string;
  authorName?: string;
  lastNote?: string;
  lastReviewedAt?: string;
};

export type ContentReviewQueue = {
  required: boolean;
  items: ContentReviewItem[];
};

export type EditorialContentType = "playlist" | "layout" | "campaign";
export type SubmissionStatus =
  | "in_review"
  | "changes_requested"
  | "approved"
  | "scheduled"
  | "published"
  | "superseded"
  | "cancelled"
  | "publication_failed";

export type ContentSubmission = {
  id: string;
  contentType: EditorialContentType;
  contentId: string;
  contentName?: string;
  workingRevision: number;
  snapshot: unknown;
  snapshotSha256: string;
  submittedBy?: string;
  submitterName?: string;
  submittedAt: string;
  basedPublishedRevision?: number;
  basedPublishedRevisionId?: string;
  status: SubmissionStatus;
  reviewRequired: boolean;
  allowSelfApproval: boolean;
  reviewNote?: string;
  reviewedBy?: string;
  reviewerName?: string;
  reviewedAt?: string;
  requestedPublicationAt?: string;
  publicationFailureReason?: string;
  publishedAt?: string;
  newerWorkingDraft: boolean;
  currentPublishedRevision?: number;
  affectedScreenCount: number;
  affectedLocationCount: number;
};

export type ContentSubmissionList = {
  policy: "off" | "contributors" | "everyone";
  allowSelfApproval: boolean;
  autoPublishOnApproval: boolean;
  items: ContentSubmission[];
};

export type PublicationHistoryItem = {
  id: string;
  revision: number;
  nativeRevisionId?: string;
  submissionId?: string;
  campaignReleaseId?: string;
  publishedBy?: string;
  publisherName?: string;
  publishedAt: string;
  supersedesPublicationId?: string;
  method:
    | "manual"
    | "automatic_after_approval"
    | "scheduled"
    | "rollback"
    | "migration"
    | "backfill";
  affectedScreenCount: number;
  snapshotSha256?: string;
};

export type CampaignDestination = {
  type: "screen" | "group";
  id: string;
};

export type CampaignBlock = {
  id: string;
  name: string;
  contentType: "playlist" | "layout";
  contentId: string;
  contentRevision?: number;
  priority: number;
  type: "one_time" | "weekly";
  timezone: string;
  startDate?: string;
  endDate?: string;
  oneTimeStart?: string;
  oneTimeEnd?: string;
  dailyStart?: string;
  dailyEnd?: string;
  daysOfWeek?: number[];
  enabled: boolean;
};

export type CampaignSnapshot = {
  name: string;
  description: string;
  ownerId?: string;
  timezone: string;
  campaignStart?: string;
  campaignEnd?: string;
  destinations: CampaignDestination[];
  blocks: CampaignBlock[];
};

export type Campaign = {
  id: string;
  name: string;
  description: string;
  ownerId?: string;
  timezone: string;
  campaignStart?: string;
  campaignEnd?: string;
  destinations: CampaignDestination[];
  draft: CampaignSnapshot;
  draftRevision: number;
  status: string;
  createdAt: string;
  updatedAt: string;
};

export type CampaignList = {
  items: Campaign[];
  total: number;
  page: number;
  pageSize: number;
};

export type CampaignRelease = {
  id: string;
  campaignId: string;
  releaseNumber: number;
  submissionId?: string;
  snapshot: CampaignSnapshot;
  snapshotSha256: string;
  status: SubmissionStatus;
  basedReleaseId?: string;
  publishedBy?: string;
  publishedAt?: string;
  requestedPublicationAt?: string;
  failureReason?: string;
  createdAt: string;
};

export type CampaignPreflight = {
  valid: boolean;
  issues: {
    severity: string;
    code: string;
    message: string;
    blockId?: string;
  }[];
  blockCount: number;
  destinationCount: number;
  screenCount: number;
  locationCount: number;
  previewedScreenCount: number;
  previewScreenLimit: number;
};

export type ScreenScope = {
  type: "location" | "group";
  id: string;
  name?: string;
};

export type ScreenScopes = {
  scopes: ScreenScope[];
  wholeFleet: boolean;
};

export type ScreenSnapshot = {
  id: string;
  screenId: string;
  capturedAt: string;
  width: number;
  height: number;
  fileSize: number;
  playerVersion?: string;
  trigger: "scheduled" | "manual";
};

export type ScreenSnapshotList = {
  items: ScreenSnapshot[];
  enabled: boolean;
  retentionDays: number;
  maxPerScreen: number;
  proofNote: string;
};

export type PlaylistRevision = {
  revision: number;
  name: string;
  itemCount: number;
  sourceType: string;
  createdAt: string;
  authorName?: string;
  isCurrent: boolean;
  restorable: boolean;
  missingReferences: number;
};

export type PlaylistRevisionList = {
  items: PlaylistRevision[];
  kept: number;
};

export type PlaylistRestoreResult = {
  restoredFrom: number;
  newRevision: number;
  skippedItems: number;
};
