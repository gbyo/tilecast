import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { MetricTile } from "../components/MetricTile";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  activityParams,
  activityRequest,
  ErrorNotice,
  humanize,
  Loading,
} from "./ActivityShared";
import {
  IncidentActionButtons,
  IncidentRow,
  isActivelyFailing,
  useCanActOnIncidents,
  useIncidentAction,
  type Incident,
} from "./ActivityIncidentShared";
import { buildActivityLink } from "./activityLinks";

export type { Incident, IncidentStatus } from "./ActivityIncidentShared";

export type IncidentAnalytics = {
  activeIncidents: number;
  incidentsOpened: number;
  incidentsResolved: number;
  meanTimeToRecoverSeconds: number | null;
  medianTimeToRecoverSeconds: number | null;
  longestIncidentSeconds: number | null;
  longestIncidentTitle?: string;
  automaticRecoveries: number;
  manualRecoveries: number;
  recurring: {
    screenId?: string;
    screenName: string;
    incidentType: string;
    incidents: number;
    occurrences: number;
  }[];
  byScreen: Breakdown[];
  byLocation: Breakdown[];
  byDeviceModel: Breakdown[];
  byPlayerVersion: Breakdown[];
  byFailureCode: Breakdown[];
  byType: Breakdown[];
};

type Breakdown = { key: string; label: string; count: number };

function formatSeconds(value: number | null) {
  // Null means nothing recovered in this range. Showing 0 would read as
  // instant recovery, which is the opposite of no data.
  if (value == null) return "No data";
  const minutes = Math.round(value / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/**
 * How many incidents the Overview preview shows before deferring to the
 * Incidents tab. The panel is one section of a long page, so a bad day on a
 * large fleet must not push everything below it off the screen. The server
 * orders incidents worst-first, so a truncated preview still leads with what
 * matters most, and the count beside the heading stays the true total.
 */
const PREVIEW_FAILING = 5;

/**
 * The Activity Overview's "Needs attention" section.
 *
 * It reads currently open and acknowledged incidents rather than whichever
 * warning happened to be latest, so a screen that failed five times is one
 * item and a screen that recovered is no longer presented as broken. An
 * incident that ended on its own is left out entirely — it is logged on the
 * Incidents tab and needs nothing from anyone. The list is current state, not
 * a range-scoped report, and says so.
 */
export function NeedsAttentionPanel() {
  const canAct = useCanActOnIncidents();
  const act = useIncidentAction();
  const query = useQuery({
    queryKey: ["activity", "incidents", "active"],
    queryFn: () =>
      activityRequest<{ items: Incident[] }>(`/incidents?status=active`),
    refetchInterval: 30_000,
  });

  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  // The server orders these: still-failing first, then by severity, then the
  // longest unresolved, then the most recently updated.
  const items = query.data?.items ?? [];
  const failing = items.filter(isActivelyFailing);

  const actions = (incident: Incident) =>
    canAct ? (
      <IncidentActionButtons
        incident={incident}
        pending={act.isPending}
        onAct={(action) => act.mutate({ id: incident.id, action })}
      />
    ) : undefined;

  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-label="Needs attention"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="flex items-center gap-2 text-base font-semibold">
            Needs attention
            {failing.length > 0 && (
              <Badge variant="destructive">{failing.length}</Badge>
            )}
          </h3>
          <p className="text-sm text-muted-foreground">
            Open incidents right now, not over the selected range. Repeats of
            one condition are a single incident.
          </p>
        </div>
        <Link
          className={buttonVariants({ variant: "outline" })}
          to={buildActivityLink("incidents")}
        >
          All incidents
        </Link>
      </header>

      {act.error && (
        <Alert variant="destructive">
          <AlertDescription>{act.error.message}</AlertDescription>
        </Alert>
      )}

      {failing.length === 0 ? (
        <Empty className="min-h-40 p-6">
          <EmptyHeader>
            <EmptyTitle>No active failures</EmptyTitle>
            <EmptyDescription>Nothing is currently failing.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          <ul className="grid list-none gap-2 p-0">
            {failing.slice(0, PREVIEW_FAILING).map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                actions={actions(incident)}
              />
            ))}
          </ul>
          <TruncationNotice
            shown={PREVIEW_FAILING}
            total={failing.length}
            noun="still failing"
          />
        </>
      )}
    </section>
  );
}

/**
 * Says what the preview left out and where the rest lives. Silence would read
 * as "this is all of them", which is the one thing a truncated list of open
 * problems must never imply.
 */
function TruncationNotice({
  shown,
  total,
  noun,
}: {
  shown: number;
  total: number;
  noun: string;
}) {
  const hidden = total - shown;
  if (hidden <= 0) return null;
  return (
    <p className="text-sm">
      <Link
        to={buildActivityLink("incidents")}
        className="font-medium text-primary hover:underline"
      >
        {hidden} more {noun}
      </Link>
    </p>
  );
}

/**
 * Incident analytics over the selected range. Every count here is historical
 * except "active incidents", which is labelled as measured now.
 */
export function IncidentAnalyticsPanel({
  range,
}: {
  range: ResolvedTimeRange;
}) {
  const query = useQuery({
    queryKey: ["activity", "incident-analytics", range.from, range.to],
    queryFn: () =>
      activityRequest<IncidentAnalytics>(
        `/incidents/analytics?${activityParams(range, {}).toString()}`,
      ),
  });
  const data = query.data;
  if (!data) return null;
  // Go marshals empty slices as null, and an older server may not send these
  // collections at all; the panel indexes into them directly.
  const recurring = data.recurring ?? [];

  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-label="Incident analytics"
    >
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">Incident analytics</h3>
        <p className="text-sm text-muted-foreground">
          Measured over {range.label}, except where a tile says otherwise.
        </p>
      </header>
      <div className="grid gap-4">
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          <MetricTile
            label="Active incidents"
            value={data.activeIncidents}
            // The one tile that is not range-scoped, said plainly rather than
            // left to look like part of the historical set.
            hint="Right now, not over the range"
          />
          <MetricTile
            label="Opened"
            value={data.incidentsOpened}
            hint={`During ${range.label}`}
          />
          <MetricTile
            label="Resolved"
            value={data.incidentsResolved}
            hint={`During ${range.label}`}
          />
          <MetricTile
            label="Mean time to recover"
            value={formatSeconds(data.meanTimeToRecoverSeconds)}
            // The median is shown beside the mean because one long outage
            // drags the mean away from the typical case.
            hint={`Median ${formatSeconds(data.medianTimeToRecoverSeconds)}`}
          />
          <MetricTile
            label="Longest incident"
            value={formatSeconds(data.longestIncidentSeconds)}
            hint={data.longestIncidentTitle || `During ${range.label}`}
          />
          <MetricTile
            label="Recovered on their own"
            value={data.automaticRecoveries}
            hint={`${data.manualRecoveries} closed by hand`}
          />
        </div>

        {recurring.length > 0 && (
          <div className="grid gap-2">
            <h4 className="text-sm font-semibold">Recurring problems</h4>
            <ul className="grid gap-2">
              {recurring.map((item) => (
                <li
                  key={`${item.screenId}-${item.incidentType}`}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border p-3 text-sm"
                >
                  <span className="grid min-w-0 gap-0.5">
                    <strong className="truncate">{item.screenName}</strong>
                    <small className="text-xs text-muted-foreground">
                      {humanize(item.incidentType)}
                    </small>
                  </span>
                  {/* Separate counts: five short outages and one outage
                      reported five times are different problems. */}
                  <span className="text-xs text-muted-foreground tabular-nums">
                    {item.incidents} incidents · {item.occurrences} occurrences
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {(
            [
              ["By screen", data.byScreen ?? []],
              ["By location", data.byLocation ?? []],
              ["By device model", data.byDeviceModel ?? []],
              ["By Player version", data.byPlayerVersion ?? []],
              ["By failure code", data.byFailureCode ?? []],
              ["By category", data.byType ?? []],
            ] as [string, Breakdown[]][]
          )
            .filter(([, items]) => items.length > 0)
            .map(([label, items]) => (
              <section key={label} className="grid gap-1.5">
                <h4 className="text-sm font-semibold">{label}</h4>
                <ul className="grid gap-1 text-sm">
                  {items.slice(0, 6).map((item) => (
                    <li
                      key={item.key || item.label}
                      className="flex items-center justify-between gap-2"
                    >
                      <span className="min-w-0 truncate">
                        {humanize(item.label)}
                      </span>
                      <span className="shrink-0 tabular-nums">
                        {item.count}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            ))}
        </div>
      </div>
    </section>
  );
}
