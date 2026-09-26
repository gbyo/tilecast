import { Puzzle } from "lucide-react";
import { studioPluginById } from "../plugin-host/discovery";

/**
 * A plugin's icon comes from its own Studio entry point. A plugin this bundle
 * has no Studio code for — a newer release's installation, for example — gets
 * the generic icon rather than being dropped.
 */
export function PluginIcon({
  pluginId,
  className,
}: {
  pluginId: string;
  className?: string;
}) {
  const Icon = studioPluginById(pluginId)?.definition.icon ?? Puzzle;
  return <Icon className={className} aria-hidden="true" />;
}
