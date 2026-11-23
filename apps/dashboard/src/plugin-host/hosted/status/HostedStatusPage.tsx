import { useQuery } from "@tanstack/react-query";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { PluginPage } from "../../PluginPage";
import { statusClient, statusKey } from "./api";
import { DeliverySummary } from "./DeliverySummary";
import { ParkedDeliveries } from "./ParkedDeliveries";
import { PublishedEventsSection } from "./PublishedEventsSection";
import { SubscriptionsSection } from "./SubscriptionsSection";
import { WebhooksSection } from "./WebhooksSection";

export type HostedStatusProps = {
  pluginId: string;
  manifest: PluginManifestV3;
};

/** Status refreshes while it is open, so a retry's result shows up. */
const refreshMs = 15_000;

/**
 * The generated Status page: the work the host runs for the plugin, and
 * the problems an operator can act on. Each part is its own section.
 */
export function HostedStatusPage({ pluginId, manifest }: HostedStatusProps) {
  const { t } = useTranslation("plugins");
  const status = useQuery({
    queryKey: statusKey(pluginId),
    queryFn: statusClient(pluginId).get,
    refetchInterval: refreshMs,
  });
  return (
    <PluginPage
      pluginId={pluginId}
      title={t("hosted.status.title")}
      description={t("hosted.status.description")}
    >
      {status.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("hosted.status.loadError")}</AlertDescription>
        </Alert>
      )}
      {status.data && (
        <div className="flex flex-col gap-4">
          <DeliverySummary deliveries={status.data.deliveries} />
          <ParkedDeliveries
            pluginId={pluginId}
            items={status.data.deliveries.parked}
            total={status.data.deliveries.parkedCount}
          />
          <SubscriptionsSection subscriptions={status.data.subscriptions} />
          <PublishedEventsSection events={status.data.publishedEvents} />
          <WebhooksSection
            webhooks={status.data.webhooks}
            webhooksPath={`${manifest.studio!.route}/webhooks`}
          />
        </div>
      )}
    </PluginPage>
  );
}
