import { useQuery } from "@tanstack/react-query";
import { Archive, MonitorOff } from "lucide-react";
import { Link } from "react-router";
import { archivedScreens } from "../api/archivedScreens";
import { PageHeader } from "../components/legacy-ui";
import { ScreenManagementTabs } from "../components/ScreenManagementTabs";

const formatDate = (value?: string) =>
  value
    ? new Date(value).toLocaleString(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      })
    : "Unknown";

export function ArchivedScreensPage() {
  const archived = useQuery({
    queryKey: ["screens", "archive"],
    queryFn: archivedScreens,
  });

  const screens = archived.data?.items ?? [];

  return (
    <div className="screens-page">
      <PageHeader
        title="Screen archive"
        description="Players with revoked pairings are retained for history but are detached from all live Tilecast configuration."
      />
      <ScreenManagementTabs />

      {archived.isError && (
        <div className="notice notice--error">{archived.error.message}</div>
      )}

      {archived.isLoading ? (
        <div className="table-loading">Loading archived screens…</div>
      ) : screens.length === 0 ? (
        <section className="screen-empty">
          <span className="empty-illustration">
            <Archive size={29} />
          </span>
          <h3>No archived screens</h3>
          <p>Revoked player pairings will appear here automatically.</p>
          <Link className="button button--primary" to="/screens">
            Back to screens
          </Link>
        </section>
      ) : (
        <section className="detail-card" aria-label="Archived screens">
          <header>
            <div>
              <h3>Revoked pairings</h3>
              <p>
                These records do not count toward locations, groups, schedules,
                assignments, takeovers, or update deployments.
              </p>
            </div>
            <span>{screens.length} archived</span>
          </header>
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Screen</th>
                  <th>Device</th>
                  <th>Archived</th>
                  <th>Reason</th>
                  <th>Last contact</th>
                </tr>
              </thead>
              <tbody>
                {screens.map((screen) => (
                  <tr key={screen.id}>
                    <td>
                      <span className="screen-name-cell">
                        <MonitorOff size={17} aria-hidden="true" />
                        <strong>{screen.name}</strong>
                      </span>
                    </td>
                    <td>
                      {screen.deviceManufacturer || screen.platform}{" "}
                      {screen.deviceModel}
                    </td>
                    <td>{formatDate(screen.archivedAt)}</td>
                    <td>{screen.archivedReason || "Pairing revoked"}</td>
                    <td>{formatDate(screen.lastContactAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}
    </div>
  );
}
