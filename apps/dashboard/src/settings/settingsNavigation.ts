import type { LucideIcon } from "lucide-react";
import {
  Accessibility,
  Archive,
  ArrowLeftRight,
  BellRing,
  Building2,
  CalendarClock,
  Camera,
  ClipboardCheck,
  DatabaseBackup,
  DownloadCloud,
  Globe,
  Image,
  KeyRound,
  Network,
  LifeBuoy,
  MapPin,
  Palette,
  Play,
  Power,
  ShieldCheck,
  Siren,
  SlidersHorizontal,
  Users,
  Wifi,
  Wrench,
} from "lucide-react";
export type SettingsSectionId =
  | "general"
  | "branding"
  | "users"
  | "locations"
  | "playback"
  | "media"
  | "websites"
  | "scheduling"
  | "reliability"
  | "power"
  | "accessibility"
  | "player-updates"
  | "presentation-networks"
  | "takeover"
  | "retention"
  | "backups"
  | "notifications"
  | "integrations"
  | "content-review"
  | "snapshots"
  | "system"
  | "import-export"
  | "security"
  | "preferences"
  | "dependency-graph";
export type SettingsNavigationGroupId =
  "organization" | "content" | "players" | "operations" | "tools";
export type SettingsNavigationItem = {
  id: SettingsSectionId;
  /**
   * English route metadata for App.tsx breadcrumbs and command-palette
   * search, which live outside the settings namespace. On-screen labels use
   * labelKey so Settings follows language changes.
   */
  label: string;
  labelKey: `nav.items.${SettingsSectionId}`;
  path: string;
};
export type SettingsNavigationGroup = {
  label: string;
  labelKey: `nav.groups.${SettingsNavigationGroupId}`;
  items: SettingsNavigationItem[];
};
// Labels stay function arguments (never rendered text in this file) so the
// display keys below are the only translation source.
function item(
  id: SettingsSectionId,
  label: string,
  path: string,
): SettingsNavigationItem {
  return { id, label, labelKey: `nav.items.${id}`, path };
}
function group(
  id: SettingsNavigationGroupId,
  label: string,
  items: SettingsNavigationItem[],
): SettingsNavigationGroup {
  return { label, labelKey: `nav.groups.${id}`, items };
}
export const settingsNavigation: SettingsNavigationGroup[] = [
  group("organization", "Organization", [
    item("general", "General", "general"),
    item("branding", "Branding", "branding"),
    item("users", "Users", "users"),
    item("security", "Sign-in security", "security"),
    item("locations", "Locations", "locations"),
  ]),
  group("content", "Content and playback", [
    item("playback", "Playback", "player/playback"),
    item("media", "Media", "content/media"),
    item("websites", "Websites", "content/websites"),
    item("scheduling", "Scheduling", "content/scheduling"),
    item("content-review", "Content review", "content-review"),
  ]),
  group("players", "Player management", [
    item("reliability", "Reliability and kiosk", "player/reliability"),
    item("power", "Active hours and power", "player/power"),
    item("accessibility", "Accessibility control", "player/accessibility"),
    item("player-updates", "Player updates", "player/updates"),
    item(
      "presentation-networks",
      "Presentation Networks",
      "player/presentation-networks",
    ),
  ]),
  group("operations", "Operations", [
    item("takeover", "Takeovers and commands", "operations/takeover"),
    item("retention", "Data retention", "operations/retention"),
    item("backups", "Backup and restore", "operations/backups"),
    item("notifications", "Notifications", "operations/notifications"),
    item("snapshots", "Snapshot history", "snapshots"),
    item("system", "System", "system"),
    item("integrations", "Integration tokens", "integrations"),
    item("import-export", "Import and export", "import-export"),
  ]),
  group("tools", "System tools", [
    item("dependency-graph", "Dependency Explorer", "dependency-graph"),
  ]),
];
export const settingsItems = settingsNavigation.flatMap((group) => group.items);
export function sectionFromPath(pathname: string): SettingsSectionId {
  const suffix = pathname.replace(/^\/settings\/?/, "").replace(/\/$/, "");
  return settingsItems.find((item) => item.path === suffix)?.id ?? "general";
}
export const sectionDetails: Record<
  SettingsSectionId,
  {
    titleKey: `nav.sections.${SettingsSectionId}.title`;
    descriptionKey: `nav.sections.${SettingsSectionId}.description`;
    icon: LucideIcon;
    /**
     * A spatial tool that needs the full content width. Its section list
     * moves into a Sheet instead of a permanent column.
     */
    workspace?: boolean;
  }
> = {
  general: {
    icon: Building2,
    titleKey: "nav.sections.general.title",
    descriptionKey: "nav.sections.general.description",
  },
  branding: {
    icon: Palette,
    titleKey: "nav.sections.branding.title",
    descriptionKey: "nav.sections.branding.description",
  },
  users: {
    icon: Users,
    titleKey: "nav.sections.users.title",
    descriptionKey: "nav.sections.users.description",
  },
  security: {
    icon: ShieldCheck,
    titleKey: "nav.sections.security.title",
    descriptionKey: "nav.sections.security.description",
  },
  locations: {
    icon: MapPin,
    titleKey: "nav.sections.locations.title",
    descriptionKey: "nav.sections.locations.description",
  },
  playback: {
    icon: Play,
    titleKey: "nav.sections.playback.title",
    descriptionKey: "nav.sections.playback.description",
  },
  media: {
    icon: Image,
    titleKey: "nav.sections.media.title",
    descriptionKey: "nav.sections.media.description",
  },
  websites: {
    icon: Globe,
    titleKey: "nav.sections.websites.title",
    descriptionKey: "nav.sections.websites.description",
  },
  scheduling: {
    icon: CalendarClock,
    titleKey: "nav.sections.scheduling.title",
    descriptionKey: "nav.sections.scheduling.description",
  },
  reliability: {
    icon: LifeBuoy,
    titleKey: "nav.sections.reliability.title",
    descriptionKey: "nav.sections.reliability.description",
  },
  power: {
    icon: Power,
    titleKey: "nav.sections.power.title",
    descriptionKey: "nav.sections.power.description",
  },
  accessibility: {
    icon: Accessibility,
    titleKey: "nav.sections.accessibility.title",
    descriptionKey: "nav.sections.accessibility.description",
  },
  "player-updates": {
    icon: DownloadCloud,
    titleKey: "nav.sections.player-updates.title",
    descriptionKey: "nav.sections.player-updates.description",
  },
  "presentation-networks": {
    icon: Wifi,
    titleKey: "nav.sections.presentation-networks.title",
    descriptionKey: "nav.sections.presentation-networks.description",
  },
  takeover: {
    icon: Siren,
    titleKey: "nav.sections.takeover.title",
    descriptionKey: "nav.sections.takeover.description",
  },
  retention: {
    icon: Archive,
    titleKey: "nav.sections.retention.title",
    descriptionKey: "nav.sections.retention.description",
  },
  backups: {
    icon: DatabaseBackup,
    titleKey: "nav.sections.backups.title",
    descriptionKey: "nav.sections.backups.description",
  },
  notifications: {
    icon: BellRing,
    titleKey: "nav.sections.notifications.title",
    descriptionKey: "nav.sections.notifications.description",
  },
  system: {
    icon: Wrench,
    titleKey: "nav.sections.system.title",
    descriptionKey: "nav.sections.system.description",
  },
  "content-review": {
    icon: ClipboardCheck,
    titleKey: "nav.sections.content-review.title",
    descriptionKey: "nav.sections.content-review.description",
  },
  snapshots: {
    icon: Camera,
    titleKey: "nav.sections.snapshots.title",
    descriptionKey: "nav.sections.snapshots.description",
  },
  integrations: {
    icon: KeyRound,
    titleKey: "nav.sections.integrations.title",
    descriptionKey: "nav.sections.integrations.description",
  },
  "import-export": {
    icon: ArrowLeftRight,
    titleKey: "nav.sections.import-export.title",
    descriptionKey: "nav.sections.import-export.description",
  },
  "dependency-graph": {
    icon: Network,
    titleKey: "nav.sections.dependency-graph.title",
    descriptionKey: "nav.sections.dependency-graph.description",
    workspace: true,
  },
  preferences: {
    icon: SlidersHorizontal,
    titleKey: "nav.sections.preferences.title",
    descriptionKey: "nav.sections.preferences.description",
  },
};
