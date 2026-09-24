package settings

import (
	"errors"
	"fmt"
	"net/mail"
	"regexp"
	"strings"
	"time"

	"github.com/tilecast/tilecast/apps/server/internal/regional"
)

const SchemaVersion = 1

type Scope string

const (
	ScopeOrganization Scope = "organization"
	ScopePolicy       Scope = "policy"
	ScopePreference   Scope = "preference"
)

type Definition struct {
	Key             string   `json:"key"`
	Category        string   `json:"category"`
	Type            string   `json:"type"`
	Title           string   `json:"title"`
	Description     string   `json:"description,omitempty"`
	Documentation   string   `json:"documentation,omitempty"`
	Default         any      `json:"default"`
	Min             *float64 `json:"min,omitempty"`
	Max             *float64 `json:"max,omitempty"`
	Allowed         []string `json:"allowed,omitempty"`
	Scope           Scope    `json:"scope"`
	Sensitive       bool     `json:"sensitive"`
	RestartRequired bool     `json:"restartRequired"`
	Immediate       bool     `json:"immediate"`
	FutureOnly      bool     `json:"futureOnly"`
}

func number(v float64) *float64 { return &v }

var definitions = []Definition{
	{Key: "backups.schedule_enabled", Category: "backups", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Scheduled backups", Description: "Create full backups automatically on a schedule"},
	{Key: "backups.schedule_frequency", Category: "backups", Type: "enum", Default: "daily", Allowed: []string{"daily", "weekly"}, Scope: ScopeOrganization, Title: "Backup frequency"},
	{Key: "backups.schedule_day", Category: "backups", Type: "enum", Default: "sunday", Allowed: []string{"sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}, Scope: ScopeOrganization, Title: "Backup day", Description: "Day of the week for weekly backups"},
	{Key: "backups.schedule_time", Category: "backups", Type: "local_time", Default: "02:30", Scope: ScopeOrganization, Title: "Backup time"},
	{Key: "backups.schedule_timezone", Category: "backups", Type: "timezone", Default: "UTC", Scope: ScopeOrganization, Title: "Backup timezone"},
	{Key: "backups.retention_max_count", Category: "backups", Type: "int", Default: 7.0, Min: number(1), Max: number(365), Scope: ScopeOrganization, Title: "Scheduled backups to keep"},
	{Key: "backups.retention_max_age_days", Category: "backups", Type: "int", Default: 90.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Maximum scheduled backup age (days)"},
	{Key: "notifications.enabled", Category: "notifications", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Send notifications", Description: "Email needs TILECAST_SMTP_HOST on the server. Without it, notifications stay off and nothing fails.", Documentation: "docs/notifications.md"},
	{Key: "notifications.from_address", Category: "notifications", Type: "email", Default: "", Scope: ScopeOrganization, Title: "From address", Description: "Address that notification email is sent from"},
	{Key: "notifications.from_name", Category: "notifications", Type: "string", Default: "Tilecast", Scope: ScopeOrganization, Title: "From name"},
	{Key: "notifications.minimum_severity", Category: "notifications", Type: "enum", Default: "warning", Allowed: []string{"info", "warning", "error", "critical"}, Scope: ScopeOrganization, Title: "Minimum severity", Description: "Conditions below this severity are recorded in Activity but are not sent"},
	{Key: "notifications.digest_time", Category: "notifications", Type: "local_time", Default: "07:30", Scope: ScopeOrganization, Title: "Daily digest time"},
	{Key: "notifications.timezone", Category: "notifications", Type: "timezone", Default: "UTC", Scope: ScopeOrganization, Title: "Notification timezone", Description: "Applies to the digest time and to quiet hours"},
	{Key: "notifications.quiet_hours_enabled", Category: "notifications", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Quiet hours", Description: "Holds notifications until quiet hours end. Critical conditions are always sent immediately."},
	{Key: "notifications.quiet_hours_start", Category: "notifications", Type: "local_time", Default: "20:00", Scope: ScopeOrganization, Title: "Quiet hours start"},
	{Key: "notifications.quiet_hours_end", Category: "notifications", Type: "local_time", Default: "06:30", Scope: ScopeOrganization, Title: "Quiet hours end"},
	{Key: "notifications.retention_days", Category: "notifications", Type: "int", Default: 90.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Delivery log retention"},
	{Key: "content_health.stale_source_hours", Category: "notifications", Type: "int", Default: 12.0, Min: number(1), Max: number(720), Scope: ScopeOrganization, Title: "Stale Data Source after", Description: "Hours without a successful refresh before a Data Source counts as stale. A weekly calendar tolerates far more than a weather feed.", Documentation: "docs/notifications.md"},
	{Key: "content_health.expiring_media_days", Category: "notifications", Type: "int", Default: 14.0, Min: number(1), Max: number(365), Scope: ScopeOrganization, Title: "Warn about expiring media", Description: "How far ahead the content health report lists media that is about to expire"},
	{Key: "snapshots.enabled", Category: "snapshots", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Keep a snapshot history", Description: "Stores periodic screen images so you can see what a screen showed earlier. Snapshots are held in the database and are included in every backup.", Documentation: "docs/snapshots.md"},
	{Key: "snapshots.interval_minutes", Category: "snapshots", Type: "int", Default: 60.0, Min: number(15), Max: number(1440), Scope: ScopeOrganization, Title: "Capture every"},
	{Key: "snapshots.retention_days", Category: "snapshots", Type: "int", Default: 7.0, Min: number(1), Max: number(90), Scope: ScopeOrganization, Title: "Keep snapshots for"},
	{Key: "snapshots.max_per_screen", Category: "snapshots", Type: "int", Default: 48.0, Min: number(1), Max: number(500), Scope: ScopeOrganization, Title: "Snapshots to keep per screen", Description: "The oldest are removed once a screen reaches this many, whatever the retention period says"},
	{Key: "content.approval_required", Category: "content_review", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Legacy approval switch", Description: "Retained for compatibility. New installations should use the content review policy.", Documentation: "docs/content-review.md"},
	{Key: "content.review_policy", Category: "content_review", Type: "enum", Default: "off", Allowed: []string{"off", "contributors", "everyone"}, Scope: ScopeOrganization, Title: "Content review policy", Description: "Choose whether no content, Contributor work, or every publication requires approval.", Documentation: "docs/content-review.md", Immediate: true},
	{Key: "content.allow_self_approval", Category: "content_review", Type: "bool", Default: true, Scope: ScopeOrganization, Title: "Allow self-approval", Description: "Allow a reviewer to approve their own submission.", Documentation: "docs/content-review.md", Immediate: true},
	{Key: "content.auto_publish_on_approval", Category: "content_review", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Automatically publish approved submissions", Description: "Publish immediately or schedule the requested time when a submission is approved.", Documentation: "docs/content-review.md", Immediate: true},
	{Key: "organization.name", Category: "general", Type: "string", Default: "Tilecast", Scope: ScopeOrganization, Title: "Organization name", Description: "Name shown throughout Tilecast Studio"},
	{Key: "organization.short_name", Category: "general", Type: "string", Default: "", Scope: ScopeOrganization, Title: "Short name", Description: "Compact organization name", Documentation: "docs/settings.md"},
	{Key: "organization.timezone", Category: "general", Type: "timezone", Default: "UTC", Scope: ScopeOrganization, Title: "Default timezone"},
	{Key: "organization.locale", Category: "general", Type: "locale", Default: "en-US", Scope: ScopeOrganization, Title: "Regional locale", Description: "BCP-47 language and region used to format organization signage and organization-level dates."},
	{Key: "organization.first_day_of_week", Category: "general", Type: "enum", Default: "sunday", Allowed: []string{"locale", "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"}, Scope: ScopeOrganization, Title: "First day of week"},
	{Key: "organization.date_format", Category: "general", Type: "enum", Default: "locale", Allowed: []string{"locale", "yyyy-MM-dd", "MM/dd/yyyy", "dd/MM/yyyy"}, Scope: ScopeOrganization, Title: "Date format"},
	{Key: "organization.time_format", Category: "general", Type: "enum", Default: "locale", Allowed: []string{"locale", "12-hour", "24-hour"}, Scope: ScopeOrganization, Title: "Time format"},
	{Key: "organization.support_name", Category: "general", Type: "string", Default: "", Scope: ScopeOrganization, Title: "Support contact"},
	{Key: "organization.support_email", Category: "general", Type: "email", Default: "", Scope: ScopeOrganization, Title: "Support email"},
	{Key: "organization.support_message", Category: "general", Type: "string", Default: "", Scope: ScopeOrganization, Title: "Internal support message"},
	{Key: "security.mfa_required_scope", Category: "security", Type: "enum", Default: "none", Allowed: []string{"none", "administrators", "all"}, Scope: ScopeOrganization, Title: "Require multi-factor authentication", Description: "Accounts in scope must enroll an authenticator app or a passkey before they can use Tilecast Studio.", Documentation: "docs/multi-factor-authentication.md", Immediate: true},
	{Key: "branding.logo_asset_id", Category: "branding", Type: "uuid_or_empty", Default: "", Scope: ScopeOrganization, Title: "Logo"},
	{Key: "branding.icon_asset_id", Category: "branding", Type: "uuid_or_empty", Default: "", Scope: ScopeOrganization, Title: "Square icon"},
	{Key: "branding.primary_color", Category: "branding", Type: "color", Default: "#78BFA6", Scope: ScopeOrganization, Title: "Primary color", Immediate: true},
	{Key: "branding.player_background_color", Category: "branding", Type: "color", Default: "#0E141B", Scope: ScopeOrganization, Title: "Player background", Immediate: true},
	{Key: "branding.player_text_color", Category: "branding", Type: "color", Default: "#F5F7FA", Scope: ScopeOrganization, Title: "Player text", Immediate: true},
	{Key: "branding.no_content_title", Category: "branding", Type: "string", Default: "No content assigned", Scope: ScopeOrganization, Title: "No-content title"},
	{Key: "branding.no_content_message", Category: "branding", Type: "string", Default: "This screen is ready for content.", Scope: ScopeOrganization, Title: "No-content message"},
	{Key: "branding.disabled_title", Category: "branding", Type: "string", Default: "Playback disabled", Scope: ScopeOrganization, Title: "Disabled title"},
	{Key: "branding.disabled_message", Category: "branding", Type: "string", Default: "This screen remains connected to Tilecast Studio.", Scope: ScopeOrganization, Title: "Disabled message"},
	{Key: "branding.footer_text", Category: "branding", Type: "string", Default: "", Scope: ScopeOrganization, Title: "Footer text"},
	{Key: "player.playback.default_fit_mode", Category: "playback", Type: "enum", Default: "contain", Allowed: []string{"contain", "cover", "stretch"}, Scope: ScopePolicy, Title: "Default fit mode"},
	{Key: "player.playback.default_volume", Category: "playback", Type: "float", Default: 0.5, Min: number(0), Max: number(1), Scope: ScopePolicy, Title: "Default volume", Immediate: true},
	{Key: "player.playback.default_image_duration_seconds", Category: "playback", Type: "int", Default: 10.0, Min: number(1), Max: number(86400), Scope: ScopeOrganization, Title: "Default image duration"},
	{Key: "player.playback.default_transition", Category: "playback", Type: "enum", Default: "none", Allowed: []string{"none", "fade", "crossfade"}, Scope: ScopeOrganization, Title: "Default transition"},
	{Key: "player.playback.default_audio_enabled", Category: "playback", Type: "bool", Default: true, Scope: ScopeOrganization, Title: "Default audio enabled"},
	{Key: "player.playback.resume_after_restart", Category: "playback", Type: "bool", Default: true, Scope: ScopeOrganization, Title: "Resume after restart"},
	{Key: "player.cache.max_bytes", Category: "playback", Type: "int64", Default: 8589934592.0, Min: number(268435456), Max: number(1099511627776), Scope: ScopePolicy, Title: "Maximum cache bytes"},
	{Key: "player.cache.minimum_free_bytes", Category: "playback", Type: "int64", Default: 1073741824.0, Min: number(134217728), Max: number(1099511627776), Scope: ScopePolicy, Title: "Minimum free bytes"},
	{Key: "player.download.concurrent_limit", Category: "playback", Type: "int", Default: 2.0, Min: number(1), Max: number(8), Scope: ScopePolicy, Title: "Concurrent downloads"},
	{Key: "player.download.automatic_threshold_bytes", Category: "playback", Type: "int64", Default: 268435456.0, Min: number(1048576), Max: number(10737418240), Scope: ScopePolicy, Title: "Automatic delivery threshold"},
	{Key: "player.sync.manifest_seconds", Category: "playback", Type: "int", Default: 300.0, Min: number(60), Max: number(86400), Scope: ScopePolicy, Title: "Manifest reconciliation interval", Immediate: true},
	{Key: "player.sync.status_seconds", Category: "playback", Type: "int", Default: 60.0, Min: number(15), Max: number(3600), Scope: ScopePolicy, Title: "Status report interval", Immediate: true},
	{Key: "player.website.timeout_seconds", Category: "websites", Type: "int", Default: 20.0, Min: number(1), Max: number(120), Scope: ScopePolicy, Title: "Website timeout", Immediate: true},
	{Key: "player.website.cookie_policy", Category: "websites", Type: "enum", Default: "first_party", Allowed: []string{"disabled", "first_party", "first_and_third_party"}, Scope: ScopePolicy, Title: "Website cookie policy"},
	{Key: "player.website.clear_on_restart", Category: "websites", Type: "bool", Default: false, Scope: ScopePolicy, Title: "Clear website data on restart"},
	{Key: "player.identify.show_location", Category: "playback", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Show location when identifying"},
	{Key: "player.update.channel", Category: "playback", Type: "enum", Default: "stable", Allowed: []string{"stable", "beta"}, Scope: ScopePolicy, Title: "Player update channel", Description: "Stable is the hardened default. Beta releases still require an explicit deployment."},
	{Key: "reliability.mode", Category: "reliability", Type: "enum", Default: "standard", Allowed: []string{"standard", "managed_kiosk"}, Scope: ScopePolicy, Title: "Reliability mode", Description: "Managed Kiosk becomes effective only when Android confirms device-policy capability."},
	{Key: "reliability.launch_after_boot", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Launch after boot", Description: "Android only. Linux players start at boot from a systemd user service, installed per screen from the screen's Reliability tab.", Immediate: true},
	{Key: "reliability.immersive_mode", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Immersive fullscreen", Immediate: true},
	{Key: "reliability.foreground_watchdog_enabled", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Foreground watchdog", Immediate: true},
	{Key: "reliability.playback_stall_seconds", Category: "reliability", Type: "int", Default: 30.0, Min: number(10), Max: number(600), Scope: ScopePolicy, Title: "Playback stall threshold"},
	{Key: "reliability.webview_stall_seconds", Category: "reliability", Type: "int", Default: 45.0, Min: number(15), Max: number(600), Scope: ScopePolicy, Title: "Website stall threshold"},
	{Key: "reliability.maximum_process_restarts", Category: "reliability", Type: "int", Default: 3.0, Min: number(0), Max: number(10), Scope: ScopePolicy, Title: "Maximum process recoveries"},
	{Key: "reliability.restart_window_minutes", Category: "reliability", Type: "int", Default: 10.0, Min: number(1), Max: number(120), Scope: ScopePolicy, Title: "Recovery window"},
	{Key: "reliability.safe_mode_enabled", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Crash-loop safe mode"},
	{Key: "power.active_hours_enabled", Category: "power", Type: "bool", Default: false, Scope: ScopePolicy, Title: "Active hours"},
	{Key: "power.active_hours_timezone", Category: "power", Type: "timezone", Default: "UTC", Scope: ScopePolicy, Title: "Active-hours timezone"},
	{Key: "power.active_hours_days", Category: "power", Type: "weekday_list", Default: []any{1.0, 2.0, 3.0, 4.0, 5.0}, Scope: ScopePolicy, Title: "Active days"},
	{Key: "power.active_hours_start", Category: "power", Type: "local_time", Default: "06:30", Scope: ScopePolicy, Title: "Start time"},
	{Key: "power.active_hours_end", Category: "power", Type: "local_time", Default: "16:00", Scope: ScopePolicy, Title: "End time"},
	{Key: "power.startup_grace_seconds", Category: "power", Type: "int", Default: 30.0, Min: number(0), Max: number(3600), Scope: ScopePolicy, Title: "Startup grace", Description: "Android Power Assist only; Linux startup and process recovery are managed by systemd."},
	{Key: "power.shutdown_prepare_seconds", Category: "power", Type: "int", Default: 60.0, Min: number(0), Max: number(3600), Scope: ScopePolicy, Title: "Shutdown preparation", Description: "Android Power Assist and status reporting only; Linux uses its systemd/display-control integration."},
	{Key: "power.keep_screen_on", Category: "power", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Keep screen awake during active hours", Description: "Android active-hours wake policy; Linux uses linux_kiosk.prevent_display_sleep for the host display-sleep blocker.", Immediate: true},
	{Key: "power.sleep_outside_active_hours", Category: "power", Type: "bool", Default: false, Scope: ScopePolicy, Title: "Request sleep outside active hours", Description: "Android Power Assist only; Linux shows its configured branded off-hours surface and does not request operating-system sleep."},
	{Key: "power.outside_active_hours_display", Category: "power", Type: "enum", Default: "black", Allowed: []string{"bouncing_logo", "custom_text", "black"}, Scope: ScopePolicy, Title: "Outside active hours", Description: "Choose what remains visible when the player is outside active hours and the display does not sleep."},
	{Key: "power.outside_active_hours_text", Category: "power", Type: "string", Default: "", Scope: ScopePolicy, Title: "Custom text", Description: "Centered text shown outside active hours. When empty, Tilecast uses the branding footer text."},
	{Key: "managed_kiosk.lock_task_enabled", Category: "reliability", Type: "bool", Default: false, Scope: ScopePolicy, Title: "Lock task"},
	{Key: "managed_kiosk.block_overlays", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Block overlays where supported"},
	{Key: "managed_kiosk.allow_settings_during_admin", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Allow Settings during maintenance"},
	{Key: "managed_kiosk.admin_session_minutes", Category: "reliability", Type: "int", Default: 15.0, Min: number(1), Max: number(120), Scope: ScopePolicy, Title: "Maintenance session duration"},
	{Key: "linux_kiosk.fullscreen_enabled", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Kiosk fullscreen", Description: "Keeps Tilecast in a frameless fullscreen kiosk window on Linux. TILECAST_WINDOWED=1 remains a local development override.", Immediate: true},
	{Key: "linux_kiosk.prevent_display_sleep", Category: "reliability", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Prevent display sleep", Description: "Asks the Linux desktop session to keep the display awake while Tilecast Player is running.", Immediate: true},
	{Key: "accessibility.control_assist_enabled", Category: "accessibility", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Accessibility Control Assist", Description: "Hardened players request this behavior by default, but the Android service still requires deliberate local enablement."},
	{Key: "accessibility.return_delay_seconds", Category: "accessibility", Type: "int", Default: 10.0, Min: number(3), Max: number(300), Scope: ScopePolicy, Title: "Return delay"},
	{Key: "accessibility.allowed_packages", Category: "accessibility", Type: "package_list", Default: []any{}, Scope: ScopePolicy, Title: "Maintenance applications"},
	{Key: "accessibility.pause_during_updates", Category: "accessibility", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Pause during player updates"},
	{Key: "accessibility.pause_during_admin_session", Category: "accessibility", Type: "bool", Default: true, Scope: ScopePolicy, Title: "Pause during maintenance"},
	{Key: "accessibility.report_foreground_package", Category: "accessibility", Type: "bool", Default: false, Scope: ScopePolicy, Title: "Report foreground package"},
	{Key: "accessibility.maximum_returns", Category: "accessibility", Type: "int", Default: 3.0, Min: number(1), Max: number(20), Scope: ScopePolicy, Title: "Maximum automatic returns"},
	{Key: "accessibility.return_window_minutes", Category: "accessibility", Type: "int", Default: 10.0, Min: number(1), Max: number(120), Scope: ScopePolicy, Title: "Return attempt window"},
	{Key: "media.upload.max_bytes", Category: "media", Type: "int64", Default: 10737418240.0, Min: number(1048576), Max: number(1099511627776), Scope: ScopeOrganization, Title: "Studio upload limit"},
	{Key: "media.keep_originals", Category: "media", Type: "bool", Default: true, Scope: ScopeOrganization, Title: "Keep originals", FutureOnly: true},
	{Key: "media.video.max_width", Category: "media", Type: "int", Default: 1920.0, Min: number(320), Max: number(7680), Scope: ScopeOrganization, Title: "Maximum video width", FutureOnly: true},
	{Key: "media.video.max_height", Category: "media", Type: "int", Default: 1080.0, Min: number(240), Max: number(4320), Scope: ScopeOrganization, Title: "Maximum video height", FutureOnly: true},
	{Key: "media.video.max_frame_rate", Category: "media", Type: "float", Default: 60.0, Min: number(1), Max: number(120), Scope: ScopeOrganization, Title: "Maximum frame rate", FutureOnly: true},
	{Key: "media.video.default_delivery_policy", Category: "media", Type: "enum", Default: "automatic", Allowed: []string{"download", "stream", "automatic"}, Scope: ScopeOrganization, Title: "Default video delivery"},
	{Key: "media.image.default_fit_mode", Category: "media", Type: "enum", Default: "contain", Allowed: []string{"contain", "cover", "stretch"}, Scope: ScopeOrganization, Title: "Default image fit"},
	{Key: "media.video.default_fit_mode", Category: "media", Type: "enum", Default: "contain", Allowed: []string{"contain", "cover", "stretch"}, Scope: ScopeOrganization, Title: "Default video fit"},
	{Key: "media.processing.retry_limit", Category: "media", Type: "int", Default: 3.0, Min: number(0), Max: number(10), Scope: ScopeOrganization, Title: "Processing retry limit", FutureOnly: true},
	{Key: "media.temporary_upload_retention_hours", Category: "media", Type: "int", Default: 24.0, Min: number(1), Max: number(720), Scope: ScopeOrganization, Title: "Temporary upload retention"},
	{Key: "media.deleted_retention_days", Category: "media", Type: "int", Default: 30.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Deleted media retention"},
	{Key: "scheduling.prefetch_days", Category: "scheduling", Type: "int", Default: 14.0, Min: number(1), Max: number(365), Scope: ScopeOrganization, Title: "Prefetch horizon"},
	{Key: "scheduling.activation_grace_seconds", Category: "scheduling", Type: "int", Default: 30.0, Min: number(1), Max: number(3600), Scope: ScopeOrganization, Title: "Activation grace"},
	{Key: "scheduling.clock_skew_warning_seconds", Category: "scheduling", Type: "int", Default: 300.0, Min: number(30), Max: number(86400), Scope: ScopeOrganization, Title: "Clock-skew warning"},
	{Key: "scheduling.default_one_time_duration_minutes", Category: "scheduling", Type: "int", Default: 60.0, Min: number(1), Max: number(10080), Scope: ScopeOrganization, Title: "Default one-time duration"},
	{Key: "website.default_javascript", Category: "websites", Type: "bool", Default: true, Scope: ScopeOrganization, Title: "JavaScript default"},
	{Key: "website.default_dom_storage", Category: "websites", Type: "bool", Default: true, Scope: ScopeOrganization, Title: "DOM storage default"},
	{Key: "website.default_timeout_seconds", Category: "websites", Type: "int", Default: 20.0, Min: number(1), Max: number(120), Scope: ScopeOrganization, Title: "Website timeout default"},
	{Key: "website.default_cookie_policy", Category: "websites", Type: "enum", Default: "first_party", Allowed: []string{"disabled", "first_party", "first_and_third_party"}, Scope: ScopeOrganization, Title: "Default cookie policy"},
	{Key: "website.default_reload_policy", Category: "websites", Type: "enum", Default: "on_each_activation", Allowed: []string{"load_once", "on_each_activation", "interval"}, Scope: ScopeOrganization, Title: "Default reload policy"},
	{Key: "website.minimum_refresh_seconds", Category: "websites", Type: "int", Default: 30.0, Min: number(30), Max: number(86400), Scope: ScopeOrganization, Title: "Minimum refresh interval"},
	{Key: "website.default_failure_behavior", Category: "websites", Type: "enum", Default: "placeholder", Allowed: []string{"last_success", "placeholder", "fallback_image", "skip"}, Scope: ScopeOrganization, Title: "Default failure behavior"},
	{Key: "website.default_zoom_percent", Category: "websites", Type: "int", Default: 100.0, Min: number(50), Max: number(200), Scope: ScopeOrganization, Title: "Default zoom"},
	{Key: "website.default_fallback_image_id", Category: "websites", Type: "uuid_or_empty", Default: "", Scope: ScopeOrganization, Title: "Default fallback image"},
	{Key: "website.clear_data_on_delete", Category: "websites", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Clear website data after deletion"},
	{Key: "website.private_http_enabled", Category: "websites", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Private HTTP enabled"},
	{Key: "takeover.default_duration_minutes", Category: "takeover", Type: "int", Default: 60.0, Min: number(1), Max: number(1440), Scope: ScopeOrganization, Title: "Default takeover duration"},
	{Key: "takeover.maximum_duration_minutes", Category: "takeover", Type: "int", Default: 1440.0, Min: number(1), Max: number(10080), Scope: ScopeOrganization, Title: "Maximum takeover duration"},
	{Key: "commands.default_expiry_minutes", Category: "takeover", Type: "int", Default: 10.0, Min: number(1), Max: number(1440), Scope: ScopeOrganization, Title: "Command expiration"},
	{Key: "commands.identify_duration_seconds", Category: "takeover", Type: "int", Default: 30.0, Min: number(10), Max: number(120), Scope: ScopeOrganization, Title: "Identify duration"},
	{Key: "takeover.confirmation_required", Category: "takeover", Type: "bool", Default: true, Scope: ScopeOrganization, Title: "Require takeover confirmation"},
	{Key: "takeover.reauthentication_required", Category: "takeover", Type: "bool", Default: false, Scope: ScopeOrganization, Title: "Require password confirmation"},
	{Key: "retention.command_history_days", Category: "retention", Type: "int", Default: 30.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Command history retention"},
	{Key: "retention.audit_days", Category: "retention", Type: "int", Default: 365.0, Min: number(30), Max: number(3650), Scope: ScopeOrganization, Title: "Audit retention"},
	{Key: "retention.player_status_days", Category: "retention", Type: "int", Default: 30.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Player status retention"},
	{Key: "retention.expired_pairing_days", Category: "retention", Type: "int", Default: 30.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Expired pairing retention"},
	{Key: "retention.failed_upload_days", Category: "retention", Type: "int", Default: 7.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Failed upload retention"},
	{Key: "retention.deleted_media_metadata_days", Category: "retention", Type: "int", Default: 90.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Deleted media metadata retention"},
	{Key: "retention.takeover_history_days", Category: "retention", Type: "int", Default: 365.0, Min: number(1), Max: number(3650), Scope: ScopeOrganization, Title: "Takeover history retention"},
	{Key: "retention.max_diagnostic_events_per_screen", Category: "retention", Type: "int", Default: 1000.0, Min: number(10), Max: number(100000), Scope: ScopeOrganization, Title: "Diagnostic event limit"},
	{Key: "preference.appearance", Category: "interface", Type: "enum", Default: "system", Allowed: []string{"system", "light", "dark"}, Scope: ScopePreference, Title: "Appearance", Immediate: true},
	// "system" follows the browser. Studio falls back to English for any
	// language it does not ship, so this list grows only with a locale.
	{Key: "preference.language", Category: "interface", Type: "enum", Default: "system", Allowed: []string{"system", "en", "es", "ru"}, Scope: ScopePreference, Title: "Language", Immediate: true},
	{Key: "preference.density", Category: "interface", Type: "enum", Default: "comfortable", Allowed: []string{"comfortable", "compact"}, Scope: ScopePreference, Title: "Interface density", Immediate: true},
	{Key: "preference.reduced_motion", Category: "interface", Type: "bool", Default: false, Scope: ScopePreference, Title: "Reduced motion", Immediate: true},
	{Key: "preference.time_format", Category: "interface", Type: "enum", Default: "organization", Allowed: []string{"organization", "12-hour", "24-hour"}, Scope: ScopePreference, Title: "Time format"},
	{Key: "preference.content_view", Category: "interface", Type: "enum", Default: "grid", Allowed: []string{"grid", "list"}, Scope: ScopePreference, Title: "Default content view"},
	{Key: "preference.screens_view", Category: "interface", Type: "enum", Default: "list", Allowed: []string{"list", "groups"}, Scope: ScopePreference, Title: "Default screens view"},
	{Key: "preference.table_page_size", Category: "interface", Type: "int", Default: 25.0, Allowed: []string{"10", "25", "50", "100"}, Scope: ScopePreference, Title: "Table page size"},
	{Key: "preference.remember_filters", Category: "interface", Type: "bool", Default: true, Scope: ScopePreference, Title: "Remember filters"},
	{Key: "preference.hide_completed_uploads_minutes", Category: "interface", Type: "int", Default: 60.0, Min: number(0), Max: number(10080), Scope: ScopePreference, Title: "Hide completed uploads after"},
	// Opt-in by design. An installation that turns notifications on must not
	// start mailing every existing account without those people choosing it.
	{Key: "preference.notifications.mode", Category: "notifications", Type: "enum", Default: "off", Allowed: []string{"off", "immediate", "digest"}, Scope: ScopePreference, Title: "Notify me", Description: "Immediate sends each condition as it happens. Digest collects them into one daily message."},
	// Tilecast accounts sign in with a username, which is not necessarily an
	// address, so where to send is asked rather than assumed. Empty means this
	// account is never emailed, whatever else it has selected.
	{Key: "preference.notifications.address", Category: "notifications", Type: "email", Default: "", Scope: ScopePreference, Title: "Send to", Description: "Your email address. Notifications are not sent until this is set."},
	{Key: "preference.notifications.incidents", Category: "notifications", Type: "bool", Default: true, Scope: ScopePreference, Title: "Screen problems", Description: "A screen stops reporting, playback fails, or a Player enters safe mode"},
	{Key: "preference.notifications.content_health", Category: "notifications", Type: "bool", Default: true, Scope: ScopePreference, Title: "Content problems", Description: "A Data Source is serving stale data, or a playlist has nothing available to play"},
	{Key: "preference.notifications.backups", Category: "notifications", Type: "bool", Default: false, Scope: ScopePreference, Title: "Backups"},
	{Key: "preference.notifications.updates", Category: "notifications", Type: "bool", Default: false, Scope: ScopePreference, Title: "Player updates"},
}

var byKey = func() map[string]Definition {
	m := map[string]Definition{}
	for _, d := range definitions {
		m[d.Key] = d
	}
	return m
}()
var colorPattern = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
var localTimePattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]$`)
var legacyLocalTimePattern = regexp.MustCompile(`^(?:[01][0-9]|2[0-3]):[0-5][0-9]:00$`)
var packagePattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$`)

func Definitions() []Definition { return append([]Definition(nil), definitions...) }
func Defaults(scope Scope) map[string]any {
	out := map[string]any{}
	for _, d := range definitions {
		if d.Scope == scope || scope == ScopePolicy && d.Scope == ScopePolicy {
			out[d.Key] = d.Default
		}
	}
	return out
}

// WritableAtScope reports whether a definition may be written at this scope.
// Organization settings may also carry player-policy defaults; nothing else
// crosses a scope.
//
// The read path filters stored values through this same predicate, and it must
// keep doing so. A settings document that hands back a key the write will refuse
// makes the whole page unsavable: the dashboard posts the document it was given,
// one refused key fails the request, and every unrelated setting on the page
// fails with it.
func WritableAtScope(d Definition, scope Scope) bool {
	return d.Scope == scope || (scope == ScopeOrganization && d.Scope == ScopePolicy)
}

func Validate(values map[string]any, scope Scope) (map[string]any, error) {
	out := map[string]any{}
	for key, value := range values {
		d, ok := byKey[key]
		if !ok {
			return nil, fmt.Errorf("unknown_setting: %s", key)
		}
		if !WritableAtScope(d, scope) {
			return nil, fmt.Errorf("setting_not_allowed_at_scope: %s", key)
		}
		normalized, err := validateValue(d, value)
		if err != nil {
			return nil, fmt.Errorf("invalid_setting_value: %s: %w", key, err)
		}
		out[key] = normalized
	}
	return out, nil
}
func validateValue(d Definition, value any) (any, error) {
	switch d.Type {
	case "bool":
		if _, ok := value.(bool); !ok {
			return nil, errors.New("must be boolean")
		}
	case "string", "email", "color", "timezone", "uuid_or_empty", "enum", "locale", "local_time":
		s, ok := value.(string)
		if !ok || len(s) > 2000 {
			return nil, errors.New("must be a bounded string")
		}
		s = strings.TrimSpace(s)
		if d.Type == "email" && s != "" {
			if _, err := mail.ParseAddress(s); err != nil {
				return nil, errors.New("must be an email address")
			}
		}
		if d.Type == "color" && !colorPattern.MatchString(s) {
			return nil, errors.New("must be a six-digit hex color")
		}
		if d.Type == "timezone" {
			if s == "Local" || isLegacyTimezoneAbbreviation(s) {
				return nil, errors.New("must be a canonical IANA timezone")
			}
			if _, err := time.LoadLocation(s); err != nil {
				return nil, errors.New("must be a canonical IANA timezone")
			}
		}
		if d.Type == "locale" {
			if len(s) > 255 {
				return nil, errors.New("must be a BCP-47 language tag")
			}
			canonical, err := regional.CanonicalLocale(s)
			if err != nil {
				return nil, errors.New("must be a valid BCP-47 language tag")
			}
			return canonical, nil
		}
		if d.Type == "enum" && !contains(d.Allowed, s) {
			return nil, errors.New("is not allowed")
		}
		if d.Type == "local_time" {
			switch {
			case localTimePattern.MatchString(s):
			case legacyLocalTimePattern.MatchString(s):
				s = strings.TrimSuffix(s, ":00")
			default:
				return nil, errors.New("must use HH:mm local time")
			}
		}
		return s, nil
	case "weekday_list", "package_list":
		values, ok := value.([]any)
		if !ok || len(values) > 50 || (d.Type == "weekday_list" && len(values) == 0) {
			return nil, errors.New("must be a bounded non-empty list")
		}
		seen := map[string]bool{}
		normalized := make([]any, 0, len(values))
		for _, item := range values {
			if d.Type == "weekday_list" {
				n, ok := item.(float64)
				if !ok || n < 1 || n > 7 || n != float64(int(n)) || seen[fmt.Sprint(n)] {
					return nil, errors.New("weekdays must be unique ISO values from 1 through 7")
				}
				seen[fmt.Sprint(n)] = true
				normalized = append(normalized, n)
				continue
			}
			s, ok := item.(string)
			s = strings.TrimSpace(s)
			if !ok || len(s) > 200 || !packagePattern.MatchString(s) || seen[s] {
				return nil, errors.New("package names must be unique Android application IDs")
			}
			seen[s] = true
			normalized = append(normalized, s)
		}
		return normalized, nil
	case "int", "int64", "float":
		n, ok := value.(float64)
		if !ok {
			return nil, errors.New("must be numeric")
		}
		if (d.Type == "int" || d.Type == "int64") && n != float64(int64(n)) {
			return nil, errors.New("must be an integer")
		}
		if d.Min != nil && n < *d.Min || d.Max != nil && n > *d.Max {
			return nil, errors.New("is outside the allowed range")
		}
		return n, nil
	}
	return value, nil
}

func isLegacyTimezoneAbbreviation(value string) bool {
	switch value {
	case "EST", "EDT", "CST", "CDT", "MST", "MDT", "PST", "PDT":
		return true
	default:
		return false
	}
}
func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}
