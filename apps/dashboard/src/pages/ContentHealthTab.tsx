import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
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

// Content health answers a question the rest of Activity cannot: why does that
// screen look wrong when nothing is reported as broken? A board showing last
// week's menu is online, playing, and compliant.
export function ContentHealthTab() {
  const { t } = useTranslation("activity");
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
          <div className="backup-job-list">
            {data.emptyPlaylists.map((playlist) => (
              <div key={playlist.id}>
                <span>
                  <strong>
                    <Link to={`/playlists/${playlist.id}`}>
                      {playlist.name}
                    </Link>
                  </strong>
                  <small>
                    {t("contentHealth.screens", {
                      count: playlist.screenCount,
                    })}
                  </small>
                </span>
                <span className="backup-job-status">
                  <Badge variant="destructive">
                    {t("contentHealth.nothingAvailable")}
                  </Badge>
                </span>
              </div>
            ))}
          </div>
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
          <div className="backup-job-list">
            {data.staleSources.map((source) => (
              <div key={source.id}>
                <span>
                  <strong>
                    <Link to={`/content/data-sources/${source.id}`}>
                      {source.name}
                    </Link>
                  </strong>
                  <small>
                    {t("contentHealth.sourceUpdated", {
                      provider: source.provider,
                      when: source.lastSuccessAt
                        ? new Date(source.lastSuccessAt).toLocaleString()
                        : t("contentHealth.never"),
                    })}
                  </small>
                </span>
                <span className="backup-job-status">
                  {source.errorCode
                    ? t("contentHealth.lastError", {
                        code: source.errorCode,
                      })
                    : t("contentHealth.noRefresh")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.expiringAssets.length > 0 && (
        <section className="settings-subsection">
          <header>
            <h3>{t("contentHealth.expiringTitle")}</h3>
            <p>{t("contentHealth.expiringHint")}</p>
          </header>
          <div className="backup-job-list">
            {data.expiringAssets.map((asset) => (
              <div key={asset.id}>
                <span>
                  <strong>{asset.name}</strong>
                  <small>
                    {t("contentHealth.expiresAt", {
                      when: new Date(asset.expiresAt).toLocaleString(),
                    })}
                  </small>
                </span>
                <span className="backup-job-status">
                  {asset.inUse
                    ? t("contentHealth.inPlaylist")
                    : t("contentHealth.notInPlaylist")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.unassignedScreens.length > 0 && (
        <section className="settings-subsection">
          <header>
            <h3>{t("contentHealth.unassignedTitle")}</h3>
            <p>{t("contentHealth.unassignedHint")}</p>
          </header>
          <div className="backup-job-list">
            {data.unassignedScreens.map((screen) => (
              <div key={screen.id}>
                <span>
                  <strong>
                    <Link to={`/screens/${screen.id}`}>{screen.name}</Link>
                  </strong>
                </span>
                <span className="backup-job-status">
                  {t("contentHealth.noPlaylist")}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
