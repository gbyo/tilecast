import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import {
  Sheet as RheaSheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
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
  const [detailsOpen, setDetailsOpen] = useState(false);
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
      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="grid gap-1">
          <h3 className="text-base font-semibold">Incidents</h3>
          <p className="text-sm text-muted-foreground">
            {filters["dateBasis"]
              ? `Incidents by ${filters["dateBasis"]} date over ${range.label}.`
              : "Current incidents. Add a date basis to report over the selected range instead."}
          </p>
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
          <ul className="grid list-none gap-2 p-0">
            {items.map((incident) => (
              <IncidentRow
                key={incident.id}
                incident={incident}
                onOpenDetail={(incident) => {
                  setSelected(incident);
                  setDetailsOpen(true);
                }}
              />
            ))}
          </ul>
        )}
        {hasActiveFilters && items.length === 0 && (
          <div>
            <RheaButton
              type="button"
              variant="secondary"
              onClick={onClearFilters}
            >
              Clear filters
            </RheaButton>
          </div>
        )}
      </section>

      {selected && (
        <IncidentDrawer
          incident={selected}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          onOpenChangeComplete={(open) => {
            if (!open) setSelected(null);
          }}
          onClose={() => setDetailsOpen(false)}
          canAct={canAct}
          onAct={(action) =>
            act.mutate(
              { id: selected.id, action },
              { onSuccess: () => setDetailsOpen(false) },
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
  open,
  onOpenChange,
  onOpenChangeComplete,
  onClose,
  canAct,
  onAct,
  pending,
  error,
}: {
  incident: Incident;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
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
  const desktop = useDesktopLayout();
  const header = desktop ? (
    <SheetHeader>
      <SheetTitle>{incident.title}</SheetTitle>
      <SheetDescription>{incident.description}</SheetDescription>
    </SheetHeader>
  ) : (
    <DrawerHeader>
      <DrawerTitle>{incident.title}</DrawerTitle>
      <DrawerDescription>{incident.description}</DrawerDescription>
    </DrawerHeader>
  );

  const content = (
    <div
      className={
        desktop
          ? "grid gap-6 px-4 pb-6"
          : "min-h-0 flex-1 overflow-y-auto px-4 pb-6 grid gap-6"
      }
    >
      <div className="flex flex-wrap items-center gap-2">
        <ResultBadge value={incident.severity} />
        <IncidentStatusBadge incident={incident} />
        <IncidentScope incident={incident} />
        {incident.primaryScreenId && (
          <Link
            to={screenActivityLink(incident.primaryScreenId)}
            className="text-sm font-medium text-primary hover:underline"
          >
            Open the screen&apos;s Activity
          </Link>
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {canAct && (
        <div className="flex flex-wrap gap-2">
          <IncidentActionButtons
            incident={incident}
            onAct={onAct}
            pending={pending}
          />
        </div>
      )}

      <IncidentFacts incident={incident} />

      <section className="grid gap-1">
        <h4 className="text-sm font-semibold">Recovery path</h4>
        {/* Stated from what was recorded, including when nothing has. */}
        <p className="text-sm text-muted-foreground">
          {detail?.recoveryPath ?? "Loading…"}
        </p>
      </section>

      {query.isLoading && <Loading />}

      {detail && (
        <>
          <DrawerSection title="Timeline" empty="No timeline entries.">
            {detail.timeline.map((entry) => (
              <TimelineEntry
                key={entry.id}
                when={entry.occurredAt}
                tag={humanize(entry.role)}
              >
                {entry.summary}
                {entry.actorName ? ` — ${entry.actorName}` : ""}
              </TimelineEntry>
            ))}
          </DrawerSection>

          <DrawerSection
            title="Related raw events"
            empty="No screen events were recorded while this incident was live."
          >
            {detail.relatedEvents.map((event) => (
              <TimelineEntry
                key={event.id}
                when={event.timestamp}
                tag={event.category}
              >
                {humanize(event.eventType)}
                {event.failureMessage ? ` — ${event.failureMessage}` : ""}
                <TechnicalDetails value={event.details} />
              </TimelineEntry>
            ))}
          </DrawerSection>

          <DrawerSection
            title="Playback during the incident"
            empty="No playback sessions overlapped this incident."
          >
            {detail.proofSessions.map((session) => (
              <TimelineEntry
                key={session.id}
                when={session.startedAt}
                tag={session.sessionType}
              >
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
                  ` · ended ${humanize(session.terminalReason).toLowerCase()}`}{" "}
                <ResultBadge value={session.result} />
              </TimelineEntry>
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
                <TimelineEntry
                  key={`command-${event.id}`}
                  when={event.timestamp}
                  tag={event.category}
                >
                  {humanize(event.eventType)}{" "}
                  <ResultBadge value={event.result} />
                </TimelineEntry>
              ))}
          </DrawerSection>

          <DrawerSection
            title="Administrative changes"
            empty="No administrative changes touched this screen during the incident."
          >
            {detail.auditChanges.map((record) => (
              <TimelineEntry
                key={record.id}
                when={record.timestamp}
                tag="audit"
              >
                {record.summary || humanize(record.action)} — {record.actorName}
              </TimelineEntry>
            ))}
          </DrawerSection>

          {detail.screens.length > 0 && (
            <DrawerSection title="Affected screens" empty="">
              {detail.screens.map((screen) => (
                <div key={screen.screenId} className="text-sm">
                  <Link
                    to={screenActivityLink(screen.screenId)}
                    className="font-medium text-primary hover:underline"
                  >
                    {screen.screenName}
                  </Link>
                </div>
              ))}
            </DrawerSection>
          )}
        </>
      )}
    </div>
  );
  const handleOpenChange = (nextOpen: boolean) => {
    onOpenChange(nextOpen);
    if (!nextOpen) onClose();
  };

  return desktop ? (
    <RheaSheet
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <SheetContent side="right" className="overflow-y-auto">
        {header}
        {content}
      </SheetContent>
    </RheaSheet>
  ) : (
    <Drawer
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
      showSwipeHandle
    >
      <DrawerContent className="max-h-[calc(100dvh-2rem)]">
        {header}
        {content}
      </DrawerContent>
    </Drawer>
  );
}

function TimelineEntry({
  when,
  tag,
  children,
}: {
  when: string;
  tag: string;
  children: React.ReactNode;
}) {
  return (
    <div className="grid gap-1 rounded-xl border border-border p-3 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <time className="text-xs text-muted-foreground tabular-nums">
          {formatWhen(when)}
        </time>
        <Badge variant="secondary">{tag}</Badge>
      </span>
      <p>{children}</p>
    </div>
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
    <section className="grid gap-2">
      <h4 className="text-sm font-semibold">{title}</h4>
      {hasContent ? (
        children
      ) : empty ? (
        <p className="text-sm text-muted-foreground">{empty}</p>
      ) : null}
    </section>
  );
}
