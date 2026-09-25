package config

import (
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Environment   string
	HTTPAddr      string
	DatabaseURL   string
	PublicURL     string
	CookieName    string
	CookieSecure  bool
	SessionTTL    time.Duration
	LogLevel      string
	MDNSEnabled   bool
	Media         MediaConfig
	Scheduling    SchedulingConfig
	Website       WebsiteConfig
	Sources       SourcesConfig
	Operations    OperationsConfig
	Updates       UpdatesConfig
	Backup        BackupConfig
	WebAuthn      WebAuthnConfig
	Notifications NotificationsConfig
	Demo          DemoConfig
	// PresentationNetworkKey seals Wi-Fi credentials for Presentation Networks.
	// Empty is a supported state: the server starts normally and every other
	// feature works, but creating or provisioning a Presentation Network
	// credential reports a clear operator-facing limitation instead. The value is
	// deliberately environment-only, like the SMTP password, so it never lands in
	// the schema, a backup, or the configuration export.
	PresentationNetworkKey string
}

// NotificationsConfig carries the SMTP relay. These are environment values
// rather than settings in the database because a mail password stored through
// Studio would become a recoverable secret in the schema, in every backup, and
// in the configuration export.
type NotificationsConfig struct {
	SMTPHost     string
	SMTPPort     int
	SMTPUsername string
	SMTPPassword string
	// starttls, implicit, or none.
	SMTPTLS string
	// Accepts a relay certificate that no public authority signed, for a mail
	// server inside the installation. It does not permit sending credentials in
	// the clear.
	SMTPAllowInsecure bool
	// Permits SMTP authentication on a connection with no encryption at all.
	//
	// Separate from SMTPAllowInsecure because trusting a private certificate and
	// putting a mail password on the wire in plaintext are different decisions
	// with different consequences, and an operator who makes the first should not
	// silently have made the second.
	SMTPAllowPlaintextAuth bool
}

// WebAuthnConfig overrides the relying party that is otherwise derived from
// the public URL. Both values are needed only when the address browsers use
// differs from TILECAST_PUBLIC_URL, which happens behind some proxies.
type WebAuthnConfig struct {
	RPID    string
	Origins string
}

type BackupConfig struct {
	Root              string
	ReservedFreeBytes int64
	MaxArchiveBytes   int64
	MaxArchiveFiles   int
}

type UpdatesConfig struct {
	Root             string
	TrustedPublicKey string
	GitHubToken      string
	GitHubClientID   string
	PublishToken     string
	RetentionDays    int
	MaxAPKBytes      int64
}

type OperationsConfig struct {
	MaxTakeoverDurationHours    int
	MaxTakeoverTargets          int
	MaxPendingCommands          int
	DefaultCommandExpiryMinutes int
	MaxIdentifySeconds          int
	CommandRetentionDays        int
}

type WebsiteConfig struct {
	AllowPrivateHTTP                                                                          bool
	DefaultTimeoutSeconds, MaxTimeoutSeconds, MinRefreshSeconds, MaxAllowedHosts, MaxWebsites int
}

type SourcesConfig struct {
	AllowPrivateNetworks  bool
	TimeoutSeconds        int
	MaximumResponseBytes  int64
	MaximumRedirects      int
	MinimumRefreshSeconds int
	MaximumRefreshSeconds int
	AirQualityBaseURL     string
}

type SchedulingConfig struct {
	MaxSchedules            int
	MaxTargetsPerSchedule   int
	MaxGroupsPerScreen      int
	PrefetchDays            int
	ActivationGraceSeconds  int
	ClockSkewWarningSeconds int
}

type MediaConfig struct {
	Root              string
	MaxUploadBytes    int64
	Workers           int
	ReservedFreeBytes uint64
	FFmpegPath        string
	FFprobePath       string
	VideoMaxWidth     int
	VideoMaxHeight    int
	VideoMaxFrameRate float64
	KeepOriginals     bool
}

func Load() (Config, error) {
	cfg := Config{
		Environment: get("TILECAST_ENV", "development"),
		HTTPAddr:    get("TILECAST_HTTP_ADDR", ":8080"),
		DatabaseURL: os.Getenv("TILECAST_DATABASE_URL"),
		PublicURL:   get("TILECAST_PUBLIC_URL", "http://localhost:8080"),
		CookieName:  get("TILECAST_COOKIE_NAME", "tilecast_session"),
		LogLevel:    get("TILECAST_LOG_LEVEL", "info"),
		WebAuthn: WebAuthnConfig{
			RPID:    get("TILECAST_WEBAUTHN_RP_ID", ""),
			Origins: get("TILECAST_WEBAUTHN_ORIGINS", ""),
		},
	}

	if cfg.DatabaseURL == "" {
		return Config{}, errors.New("TILECAST_DATABASE_URL is required")
	}

	secure, err := strconv.ParseBool(get("TILECAST_COOKIE_SECURE", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse TILECAST_COOKIE_SECURE: %w", err)
	}
	cfg.CookieSecure = secure
	mdnsEnabled, err := strconv.ParseBool(get("TILECAST_MDNS_ENABLED", mdnsDefault()))
	if err != nil {
		return Config{}, fmt.Errorf("parse TILECAST_MDNS_ENABLED: %w", err)
	}
	cfg.MDNSEnabled = mdnsEnabled
	values := []struct {
		name, fallback string
		max            int
		dest           *int
	}{
		{"TILECAST_MAX_SCHEDULES", "1000", 10000, &cfg.Scheduling.MaxSchedules},
		{"TILECAST_MAX_SCHEDULE_TARGETS", "250", 1000, &cfg.Scheduling.MaxTargetsPerSchedule},
		{"TILECAST_MAX_GROUPS_PER_SCREEN", "50", 500, &cfg.Scheduling.MaxGroupsPerScreen},
		{"TILECAST_SCHEDULE_PREFETCH_DAYS", "14", 365, &cfg.Scheduling.PrefetchDays},
		{"TILECAST_SCHEDULE_ACTIVATION_GRACE_SECONDS", "30", 3600, &cfg.Scheduling.ActivationGraceSeconds},
		{"TILECAST_CLOCK_SKEW_WARNING_SECONDS", "300", 86400, &cfg.Scheduling.ClockSkewWarningSeconds},
	}
	for _, value := range values {
		parsed, parseErr := parsePositiveInt(value.name, value.fallback, value.max)
		if parseErr != nil {
			return Config{}, parseErr
		}
		*value.dest = parsed
	}
	cfg.Website.AllowPrivateHTTP, err = strconv.ParseBool(get("TILECAST_WEBSITE_ALLOW_PRIVATE_HTTP", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse TILECAST_WEBSITE_ALLOW_PRIVATE_HTTP: %w", err)
	}
	websiteValues := []struct {
		name, fallback string
		max            int
		dest           *int
	}{{"TILECAST_WEBSITE_DEFAULT_TIMEOUT_SECONDS", "20", 120, &cfg.Website.DefaultTimeoutSeconds}, {"TILECAST_WEBSITE_MAX_TIMEOUT_SECONDS", "120", 600, &cfg.Website.MaxTimeoutSeconds}, {"TILECAST_WEBSITE_MIN_REFRESH_SECONDS", "30", 3600, &cfg.Website.MinRefreshSeconds}, {"TILECAST_WEBSITE_MAX_ALLOWED_HOSTS", "25", 100, &cfg.Website.MaxAllowedHosts}, {"TILECAST_WEBSITE_MAX_ASSETS", "500", 5000, &cfg.Website.MaxWebsites}}
	for _, value := range websiteValues {
		parsed, parseErr := parsePositiveInt(value.name, value.fallback, value.max)
		if parseErr != nil {
			return Config{}, parseErr
		}
		*value.dest = parsed
	}
	if cfg.Website.DefaultTimeoutSeconds > cfg.Website.MaxTimeoutSeconds {
		return Config{}, errors.New("TILECAST_WEBSITE_DEFAULT_TIMEOUT_SECONDS must not exceed TILECAST_WEBSITE_MAX_TIMEOUT_SECONDS")
	}
	cfg.Sources.AllowPrivateNetworks, err = strconv.ParseBool(get("TILECAST_SOURCE_ALLOW_PRIVATE_NETWORKS", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse TILECAST_SOURCE_ALLOW_PRIVATE_NETWORKS: %w", err)
	}
	if cfg.Sources.TimeoutSeconds, err = parsePositiveInt("TILECAST_SOURCE_FETCH_TIMEOUT_SECONDS", "15", 120); err != nil {
		return Config{}, err
	}
	if cfg.Sources.MaximumResponseBytes, err = parsePositiveInt64("TILECAST_SOURCE_MAX_RESPONSE_BYTES", "2097152"); err != nil {
		return Config{}, err
	}
	if cfg.Sources.MaximumRedirects, err = parsePositiveInt("TILECAST_SOURCE_MAX_REDIRECTS", "3", 10); err != nil {
		return Config{}, err
	}
	if cfg.Sources.MinimumRefreshSeconds, err = parsePositiveInt("TILECAST_SOURCE_MIN_REFRESH_SECONDS", "300", 86400); err != nil {
		return Config{}, err
	}
	if cfg.Sources.MaximumRefreshSeconds, err = parsePositiveInt("TILECAST_SOURCE_MAX_REFRESH_SECONDS", "86400", 604800); err != nil {
		return Config{}, err
	}
	if cfg.Sources.MinimumRefreshSeconds > cfg.Sources.MaximumRefreshSeconds {
		return Config{}, errors.New("TILECAST_SOURCE_MIN_REFRESH_SECONDS must not exceed TILECAST_SOURCE_MAX_REFRESH_SECONDS")
	}
	cfg.Sources.AirQualityBaseURL = get("TILECAST_AIR_QUALITY_BASE_URL", "https://air-quality-api.open-meteo.com")
	cfg.PresentationNetworkKey = strings.TrimSpace(os.Getenv("TILECAST_PRESENTATION_NETWORK_KEY"))
	cfg.Notifications.SMTPHost = strings.TrimSpace(get("TILECAST_SMTP_HOST", ""))
	cfg.Notifications.SMTPUsername = get("TILECAST_SMTP_USERNAME", "")
	cfg.Notifications.SMTPPassword = os.Getenv("TILECAST_SMTP_PASSWORD")
	cfg.Notifications.SMTPTLS = strings.ToLower(strings.TrimSpace(get("TILECAST_SMTP_TLS", "starttls")))
	switch cfg.Notifications.SMTPTLS {
	case "starttls", "implicit", "none":
	default:
		return Config{}, errors.New("TILECAST_SMTP_TLS must be starttls, implicit, or none")
	}
	if cfg.Notifications.SMTPPort, err = parsePositiveInt("TILECAST_SMTP_PORT", "587", 65535); err != nil {
		return Config{}, err
	}
	cfg.Notifications.SMTPAllowInsecure, err = strconv.ParseBool(get("TILECAST_SMTP_ALLOW_INSECURE", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse TILECAST_SMTP_ALLOW_INSECURE: %w", err)
	}
	// Defaults to false on its own rather than following ALLOW_INSECURE: putting
	// a mail password on the wire in plaintext is a decision an operator has to
	// make deliberately, not one that comes along with a private certificate.
	cfg.Notifications.SMTPAllowPlaintextAuth, err = strconv.ParseBool(get("TILECAST_SMTP_ALLOW_PLAINTEXT_AUTH", "false"))
	if err != nil {
		return Config{}, fmt.Errorf("parse TILECAST_SMTP_ALLOW_PLAINTEXT_AUTH: %w", err)
	}
	takeoverDurationFallback := get("TILECAST_MAX_EMERGENCY_DURATION_HOURS", "24")
	takeoverTargetsFallback := get("TILECAST_MAX_EMERGENCY_TARGETS", "250")
	operationValues := []struct {
		name, fallback string
		max            int
		dest           *int
	}{
		{"TILECAST_MAX_TAKEOVER_DURATION_HOURS", takeoverDurationFallback, 168, &cfg.Operations.MaxTakeoverDurationHours},
		{"TILECAST_MAX_TAKEOVER_TARGETS", takeoverTargetsFallback, 1000, &cfg.Operations.MaxTakeoverTargets},
		{"TILECAST_MAX_PENDING_COMMANDS_PER_SCREEN", "50", 500, &cfg.Operations.MaxPendingCommands},
		{"TILECAST_DEFAULT_COMMAND_EXPIRY_MINUTES", "10", 1440, &cfg.Operations.DefaultCommandExpiryMinutes},
		{"TILECAST_IDENTIFY_SCREEN_MAX_SECONDS", "120", 600, &cfg.Operations.MaxIdentifySeconds},
		{"TILECAST_COMMAND_RETENTION_DAYS", "30", 3650, &cfg.Operations.CommandRetentionDays},
	}
	for _, value := range operationValues {
		parsed, parseErr := parsePositiveInt(value.name, value.fallback, value.max)
		if parseErr != nil {
			return Config{}, parseErr
		}
		*value.dest = parsed
	}

	cfg.Media = MediaConfig{
		Root:        get("TILECAST_MEDIA_ROOT", "/data/media"),
		FFmpegPath:  get("TILECAST_FFMPEG_PATH", "/usr/bin/ffmpeg"),
		FFprobePath: get("TILECAST_FFPROBE_PATH", "/usr/bin/ffprobe"),
	}
	cfg.Updates = UpdatesConfig{
		Root:             get("TILECAST_UPDATE_ROOT", "/data/updates"),
		TrustedPublicKey: get("TILECAST_UPDATE_MANIFEST_PUBLIC_KEY", DefaultUpdateManifestPublicKey),
		GitHubToken:      os.Getenv("TILECAST_GITHUB_TOKEN"),
		GitHubClientID:   os.Getenv("TILECAST_GITHUB_CLIENT_ID"),
		PublishToken:     os.Getenv("TILECAST_RELEASE_PUBLISH_TOKEN"),
	}
	if cfg.Updates.MaxAPKBytes, err = parsePositiveInt64("TILECAST_UPDATE_MAX_APK_BYTES", "536870912"); err != nil {
		return Config{}, err
	}
	if cfg.Updates.RetentionDays, err = parsePositiveInt("TILECAST_UPDATE_RETENTION_DAYS", "90", 3650); err != nil {
		return Config{}, err
	}
	if cfg.Media.MaxUploadBytes, err = parsePositiveInt64("TILECAST_MAX_UPLOAD_BYTES", "10737418240"); err != nil {
		return Config{}, err
	}
	if cfg.Media.Workers, err = parsePositiveInt("TILECAST_MEDIA_WORKERS", "2", 32); err != nil {
		return Config{}, err
	}
	reserved, err := parsePositiveInt64("TILECAST_MEDIA_RESERVED_FREE_BYTES", "1073741824")
	if err != nil {
		return Config{}, err
	}
	cfg.Media.ReservedFreeBytes = uint64(reserved)
	if cfg.Media.VideoMaxWidth, err = parsePositiveInt("TILECAST_VIDEO_MAX_WIDTH", "1920", 0); err != nil {
		return Config{}, err
	}
	if cfg.Media.VideoMaxHeight, err = parsePositiveInt("TILECAST_VIDEO_MAX_HEIGHT", "1080", 0); err != nil {
		return Config{}, err
	}
	if cfg.Media.VideoMaxFrameRate, err = strconv.ParseFloat(get("TILECAST_VIDEO_MAX_FRAME_RATE", "60"), 64); err != nil || cfg.Media.VideoMaxFrameRate <= 0 {
		return Config{}, errors.New("TILECAST_VIDEO_MAX_FRAME_RATE must be positive")
	}
	if cfg.Media.KeepOriginals, err = strconv.ParseBool(get("TILECAST_KEEP_ORIGINALS", "true")); err != nil {
		return Config{}, fmt.Errorf("parse TILECAST_KEEP_ORIGINALS: %w", err)
	}

	cfg.Backup.Root = get("TILECAST_BACKUP_ROOT", "/data/backups")
	if cfg.Backup.ReservedFreeBytes, err = parsePositiveInt64("TILECAST_BACKUP_RESERVED_FREE_BYTES", "1073741824"); err != nil {
		return Config{}, err
	}
	if cfg.Backup.MaxArchiveBytes, err = parsePositiveInt64("TILECAST_BACKUP_MAX_ARCHIVE_BYTES", "4398046511104"); err != nil {
		return Config{}, err
	}
	if cfg.Backup.MaxArchiveFiles, err = parsePositiveInt("TILECAST_BACKUP_MAX_ARCHIVE_FILES", "2000000", 100000000); err != nil {
		return Config{}, err
	}

	ttl, err := time.ParseDuration(get("TILECAST_SESSION_TTL", "24h"))
	if err != nil || ttl < 15*time.Minute {
		return Config{}, errors.New("TILECAST_SESSION_TTL must be a duration of at least 15m")
	}
	cfg.SessionTTL = ttl

	if cfg.DemoMode() {
		if err := loadDemo(&cfg); err != nil {
			return Config{}, err
		}
	}

	return cfg, nil
}

func parsePositiveInt(key, fallback string, max int) (int, error) {
	value, err := strconv.Atoi(get(key, fallback))
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	if max > 0 && value > max {
		return 0, fmt.Errorf("%s must be between 1 and %d", key, max)
	}
	return value, nil
}

func parsePositiveInt64(key, fallback string) (int64, error) {
	value, err := strconv.ParseInt(get(key, fallback), 10, 64)
	if err != nil || value <= 0 {
		return 0, fmt.Errorf("%s must be a positive integer", key)
	}
	return value, nil
}

func get(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
