import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Drawer, type ResolvedTimeRange } from "../components/legacy-ui";
import {
  activityParams,
  activityRequest,
  EmptyState,
  ErrorNotice,
  formatDuration,
  formatWhen,
  humanize,
  Loading,
  ResourceLink,
  ResultBadge,
  TechnicalDetails,
} from "./ActivityShared";
import type { AuditRecord, ProofRecord, ScreenEvent } from "./ActivityShared";
import {
  IncidentActionButtons,
  IncidentFacts,
  IncidentRow,
  IncidentScope,
  IncidentStatusBadge,
  useCanActOnIncidents,
  useIncidentAction,
  type Incident,
} from "./ActivityIncidentShared";
import { screenActivityLink } from "./activityLinks";

type IncidentTimelineEntry = {
  id: string;
  role: string;
  occurredAt: string;
  actorName?: string;
  summary: string;
};

type IncidentDetail = Incident & {
  timeline: IncidentTimelineEntry[];
  screens: { screenId: string; screenName: string }[];
  relatedEvents: ScreenEvent[];
  proofSessions: ProofRecord[];
  auditChanges: AuditRecord[];
  recoveryPath: string;
};

/**
 * The Incidents report. Screen Events remains the raw diagnostic stream; this
 * tab is the grouped operational view over it, and each row can open the
 * evidence that produced it.
 */
export function IncidentsTab({
  range,
  filters,
  hasActiveFilters,
  onClearFilters,
}: {
  range: ResolvedTimeRange;
  filters: Record<string, string>;
  hasActiveFilters: boolean;
  onClearFilters: () => void;
}) {
  const [selected, setSelected] = useState<Incident | null>(null);
  const canAct = useCanActOnIncidents();
  const act = useIncidentAction();

  // The range only narrows the report when a basis says which timestamp it
  // applies to, so an unfiltered Incidents tab shows current state.
  const params = filters["dateBasis"]
    ? activityParams(range, filters)
    : new URLSearchParams(
        Object.entries(filters).filter(([, value]) => Boolean(value)),
      );
  const paramsKey = params.toString();
  const query = useQuery({
    queryKey: ["activity", "incidents", "tab", paramsKey],
    queryFn: () =>
      activityRequest<{ items: Incident[] }>(`/incidents?${params}`),
    refetchInterval: 30_000,
  });

  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const items = query.data?.items ?? [];

  return (
    <>
      <section className="activity-panel activity-incidents">
        <header>
          <div>
            <h3>Incidents</h3>
            <p>
              {filters["dateBasis"]
                ? `Incidents by ${filters["dateBasis"]} date over ${range.label}.`
                : "Current incidents. Add a date basis to report over the selected range instead."}
            </p>
          </div>
        </header>
        {items.length === 0 ? (
          <EmptyState
            message={
              hasActiveFilters
                ? "No incidents match these filters."
                : "No incidents have been recorded."
            }
          />
        ) : (
          <ul className="activity-incident-list">
            {items.map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                onOpenDetail={setSelected}
              />
            ))}
          </ul>
        )}
        {hasActiveFilters && items.length === 0 && (
          <div className="activity-empty-actions">
            <button
              type="button"
              className="button button--secondary"
              onClick={onClearFilters}
            >
              Clear filters
            </button>
          </div>
        )}
      </section>

      {selected && (
        <IncidentDrawer
          incident={selected}
          onClose={() => setSelected(null)}
          canAct={canAct}
          onAct={(action) =>
            act.mutate(
              { id: selected.id, action },
              { onSuccess: () => setSelected(null) },
            )
          }
          pending={act.isPending}
          error={act.error?.message}
        />
      )}
    </>
  );
}

function IncidentDrawer({
  incident,
  onClose,
  canAct,
  onAct,
  pending,
  error,
}: {
  incident: Incident;
  onClose: () => void;
  canAct: boolean;
  onAct: (action: string) => void;
  pending: boolean;
  error?: string;
}) {
  const query = useQuery({
    queryKey: ["activity", "incident", incident.id],
    queryFn: () => activityRequest<IncidentDetail>(`/incidents/${incident.id}`),
  });
  const detail = query.data;

  return (
    <Drawer
      onClose={onClose}
      title={incident.title}
      className="activity-detail-drawer activity-incident-drawer"
    >
      <div className="activity-incident-drawer__summary">
        <ResultBadge value={incident.severity} />
        <IncidentStatusBadge incident={incident} />
        <IncidentScope incident={incident} />
        {incident.primaryScreenId && (
          <Link to={screenActivityLink(incident.primaryScreenId)}>
            Open the screen's Activity
          </Link>
        )}
      </div>
      <p>{incident.description}</p>

      {error && <div className="notice notice--error">{error}</div>}
      {canAct && (
        <div className="activity-incident__actions">
          <IncidentActionButtons
            incident={incident}
            onAct={onAct}
            pending={pending}
          />
        </div>
      )}

      <IncidentFacts incident={incident} />

      <section>
        <h4>Recovery path</h4>
        {/* Stated from what was recorded, including when nothing has. */}
        <p>{detail?.recoveryPath ?? "Loading…"}</p>
      </section>

      {query.isLoading && <Loading />}

      {detail && (
        <>
          <DrawerSection title="Timeline" empty="No timeline entries.">
            {detail.timeline.map((entry) => (
              <div key={entry.id} className="activity-incident-timeline__entry">
                <time>{formatWhen(entry.occurredAt)}</time>
                <span className="activity-domain">{humanize(entry.role)}</span>
                <p>
                  {entry.summary}
                  {entry.actorName ? ` — ${entry.actorName}` : ""}
                </p>
              </div>
            ))}
          </DrawerSection>

          <DrawerSection
            title="Related raw events"
            empty="No screen events were recorded while this incident was live."
          >
            {detail.relatedEvents.map((event) => (
              <div key={event.id} className="activity-incident-timeline__entry">
                <time>{formatWhen(event.timestamp)}</time>
                <span
                  className={`activity-domain activity-domain--${event.category}`}
                >
                  {event.category}
                </span>
                <p>
                  {humanize(event.eventType)}
                  {event.failureMessage ? ` — ${event.failureMessage}` : ""}
                </p>
                <TechnicalDetails value={event.details} />
              </div>
            ))}
          </DrawerSection>

          <DrawerSection
            title="Playback during the incident"
            empty="No playback sessions overlapped this incident."
          >
            {detail.proofSessions.map((session) => (
              <div
                key={session.id}
                className="activity-incident-timeline__entry"
              >
                <time>{formatWhen(session.startedAt)}</time>
                <span className="activity-domain">{session.sessionType}</span>
                <p>
                  <ResourceLink
                    type={session.contentType ?? session.presentationType}
                    id={session.contentId ?? session.presentationId}
                    label={
                      session.contentName ||
                      session.presentationName ||
                      session.contentId ||
                      "Presentation"
                    }
                  />
                  {session.actualDurationMs != null &&
                    ` · ${formatDuration(session.actualDurationMs)}`}
                  {session.terminalReason &&
                    ` · ended ${humanize(session.terminalReason).toLowerCase()}`}
                </p>
                <ResultBadge value={session.result} />
              </div>
            ))}
          </DrawerSection>

          {/* Commands and updates are activity events with their own
              categories, so they arrive in the related-events stream above and
              are surfaced here as their own view of it. */}
          <DrawerSection
            title="Commands and updates"
            empty="No commands or updates ran during this incident."
          >
            {detail.relatedEvents
              .filter((event) =>
                ["commands", "updates"].includes(event.category),
              )
              .map((event) => (
                <div
                  key={`command-${event.id}`}
                  className="activity-incident-timeline__entry"
                >
                  <time>{formatWhen(event.timestamp)}</time>
                  <span className="activity-domain">{event.category}</span>
                  <p>{humanize(event.eventType)}</p>
                  <ResultBadge value={event.result} />
                </div>
              ))}
          </DrawerSection>

          <DrawerSection
            title="Administrative changes"
            empty="No administrative changes touched this screen during the incident."
          >
            {detail.auditChanges.map((record) => (
              <div
                key={record.id}
                className="activity-incident-timeline__entry"
              >
                <time>{formatWhen(record.timestamp)}</time>
                <span className="activity-domain">audit</span>
                <p>
                  {record.summary || humanize(record.action)} —{" "}
                  {record.actorName}
                </p>
              </div>
            ))}
          </DrawerSection>

          {detail.screens.length > 0 && (
            <DrawerSection title="Affected screens" empty="">
              {detail.screens.map((screen) => (
                <div key={screen.screenId}>
                  <Link to={screenActivityLink(screen.screenId)}>
                    {screen.screenName}
                  </Link>
                </div>
              ))}
            </DrawerSection>
          )}
        </>
      )}
    </Drawer>
  );
}

function DrawerSection({
  title,
  empty,
  children,
}: {
  title: string;
  empty: string;
  children: React.ReactNode;
}) {
  const items = Array.isArray(children) ? children : [children];
  const hasContent = items.some(Boolean) && items.flat().length > 0;
  return (
    <section className="activity-incident-drawer__section">
      <h4>{title}</h4>
      {hasContent ? children : empty ? <p>{empty}</p> : null}
    </section>
  );
}
