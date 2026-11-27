import { useQuery } from "@tanstack/react-query";
import type { PluginManifestV3 } from "@tilecast/plugin-sdk/manifest";
import { Rss } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { buttonVariants } from "@/components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@/components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "@/components/ui/item";
import { useFormatLocale } from "@/i18n";
import { PluginPage } from "../../PluginPage";
import { feedsClient, feedsKey } from "./api";
import { feedsRoute } from "./model";

export type HostedFeedsProps = {
  pluginId: string;
  manifest: PluginManifestV3;
};

/**
 * The generated list of the datasets a plugin publishes. Each one is an
 * ordinary Data Source that Widgets bind to; the records change only
 * through the plugin, except for the overrides an operator sets here.
 */
export function HostedFeedsPage({ pluginId, manifest }: HostedFeedsProps) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
  const feeds = useQuery({
    queryKey: feedsKey(pluginId),
    queryFn: feedsClient(pluginId).list,
  });
  const items = feeds.data?.items ?? [];
  return (
    <PluginPage
      pluginId={pluginId}
      title={t("hosted.feeds.title")}
      description={t("hosted.feeds.description")}
    >
      {feeds.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("hosted.feeds.loadError")}</AlertDescription>
        </Alert>
      )}
      {feeds.isSuccess && items.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Rss size={24} aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("hosted.feeds.emptyTitle")}</EmptyTitle>
            <EmptyDescription>
              {t("hosted.feeds.emptyDescription")}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ItemGroup className="gap-2">
          {items.map((dataset) => (
            <Item variant="outline" key={dataset.id}>
              <ItemContent>
                <ItemTitle>
                  <h2 className="text-sm font-medium">{dataset.name}</h2>
                  <Badge variant={dataset.stale ? "destructive" : "secondary"}>
                    {dataset.stale
                      ? t("hosted.feeds.stale")
                      : t("hosted.feeds.current")}
                  </Badge>
                  {dataset.imageIssues > 0 && (
                    <Badge variant="outline">
                      {t("hosted.feeds.imageIssues", {
                        count: dataset.imageIssues,
                      })}
                    </Badge>
                  )}
                </ItemTitle>
                <ItemDescription>
                  {[
                    t("hosted.feeds.records", { count: dataset.records }),
                    dataset.publishedAt
                      ? t("hosted.feeds.publishedAt", {
                          date: new Date(dataset.publishedAt).toLocaleString(
                            locale,
                          ),
                        })
                      : t("hosted.feeds.neverPublished"),
                    t("hosted.feeds.widgetsUsing", {
                      count: dataset.widgetsUsing,
                    }),
                  ].join(" · ")}
                </ItemDescription>
              </ItemContent>
              <ItemActions>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={`${feedsRoute(manifest)}/${dataset.id}`}
                >
                  {t("hosted.feeds.open")}
                </Link>
              </ItemActions>
            </Item>
          ))}
        </ItemGroup>
      )}
    </PluginPage>
  );
}
