import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { Plug, Rss, Settings2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button";

/**
 * Links to the host-generated pages a plugin's manifest asks for: its
 * feeds, its connections, and its settings.
 */
export function HostedPluginLinks({
  manifest,
}: {
  manifest: PluginManifestV3;
}) {
  const { t } = useTranslation("plugins");
  const route = manifest.studio!.route;
  const links = [
    (manifest.feeds ?? []).length > 0 && {
      to: `${route}/feeds`,
      icon: Rss,
      label: t("hosted.feeds.title"),
    },
    (manifest.connections ?? []).length > 0 && {
      to: `${route}/connections`,
      icon: Plug,
      label: t("hosted.connections.open"),
    },
    (manifest.settings?.organization?.length ?? 0) > 0 && {
      to: `${route}/settings`,
      icon: Settings2,
      label: t("hosted.settings"),
    },
  ].filter((link) => link !== false);
  return (
    <>
      {links.map(({ to, icon: Icon, label }) => (
        <Link
          key={to}
          className={buttonVariants({ variant: "outline", size: "lg" })}
          to={to}
        >
          <Icon data-icon="inline-start" aria-hidden="true" /> {label}
        </Link>
      ))}
    </>
  );
}
