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
export type SettingsNavigationItem = {
  id: SettingsSectionId;
  label: string;
  path: string;
};
export type SettingsNavigationGroup = {
  label: string;
  items: SettingsNavigationItem[];
};
export const settingsNavigation: SettingsNavigationGroup[] = [
  {
    label: "Organization",
    items: [
      { id: "general", label: "General", path: "general" },
      { id: "branding", label: "Branding", path: "branding" },
      { id: "users", label: "Users", path: "users" },
      { id: "security", label: "Sign-in security", path: "security" },
      { id: "locations", label: "Locations", path: "locations" },
    ],
  },
  {
    label: "Content and playback",
    items: [
      { id: "playback", label: "Playback", path: "player/playback" },
      { id: "media", label: "Media", path: "content/media" },
      { id: "websites", label: "Websites", path: "content/websites" },
      { id: "scheduling", label: "Scheduling", path: "content/scheduling" },
      {
        id: "content-review",
        label: "Content review",
        path: "content-review",
      },
    ],
  },
  {
    label: "Player management",
    items: [
      {
        id: "reliability",
        label: "Reliability and kiosk",
        path: "player/reliability",
      },
      { id: "power", label: "Active hours and power", path: "player/power" },
      {
        id: "accessibility",
        label: "Accessibility control",
        path: "player/accessibility",
      },
      { id: "player-updates", label: "Player updates", path: "player/updates" },
      {
        id: "presentation-networks",
        label: "Presentation Networks",
        path: "player/presentation-networks",
      },
    ],
  },
  {
    label: "Operations",
    items: [
      {
        id: "takeover",
        label: "Takeovers and commands",
        path: "operations/takeover",
      },
      {
        id: "retention",
        label: "Data retention",
        path: "operations/retention",
      },
      {
        id: "backups",
        label: "Backup and restore",
        path: "operations/backups",
      },
      {
        id: "notifications",
        label: "Notifications",
        path: "operations/notifications",
      },
      {
        id: "snapshots",
        label: "Snapshot history",
        path: "snapshots",
      },
      { id: "system", label: "System", path: "system" },
      {
        id: "integrations",
        label: "Integration tokens",
        path: "integrations",
      },
      {
        id: "import-export",
        label: "Import and export",
        path: "import-export",
      },
    ],
  },
  {
    label: "System tools",
    items: [
      {
        id: "dependency-graph",
        label: "Dependency Graph",
        path: "dependency-graph",
      },
    ],
  },
] as const;
export const settingsItems = settingsNavigation.flatMap((group) => group.items);
export function sectionFromPath(pathname: string): SettingsSectionId {
  const suffix = pathname.replace(/^\/settings\/?/, "").replace(/\/$/, "");
  return settingsItems.find((item) => item.path === suffix)?.id ?? "general";
}
export const sectionDetails: Record<
  SettingsSectionId,
  { title: string; description: string; icon: LucideIcon }
> = {
  general: {
    icon: Building2,
    title: "General",
    description:
      "Organization identity, regional formats, and support details.",
  },
  branding: {
    icon: Palette,
    title: "Branding",
    description:
      "Organization identity and the fallback appearance shown by players.",
  },
  users: {
    icon: Users,
    title: "Users",
    description:
      "Give each person an individual sign-in and assign only the permissions they need. Appearance and density preferences remain separate for every account.",
  },
  security: {
    icon: ShieldCheck,
    title: "Sign-in security",
    description:
      "Decide who must use a second factor to sign in. Each person manages their own authenticator, passkeys, and recovery codes from My Account → Sign-in security.",
  },
  locations: {
    icon: MapPin,
    title: "Locations",
    description:
      "Reusable buildings and campuses assigned to multiple screens, while room details stay on each player.",
  },
  playback: {
    icon: Play,
    title: "Playback",
    description:
      "Default playback, storage, delivery, synchronization, and diagnostics.",
  },
  media: {
    icon: Image,
    title: "Media",
    description:
      "Upload limits, delivery defaults, and future media-processing behavior.",
  },
  websites: {
    icon: Globe,
    title: "Websites",
    description:
      "Safe defaults for website playback, reloads, cookies, and failures.",
  },
  scheduling: {
    icon: CalendarClock,
    title: "Scheduling",
    description: "Schedule preparation, timing, and clock-warning defaults.",
  },
  reliability: {
    icon: LifeBuoy,
    title: "Reliability and kiosk",
    description:
      "Shared recovery with platform-specific Android and Linux kiosk controls.",
  },
  power: {
    icon: Power,
    title: "Active hours and power",
    description:
      "Player operating hours and best-effort Android sleep and wake behavior.",
  },
  accessibility: {
    icon: Accessibility,
    title: "Accessibility control",
    description:
      "Optional foreground-return assistance with explicit safety pauses.",
  },
  "player-updates": {
    icon: DownloadCloud,
    title: "Player updates",
    description: "Verified Tilecast Player releases and update deployments.",
  },
  "presentation-networks": {
    icon: Wifi,
    title: "Presentation Networks",
    description:
      "Temporarily connect supported Linux players to Wi-Fi for AirPlay and other local presentation features while keeping Ethernet as their primary Tilecast connection.",
  },
  takeover: {
    icon: Siren,
    title: "Takeovers and commands",
    description:
      "Defaults for a Takeover started by hand and for player commands. Automatic weather alerts are the Emergency Alerts plugin.",
  },
  retention: {
    icon: Archive,
    title: "Data retention",
    description: "Bounded history and cleanup periods for operational records.",
  },
  backups: {
    icon: DatabaseBackup,
    title: "Backup and restore",
    description:
      "Create, verify, download, schedule, and restore full installation backups.",
  },
  notifications: {
    icon: BellRing,
    title: "Notifications",
    description: "Send alerts by email or webhook.",
  },
  system: {
    icon: Wrench,
    title: "System",
    description: "Safe diagnostics and deliberate maintenance actions.",
  },
  "content-review": {
    icon: ClipboardCheck,
    title: "Content review",
    description:
      "Require approval before a playlist or Layout can be assigned to a screen. A Contributor authors content but cannot publish or assign it.",
  },
  snapshots: {
    icon: Camera,
    title: "Snapshot history",
    description: "Periodic Player screenshots with configurable retention.",
  },
  integrations: {
    icon: KeyRound,
    title: "Integration tokens",
    description: "Scoped tokens for Manual Tables and fleet health.",
  },
  "import-export": {
    icon: ArrowLeftRight,
    title: "Import and export",
    description: "Portable, non-secret Tilecast configuration.",
  },
  "dependency-graph": {
    icon: Network,
    title: "Dependency Graph",
    description:
      "Follow content and data through presentations, schedules, groups, and screens.",
  },
  preferences: {
    icon: SlidersHorizontal,
    title: "Preferences",
    description: "Appearance and workflow preferences for your Studio account.",
  },
};
