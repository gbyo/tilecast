import { useTranslation } from "react-i18next";
import { Megaphone, Radio } from "lucide-react";
import { Badge } from "../../components/ui/badge";
import {
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import {
  isCoreEvent,
  useEventLabels,
} from "../../plugin-host/hosted/events/labels";
import { DetailSection } from "./DetailSections";
import { ItemRow } from "./CapabilityItems";
import type { PluginDetailViewModel } from "./detailView";

/**
 * The Server events a plugin publishes and the events it receives, before
 * install. It informs; it grants nothing. A core event is named as a
 * Tilecast event, and a plugin event names the plugin that publishes it.
 */
export function EventReviewSection({ view }: { view: PluginDetailViewModel }) {
  const { t } = useTranslation("plugins");
  const labels = useEventLabels();
  const publishes = view.plugin?.events?.publishes ?? [];
  const subscribes = view.plugin?.events?.subscribes ?? [];
  if (publishes.length === 0 && subscribes.length === 0) return null;
  return (
    <DetailSection
      id="detail-events"
      title={t("hosted.events.review.title")}
      description={t("hosted.events.review.description")}
    >
      {publishes.length > 0 && (
        <>
          <h3 className="text-sm font-medium">
            {t("hosted.events.review.publishes")}
          </h3>
          <ItemGroup render={<ul />} className="gap-0">
            {publishes.map((event, index) => (
              <ItemRow key={event.event} separated={index > 0}>
                <ItemMedia variant="icon">
                  <Megaphone aria-hidden="true" />
                </ItemMedia>
                <ItemContent>
                  <ItemTitle>{event.title}</ItemTitle>
                  <ItemDescription className="line-clamp-none">
                    <code className="font-mono text-xs">{event.event}</code> ·{" "}
                    {t("hosted.events.review.fields", { count: event.fields })}
                  </ItemDescription>
                </ItemContent>
              </ItemRow>
            ))}
          </ItemGroup>
        </>
      )}
      {subscribes.length > 0 && (
        <>
          <h3 className="text-sm font-medium">
            {t("hosted.events.review.subscribes")}
          </h3>
          <ItemGroup render={<ul />} className="gap-0">
            {subscribes.map((event, index) => {
              const core = isCoreEvent(event.event);
              return (
                <ItemRow key={event.event} separated={index > 0}>
                  <ItemMedia variant="icon">
                    <Radio aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent>
                    <ItemTitle>
                      {labels.core(event.event) ?? event.event}
                      <Badge variant="outline">
                        {core
                          ? t("hosted.events.review.coreEvent")
                          : t("hosted.events.review.pluginEvent")}
                      </Badge>
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      <code className="font-mono text-xs">{event.event}</code> ·{" "}
                      {t("hosted.events.publishedBy", {
                        publisher: labels.publisher(
                          event.publisher,
                          event.publisherName,
                        ),
                      })}
                    </ItemDescription>
                  </ItemContent>
                </ItemRow>
              );
            })}
          </ItemGroup>
        </>
      )}
    </DetailSection>
  );
}
