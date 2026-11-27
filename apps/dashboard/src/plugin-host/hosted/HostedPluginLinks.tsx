import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { Activity, Plug, Rss, Settings2, Webhook } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { buttonVariants } from "@/components/ui/button";
import { hasStatusPage } from "./status/model";
import { hasWebhooksPage } from "./webhooks/model";

/**
 * Links to the host-generated pages a plugin's manifest asks for: its
 * feeds, its connections, its webhooks, its settings, and its status.
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
    hasWebhooksPage(manifest) && {
      to: `${route}/webhooks`,
      icon: Webhook,
      label: t("hosted.webhooks.open"),
    },
    (manifest.settings?.organization?.length ?? 0) > 0 && {
      to: `${route}/settings`,
      icon: Settings2,
      label: t("hosted.settings"),
    },
    hasStatusPage(manifest) && {
      to: `${route}/status`,
      icon: Activity,
      label: t("hosted.status.open"),
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
