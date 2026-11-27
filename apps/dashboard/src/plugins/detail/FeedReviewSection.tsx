import { useTranslation } from "react-i18next";
import { Database, ShieldAlert } from "lucide-react";
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

/**
 * What a plugin's feeds create before install: the Data Sources it
 * publishes, whether it downloads remote images, and which fields hold
 * personal data for how long. The personal-data facts are kept apart from
 * the feed's own title.
 */
export function FeedReviewSection({ view }: { view: PluginDetailViewModel }) {
  const { t } = useTranslation("plugins");
  const feeds = view.plugin?.feeds ?? [];
  if (feeds.length === 0) return null;
  return (
    <DetailSection id="detail-feeds" title={t("hosted.feeds.review.title")}>
      <ItemGroup render={<ul />} className="gap-0">
        {feeds.map((feed, index) => (
          <ItemRow key={feed.id} separated={index > 0}>
            <ItemMedia variant="icon">
              {feed.personal.length > 0 ? (
                <ShieldAlert aria-hidden="true" />
              ) : (
                <Database aria-hidden="true" />
              )}
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{feed.title}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                {feed.dataset === "instance"
                  ? t("hosted.feeds.review.perInstance", {
                      provider: feed.provider,
                    })
                  : t("hosted.feeds.review.organization", {
                      provider: feed.provider,
                    })}
              </ItemDescription>
              <ul className="list-disc pl-5 text-sm text-muted-foreground">
                {feed.images && <li>{t("hosted.feeds.review.images")}</li>}
                {feed.personal.map((field) => (
                  <li key={field.key}>
                    {t("hosted.feeds.review.personal", {
                      field: field.label,
                      count: field.retentionDays,
                    })}
                  </li>
                ))}
              </ul>
            </ItemContent>
          </ItemRow>
        ))}
      </ItemGroup>
    </DetailSection>
  );
}
