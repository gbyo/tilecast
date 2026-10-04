import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import { api } from "../api/client";
import type { ContentHealthReport } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import { Skeleton } from "../components/ui/skeleton";

// Content health answers a question the rest of Activity cannot: why does that
// screen look wrong when nothing is reported as broken? A board showing last
// week's menu is online, playing, and compliant.
export function ContentHealthTab() {
  const { t } = useTranslation(["activity", "common"]);
  const formatLocale = useFormatLocale();
  const report = useQuery({
    queryKey: ["content-health"],
    queryFn: api.contentHealth,
    refetchInterval: 60_000,
  });

  if (report.isLoading)
    return (
      <div
        className="grid gap-2"
        role="status"
        aria-label={t("contentHealth.loading")}
      >
        <Skeleton className="h-16 w-full" />
        <Skeleton className="h-16 w-full" />
      </div>
    );
  if (report.error)
    return (
      <Alert variant="destructive">
        <AlertDescription className="flex flex-wrap items-center justify-between gap-3">
          <span>
            {t("contentHealth.loadError", {
              message: apiErrorMessage(report.error),
            })}
          </span>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={report.isFetching}
            onClick={() => void report.refetch()}
          >
            {t("common:actions.retry")}
          </Button>
        </AlertDescription>
      </Alert>
    );

  const data = report.data as ContentHealthReport;
  const healthy =
    !data.staleSources.length &&
    !data.expiringAssets.length &&
    !data.emptyPlaylists.length &&
    !data.unassignedScreens.length;

  if (healthy)
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>{t("contentHealth.healthyTitle")}</EmptyTitle>
          <EmptyDescription>
            {t("contentHealth.healthyDescription", {
              hours: t("contentHealth.hours", {
                count: data.thresholds.staleSourceHours,
              }),
              days: t("contentHealth.days", {
                count: data.thresholds.expiringMediaDays,
              }),
            })}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div className="grid gap-6">
      {data.emptyPlaylists.length > 0 && (
        <section className="grid gap-3">
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold">
              {t("contentHealth.emptyPlaylistsTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("contentHealth.emptyPlaylistsHint")}
            </p>
          </div>
          <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
            {data.emptyPlaylists.map((playlist) => (
              <Item key={playlist.id} size="sm" className="rounded-none px-0">
                <ItemContent>
                  <ItemTitle>
                    <Link to={`/playlists/${playlist.id}`}>
                      {playlist.name}
                    </Link>
                  </ItemTitle>
                  <ItemDescription>
                    {t("contentHealth.screens", {
                      count: playlist.screenCount,
                    })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant="destructive">
                    {t("contentHealth.nothingAvailable")}
                  </Badge>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}

      {data.staleSources.length > 0 && (
        <section className="grid gap-3">
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold">
              {t("contentHealth.staleTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("contentHealth.staleHint", {
                hours: t("contentHealth.hoursAfter", {
                  count: data.thresholds.staleSourceHours,
                }),
              })}
            </p>
          </div>
          <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
            {data.staleSources.map((source) => (
              <Item key={source.id} size="sm" className="rounded-none px-0">
                <ItemContent>
                  <ItemTitle>
                    <Link to={`/content/data-sources/${source.id}`}>
                      {source.name}
                    </Link>
                  </ItemTitle>
                  <ItemDescription>
                    {t("contentHealth.sourceUpdated", {
                      provider: source.provider,
                      when: source.lastSuccessAt
                        ? new Date(source.lastSuccessAt).toLocaleString(
                            formatLocale,
                          )
                        : t("contentHealth.never"),
                    })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions className="text-sm text-muted-foreground">
                  {source.errorCode
                    ? t("contentHealth.lastError", { code: source.errorCode })
                    : t("contentHealth.noRefresh")}
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}

      {data.expiringAssets.length > 0 && (
        <section className="grid gap-3">
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold">
              {t("contentHealth.expiringTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("contentHealth.expiringHint")}
            </p>
          </div>
          <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
            {data.expiringAssets.map((asset) => (
              <Item key={asset.id} size="sm" className="rounded-none px-0">
                <ItemContent>
                  <ItemTitle>{asset.name}</ItemTitle>
                  <ItemDescription>
                    {t("contentHealth.expiresAt", {
                      when: new Date(asset.expiresAt).toLocaleString(
                        formatLocale,
                      ),
                    })}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant={asset.inUse ? "secondary" : "outline"}>
                    {asset.inUse
                      ? t("contentHealth.inPlaylist")
                      : t("contentHealth.notInPlaylist")}
                  </Badge>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}

      {data.unassignedScreens.length > 0 && (
        <section className="grid gap-3">
          <div className="grid gap-1">
            <h3 className="text-sm font-semibold">
              {t("contentHealth.unassignedTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("contentHealth.unassignedHint")}
            </p>
          </div>
          <ItemGroup className="gap-0 divide-y divide-border border-y border-border">
            {data.unassignedScreens.map((screen) => (
              <Item key={screen.id} size="sm" className="rounded-none px-0">
                <ItemContent>
                  <ItemTitle>
                    <Link to={`/screens/${screen.id}`}>{screen.name}</Link>
                  </ItemTitle>
                  <ItemDescription>
                    {t("contentHealth.noPlaylist")}
                  </ItemDescription>
                </ItemContent>
                <ItemActions>
                  <Badge variant="outline">{t("contentHealth.setup")}</Badge>
                </ItemActions>
              </Item>
            ))}
          </ItemGroup>
        </section>
      )}
    </div>
  );
}
