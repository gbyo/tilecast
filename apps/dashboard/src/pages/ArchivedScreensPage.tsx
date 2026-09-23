import { useQuery } from "@tanstack/react-query";
import { Archive, MonitorOff } from "lucide-react";
import { Link } from "react-router";
import { archivedScreens } from "../api/archivedScreens";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";

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
    <div className="w-full min-w-0 space-y-4">
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
        <section className="min-w-0" aria-label="Archived screens">
          <header className="mb-2 flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold">Revoked pairings</h2>
              <p className="mt-1 text-sm text-muted-foreground">
                These records do not count toward locations, groups, schedules,
                assignments, takeovers, or update deployments.
              </p>
            </div>
            <span className="text-sm text-muted-foreground">
              {screens.length} archived
            </span>
          </header>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Screen</TableHead>
                <TableHead>Device</TableHead>
                <TableHead>Archived</TableHead>
                <TableHead>Reason</TableHead>
                <TableHead>Last contact</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {screens.map((screen) => (
                <TableRow key={screen.id}>
                  <TableCell className="font-medium">
                    <span className="flex items-center gap-2">
                      <MonitorOff
                        className="size-4 text-muted-foreground"
                        aria-hidden="true"
                      />
                      {screen.name}
                    </span>
                  </TableCell>
                  <TableCell>
                    {screen.deviceManufacturer || screen.platform}{" "}
                    {screen.deviceModel}
                  </TableCell>
                  <TableCell>{formatDate(screen.archivedAt)}</TableCell>
                  <TableCell>
                    {screen.archivedReason || "Pairing revoked"}
                  </TableCell>
                  <TableCell>{formatDate(screen.lastContactAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </section>
      )}
    </div>
  );
}
