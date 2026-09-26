package devices

import (
	"encoding/json"
	"net/netip"
	"time"

	"github.com/google/uuid"
)

const (
	PairingLifetime  = 10 * time.Minute
	PollingInterval  = 3 * time.Second
	RecentThreshold  = 2 * time.Minute
	OfflineThreshold = 15 * time.Minute
)

type Identity struct {
	Product          string `json:"product"`
	InstallationID   string `json:"installationId"`
	OrganizationName string `json:"organizationName"`
	APIVersion       string `json:"apiVersion"`
	PairingEnabled   bool   `json:"pairingEnabled"`
}

type DeviceMetadata struct {
	PlayerInstallationID string  `json:"playerInstallationId"`
	Platform             string  `json:"platform"`
	Manufacturer         string  `json:"manufacturer"`
	Model                string  `json:"model"`
	AndroidVersion       string  `json:"androidVersion"`
	PlayerVersion        string  `json:"playerVersion"`
	ScreenWidth          int     `json:"screenWidth"`
	ScreenHeight         int     `json:"screenHeight"`
	Density              float32 `json:"density"`
	Locale               string  `json:"locale"`
	Timezone             string  `json:"timezone"`
	ApproximateAddress   string  `json:"approximateAddress,omitempty"`
}

type PairingCreated struct {
	ID              uuid.UUID `json:"id"`
	Code            string    `json:"code"`
	PollSecret      string    `json:"pollSecret"`
	ExpiresAt       time.Time `json:"expiresAt"`
	ServerTime      time.Time `json:"serverTime"`
	PollingInterval int       `json:"pollingIntervalSeconds"`
	ApprovalURL     string    `json:"approvalUrl"`
	Organization    string    `json:"organizationName"`
}

type PairingRequest struct {
	ID                      uuid.UUID      `json:"id"`
	Status                  string         `json:"status"`
	Metadata                DeviceMetadata `json:"metadata"`
	CreatedAt               time.Time      `json:"createdAt"`
	ExpiresAt               time.Time      `json:"expiresAt"`
	PreviouslyPaired        bool           `json:"previouslyPaired"`
	ExistingScreenID        *uuid.UUID     `json:"existingScreenId,omitempty"`
	ExistingScreenName      string         `json:"existingScreenName,omitempty"`
	HasActiveCredential     bool           `json:"hasActiveCredential"`
	CredentialReplacementOK bool           `json:"credentialReplacementAuthorized"`
	PairingMode             string         `json:"pairingMode"`
}

type PairingApproval struct {
	Name                      string
	LocationID                *uuid.UUID
	RoomName                  string
	RoomNumber                string
	Description               string
	ReplaceExistingCredential bool
	ReplaceHardware           bool
	ReplacementScreenID       *uuid.UUID
}

type PlayerHistory struct {
	ID               uuid.UUID  `json:"id"`
	ScreenID         uuid.UUID  `json:"screenId"`
	CredentialID     *uuid.UUID `json:"credentialId,omitempty"`
	InstallationID   string     `json:"installationId"`
	Platform         string     `json:"platform"`
	Manufacturer     string     `json:"manufacturer"`
	Model            string     `json:"model"`
	AndroidVersion   string     `json:"androidVersion"`
	PlayerVersion    string     `json:"playerVersion"`
	ScreenWidth      int        `json:"screenWidth"`
	ScreenHeight     int        `json:"screenHeight"`
	Density          float32    `json:"density"`
	Locale           string     `json:"locale"`
	Timezone         string     `json:"timezone"`
	PairedAt         time.Time  `json:"pairedAt"`
	RetiredAt        *time.Time `json:"retiredAt,omitempty"`
	RetirementReason string     `json:"retirementReason,omitempty"`
}

type PollResult struct {
	Status          string     `json:"status"`
	ExpiresAt       time.Time  `json:"expiresAt"`
	ScreenID        *uuid.UUID `json:"screenId,omitempty"`
	EnrollmentToken string     `json:"enrollmentToken,omitempty"`
	FailureReason   string     `json:"failureReason,omitempty"`
}

type EnrollmentResult struct {
	ScreenID         uuid.UUID `json:"screenId"`
	ScreenName       string    `json:"screenName"`
	DeviceCredential string    `json:"deviceCredential"`
}

type Screen struct {
	ID                        uuid.UUID  `json:"id"`
	Name                      string     `json:"name"`
	Description               string     `json:"description"`
	Location                  string     `json:"location"`
	LocationID                *uuid.UUID `json:"locationId,omitempty"`
	LocationDetails           *Location  `json:"locationDetails,omitempty"`
	RoomName                  string     `json:"roomName"`
	RoomNumber                string     `json:"roomNumber"`
	SyncGroupID               *uuid.UUID `json:"syncGroupId,omitempty"`
	SyncGroupName             *string    `json:"syncGroupName,omitempty"`
	NowPlayingName            *string    `json:"nowPlayingName,omitempty"`
	NowPlayingType            *string    `json:"nowPlayingType,omitempty"`
	Platform                  string     `json:"platform"`
	DeviceManufacturer        string     `json:"deviceManufacturer"`
	DeviceModel               string     `json:"deviceModel"`
	AndroidVersion            string     `json:"androidVersion"`
	PlayerVersion             string     `json:"playerVersion"`
	PlayerVersionCode         *int64     `json:"playerVersionCode,omitempty"`
	AndroidSDK                *int       `json:"androidSdk,omitempty"`
	InstallerSource           *string    `json:"installerSource,omitempty"`
	InstallPermissionStatus   *string    `json:"installPermissionStatus,omitempty"`
	CurrentUpdateDeploymentID *uuid.UUID `json:"currentUpdateDeploymentId,omitempty"`
	UpdateState               *string    `json:"updateState,omitempty"`
	UpdateDownloadedBytes     *int64     `json:"updateDownloadedBytes,omitempty"`
	UpdateExpectedBytes       *int64     `json:"updateExpectedBytes,omitempty"`
	UpdateError               *string    `json:"updateError,omitempty"`
	// PlayerFamily is what the running player reported (`edge` for Tilecast
	// Edge); absent for players that do not report it.
	PlayerFamily          *string    `json:"playerFamily,omitempty"`
	PlayerArchitecture    *string    `json:"playerArchitecture,omitempty"`
	ScreenWidth           int        `json:"screenWidth"`
	ScreenHeight          int        `json:"screenHeight"`
	Density               float32    `json:"density"`
	Locale                string     `json:"locale"`
	Timezone              string     `json:"timezone"`
	AvailableStorageBytes *int64     `json:"availableStorageBytes,omitempty"`
	UptimeSeconds         *int64     `json:"uptimeSeconds,omitempty"`
	Enabled               bool       `json:"enabled"`
	PairedAt              time.Time  `json:"pairedAt"`
	LastConnectedAt       *time.Time `json:"lastConnectedAt,omitempty"`
	LastDisconnectedAt    *time.Time `json:"lastDisconnectedAt,omitempty"`
	LastHeartbeatAt       *time.Time `json:"lastHeartbeatAt,omitempty"`
	LastKnownIP           *string    `json:"lastKnownIp,omitempty"`
	LastContactAt         *time.Time `json:"lastContactAt,omitempty"`
	Status                Status     `json:"status"`
	HasActiveCredential   bool       `json:"hasActiveCredential"`
	ArchivedAt            *time.Time `json:"archivedAt,omitempty"`
	ArchivedReason        string     `json:"archivedReason,omitempty"`
	CreatedAt             time.Time  `json:"createdAt"`
	UpdatedAt             time.Time  `json:"updatedAt"`
}

type Status string

const (
	StatusOnline   Status = "online"
	StatusRecent   Status = "recent"
	StatusStale    Status = "stale"
	StatusOffline  Status = "offline"
	StatusDisabled Status = "disabled"
	StatusRevoked  Status = "revoked"
)

type DevicePrincipal struct {
	CredentialID uuid.UUID
	ScreenID     uuid.UUID
	ScreenName   string
	Enabled      bool
}

type Heartbeat struct {
	ScreenWidth           int    `json:"screenWidth"`
	ScreenHeight          int    `json:"screenHeight"`
	AvailableStorageBytes *int64 `json:"availableStorageBytes,omitempty"`
	UptimeSeconds         *int64 `json:"uptimeSeconds,omitempty"`
	PlayerVersion         string `json:"playerVersion"`
	PlayerVersionCode     *int64 `json:"playerVersionCode,omitempty"`
	// PlayerFamily and PlayerArchitecture say which Player release family
	// the running player installs (`android`, `electron-linux`, `edge`) and,
	// for Tilecast Edge, its architecture. A release reaches only screens of
	// its family; older players omit both.
	PlayerFamily                      string            `json:"playerFamily,omitempty"`
	PlayerArchitecture                string            `json:"playerArchitecture,omitempty"`
	PresentationSchemaVersions        []int             `json:"presentationSchemaVersions,omitempty"`
	NativePresentationCapabilities    map[string]int    `json:"nativePresentationCapabilities,omitempty"`
	WebRuntimeVersion                 int               `json:"webRuntimeVersion,omitempty"`
	WebBundleLimitBytes               int64             `json:"webBundleLimitBytes,omitempty"`
	AndroidSDK                        *int              `json:"androidSdk,omitempty"`
	InstallerSource                   string            `json:"installerSource,omitempty"`
	InstallPermissionStatus           string            `json:"installPermissionStatus,omitempty"`
	ActiveManifestVersion             *int64            `json:"activeManifestVersion,omitempty"`
	PendingManifestVersion            *int64            `json:"pendingManifestVersion,omitempty"`
	AssignedPlaylistID                *uuid.UUID        `json:"assignedPlaylistId,omitempty"`
	CurrentItemID                     *uuid.UUID        `json:"currentItemId,omitempty"`
	CurrentAssetID                    *uuid.UUID        `json:"currentAssetId,omitempty"`
	PlaybackState                     string            `json:"playbackState,omitempty"`
	DownloadQueueCount                *int              `json:"downloadQueueCount,omitempty"`
	DownloadedBytes                   *int64            `json:"downloadedBytes,omitempty"`
	RequiredBytes                     *int64            `json:"requiredBytes,omitempty"`
	CacheUsedBytes                    *int64            `json:"cacheUsedBytes,omitempty"`
	CacheLimitBytes                   *int64            `json:"cacheLimitBytes,omitempty"`
	LastSynchronizationError          string            `json:"lastSynchronizationError,omitempty"`
	LastPlaybackError                 string            `json:"lastPlaybackError,omitempty"`
	CurrentScheduleID                 *uuid.UUID        `json:"currentScheduleId,omitempty"`
	CurrentPlaylistID                 *uuid.UUID        `json:"currentPlaylistId,omitempty"`
	SelectionSource                   string            `json:"selectionSource,omitempty"`
	NextTransitionAt                  *time.Time        `json:"nextTransitionAt,omitempty"`
	DeviceClockOffsetSeconds          *int64            `json:"deviceClockOffsetSeconds,omitempty"`
	ScheduleEvaluationError           string            `json:"scheduleEvaluationError,omitempty"`
	ScheduleManifestVersion           *int64            `json:"scheduleManifestVersion,omitempty"`
	CurrentWebsiteAssetID             *uuid.UUID        `json:"currentWebsiteAssetId,omitempty"`
	WebsiteState                      string            `json:"websiteState,omitempty"`
	WebsiteLoadStartedAt              *time.Time        `json:"websiteLoadStartedAt,omitempty"`
	WebsiteLoadCompletedAt            *time.Time        `json:"websiteLoadCompletedAt,omitempty"`
	WebsiteFailureCategory            string            `json:"websiteFailureCategory,omitempty"`
	WebsiteBlockedNavigationCount     *int              `json:"websiteBlockedNavigationCount,omitempty"`
	WebsiteCurrentHost                string            `json:"websiteCurrentHost,omitempty"`
	WebsiteFallbackShown              *bool             `json:"websiteFallbackShown,omitempty"`
	WebsiteRendererRecoveryCount      *int              `json:"websiteRendererRecoveryCount,omitempty"`
	CurrentWidgetID                   *uuid.UUID        `json:"currentWidgetId,omitempty"`
	WidgetProvider                    string            `json:"widgetProvider,omitempty"`
	WidgetState                       string            `json:"widgetState,omitempty"`
	WidgetError                       string            `json:"widgetError,omitempty"`
	ActiveTakeoverID                  *uuid.UUID        `json:"activeTakeoverId,omitempty"`
	TakeoverState                     string            `json:"takeoverState,omitempty"`
	TakeoverPreparationProgress       *int              `json:"takeoverPreparationProgress,omitempty"`
	PlaybackDisabled                  *bool             `json:"playbackDisabled,omitempty"`
	LastCommandID                     *uuid.UUID        `json:"lastCommandId,omitempty"`
	LastCommandState                  string            `json:"lastCommandState,omitempty"`
	LastCommandResult                 string            `json:"lastCommandResult,omitempty"`
	LastCommandCompletedAt            *time.Time        `json:"lastCommandCompletedAt,omitempty"`
	ActiveConfigRevision              *int64            `json:"activeConfigRevision,omitempty"`
	ConfigurationError                string            `json:"configurationError,omitempty"`
	CurrentUpdateDeploymentID         *uuid.UUID        `json:"currentUpdateDeploymentId,omitempty"`
	UpdateState                       string            `json:"updateState,omitempty"`
	UpdateDownloadedBytes             *int64            `json:"updateDownloadedBytes,omitempty"`
	UpdateExpectedBytes               *int64            `json:"updateExpectedBytes,omitempty"`
	UpdateError                       string            `json:"updateError,omitempty"`
	ConfiguredReliabilityMode         string            `json:"configuredReliabilityMode,omitempty"`
	EffectiveReliabilityMode          string            `json:"effectiveReliabilityMode,omitempty"`
	ForegroundState                   string            `json:"foregroundState,omitempty"`
	LastForegroundExitAt              *time.Time        `json:"lastForegroundExitAt,omitempty"`
	LastForegroundPackage             string            `json:"lastForegroundPackage,omitempty"`
	BootRecoveryResult                string            `json:"bootRecoveryResult,omitempty"`
	LastSuccessfulColdBootAt          *time.Time        `json:"lastSuccessfulColdBootAt,omitempty"`
	ImmersiveModeActive               *bool             `json:"immersiveModeActive,omitempty"`
	KeepScreenOn                      *bool             `json:"keepScreenOn,omitempty"`
	ManagedKioskCapability            string            `json:"managedKioskCapability,omitempty"`
	DeviceOwnerState                  string            `json:"deviceOwnerState,omitempty"`
	LockTaskState                     string            `json:"lockTaskState,omitempty"`
	AccessibilityServiceState         string            `json:"accessibilityServiceState,omitempty"`
	AccessibilityReturnState          string            `json:"accessibilityReturnState,omitempty"`
	AccessibilityReturnAttempts       *int              `json:"accessibilityReturnAttempts,omitempty"`
	ActiveHoursState                  string            `json:"activeHoursState,omitempty"`
	SleepCapability                   string            `json:"sleepCapability,omitempty"`
	LastSleepRequestResult            string            `json:"lastSleepRequestResult,omitempty"`
	LastWakeResult                    string            `json:"lastWakeResult,omitempty"`
	RecoveryLevel                     *int              `json:"recoveryLevel,omitempty"`
	RecoveryCount                     *int              `json:"recoveryCount,omitempty"`
	SafeMode                          *bool             `json:"safeMode,omitempty"`
	LastWatchdogFailure               string            `json:"lastWatchdogFailure,omitempty"`
	LastWatchdogRecoveryAt            *time.Time        `json:"lastWatchdogRecoveryAt,omitempty"`
	MaintenanceSessionExpiresAt       *time.Time        `json:"maintenanceSessionExpiresAt,omitempty"`
	AdminPINChangedAt                 *time.Time        `json:"adminPinChangedAt,omitempty"`
	CommissioningState                string            `json:"commissioningState,omitempty"`
	CommissioningStep                 string            `json:"commissioningStep,omitempty"`
	CommissioningCompletedAt          *time.Time        `json:"commissioningCompletedAt,omitempty"`
	CachedFallbackAvailable           *bool             `json:"cachedFallbackAvailable,omitempty"`
	LastHealthyPlaybackAt             *time.Time        `json:"lastHealthyPlaybackAt,omitempty"`
	LastPlaylistTransitionAt          *time.Time        `json:"lastPlaylistTransitionAt,omitempty"`
	LastSuccessfulSyncAt              *time.Time        `json:"lastSuccessfulSyncAt,omitempty"`
	LastServerConnectionAt            *time.Time        `json:"lastServerConnectionAt,omitempty"`
	BootAttemptCount                  *int              `json:"bootAttemptCount,omitempty"`
	BootLastAttemptAt                 *time.Time        `json:"bootLastAttemptAt,omitempty"`
	BootLaunchVerified                *bool             `json:"bootLaunchVerified,omitempty"`
	UpdateReadiness                   string            `json:"updateReadiness,omitempty"`
	SelfTestResult                    string            `json:"selfTestResult,omitempty"`
	SelfTestCompletedAt               *time.Time        `json:"selfTestCompletedAt,omitempty"`
	AutostartState                    string            `json:"autostartState,omitempty"`
	AutostartTarget                   string            `json:"autostartTarget,omitempty"`
	AutostartSupervised               *bool             `json:"autostartSupervised,omitempty"`
	AutostartLingerEnabled            *bool             `json:"autostartLingerEnabled,omitempty"`
	AutostartError                    string            `json:"autostartError,omitempty"`
	AirplaySupported                  *bool             `json:"airplaySupported,omitempty"`
	AirplayUxPlayInstalled            *bool             `json:"airplayUxPlayInstalled,omitempty"`
	AirplayUxPlayVersion              string            `json:"airplayUxPlayVersion,omitempty"`
	AirplayGstreamerInstalled         *bool             `json:"airplayGstreamerInstalled,omitempty"`
	AirplayH264DecoderAvailable       *bool             `json:"airplayH264DecoderAvailable,omitempty"`
	AirplayHardwareDecode             *bool             `json:"airplayHardwareDecode,omitempty"`
	AirplayDecoder                    string            `json:"airplayDecoder,omitempty"`
	AirplayMaxProfile                 string            `json:"airplayMaxProfile,omitempty"`
	AirplayGroupSupported             *bool             `json:"airplayGroupSupported,omitempty"`
	AirplayAudioAvailable             *bool             `json:"airplayAudioAvailable,omitempty"`
	AirplayAvahiAvailable             *bool             `json:"airplayAvahiAvailable,omitempty"`
	AirplayMdnsAdvertisementAvailable *bool             `json:"airplayMdnsAdvertisementAvailable,omitempty"`
	AirplayMulticastSupported         *bool             `json:"airplayMulticastSupported,omitempty"`
	AirplayMulticastTestStatus        string            `json:"airplayMulticastTestStatus,omitempty"`
	AirplayLimitation                 string            `json:"airplayLimitation,omitempty"`
	ExternalPresentationState         string            `json:"externalPresentationState,omitempty"`
	ExternalPresentationSessionID     *uuid.UUID        `json:"externalPresentationSessionId,omitempty"`
	ExternalPresentationRole          string            `json:"externalPresentationRole,omitempty"`
	AirplayReceiverState              string            `json:"airplayReceiverState,omitempty"`
	AirplayTransport                  string            `json:"airplayTransport,omitempty"`
	AirplayConnected                  *bool             `json:"airplayConnected,omitempty"`
	ExternalPresentationExpiresAt     *time.Time        `json:"externalPresentationExpiresAt,omitempty"`
	DisplayControlProvider            string            `json:"displayControlProvider,omitempty"`
	DisplayControlProviders           []string          `json:"displayControlProviders,omitempty"`
	DisplayControlCapabilities        map[string]string `json:"displayControlCapabilities,omitempty"`
	DisplayPowerState                 string            `json:"displayPowerState,omitempty"`
	DisplayPowerStateConfirmed        *bool             `json:"displayPowerStateConfirmed,omitempty"`
	DisplayPowerStateObservedAt       *time.Time        `json:"displayPowerStateObservedAt,omitempty"`
	DisplayControlPolicyState         string            `json:"displayControlPolicyState,omitempty"`
	DisplayControlError               string            `json:"displayControlError,omitempty"`

	// Presentation Network capability and state, reported by the Linux probe.
	//
	// Deliberately separate from the ordinary telemetry gauges: NetworkLinkType
	// keeps describing the interface that carries the default route, so a
	// temporary Wi-Fi sidecar never makes the fleet's link-quality metrics
	// describe the wrong path. Nothing here can carry a credential — the fields
	// are booleans, enumerated states, identifiers, and revisions.
	PresentationNetworkSupported        *bool      `json:"presentationNetworkSupported,omitempty"`
	PresentationNetworkHelperState      string     `json:"presentationNetworkHelperState,omitempty"`
	PresentationNetworkManagerAvailable *bool      `json:"presentationNetworkManagerAvailable,omitempty"`
	PresentationNetworkWifiAdapter      *bool      `json:"presentationNetworkWifiAdapter,omitempty"`
	PresentationNetworkRadioEnabled     *bool      `json:"presentationNetworkRadioEnabled,omitempty"`
	PresentationNetworkState            string     `json:"presentationNetworkState,omitempty"`
	PresentationNetworkInstalledID      *uuid.UUID `json:"presentationNetworkInstalledId,omitempty"`
	PresentationNetworkInstalledRev     *int64     `json:"presentationNetworkInstalledRevision,omitempty"`
	PresentationNetworkActiveID         *uuid.UUID `json:"presentationNetworkActiveId,omitempty"`
	PresentationNetworkLastConnectedAt  *time.Time `json:"presentationNetworkLastConnectedAt,omitempty"`
	PresentationNetworkLastFailureAt    *time.Time `json:"presentationNetworkLastFailureAt,omitempty"`
	PresentationNetworkLastFailureCode  string     `json:"presentationNetworkLastFailureCode,omitempty"`
	PresentationNetworkLimitation       string     `json:"presentationNetworkLimitation,omitempty"`
	// The wired facts group AirPlay RTP fan-out needs. A player can hold two
	// addresses once it joins a Presentation Network, at which point the address
	// a request happened to arrive from is no longer an unambiguous answer for
	// "where do I send this room's video".
	WiredInterfaceAvailable *bool  `json:"wiredInterfaceAvailable,omitempty"`
	WiredIPv4               string `json:"wiredIpv4,omitempty"`

	// COMPATIBILITY: the retired Noise Meter plugin's section. Linux and Edge
	// Players released with it keep sending it, and strict decoding would
	// otherwise refuse their whole heartbeat. It is accepted and ignored.
	RetiredNoiseMeter json.RawMessage `json:"noiseMeter,omitempty"`
}

func addressString(address netip.Addr) *string {
	if !address.IsValid() {
		return nil
	}
	value := address.String()
	return &value
}
