import { useQuery } from "@tanstack/react-query";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Skeleton } from "@/components/ui/skeleton";
import { PluginPage } from "../../PluginPage";
import { webhooksClient, webhooksKey } from "./api";
import { WebhookCard } from "./WebhookCard";

/**
 * The generated Webhooks page: one card for each inbound endpoint the
 * plugin declares, with its exact address, how the host checks requests,
 * and its tokens.
 */
export function HostedWebhooksPage({
  pluginId,
  manifest,
}: {
  pluginId: string;
  manifest: PluginManifestV3;
}) {
  const { t } = useTranslation("plugins");
  const webhooks = useQuery({
    queryKey: webhooksKey(pluginId),
    queryFn: webhooksClient(pluginId).list,
  });
  return (
    <PluginPage
      pluginId={pluginId}
      title={t("hosted.webhooks.title")}
      description={t("hosted.webhooks.description")}
    >
      {webhooks.isPending && <Skeleton className="h-40 w-full" />}
      {webhooks.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("hosted.webhooks.loadError")}</AlertDescription>
        </Alert>
      )}
      {webhooks.data && (
        <div className="flex flex-col gap-4">
          {webhooks.data.map((webhook) => (
            <WebhookCard
              key={webhook.id}
              pluginId={pluginId}
              manifest={manifest}
              webhook={webhook}
            />
          ))}
        </div>
      )}
    </PluginPage>
  );
}
