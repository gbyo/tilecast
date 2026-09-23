import { useQuery } from "@tanstack/react-query";
import { Archive, MonitorOff } from "lucide-react";
import { Link } from "react-router";
import { archivedScreens } from "../api/archivedScreens";
import { PageHeader } from "../components/PageHeader";
import { Alert, AlertDescription } from "../components/ui/alert";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";

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

      {archived.isError && (
        <Alert variant="destructive">
          <AlertDescription>{archived.error.message}</AlertDescription>
        </Alert>
      )}

      {archived.isLoading ? (
        <p className="text-sm text-muted-foreground">
          Loading archived screens…
        </p>
      ) : screens.length === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Archive aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No archived screens</EmptyTitle>
            <EmptyDescription>
              Revoked player pairings will appear here automatically.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Link className={buttonVariants()} to="/screens">
              Back to screens
            </Link>
          </EmptyContent>
        </Empty>
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
