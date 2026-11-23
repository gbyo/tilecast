import { useTranslation } from "react-i18next";
import { Webhook } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import {
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import { useWebhookLabels } from "../../plugin-host/hosted/webhooks/labels";
import { DetailSection } from "./DetailSections";
import { ItemRow } from "./CapabilityItems";
import type { PluginDetailViewModel } from "./detailView";

/**
 * The inbound endpoints a plugin adds, before install: how each request is
 * authenticated, whether a public HTTPS address is needed, and whether the
 * host answers a provider's endpoint check. It informs; it grants nothing.
 */
export function WebhookReviewSection({
  view,
}: {
  view: PluginDetailViewModel;
}) {
  const { t } = useTranslation("plugins");
  const labels = useWebhookLabels();
  const webhooks = view.plugin?.webhooks ?? [];
  if (webhooks.length === 0) return null;
  return (
    <DetailSection
      id="detail-webhooks"
      title={t("hosted.webhooks.review.title")}
      description={t("hosted.webhooks.review.description")}
    >
      <ItemGroup render={<ul />} className="gap-0">
        {webhooks.map((webhook, index) => (
          <ItemRow key={webhook.id} separated={index > 0}>
            <ItemMedia variant="icon">
              <Webhook aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {webhook.title}
                <Badge variant="outline">
                  {labels.authentication(webhook.authentication)}
                </Badge>
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                <code className="font-mono text-xs">{webhook.path}</code>
              </ItemDescription>
              <ItemDescription className="line-clamp-none">
                {[
                  webhook.scheme && labels.scheme(webhook.scheme),
                  webhook.requiresPublicHttps
                    ? t("hosted.webhooks.review.publicHttps")
                    : t("hosted.webhooks.review.localAllowed"),
                  webhook.handshake &&
                    t("hosted.webhooks.review.handshake", {
                      handshake: labels.handshake(webhook.handshake),
                    }),
                  t("hosted.webhooks.ackStatus", { status: webhook.ackStatus }),
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </ItemDescription>
              {webhook.signingSecretKey && (
                <ItemDescription className="line-clamp-none">
                  {t("hosted.webhooks.review.secret")}
                </ItemDescription>
              )}
            </ItemContent>
          </ItemRow>
        ))}
      </ItemGroup>
    </DetailSection>
  );
}
