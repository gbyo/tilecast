import {
  AudioLines,
  ClipboardList,
  Clock3,
  Puzzle,
  Siren,
  Stamp,
  type LucideIcon,
} from "lucide-react";

/**
 * The server owns every plugin's name, route, and status; Studio only maps the
 * bounded icon identifier to a component. An identifier this bundle does not
 * know gets the generic icon rather than dropping the plugin.
 */
const pluginIcons: Record<string, LucideIcon> = {
  clock: Clock3,
  siren: Siren,
  "clipboard-list": ClipboardList,
  stamp: Stamp,
  "audio-lines": AudioLines,
};

export function PluginIcon({
  icon,
  className,
}: {
  icon: string;
  className?: string;
}) {
  const Icon = pluginIcons[icon] ?? Puzzle;
  return <Icon className={className} aria-hidden="true" />;
}
