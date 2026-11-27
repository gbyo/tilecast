import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { useFormatLocale } from "@/i18n";
import type { PluginWebhookState } from "../webhooks/api";
import { useWebhookLabels } from "../webhooks/labels";

/**
 * Whether each inbound webhook can work here, and the last request it
 * accepted or refused. The Webhooks page holds the endpoints and tokens.
 */
export function WebhooksSection({
  webhooks,
  webhooksPath,
}: {
  webhooks: PluginWebhookState[];
  webhooksPath: string;
}) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const labels = useWebhookLabels();
  if (webhooks.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="webhooks-title">
      <h2 id="webhooks-title" className="text-sm font-medium">
        {t("hosted.webhooks.status.title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("hosted.webhooks.status.description")}{" "}
        <Link className="underline underline-offset-4" to={webhooksPath}>
          {t("hosted.webhooks.open")}
        </Link>
      </p>
      <ItemGroup className="gap-2">
        {webhooks.map((webhook) => {
          const attention =
            webhook.reachability === "public_https_required" ||
            webhook.reachability === "public_url_missing" ||
            (webhook.signingSecret !== undefined &&
              webhook.signingSecret !== "set");
          return (
            <Item key={webhook.id} variant="outline">
              <ItemContent>
                <ItemTitle>
                  {webhook.title}
                  <Badge variant={attention ? "destructive" : "secondary"}>
                    {attention
                      ? t("hosted.webhooks.status.attention")
                      : t("hosted.webhooks.status.ready")}
                  </Badge>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  {labels.reachability(webhook.reachability)}
                </ItemDescription>
                {webhook.signingSecret && webhook.signingSecret !== "set" && (
                  <ItemDescription className="line-clamp-none">
                    {labels.secretState(webhook.signingSecret)}
                  </ItemDescription>
                )}
                <ItemDescription className="line-clamp-none">
                  {webhook.lastAcceptedAt
                    ? t("hosted.webhooks.status.lastAccepted", {
                        when: new Date(webhook.lastAcceptedAt).toLocaleString(
                          locale,
                        ),
                      })
                    : t("hosted.webhooks.status.noneAccepted")}
                  {webhook.lastRefusal &&
                    ` · ${t("hosted.webhooks.status.lastRefusal", {
                      reason: labels.refusal(webhook.lastRefusal),
                    })}`}
                </ItemDescription>
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
}
