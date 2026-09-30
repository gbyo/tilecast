import {
  Activity,
  Blocks,
  CalendarClock,
  CircleDashed,
  Database,
  Home,
  Image,
  ListVideo,
  Megaphone,
  Monitor,
  PanelsTopLeft,
  Puzzle,
  Settings,
  Users,
  type LucideIcon,
} from "lucide-react";
import type { PluginIconComponent } from "@/plugin-host/kit";

/**
 * Lucide icons for the semantic navigation icon tokens. Native hosts map the
 * same tokens to their own symbols (packages/native-bridge-schema/
 * icon-tokens.json). An unknown token shows the generic icon.
 */
export const navigationIcons: Readonly<Record<string, LucideIcon>> = {
  home: Home,
  screens: Monitor,
  groups: Users,
  media: Image,
  widgets: Blocks,
  data: Database,
  playlists: ListVideo,
  layouts: PanelsTopLeft,
  campaigns: Megaphone,
  schedules: CalendarClock,
  plugins: Puzzle,
  activity: Activity,
  settings: Settings,
  plugin: Puzzle,
};

export const genericNavigationIcon: LucideIcon = CircleDashed;

export function NavigationIcon({
  token,
  component: Component,
}: {
  token: string;
  /** A plugin's own icon, which takes precedence in the browser. */
  component?: PluginIconComponent;
}) {
  if (Component) return <Component />;
  const Icon = Object.hasOwn(navigationIcons, token)
    ? navigationIcons[token]!
    : genericNavigationIcon;
  return <Icon />;
}
