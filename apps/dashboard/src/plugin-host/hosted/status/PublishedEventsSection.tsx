import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import type { PluginPublishedEventStatus } from "./api";

/**
 * The events the plugin publishes, how many installed plugins receive
 * each, and any version whose payload changed after it was first
 * published. Tilecast refuses to publish such a version.
 */
export function PublishedEventsSection({
  events,
}: {
  events: PluginPublishedEventStatus[];
}) {
  const { t } = useTranslation("plugins");
  if (events.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-labelledby="published-title">
      <h2 id="published-title" className="text-sm font-medium">
        {t("hosted.events.status.published.title")}
      </h2>
      <ItemGroup className="gap-2">
        {events.map((event) => (
          <Item key={event.event} variant="outline">
            <ItemContent>
              <ItemTitle>{event.title}</ItemTitle>
              <ItemDescription className="line-clamp-none">
                <code className="font-mono text-xs">{event.event}</code> ·{" "}
                {event.subscribers === 0
                  ? t("hosted.events.status.published.noSubscribers")
                  : t("hosted.events.status.published.subscribers", {
                      count: event.subscribers,
                    })}
              </ItemDescription>
              {event.schemaChanged && (
                <Alert variant="destructive">
                  <AlertTitle>
                    {t("hosted.events.status.published.schemaChangedTitle")}
                  </AlertTitle>
                  <AlertDescription>
                    {t("hosted.events.status.published.schemaChanged")}
                  </AlertDescription>
                </Alert>
              )}
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
}
