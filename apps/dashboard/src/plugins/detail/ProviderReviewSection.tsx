import { useTranslation } from "react-i18next";
import { BellRing, ListChecks } from "lucide-react";
import {
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import { DetailSection } from "./DetailSections";
import { ItemRow } from "./CapabilityItems";
import type { PluginDetailViewModel } from "./detailView";

const knownKinds = [
  "playlist",
  "layout",
  "widget_instance",
  "media_item",
] as const;

/**
 * The core features a plugin serves, before install: notification channels
 * and Content Health checks. It informs; it grants nothing.
 */
export function ProviderReviewSection({
  view,
}: {
  view: PluginDetailViewModel;
}) {
  const { t } = useTranslation("plugins");
  const channels = view.plugin?.providers?.channels ?? [];
  const checks = view.plugin?.providers?.checks ?? [];
  if (channels.length === 0 && checks.length === 0) return null;
  const kind = (value: string) =>
    (knownKinds as readonly string[]).includes(value)
      ? t(`hosted.providers.kinds.${value as (typeof knownKinds)[number]}`)
      : value;
  return (
    <DetailSection
      id="detail-providers"
      title={t("hosted.providers.review.title")}
      description={t("hosted.providers.review.description")}
    >
      <ItemGroup render={<ul />} className="gap-0">
        {channels.map((channel, index) => (
          <ItemRow key={`channel-${channel.id}`} separated={index > 0}>
            <ItemMedia variant="icon">
              <BellRing aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{channel.title}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {t("hosted.providers.review.channel")}
              </ItemDescription>
            </ItemContent>
          </ItemRow>
        ))}
        {checks.map((check, index) => (
          <ItemRow
            key={`check-${check.id}`}
            separated={channels.length + index > 0}
          >
            <ItemMedia variant="icon">
              <ListChecks aria-hidden="true" />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{check.title}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {t("hosted.providers.review.check", {
                  kinds: check.kinds.map(kind).join(", "),
                })}
              </ItemDescription>
            </ItemContent>
          </ItemRow>
        ))}
      </ItemGroup>
    </DetailSection>
  );
}
