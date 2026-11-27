import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemTitle,
} from "@/components/ui/item";
import { useFormatLocale } from "@/i18n";
import type { PluginDeliveryStatus } from "./api";
import { useDeliveryLabels } from "./labels";

/**
 * The plugin's queued work in one line: what waits, what runs, and the
 * last failure. Expired work, which the plugin never received, is an
 * alert of its own.
 */
export function DeliverySummary({
  deliveries,
}: {
  deliveries: PluginDeliveryStatus;
}) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const labels = useDeliveryLabels();
  const healthy = deliveries.parkedCount === 0;
  const failure = deliveries.lastFailure;
  return (
    <>
      <Item variant="outline">
        <ItemContent>
          <ItemTitle>
            <h2 className="text-sm font-medium">
              {t("hosted.status.deliveries.title")}
            </h2>
            <Badge variant={healthy ? "secondary" : "destructive"}>
              {healthy
                ? t("hosted.status.deliveries.healthy")
                : t("hosted.status.deliveries.parked", {
                    count: deliveries.parkedCount,
                  })}
            </Badge>
          </ItemTitle>
          <ItemDescription>
            {[
              t("hosted.status.deliveries.pending", {
                count: deliveries.pending,
              }),
              t("hosted.status.deliveries.running", {
                count: deliveries.running,
              }),
            ].join(" · ")}
          </ItemDescription>
          {failure && (
            <ItemDescription>
              {t("hosted.status.deliveries.lastFailure", {
                reason: labels.failure(failure.code),
                date: new Date(failure.at).toLocaleString(locale),
              })}
            </ItemDescription>
          )}
        </ItemContent>
      </Item>
      {deliveries.expiredCount > 0 && (
        <Alert>
          <AlertTitle>
            {t("hosted.status.deliveries.expiredTitle", {
              count: deliveries.expiredCount,
            })}
          </AlertTitle>
          <AlertDescription>
            {t("hosted.status.deliveries.expiredDescription", {
              date: deliveries.lastExpiredAt
                ? new Date(deliveries.lastExpiredAt).toLocaleString(locale)
                : "",
            })}
          </AlertDescription>
        </Alert>
      )}
    </>
  );
}
