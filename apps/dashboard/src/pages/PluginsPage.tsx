import { useQuery } from "@tanstack/react-query";
import {
  AudioLines,
  ClipboardList,
  Clock3,
  Network,
  Puzzle,
  Siren,
  Stamp,
  type LucideIcon,
} from "lucide-react";
import { Link } from "react-router";
import { api } from "../api/client";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";

/**
 * How Studio presents each plugin the server reports. The server owns the
 * catalog; this is only the icon and the page that manages it. A plugin Studio
 * does not recognise still gets a card — a newer server must not silently drop
 * a feature from the list — it just carries the generic icon and no link.
 */
const pluginPresentation: Record<
  string,
  { icon: LucideIcon; path: string; instanceNoun: [string, string] }
> = {
  countdown_bar: {
    icon: Clock3,
    path: "/plugins/countdown-bar",
    instanceNoun: ["instance", "instances"],
  },
  emergency_alerts: {
    icon: Siren,
    path: "/plugins/emergency-alerts",
    instanceNoun: ["alert rule", "alert rules"],
  },
  forms: {
    icon: ClipboardList,
    path: "/plugins/forms",
    instanceNoun: ["form", "forms"],
  },
  brand_bug: {
    icon: Stamp,
    path: "/plugins/brand-bug",
    instanceNoun: ["mark", "marks"],
  },
  noise_meter: {
    icon: AudioLines,
    path: "/plugins/noise-meter",
    instanceNoun: ["meter", "meters"],
  },
  dependency_graph: {
    icon: Network,
    path: "/plugins/dependency-graph",
    instanceNoun: ["map", "maps"],
  },
};

export function PluginsPage() {
  const plugins = useQuery({ queryKey: ["plugins"], queryFn: api.plugins });
  return (
    <main className="grid gap-4">
      <header className="grid gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Plugins</h1>
        <p className="text-sm text-muted-foreground">
          Built-in Tilecast features that can affect Player behavior outside
          playlists and Layout zones.
        </p>
      </header>
      {plugins.isError && (
        <Alert variant="destructive">
          <AlertDescription>Plugins could not be loaded.</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {(plugins.data?.items ?? []).map((plugin) => {
          const presentation = pluginPresentation[plugin.id];
          const Icon = presentation?.icon ?? Puzzle;
          const [one, many] = presentation?.instanceNoun ?? [
            "instance",
            "instances",
          ];
          return (
            <article
              className="grid gap-3 rounded-xl border border-border p-4"
              key={plugin.id}
            >
              <span className="flex items-center gap-2">
                <span
                  className="flex size-10 items-center justify-center rounded-xl bg-muted"
                  aria-hidden="true"
                >
                  <Icon size={24} />
                </span>
                <span className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-semibold">{plugin.name}</h2>
                  <Badge variant={plugin.enabled ? "default" : "secondary"}>
                    {plugin.enabled ? "Enabled" : "Disabled"}
                  </Badge>
                </span>
              </span>
              <p className="text-sm text-muted-foreground">
                {plugin.description}
              </p>
              <span className="flex flex-wrap items-center justify-between gap-2 text-sm">
                <span className="text-muted-foreground tabular-nums">
                  {plugin.instanceCount} configured{" "}
                  {plugin.instanceCount === 1 ? one : many}
                </span>
                {presentation && (
                  <Link
                    to={presentation.path}
                    className="inline-flex h-8 items-center justify-center gap-2 rounded-2xl border border-border bg-background px-3 text-sm font-medium hover:bg-muted"
                  >
                    Manage plugin
                  </Link>
                )}
              </span>
            </article>
          );
        })}
      </div>
    </main>
  );
}
