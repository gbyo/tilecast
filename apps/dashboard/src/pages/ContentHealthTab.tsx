import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { useFormatLocale } from "../i18n";
import { api } from "../api/client";
import type { ContentHealthReport } from "../api/types";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
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

// Content health answers a question the rest of Activity cannot: why does that
// screen look wrong when nothing is reported as broken? A board showing last
// week's menu is online, playing, and compliant.
export function ContentHealthTab() {
  const { t } = useTranslation("activity");
  const formatLocale = useFormatLocale();
  const report = useQuery({
    queryKey: ["content-health"],
    queryFn: api.contentHealth,
    refetchInterval: 60_000,
  });

  if (report.isLoading)
    return <div className="table-loading">{t("contentHealth.loading")}</div>;
  if (report.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          {t("contentHealth.loadError", {
            message: report.error.message,
          })}
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
    <div className="settings-sections">
      {data.emptyPlaylists.length > 0 && (
        <section className="settings-subsection">
          <header>
            <h3>{t("contentHealth.emptyPlaylistsTitle")}</h3>
            <p>{t("contentHealth.emptyPlaylistsHint")}</p>
          </header>
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
        <section className="settings-subsection">
          <header>
            <h3>{t("contentHealth.staleTitle")}</h3>
            <p>
              {t("contentHealth.staleHint", {
                hours: t("contentHealth.hoursAfter", {
                  count: data.thresholds.staleSourceHours,
                }),
              })}
            </p>
          </header>
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
        <section className="settings-subsection">
          <header>
            <h3>{t("contentHealth.expiringTitle")}</h3>
            <p>{t("contentHealth.expiringHint")}</p>
          </header>
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
        <section className="settings-subsection">
          <header>
            <h3>{t("contentHealth.unassignedTitle")}</h3>
            <p>{t("contentHealth.unassignedHint")}</p>
          </header>
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
