import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";
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
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
import {
  activityParams,
  activityRequest,
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
  const { t } = useTranslation("activity");
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
          <h3 className="text-base font-semibold">{t("incidents.tabTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {filters["dateBasis"]
              ? t("incidents.tabDescriptionRanged", {
                  basis: filters["dateBasis"],
                  range: range.label,
                })
              : t("incidents.tabDescriptionCurrent")}
          </p>
        </header>
        {items.length === 0 ? (
          <EmptyState
            message={
              hasActiveFilters
                ? t("incidents.emptyFiltered")
                : t("incidents.emptyNone")
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
              {t("shared.clearFilters")}
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
  const { t } = useTranslation(["activity", "common"]);
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
            {t("incidents.drawer.openScreenActivity")}
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
        <h4 className="text-sm font-semibold">
          {t("incidents.drawer.recoveryPath")}
        </h4>
        {/* Stated from what was recorded, including when nothing has. */}
        <p className="text-sm text-muted-foreground">
          {detail?.recoveryPath ?? t("common:status.loading")}
        </p>
      </section>

      {query.isLoading && <Loading />}

      {detail && (
        <>
          <DrawerSection
            title={t("incidents.drawer.sections.timeline")}
            empty={t("incidents.drawer.sections.timelineEmpty")}
          >
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
            title={t("incidents.drawer.sections.events")}
            empty={t("incidents.drawer.sections.eventsEmpty")}
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
            title={t("incidents.drawer.sections.playback")}
            empty={t("incidents.drawer.sections.playbackEmpty")}
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
                    t("shared.unnamedPresentation")
                  }
                />
                {session.actualDurationMs != null &&
                  ` · ${formatDuration(session.actualDurationMs)}`}
                {session.terminalReason &&
                  ` · ${t("incidents.drawer.sessionEnded", {
                    reason: humanize(session.terminalReason).toLowerCase(),
                  })}`}{" "}
                <ResultBadge value={session.result} />
              </TimelineEntry>
            ))}
          </DrawerSection>

          {/* Commands and updates are activity events with their own
                  categories, so they arrive in the related-events stream above and
                  are surfaced here as their own view of it. */}
          <DrawerSection
            title={t("incidents.drawer.sections.commands")}
            empty={t("incidents.drawer.sections.commandsEmpty")}
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
            title={t("incidents.drawer.sections.audit")}
            empty={t("incidents.drawer.sections.auditEmpty")}
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
            <DrawerSection
              title={t("incidents.drawer.sections.screens")}
              empty=""
            >
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
    <Sheet
      open={open}
      onOpenChange={handleOpenChange}
      onOpenChangeComplete={onOpenChangeComplete}
    >
      <SheetContent side="right" className="overflow-y-auto">
        {header}
        {content}
      </SheetContent>
    </Sheet>
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
