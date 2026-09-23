import type { SettingDefinition } from "../api/types";
import type { SettingsSectionId } from "./settingsNavigation";

export const enumLabels: Record<string, string> = {
  managed_kiosk: "Managed Kiosk",
  standard: "Standard reliability",
  first_party: "First-party cookies",
  first_and_third_party: "First- and third-party cookies",
  download_only: "Download only",
  on_each_activation: "Reload on each activation",
  load_once: "Load once",
  fallback_image: "Fallback image",
  last_success: "Last successful page",
  "12-hour": "12-hour",
  "24-hour": "24-hour",
  en_US: "English (United States)",
  contain: "Contain",
  cover: "Cover",
  stretch: "Stretch",
  disabled: "Disabled",
  enabled: "Enabled",
  none: "None",
  fade: "Fade",
  automatic: "Automatic",
  download: "Download",
  stream: "Stream",
  minimal: "Minimal",
  detailed: "Detailed",
  system: "System",
  light: "Light",
  dark: "Dark",
  comfortable: "Comfortable",
  compact: "Compact",
  grid: "Grid",
  list: "List",
  groups: "Groups",
  organization: "Organization default",
  sunday: "Sunday",
  monday: "Monday",
  locale: "Use locale",
  placeholder: "Tilecast placeholder",
  skip: "Skip item",
  interval: "Reload on an interval",
  bouncing_logo: "Bouncing Tilecast logo",
  custom_text: "Custom text",
  black: "Black screen",
};
export const descriptions: Record<string, string> = {
  "player.cache.max_bytes":
    "Maximum storage Tilecast may use for downloaded content.",
  "player.cache.minimum_free_bytes":
    "Storage Tilecast keeps free for Android and other applications.",
  "player.download.automatic_threshold_bytes":
    "Largest item Automatic delivery will download instead of stream.",
  "power.active_hours_days": "Days when this player should operate normally.",
  "power.outside_active_hours_display":
    "What remains visible when the player is outside active hours and the television does not sleep.",
  "power.outside_active_hours_text":
    "Centered text shown outside active hours. Leave it empty to use the branding footer text.",
  "accessibility.allowed_packages":
    "Applications that may remain in front during authorized maintenance.",
  "reliability.mode":
    "Standard reliability and recovery apply to Android and Linux. Managed Kiosk is Android-only and requires device-owner support.",
};

export const subsectionOrder: Record<
  SettingsSectionId,
  { title: string; description?: string; keys?: string[]; prefix?: string[] }[]
> = {
  playback: [
    {
      title: "Playback defaults",
      keys: [
        "player.playback.default_fit_mode",
        "player.playback.default_volume",
        "player.playback.default_image_duration_seconds",
        "player.playback.default_transition",
        "player.playback.default_audio_enabled",
        "player.playback.resume_after_restart",
      ],
    },
    {
      title: "Storage and delivery",
      prefix: ["player.cache.", "player.download."],
    },
    { title: "Synchronization", prefix: ["player.sync."] },
    {
      title: "Identification and diagnostics",
      prefix: ["player.identify."],
    },
  ],
  reliability: [
    { title: "Reliability mode", keys: ["reliability.mode"] },
    {
      title: "Startup and presentation",
      keys: ["reliability.launch_after_boot", "reliability.immersive_mode"],
    },
    {
      title: "Watchdog and recovery",
      prefix: [
        "reliability.foreground_",
        "reliability.playback_",
        "reliability.webview_",
        "reliability.maximum_",
        "reliability.restart_",
        "reliability.safe_",
      ],
    },
    {
      title: "Android Managed Kiosk",
      description:
        "Android-only controls that take effect when the device confirms compatible device-owner capability.",
      prefix: ["managed_kiosk."],
    },
    {
      title: "Linux kiosk",
      description:
        "Linux window and desktop-session behavior. Starting at boot and restarting after process exit come from the player's systemd service, which is set up per screen from the screen's Reliability tab rather than here.",
      prefix: ["linux_kiosk."],
    },
  ],
  power: [
    {
      title: "Active hours",
      keys: [
        "power.active_hours_enabled",
        "power.active_hours_timezone",
        "power.active_hours_days",
        "power.active_hours_start",
        "power.active_hours_end",
      ],
    },
    {
      title: "Active-hour behavior",
      keys: [
        "power.startup_grace_seconds",
        "power.shutdown_prepare_seconds",
        "power.keep_screen_on",
        "power.sleep_outside_active_hours",
      ],
    },
    {
      title: "Outside active hours",
      description:
        "Choose the fallback shown when the player is outside active hours and Android or the television remains awake.",
      keys: [
        "power.outside_active_hours_display",
        "power.outside_active_hours_text",
      ],
    },
  ],
  accessibility: [
    {
      title: "Automatic return",
      keys: [
        "accessibility.control_assist_enabled",
        "accessibility.return_delay_seconds",
        "accessibility.maximum_returns",
        "accessibility.return_window_minutes",
      ],
    },
    {
      title: "Safety pauses",
      keys: [
        "accessibility.pause_during_updates",
        "accessibility.pause_during_admin_session",
      ],
    },
    {
      title: "Allowed maintenance applications",
      keys: ["accessibility.allowed_packages"],
    },
    { title: "Diagnostics", keys: ["accessibility.report_foreground_package"] },
  ],
  branding: [
    {
      title: "Player fallback screen",
      prefix: [
        "branding.no_content_",
        "branding.disabled_",
        "branding.footer_",
      ],
    },
  ],
  general: [
    {
      title: "Organization identity",
      prefix: ["organization.name", "organization.short"],
    },
    {
      title: "Regional formats",
      prefix: [
        "organization.timezone",
        "organization.locale",
        "organization.first",
        "organization.date",
        "organization.time_format",
      ],
    },
    { title: "Support details", prefix: ["organization.support"] },
  ],
  media: [
    {
      title: "Uploads and retention",
      prefix: [
        "media.upload",
        "media.keep",
        "media.temporary",
        "media.deleted",
      ],
    },
    {
      title: "Future video processing",
      prefix: ["media.video.max", "media.processing"],
    },
    {
      title: "Delivery defaults",
      prefix: ["media.video.default", "media.image.default"],
    },
  ],
  websites: [
    {
      title: "Page capabilities",
      prefix: [
        "website.default_javascript",
        "website.default_dom",
        "website.default_cookie",
        "website.private",
      ],
    },
    {
      title: "Loading and reloads",
      prefix: [
        "website.default_timeout",
        "website.default_reload",
        "website.minimum_refresh",
        "website.default_zoom",
      ],
    },
    {
      title: "Failure behavior",
      prefix: [
        "website.default_failure",
        "website.default_fallback",
        "website.clear_data",
      ],
    },
    { title: "Player overrides", prefix: ["player.website."] },
  ],
  scheduling: [{ title: "Schedule defaults", prefix: ["scheduling."] }],
  takeover: [
    { title: "Takeover defaults", prefix: ["takeover."] },
    { title: "Player command defaults", prefix: ["commands."] },
  ],
  retention: [
    {
      title: "Security and operational history",
      prefix: ["retention.audit", "retention.command", "retention.takeover"],
    },
    {
      title: "Cleanup periods",
      prefix: [
        "retention.player",
        "retention.expired",
        "retention.failed",
        "retention.deleted",
      ],
    },
    { title: "Diagnostic limits", prefix: ["retention.max"] },
  ],
  backups: [
    {
      title: "Automatic backup schedule",
      prefix: ["backups.schedule_"],
    },
    {
      title: "Scheduled backup retention",
      description:
        "Retention applies to scheduled backups. Manually created backups remain until an Owner deletes them.",
      prefix: ["backups.retention_"],
    },
  ],
  notifications: [
    {
      title: "Delivery",
      description:
        "Email needs an SMTP relay configured on the server. Webhooks work without one.",
      keys: [
        "notifications.enabled",
        "notifications.from_address",
        "notifications.from_name",
        "notifications.minimum_severity",
      ],
    },
    {
      title: "Timing",
      description:
        "A critical condition is always sent immediately, whatever these say.",
      keys: [
        "notifications.timezone",
        "notifications.digest_time",
        "notifications.quiet_hours_enabled",
        "notifications.quiet_hours_start",
        "notifications.quiet_hours_end",
      ],
    },
    { title: "History", keys: ["notifications.retention_days"] },
  ],
  preferences: [
    {
      title: "Notifications",
      description:
        "What Tilecast tells you about when you are not looking at Studio.",
      prefix: ["preference.notifications."],
    },
    {
      title: "Appearance",
      prefix: [
        "preference.appearance",
        "preference.density",
        "preference.reduced",
      ],
    },
    {
      title: "Dates and tables",
      prefix: ["preference.time", "preference.table"],
    },
    {
      title: "Default views",
      prefix: [
        "preference.content",
        "preference.screens",
        "preference.remember",
        "preference.hide",
      ],
    },
  ],
  users: [],
  security: [
    {
      title: "Multi-factor authentication",
      keys: ["security.mfa_required_scope"],
    },
  ],
  locations: [],
  snapshots: [
    {
      title: "Capture",
      description:
        "Snapshots are held in the database and are included in every backup. The caps below are what keep that bounded.",
      prefix: ["snapshots."],
    },
  ],
  "content-review": [
    {
      title: "Approval",
      description:
        "There is no submit step. Content is waiting for review whenever its current revision has no decision, so editing approved content sends it back automatically.",
      prefix: ["content.approval_"],
    },
  ],
  integrations: [],
  "player-updates": [],
  "presentation-networks": [],
  system: [],
  "import-export": [],
  "dependency-graph": [],
};

const hiddenSettingKeys = new Set(["power.black_screen_fallback"]);

export function groupsFor(
  section: SettingsSectionId,
  definitions: SettingDefinition[],
) {
  const visibleDefinitions = definitions.filter(
    (definition) => !hiddenSettingKeys.has(definition.key),
  );
  const used = new Set<string>();
  const groups = subsectionOrder[section]
    .map((group) => ({
      ...group,
      definitions: visibleDefinitions.filter((definition) => {
        const match =
          group.keys?.includes(definition.key) ||
          group.prefix?.some((prefix) => definition.key.startsWith(prefix));
        if (match) used.add(definition.key);
        return match;
      }),
    }))
    .filter((group) => group.definitions.length > 0);
  const remaining = visibleDefinitions.filter(
    (definition) => !used.has(definition.key),
  );
  if (remaining.length)
    groups.push({ title: "Additional settings", definitions: remaining });
  return groups;
}

export function descriptionFor(definition: SettingDefinition) {
  return (
    definition.description ||
    descriptions[definition.key] ||
    `Configure ${definition.title.toLowerCase()} for Tilecast.`
  );
}
export function enumLabel(value: string) {
  return (
    enumLabels[value] ??
    value.replaceAll("_", " ").replace(/^./, (letter) => letter.toUpperCase())
  );
}
