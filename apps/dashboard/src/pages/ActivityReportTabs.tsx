import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  ChevronRight,
  Clock3,
  Layers,
  MonitorCheck,
  PlayCircle,
} from "lucide-react";
import {
  ActivityPagination,
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
  useActivityCursor,
} from "./ActivityShared";
import { MetricTile } from "../components/MetricTile";
import { Button } from "../components/ui/button";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../components/ui/drawer";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import type {
  AuditPage,
  EventPage,
  ProofPage,
  ProofRecord,
  ProofSummary,
} from "./ActivityShared";

export function ProofTab({
  range,
  filters,
  dimension,
  setDimension,
  hasActiveFilters,
  canExtendRange,
  onClearFilters,
  onExtendRange,
  onViewScreenEvents,
}: {
  range: { from: string; to: string };
  filters: Record<string, string>;
  dimension: string;
  setDimension: (value: string) => void;
  hasActiveFilters: boolean;
  canExtendRange: boolean;
  onClearFilters: () => void;
  onExtendRange: () => void;
  onViewScreenEvents?: () => void;
}) {
  const { t } = useTranslation("activity");
  const [selectedRecord, setSelectedRecord] = useState<ProofRecord | null>(
    null,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  const params = activityParams(range, filters);
  const paramsKey = params.toString();
  const pagination = useActivityCursor(paramsKey);
  const pageParams = new URLSearchParams(params);
  if (pagination.cursor) pageParams.set("cursor", pagination.cursor);
  const query = useQuery({
    queryKey: ["activity", "proof", pageParams.toString()],
    queryFn: () => activityRequest<ProofPage>(`/proof-of-play?${pageParams}`),
  });
  const summaryParams = new URLSearchParams(params);
  summaryParams.set("dimension", dimension);
  const summary = useQuery({
    queryKey: ["activity", "proof-summary", summaryParams.toString()],
    queryFn: () =>
      activityRequest<ProofSummary>(`/proof-of-play/summary?${summaryParams}`),
  });
  const screenSummaryParams = new URLSearchParams(params);
  screenSummaryParams.set("dimension", "screen");
  const screenSummary = useQuery({
    queryKey: ["activity", "proof-summary", screenSummaryParams.toString()],
    queryFn: () =>
      activityRequest<ProofSummary>(
        `/proof-of-play/summary?${screenSummaryParams}`,
      ),
  });
  const metrics = useMemo(() => {
    const items = screenSummary.data?.items ?? [];
    // Screen playback and content exposure are kept apart on purpose: adding
    // them would count one second of wall clock once per layout zone.
    const totals = items.reduce(
      (current, item) => ({
        records: current.records + item.records,
        screenPlayback: current.screenPlayback + item.confirmedScreenPlaybackMs,
        exposure: current.exposure + item.contentExposureMs,
        failures: current.failures + item.failures,
        interrupted: current.interrupted + item.interrupted,
        completed: current.completed + item.completed + item.partial,
      }),
      {
        records: 0,
        screenPlayback: 0,
        exposure: 0,
        failures: 0,
        interrupted: 0,
        completed: 0,
      },
    );
    return {
      ...totals,
      screens: items.length,
      // This is the share of sessions with a completed or partial outcome.
      // Averaging each screen's percentage gives a one-session screen the same
      // weight as a screen with hundreds of sessions and distorts the result.
      completion: totals.records
        ? (totals.completed / totals.records) * 100
        : 0,
    };
  }, [screenSummary.data]);

  useEffect(() => {
    setSelectedRecord(null);
    setDetailsOpen(false);
  }, [paramsKey]);
  useEffect(() => {
    if (!selectedRecord) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setDetailsOpen(false);
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [selectedRecord]);

  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;

  const hasSummaryData = metrics.screens > 0;
  const records = query.data?.items ?? [];

  return (
    <>
      {hasSummaryData && (
        <section
          className="grid gap-3 rounded-xl border border-border p-4"
          aria-label={t("proof.summaryLabel")}
        >
          <header className="flex flex-wrap items-start justify-between gap-3">
            <div className="grid min-w-0 flex-1 gap-1">
              <h3 className="text-base font-semibold">
                {t("proof.summaryTitle")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("proof.summaryDescription")}
              </p>
            </div>
            <label className="grid gap-1 text-xs font-medium">
              <span>{t("proof.groupBy")}</span>
              <Select
                items={proofDimensionOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                value={dimension}
                onValueChange={(next) => {
                  if (next) setDimension(next);
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="w-44"
                  aria-label={t("proof.groupBy")}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {proofDimensionOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </label>
          </header>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            <MetricTile
              icon={PlayCircle}
              label={t("proof.tiles.plays")}
              value={metrics.records.toLocaleString()}
              hint={t("proof.tiles.playsHint")}
            />
            <MetricTile
              icon={Clock3}
              label={t("proof.tiles.playback")}
              value={formatDuration(metrics.screenPlayback)}
              hint={t("proof.tiles.playbackHint")}
            />
            <MetricTile
              icon={Layers}
              label={t("proof.tiles.exposure")}
              value={formatDuration(metrics.exposure)}
              hint={t("proof.tiles.exposureHint")}
            />
            <MetricTile
              icon={MonitorCheck}
              label={t("proof.tiles.completionRate")}
              value={`${metrics.completion.toFixed(0)}%`}
              hint={t("proof.tiles.acrossScreens", {
                count: metrics.screens,
              })}
            />
            <MetricTile
              icon={AlertTriangle}
              label={t("proof.tiles.failed")}
              value={metrics.failures.toLocaleString()}
              hint={t("proof.tiles.endedUnexpectedly", {
                count: metrics.interrupted,
                value: metrics.interrupted.toLocaleString(),
              })}
            />
          </div>
          {(summary.data?.items?.length ?? 0) > 0 && (
            <Collapsible className="grid gap-2 rounded-xl border border-border p-3">
              <CollapsibleTrigger className="flex cursor-pointer items-center gap-1 text-left text-sm font-medium">
                {t("proof.viewBreakdown", {
                  dimension: dimensionLabel(dimension),
                })}
                <ChevronRight size={15} aria-hidden="true" />
              </CollapsibleTrigger>
              <CollapsibleContent className="grid gap-2">
                {summary.data?.items?.slice(0, 12).map((item) => (
                  <div
                    key={item.key}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-sm"
                  >
                    <span className="grid min-w-0 gap-0.5">
                      <strong className="truncate">{item.label}</strong>
                      <small className="text-xs text-muted-foreground">
                        {t("proof.confirmedRecords", { count: item.records })}
                      </small>
                    </span>
                    <span className="tabular-nums">
                      {formatDuration(item.confirmedScreenPlaybackMs)}
                    </span>
                    <span className="tabular-nums">
                      {t("proof.percentCompleted", {
                        value: item.sessionCompletionPercent.toFixed(0),
                      })}
                    </span>
                    <span className="tabular-nums">
                      {t("proof.failures", { count: item.failures })}
                    </span>
                  </div>
                ))}
              </CollapsibleContent>
            </Collapsible>
          )}
        </section>
      )}

      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="grid gap-1">
          <h3 className="text-base font-semibold">{t("proof.tableTitle")}</h3>
        </header>
        {records.length > 0 && (
          <div className="overflow-x-auto rounded-xl border border-border">
            <table className="w-full min-w-[52rem] text-sm">
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted-foreground">
                  <th className="px-3 py-2 font-medium">
                    {t("proof.headers.started")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("proof.headers.screen")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("proof.headers.presentation")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("proof.headers.content")}
                  </th>
                  <th className="px-3 py-2 text-right font-medium">
                    {t("proof.headers.duration")}
                  </th>
                  <th className="px-3 py-2 font-medium">
                    {t("proof.headers.result")}
                  </th>
                  <th aria-label={t("proof.openDetails")} className="w-10" />
                </tr>
              </thead>
              <tbody>
                {records.map((item) => (
                  <tr
                    key={item.id}
                    className="border-b border-border last:border-0 hover:bg-muted"
                  >
                    <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                      <time>{formatWhen(item.startedAt)}</time>
                    </td>
                    <td className="px-3 py-2">
                      <span className="grid gap-0.5">
                        <Link
                          to={`/screens/${item.screenId}?tab=activity`}
                          className="font-medium text-primary hover:underline"
                        >
                          {item.screenName}
                        </Link>
                        <small className="text-xs text-muted-foreground">
                          {item.groupName}
                        </small>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="grid gap-0.5">
                        <strong className="font-medium">
                          <ResourceLink
                            type={item.presentationType}
                            id={item.presentationId}
                            label={
                              item.presentationName ||
                              item.presentationId ||
                              "—"
                            }
                          />
                        </strong>
                        <small className="text-xs text-muted-foreground">
                          {[
                            item.presentationType,
                            item.presentationRevision &&
                              t("proof.revisionShort", {
                                value: item.presentationRevision,
                              }),
                            item.trigger,
                            item.scheduleId &&
                              t("proof.scheduleShort", {
                                value: item.scheduleId,
                              }),
                          ]
                            .filter(Boolean)
                            .join(" · ")}
                        </small>
                      </span>
                    </td>
                    <td className="px-3 py-2">
                      <span className="grid gap-0.5">
                        <strong className="font-medium">
                          <ResourceLink
                            type={item.contentType}
                            id={item.contentId}
                            label={
                              item.contentName ||
                              item.contentId ||
                              t("shared.rootPresentation")
                            }
                          />
                        </strong>
                        <small className="text-xs text-muted-foreground">
                          {item.contentType}
                        </small>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
                      {item.actualDurationMs == null
                        ? t("proof.inProgress")
                        : formatDuration(item.actualDurationMs)}
                    </td>
                    <td className="px-3 py-2">
                      <ResultBadge value={item.result} />
                    </td>
                    <td className="px-3 py-2 text-muted-foreground">
                      <button
                        type="button"
                        aria-label={t("proof.openRecordDetails", {
                          screen: item.screenName,
                        })}
                        className="rounded-md p-1 hover:bg-muted hover:text-foreground"
                        onClick={() => {
                          setSelectedRecord(item);
                          setDetailsOpen(true);
                        }}
                      >
                        <ChevronRight size={17} aria-hidden="true" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!records.length && (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <MonitorCheck size={24} aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>
                {hasActiveFilters
                  ? t("proof.emptyFilteredTitle")
                  : t("proof.emptyNoneTitle")}
              </EmptyTitle>
              <EmptyDescription>
                {hasActiveFilters
                  ? t("proof.emptyFilteredHint")
                  : t("proof.emptyNoneHint")}
              </EmptyDescription>
            </EmptyHeader>
            <div className="flex flex-wrap justify-center gap-2">
              {hasActiveFilters ? (
                <Button
                  type="button"
                  variant="secondary"
                  onClick={onClearFilters}
                >
                  {t("shared.clearFilters")}
                </Button>
              ) : (
                <>
                  {canExtendRange && (
                    <Button
                      type="button"
                      variant="secondary"
                      onClick={onExtendRange}
                    >
                      {t("proof.extendRange")}
                    </Button>
                  )}
                  {onViewScreenEvents && (
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={onViewScreenEvents}
                    >
                      {t("proof.viewScreenEvents")}
                    </Button>
                  )}
                </>
              )}
            </div>
          </Empty>
        )}
        <ActivityPagination
          pagination={pagination}
          nextCursor={query.data?.nextCursor}
        />
      </section>

      {selectedRecord && (
        <ProofDetailsDrawer
          record={selectedRecord}
          open={detailsOpen}
          onOpenChange={setDetailsOpen}
          onOpenChangeComplete={(open) => {
            if (!open) setSelectedRecord(null);
          }}
          onClose={() => setDetailsOpen(false)}
        />
      )}
    </>
  );
}

function ProofDetailsDrawer({
  record,
  open,
  onOpenChange,
  onOpenChangeComplete,
  onClose,
}: {
  record: ProofRecord;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenChangeComplete: (open: boolean) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation("activity");
  const desktop = useDesktopLayout();
  const technicalDetails = {
    recordId: record.id,
    manifestVersion: record.manifestVersion,
    failureCode: record.failureCode,
    expectedDurationMs: record.expectedDurationMs,
    playlistItemId: record.playlistItemId,
    layoutPlacementId: record.layoutPlacementId,
    sourceId: record.sourceId,
    selectedRecordId: record.selectedRecordId,
    selectionDate: record.selectionDate,
    sourceCachedAt: record.sourceCachedAt,
    sourceRevision: record.sourceRevision,
    snapshotHash: record.snapshotHash,
    ...record.details,
  };
  const entries = Object.entries(technicalDetails).filter(([, value]) => {
    if (value == null || value === "") return false;
    return typeof value !== "boolean" || value;
  });

  const header = desktop ? (
    <SheetHeader>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("proof.drawer.eyebrow")}
      </p>
      <SheetTitle>
        {record.contentName || record.presentationName || record.screenName}
      </SheetTitle>
      <SheetDescription>{t("proof.drawer.description")}</SheetDescription>
    </SheetHeader>
  ) : (
    <DrawerHeader>
      <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
        {t("proof.drawer.eyebrow")}
      </p>
      <DrawerTitle>
        {record.contentName || record.presentationName || record.screenName}
      </DrawerTitle>
      <DrawerDescription>{t("proof.drawer.description")}</DrawerDescription>
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
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <ResultBadge value={record.result} />
        <span>
          {record.actualDurationMs == null
            ? t("proof.drawer.inProgress")
            : t("proof.drawer.confirmedDuration", {
                duration: formatDuration(record.actualDurationMs),
              })}
        </span>
      </p>

      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">
          {t("proof.drawer.sections.playback")}
        </h3>
        <dl className="grid gap-1.5 text-sm">
          <DetailRow
            label={t("proof.drawer.rows.started")}
            value={formatFullWhen(record.startedAt)}
          />
          <DetailRow
            label={t("proof.drawer.rows.ended")}
            value={record.endedAt ? formatFullWhen(record.endedAt) : "—"}
          />
          <DetailRow
            label={t("proof.drawer.rows.screen")}
            value={
              <Link
                to={`/screens/${record.screenId}?tab=activity`}
                className="font-medium text-primary hover:underline"
              >
                {record.screenName}
              </Link>
            }
          />
          <DetailRow
            label={t("proof.drawer.rows.group")}
            value={record.groupName || "—"}
          />
          <DetailRow
            label={t("proof.drawer.rows.trigger")}
            value={record.trigger || "—"}
          />
        </dl>
      </section>

      <section className="grid gap-2">
        <h3 className="text-sm font-semibold">
          {t("proof.drawer.sections.content")}
        </h3>
        <dl className="grid gap-1.5 text-sm">
          <DetailRow
            label={t("proof.drawer.rows.presentation")}
            value={
              <ResourceLink
                type={record.presentationType}
                id={record.presentationId}
                label={record.presentationName || record.presentationId || "—"}
              />
            }
          />
          <DetailRow
            label={t("proof.drawer.rows.revision")}
            value={record.presentationRevision || "—"}
          />
          <DetailRow
            label={t("proof.drawer.rows.content")}
            value={
              <ResourceLink
                type={record.contentType}
                id={record.contentId}
                label={
                  record.contentName ||
                  record.contentId ||
                  t("shared.rootPresentation")
                }
              />
            }
          />
          <DetailRow
            label={t("proof.drawer.rows.scheduleId")}
            value={record.scheduleId || "—"}
          />
          <DetailRow
            label={t("proof.drawer.rows.takeoverId")}
            value={record.takeoverId || "—"}
          />
        </dl>
      </section>

      {entries.length > 0 && (
        <section className="grid gap-2">
          <h3 className="text-sm font-semibold">
            {t("proof.drawer.sections.metadata")}
          </h3>
          <dl className="grid gap-1.5 text-sm">
            {entries.map(([key, value]) => (
              <DetailRow
                key={key}
                label={humanize(key)}
                value={formatTechnicalValue(
                  value,
                  t("shared.detailsUnavailable"),
                )}
              />
            ))}
          </dl>
        </section>
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

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="min-w-0 flex-1 break-words">{value}</dd>
    </div>
  );
}

function dimensionLabel(value: string) {
  return value === "presentation" ? "presentation" : value;
}

// Dimension structures hold translation keys, never rendered text. Labels are
// resolved with t() at render so the tab follows language changes.
const proofDimensionOptions = [
  { value: "screen", labelKey: "proof.dimensions.screen" },
  { value: "content", labelKey: "proof.dimensions.content" },
  { value: "presentation", labelKey: "proof.dimensions.presentation" },
  { value: "schedule", labelKey: "proof.dimensions.schedule" },
] as const;

function formatFullWhen(value: string) {
  return new Date(value).toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatTechnicalValue(value: unknown, unavailable: string): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return unavailable;
  }
}

export function EventsTab({
  range,
  filters,
}: {
  range: { from: string; to: string };
  filters: Record<string, string>;
}) {
  const { t } = useTranslation("activity");
  const params = activityParams(range, filters);
  const pagination = useActivityCursor(params.toString());
  const pageParams = new URLSearchParams(params);
  if (pagination.cursor) pageParams.set("cursor", pagination.cursor);
  const query = useQuery({
    queryKey: ["activity", "events", pageParams.toString()],
    queryFn: () => activityRequest<EventPage>(`/screen-events?${pageParams}`),
    refetchInterval: 20_000,
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">{t("events.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("events.description")}
        </p>
      </header>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">
                {t("events.headers.severity")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("events.headers.time")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("events.headers.screen")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("events.headers.event")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("events.headers.resource")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("events.headers.result")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("events.headers.details")}
              </th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items?.map((item) => (
              <tr
                key={item.id}
                className="border-b border-border align-top last:border-0"
              >
                <td className="px-3 py-2">
                  <ResultBadge value={item.severity} />
                </td>
                <td className="px-3 py-2">
                  <span className="grid gap-0.5">
                    <time className="whitespace-nowrap tabular-nums">
                      {formatWhen(item.timestamp)}
                    </time>
                    <small className="text-xs whitespace-nowrap text-muted-foreground tabular-nums">
                      {t("events.receivedAt", {
                        when: formatWhen(item.receivedAt),
                      })}
                    </small>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="grid gap-0.5">
                    <Link
                      to={`/screens/${item.screenId}?tab=activity`}
                      className="font-medium text-primary hover:underline"
                    >
                      {item.screenName}
                    </Link>
                    <small className="text-xs text-muted-foreground">
                      {item.groupName}
                    </small>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="grid gap-0.5">
                    <strong className="font-medium">
                      {humanize(item.eventType)}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {t("events.sequence", {
                        category: item.category,
                        sequence: item.sequence ?? t("events.serverAssigned"),
                      })}
                    </small>
                  </span>
                </td>
                <td className="px-3 py-2">
                  {item.relatedId ? (
                    <span className="grid gap-0.5">
                      <strong className="font-medium">
                        <ResourceLink
                          type={item.relatedType}
                          id={item.relatedId}
                          label={item.relatedId}
                        />
                      </strong>
                      <small className="text-xs text-muted-foreground">
                        {item.relatedType}
                      </small>
                    </span>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="px-3 py-2">
                  <ResultBadge value={item.result} />
                </td>
                <td className="px-3 py-2">
                  <TechnicalDetails
                    value={{
                      failureCode: item.failureCode,
                      failureMessage: item.failureMessage,
                      manifestVersion: item.manifestVersion,
                      ...item.details,
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!query.data?.items?.length && <EmptyState message={t("events.empty")} />}
      <ActivityPagination
        pagination={pagination}
        nextCursor={query.data?.nextCursor}
      />
    </section>
  );
}

export function AuditTab({
  range,
  filters,
}: {
  range: { from: string; to: string };
  filters: Record<string, string>;
}) {
  const { t } = useTranslation("activity");
  const params = activityParams(range, filters);
  const pagination = useActivityCursor(params.toString());
  const pageParams = new URLSearchParams(params);
  if (pagination.cursor) pageParams.set("cursor", pagination.cursor);
  const query = useQuery({
    queryKey: ["activity", "audit", pageParams.toString()],
    queryFn: () => activityRequest<AuditPage>(`/audit?${pageParams}`),
  });
  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">{t("audit.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("audit.description")}
        </p>
      </header>
      <div className="overflow-x-auto rounded-xl border border-border">
        <table className="w-full min-w-[56rem] text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs text-muted-foreground">
              <th className="px-3 py-2 font-medium">
                {t("audit.headers.time")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("audit.headers.actor")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("audit.headers.action")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("audit.headers.resource")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("audit.headers.result")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("audit.headers.summary")}
              </th>
              <th className="px-3 py-2 font-medium">
                {t("audit.headers.details")}
              </th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items?.map((item) => (
              <tr
                key={item.id}
                className="border-b border-border align-top last:border-0"
              >
                <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                  <time>{formatWhen(item.timestamp)}</time>
                </td>
                <td className="px-3 py-2">
                  <span className="grid gap-0.5">
                    <strong className="font-medium">{item.actorName}</strong>
                    <small className="text-xs text-muted-foreground">
                      {item.actorUsername}
                    </small>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="grid gap-0.5">
                    <strong className="font-medium">
                      {humanize(item.action)}
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {item.action}
                    </small>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <span className="grid gap-0.5">
                    <strong className="font-medium">
                      <ResourceLink
                        type={item.resourceType}
                        id={item.resourceId}
                        label={item.resourceName || item.resourceId || "—"}
                      />
                    </strong>
                    <small className="text-xs text-muted-foreground">
                      {item.resourceType}
                    </small>
                  </span>
                </td>
                <td className="px-3 py-2">
                  <ResultBadge value={item.result} />
                </td>
                <td className="px-3 py-2">{item.summary}</td>
                <td className="px-3 py-2">
                  <TechnicalDetails
                    value={{
                      requestId: item.requestId,
                      ipAddress: item.ipAddress,
                      ...item.metadata,
                    }}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!query.data?.items?.length && <EmptyState message={t("audit.empty")} />}
      <ActivityPagination
        pagination={pagination}
        nextCursor={query.data?.nextCursor}
      />
    </section>
  );
}
