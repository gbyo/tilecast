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
import { isKnown } from "./model";
import type { PluginProviderStatus } from "./api";

const knownCheckFailures = [
  "check_failed",
  "check_timeout",
  "check_panic",
  "invalid_result",
  "item_too_large",
] as const;

const knownKinds = [
  "playlist",
  "layout",
  "widget_instance",
  "media_item",
] as const;

/**
 * The core features this plugin serves: the notification channels that
 * deliver Tilecast's notifications, and the Content Health checks that
 * report conditions. Tilecast decides what is sent and what becomes an
 * incident; this shows whether the plugin's part works.
 */
export function ProvidersSection({
  providers,
}: {
  providers: PluginProviderStatus;
}) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const when = (value?: string) =>
    value ? new Date(value).toLocaleString(locale) : undefined;
  if (providers.channels.length === 0 && providers.checks.length === 0)
    return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="providers-title">
      <h2 id="providers-title" className="text-sm font-medium">
        {t("hosted.providers.status.title")}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t("hosted.providers.status.description")}
      </p>
      <ItemGroup className="gap-2">
        {providers.channels.map((channel) => (
          <Item key={`channel-${channel.id}`} variant="outline">
            <ItemContent>
              <ItemTitle>
                {channel.title}
                <Badge variant={channel.ready ? "secondary" : "outline"}>
                  {channel.ready
                    ? t("hosted.providers.status.ready")
                    : t("hosted.providers.status.off")}
                </Badge>
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                {t("hosted.providers.status.channelCounts", {
                  sent: channel.sent,
                  pending: channel.pending,
                  failed: channel.failed,
                })}
              </ItemDescription>
              {!channel.ready && (
                <ItemDescription className="line-clamp-none">
                  {t("hosted.providers.status.offHelp")}
                </ItemDescription>
              )}
              {channel.lastFailedAt && (
                <ItemDescription className="line-clamp-none">
                  {t("hosted.providers.status.lastFailed", {
                    when: when(channel.lastFailedAt),
                  })}
                </ItemDescription>
              )}
            </ItemContent>
          </Item>
        ))}
        {providers.checks.map((check) => (
          <Item key={`check-${check.id}`} variant="outline">
            <ItemContent>
              <ItemTitle>
                {check.title}
                <Badge
                  variant={check.failingItems > 0 ? "destructive" : "secondary"}
                >
                  {t("hosted.providers.status.openConditions", {
                    count: check.openConditions,
                  })}
                </Badge>
              </ItemTitle>
              <ItemDescription className="line-clamp-none">
                {t("hosted.providers.status.checkCounts", {
                  checked: check.checkedItems,
                  kinds: check.kinds
                    .map((kind) =>
                      isKnown(knownKinds, kind)
                        ? t(`hosted.providers.kinds.${kind}`)
                        : kind,
                    )
                    .join(", "),
                })}
              </ItemDescription>
              {check.failingItems > 0 && (
                <ItemDescription className="line-clamp-none">
                  {t("hosted.providers.status.failing", {
                    count: check.failingItems,
                    reason:
                      check.lastFailure &&
                      isKnown(knownCheckFailures, check.lastFailure)
                        ? t(`hosted.providers.failures.${check.lastFailure}`)
                        : (check.lastFailure ?? ""),
                  })}
                </ItemDescription>
              )}
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
}
