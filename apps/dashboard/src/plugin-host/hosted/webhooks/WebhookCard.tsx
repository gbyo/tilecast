import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useFormatLocale } from "@/i18n";
import type { PluginWebhookState } from "./api";
import { CopyValue } from "./CopyValue";
import { useWebhookLabels } from "./labels";
import { WebhookTokens } from "./WebhookTokens";

/**
 * One inbound webhook: where a provider sends it, how the host checks it,
 * whether it can work on this installation, and what it last received.
 */
export function WebhookCard({
  pluginId,
  manifest,
  webhook,
}: {
  pluginId: string;
  manifest: PluginManifestV3;
  webhook: PluginWebhookState;
}) {
  const { t } = useTranslation("plugins");
  const labels = useWebhookLabels();
  const titleId = `webhook-${webhook.id}`;
  const blocked =
    webhook.reachability === "public_https_required" ||
    webhook.reachability === "public_url_missing";
  return (
    <Card role="region" aria-labelledby={titleId}>
      <CardHeader>
        <CardTitle id={titleId} className="flex flex-wrap items-center gap-2">
          {webhook.title}
          <Badge variant="outline">
            {labels.authentication(webhook.authentication)}
          </Badge>
        </CardTitle>
        {webhook.description && (
          <CardDescription>{webhook.description}</CardDescription>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {webhook.endpointUrl && (
          <CopyValue
            label={t("hosted.webhooks.endpoint")}
            value={webhook.endpointUrl}
          />
        )}
        <Alert
          variant={blocked ? "destructive" : "default"}
          role={blocked ? "alert" : "status"}
        >
          <AlertDescription>
            {labels.reachability(webhook.reachability)}
          </AlertDescription>
        </Alert>
        <WebhookFacts webhook={webhook} manifest={manifest} />
        <WebhookActivity webhook={webhook} />
        {webhook.authentication === "token" && (
          <WebhookTokens
            pluginId={pluginId}
            webhookId={webhook.id}
            tokens={webhook.tokens ?? []}
          />
        )}
      </CardContent>
    </Card>
  );
}

function WebhookFacts({
  webhook,
  manifest,
}: {
  webhook: PluginWebhookState;
  manifest: PluginManifestV3;
}) {
  const { t } = useTranslation("plugins");
  const labels = useWebhookLabels();
  const settings = `${manifest.studio!.route}/settings`;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      {webhook.scheme && (
        <>
          <dt className="text-muted-foreground">
            {t("hosted.webhooks.verification")}
          </dt>
          <dd>{labels.scheme(webhook.scheme)}</dd>
        </>
      )}
      <dt className="text-muted-foreground">
        {t("hosted.webhooks.acknowledgement")}
      </dt>
      <dd>{t("hosted.webhooks.ackStatus", { status: webhook.ackStatus })}</dd>
      {webhook.handshake && (
        <>
          <dt className="text-muted-foreground">
            {t("hosted.webhooks.handshake")}
          </dt>
          <dd>{labels.handshake(webhook.handshake)}</dd>
        </>
      )}
      {webhook.signingSecret && (
        <>
          <dt className="text-muted-foreground">
            {t("hosted.webhooks.signingSecret")}
          </dt>
          <dd className="flex flex-wrap items-center gap-2">
            <Badge
              variant={
                webhook.signingSecret === "set" ? "secondary" : "destructive"
              }
            >
              {labels.secretState(webhook.signingSecret)}
            </Badge>
            {webhook.signingSecret !== "set" && (
              <Link className="underline underline-offset-4" to={settings}>
                {t("hosted.webhooks.enterSecret")}
              </Link>
            )}
          </dd>
        </>
      )}
    </dl>
  );
}

function WebhookActivity({ webhook }: { webhook: PluginWebhookState }) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const labels = useWebhookLabels();
  const when = (value?: string) =>
    value ? new Date(value).toLocaleString(locale) : t("hosted.webhooks.never");
  return (
    <div className="flex flex-col gap-1 text-sm">
      <p>
        {t("hosted.webhooks.accepted", {
          count: webhook.acceptedCount,
          when: when(webhook.lastAcceptedAt),
        })}
      </p>
      {webhook.duplicateCount > 0 && (
        <p className="text-muted-foreground">
          {t("hosted.webhooks.duplicates", { count: webhook.duplicateCount })}
        </p>
      )}
      {webhook.pending > 0 && (
        <p className="text-muted-foreground">
          {t("hosted.webhooks.pending", { count: webhook.pending })}
        </p>
      )}
      {webhook.lastRefusal && (
        <p className="text-muted-foreground">
          {t("hosted.webhooks.lastRefused", {
            reason: labels.refusal(webhook.lastRefusal),
            when: when(webhook.lastRefusedAt),
          })}
        </p>
      )}
    </div>
  );
}
