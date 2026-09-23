import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
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
  const report = useQuery({
    queryKey: ["content-health"],
    queryFn: api.contentHealth,
    refetchInterval: 60_000,
  });

  if (report.isLoading)
    return <div className="table-loading">Checking content health…</div>;
  if (report.error)
    return (
      <Alert variant="destructive">
        <AlertDescription>
          Content health could not be loaded. {report.error.message}
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
          <EmptyTitle>Nothing needs attention.</EmptyTitle>
          <EmptyDescription>
            Every Data Source has refreshed within the last{" "}
            {data.thresholds.staleSourceHours} hours, every assigned playlist
            has content available, and no media expires in the next{" "}
            {data.thresholds.expiringMediaDays} days.
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );

  return (
    <div className="settings-sections">
      {data.emptyPlaylists.length > 0 && (
        <section className="settings-subsection">
          <header>
            <h3>Playlists with nothing to play</h3>
            <p>
              These are assigned to a screen. Everything in them has expired, is
              not available yet, or was removed.
            </p>
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
                    {playlist.screenCount === 1
                      ? "1 screen"
                      : `${playlist.screenCount} screens`}
                  </small>
                </span>
                <span className="backup-job-status">
                  <Badge variant="destructive">Nothing available</Badge>
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.staleSources.length > 0 && (
        <section className="settings-subsection">
          <header>
            <h3>Data Sources that are not refreshing</h3>
            <p>
              Screens keep showing the cached copy, so they look correct while
              the data ages. Stale after {data.thresholds.staleSourceHours}{" "}
              hours.
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
                    {source.provider} · last updated{" "}
                    {source.lastSuccessAt
                      ? new Date(source.lastSuccessAt).toLocaleString()
                      : "never"}
                  </small>
                </span>
                <span className="backup-job-status">
                  {source.errorCode
                    ? `Last error: ${source.errorCode}`
                    : "No successful refresh"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.expiringAssets.length > 0 && (
        <section className="settings-subsection">
          <header>
            <h3>Media expiring soon</h3>
            <p>
              Not a fault yet. Media stops playing at its expiry, and a playlist
              that loses its last item stops having anything to show.
            </p>
          </header>
          <div className="backup-job-list">
            {data.expiringAssets.map((asset) => (
              <div key={asset.id}>
                <span>
                  <strong>{asset.name}</strong>
                  <small>
                    Expires {new Date(asset.expiresAt).toLocaleString()}
                  </small>
                </span>
                <span className="backup-job-status">
                  {asset.inUse ? "In a playlist" : "Not in a playlist"}
                </span>
              </div>
            ))}
          </div>
        </section>
      )}

      {data.unassignedScreens.length > 0 && (
        <section className="settings-subsection">
          <header>
            <h3>Screens with nothing assigned</h3>
            <p>
              These show the no-content message. That is a setup state, not a
              fault, so it does not raise an incident.
            </p>
          </header>
          <div className="backup-job-list">
            {data.unassignedScreens.map((screen) => (
              <div key={screen.id}>
                <span>
                  <strong>
                    <Link to={`/screens/${screen.id}`}>{screen.name}</Link>
                  </strong>
                </span>
                <span className="backup-job-status">No playlist</span>
              </div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
