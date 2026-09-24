import type { SettingDefinition } from "../api/types";
import { translateKnown } from "../i18n";
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
  // i18n-ignore: translateKnown fallback; the scan flags the key name
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

// Group headings hold translation keys, never rendered text. They are
// resolved with t() where they render (SettingsSection) so the headings
// follow language changes.
export type SettingsGroupTitleKey =
  | "groups.additional.title"
  | "groups.playback.defaults.title"
  | "groups.playback.storage.title"
  | "groups.playback.sync.title"
  | "groups.playback.identity.title"
  | "groups.reliability.mode.title"
  | "groups.reliability.startup.title"
  | "groups.reliability.watchdog.title"
  | "groups.reliability.androidKiosk.title"
  | "groups.reliability.linuxKiosk.title"
  | "groups.power.hours.title"
  | "groups.power.behavior.title"
  | "groups.power.outside.title"
  | "groups.accessibility.return.title"
  | "groups.accessibility.safety.title"
  | "groups.accessibility.allowed.title"
  | "groups.accessibility.diagnostics.title"
  | "groups.branding.fallback.title"
  | "groups.general.identity.title"
  | "groups.general.regional.title"
  | "groups.general.support.title"
  | "groups.media.uploads.title"
  | "groups.media.future.title"
  | "groups.media.delivery.title"
  | "groups.websites.capabilities.title"
  | "groups.websites.loading.title"
  | "groups.websites.failure.title"
  | "groups.websites.overrides.title"
  | "groups.scheduling.defaults.title"
  | "groups.takeover.takeover.title"
  | "groups.takeover.commands.title"
  | "groups.retention.security.title"
  | "groups.retention.cleanup.title"
  | "groups.retention.limits.title"
  | "groups.backups.schedule.title"
  | "groups.backups.retention.title"
  | "groups.notifications.delivery.title"
  | "groups.notifications.timing.title"
  | "groups.notifications.history.title"
  | "groups.preferences.notifications.title"
  | "groups.preferences.appearance.title"
  | "groups.preferences.dates.title"
  | "groups.preferences.views.title"
  | "groups.security.mfa.title"
  | "groups.snapshots.capture.title"
  | "groups.content-review.approval.title";

export type SettingsGroupDescriptionKey =
  | "groups.reliability.androidKiosk.description"
  | "groups.reliability.linuxKiosk.description"
  | "groups.power.outside.description"
  | "groups.backups.retention.description"
  | "groups.notifications.delivery.description"
  | "groups.notifications.timing.description"
  | "groups.preferences.notifications.description"
  | "groups.snapshots.capture.description"
  | "groups.content-review.approval.description";

export const subsectionOrder: Record<
  SettingsSectionId,
  {
    titleKey: SettingsGroupTitleKey;
    descriptionKey?: SettingsGroupDescriptionKey;
    keys?: string[];
    prefix?: string[];
  }[]
> = {
  playback: [
    {
      titleKey: "groups.playback.defaults.title",
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
      titleKey: "groups.playback.storage.title",
      prefix: ["player.cache.", "player.download."],
    },
    { titleKey: "groups.playback.sync.title", prefix: ["player.sync."] },
    {
      titleKey: "groups.playback.identity.title",
      prefix: ["player.identify."],
    },
  ],
  reliability: [
    {
      titleKey: "groups.reliability.mode.title",
      keys: ["reliability.mode"],
    },
    {
      titleKey: "groups.reliability.startup.title",
      keys: ["reliability.launch_after_boot", "reliability.immersive_mode"],
    },
    {
      titleKey: "groups.reliability.watchdog.title",
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
      titleKey: "groups.reliability.androidKiosk.title",
      descriptionKey: "groups.reliability.androidKiosk.description",
      prefix: ["managed_kiosk."],
    },
    {
      titleKey: "groups.reliability.linuxKiosk.title",
      descriptionKey: "groups.reliability.linuxKiosk.description",
      prefix: ["linux_kiosk."],
    },
  ],
  power: [
    {
      titleKey: "groups.power.hours.title",
      keys: [
        "power.active_hours_enabled",
        "power.active_hours_timezone",
        "power.active_hours_days",
        "power.active_hours_start",
        "power.active_hours_end",
      ],
    },
    {
      titleKey: "groups.power.behavior.title",
      keys: [
        "power.startup_grace_seconds",
        "power.shutdown_prepare_seconds",
        "power.keep_screen_on",
        "power.sleep_outside_active_hours",
      ],
    },
    {
      titleKey: "groups.power.outside.title",
      descriptionKey: "groups.power.outside.description",
      keys: [
        "power.outside_active_hours_display",
        "power.outside_active_hours_text",
      ],
    },
  ],
  accessibility: [
    {
      titleKey: "groups.accessibility.return.title",
      keys: [
        "accessibility.control_assist_enabled",
        "accessibility.return_delay_seconds",
        "accessibility.maximum_returns",
        "accessibility.return_window_minutes",
      ],
    },
    {
      titleKey: "groups.accessibility.safety.title",
      keys: [
        "accessibility.pause_during_updates",
        "accessibility.pause_during_admin_session",
      ],
    },
    {
      titleKey: "groups.accessibility.allowed.title",
      keys: ["accessibility.allowed_packages"],
    },
    {
      titleKey: "groups.accessibility.diagnostics.title",
      keys: ["accessibility.report_foreground_package"],
    },
  ],
  branding: [
    {
      titleKey: "groups.branding.fallback.title",
      prefix: [
        "branding.no_content_",
        "branding.disabled_",
        "branding.footer_",
      ],
    },
  ],
  general: [
    {
      titleKey: "groups.general.identity.title",
      prefix: ["organization.name", "organization.short"],
    },
    {
      titleKey: "groups.general.regional.title",
      prefix: [
        "organization.timezone",
        "organization.locale",
        "organization.first",
        "organization.date",
        "organization.time_format",
      ],
    },
    {
      titleKey: "groups.general.support.title",
      prefix: ["organization.support"],
    },
  ],
  media: [
    {
      titleKey: "groups.media.uploads.title",
      prefix: [
        "media.upload",
        "media.keep",
        "media.temporary",
        "media.deleted",
      ],
    },
    {
      titleKey: "groups.media.future.title",
      prefix: ["media.video.max", "media.processing"],
    },
    {
      titleKey: "groups.media.delivery.title",
      prefix: ["media.video.default", "media.image.default"],
    },
  ],
  websites: [
    {
      titleKey: "groups.websites.capabilities.title",
      prefix: [
        "website.default_javascript",
        "website.default_dom",
        "website.default_cookie",
        "website.private",
      ],
    },
    {
      titleKey: "groups.websites.loading.title",
      prefix: [
        "website.default_timeout",
        "website.default_reload",
        "website.minimum_refresh",
        "website.default_zoom",
      ],
    },
    {
      titleKey: "groups.websites.failure.title",
      prefix: [
        "website.default_failure",
        "website.default_fallback",
        "website.clear_data",
      ],
    },
    {
      titleKey: "groups.websites.overrides.title",
      prefix: ["player.website."],
    },
  ],
  scheduling: [
    {
      titleKey: "groups.scheduling.defaults.title",
      prefix: ["scheduling."],
    },
  ],
  takeover: [
    {
      titleKey: "groups.takeover.takeover.title",
      prefix: ["takeover."],
    },
    {
      titleKey: "groups.takeover.commands.title",
      prefix: ["commands."],
    },
  ],
  retention: [
    {
      titleKey: "groups.retention.security.title",
      prefix: ["retention.audit", "retention.command", "retention.takeover"],
    },
    {
      titleKey: "groups.retention.cleanup.title",
      prefix: [
        "retention.player",
        "retention.expired",
        "retention.failed",
        "retention.deleted",
      ],
    },
    {
      titleKey: "groups.retention.limits.title",
      prefix: ["retention.max"],
    },
  ],
  backups: [
    {
      titleKey: "groups.backups.schedule.title",
      prefix: ["backups.schedule_"],
    },
    {
      titleKey: "groups.backups.retention.title",
      descriptionKey: "groups.backups.retention.description",
      prefix: ["backups.retention_"],
    },
  ],
  notifications: [
    {
      titleKey: "groups.notifications.delivery.title",
      descriptionKey: "groups.notifications.delivery.description",
      keys: [
        "notifications.enabled",
        "notifications.from_address",
        "notifications.from_name",
        "notifications.minimum_severity",
      ],
    },
    {
      titleKey: "groups.notifications.timing.title",
      descriptionKey: "groups.notifications.timing.description",
      keys: [
        "notifications.timezone",
        "notifications.digest_time",
        "notifications.quiet_hours_enabled",
        "notifications.quiet_hours_start",
        "notifications.quiet_hours_end",
      ],
    },
    {
      titleKey: "groups.notifications.history.title",
      keys: ["notifications.retention_days"],
    },
  ],
  preferences: [
    {
      titleKey: "groups.preferences.notifications.title",
      descriptionKey: "groups.preferences.notifications.description",
      prefix: ["preference.notifications."],
    },
    {
      titleKey: "groups.preferences.appearance.title",
      prefix: [
        "preference.appearance",
        "preference.density",
        "preference.reduced",
      ],
    },
    {
      titleKey: "groups.preferences.dates.title",
      prefix: ["preference.time", "preference.table"],
    },
    {
      titleKey: "groups.preferences.views.title",
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
      titleKey: "groups.security.mfa.title",
      keys: ["security.mfa_required_scope"],
    },
  ],
  locations: [],
  snapshots: [
    {
      titleKey: "groups.snapshots.capture.title",
      descriptionKey: "groups.snapshots.capture.description",
      prefix: ["snapshots."],
    },
  ],
  "content-review": [
    {
      titleKey: "groups.content-review.approval.title",
      descriptionKey: "groups.content-review.approval.description",
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
    groups.push({
      titleKey: "groups.additional.title",
      definitions: remaining,
    });
  return groups;
}

/**
 * Server setting titles stay English in the API and are translated here at
 * display time. A new server value without a key renders the server English.
 */
export function titleFor(definition: SettingDefinition) {
  return translateKnown(
    `settings:definitions.${definition.key}.title`,
    definition.title,
  );
}

export function descriptionFor(definition: SettingDefinition) {
  const key = `settings:definitions.${definition.key}.description`;
  if (definition.description)
    return translateKnown(key, definition.description);
  const override = descriptions[definition.key];
  if (override) return translateKnown(key, override);
  return translateKnown(
    key,
    `Configure ${titleFor(definition).toLowerCase()} for Tilecast.`,
    {
      title: titleFor(definition).toLowerCase(),
    },
  );
}

/**
 * Known enum option labels. Unknown values render capitalized, as before.
 */
export function enumLabel(value: string) {
  return translateKnown(
    `settings:enumValues.${value}`,
    enumLabels[value] ??
      value
        .replaceAll("_", " ")
        .replace(/^./, (letter) => letter.toUpperCase()),
  );
}
