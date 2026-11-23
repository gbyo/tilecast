import { useTranslation } from "react-i18next";
import { Badge } from "@/components/ui/badge";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { knownInactiveReasons, useEventLabels } from "../events/labels";
import { isKnown } from "./model";
import type { PluginEventSubscription } from "./api";

/**
 * The events the plugin receives. An inactive subscription receives
 * nothing, and the row says what would make it active.
 */
export function SubscriptionsSection({
  subscriptions,
}: {
  subscriptions: PluginEventSubscription[];
}) {
  const { t } = useTranslation("plugins");
  const labels = useEventLabels();
  if (subscriptions.length === 0) return null;
  return (
    <section
      className="flex flex-col gap-2"
      aria-labelledby="subscriptions-title"
    >
      <h2 id="subscriptions-title" className="text-sm font-medium">
        {t("hosted.events.status.subscriptions.title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("hosted.events.status.subscriptions.description")}
      </p>
      <ItemGroup className="gap-2">
        {subscriptions.map((subscription) => {
          const active = subscription.state === "active";
          const publisher = labels.publisher(
            subscription.publisher,
            subscription.publisherName,
          );
          const reason = subscription.reason ?? "";
          return (
            <Item key={subscription.event} variant="outline">
              <ItemContent>
                <ItemTitle>
                  {labels.core(subscription.event) ?? subscription.event}
                  <Badge variant={active ? "secondary" : "outline"}>
                    {active
                      ? t("hosted.events.status.subscriptions.active")
                      : t("hosted.events.status.subscriptions.inactive")}
                  </Badge>
                </ItemTitle>
                <ItemDescription className="line-clamp-none">
                  <code className="font-mono text-xs">
                    {subscription.event}
                  </code>{" "}
                  · {t("hosted.events.publishedBy", { publisher })}
                </ItemDescription>
                {!active && (
                  <ItemDescription className="line-clamp-none">
                    {isKnown(knownInactiveReasons, reason)
                      ? t(`hosted.events.status.reasons.${reason}`, {
                          publisher,
                        })
                      : t("hosted.events.status.reasons.other")}
                  </ItemDescription>
                )}
              </ItemContent>
            </Item>
          );
        })}
      </ItemGroup>
    </section>
  );
}
