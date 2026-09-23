import { Drawer, Select } from "../components/legacy-ui";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
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
  const [selectedRecord, setSelectedRecord] = useState<ProofRecord | null>(
    null,
  );
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

  useEffect(() => setSelectedRecord(null), [paramsKey]);
  useEffect(() => {
    if (!selectedRecord) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setSelectedRecord(null);
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
        <section className="activity-panel activity-proof-summary">
          <header>
            <div>
              <h3>Proof-of-play summary</h3>
              <p>
                Only Player-confirmed intervals are counted. Screen time is the
                union of root presentations; exposure sums the content inside
                them and can be larger when zones play at once.
              </p>
            </div>
            <label className="activity-group-by">
              <span>Group by</span>
              <Select
                value={dimension}
                onChange={(e) => setDimension(e.target.value)}
              >
                <option value="screen">Screen</option>
                <option value="content">Content</option>
                <option value="presentation">Playlist or Layout</option>
                <option value="schedule">Schedule</option>
              </Select>
            </label>
          </header>
          <div className="activity-proof-metrics">
            <article>
              <PlayCircle size={18} aria-hidden="true" />
              <strong>{metrics.records.toLocaleString()}</strong>
              <span>Confirmed plays</span>
              <small>Total intervals</small>
            </article>
            <article>
              <Clock3 size={18} aria-hidden="true" />
              <strong>{formatDuration(metrics.screenPlayback)}</strong>
              <span>Confirmed screen playback</span>
              <small>Wall clock, overlaps merged</small>
            </article>
            <article>
              <Layers size={18} aria-hidden="true" />
              <strong>{formatDuration(metrics.exposure)}</strong>
              <span>Content exposure</span>
              <small>Sums simultaneous zones</small>
            </article>
            <article>
              <MonitorCheck size={18} aria-hidden="true" />
              <strong>{metrics.completion.toFixed(0)}%</strong>
              <span>Session completion rate</span>
              <small>
                Across {metrics.screens} screen
                {metrics.screens === 1 ? "" : "s"}
              </small>
            </article>
            <article>
              <AlertTriangle size={18} aria-hidden="true" />
              <strong>{metrics.failures.toLocaleString()}</strong>
              <span>Failed sessions</span>
              <small>
                {metrics.interrupted.toLocaleString()} ended unexpectedly
              </small>
            </article>
          </div>
          {(summary.data?.items?.length ?? 0) > 0 && (
            <details className="activity-summary-breakdown">
              <summary>
                View {dimensionLabel(dimension)} breakdown
                <ChevronRight size={15} aria-hidden="true" />
              </summary>
              <div className="activity-summary-table">
                {summary.data?.items?.slice(0, 12).map((item) => (
                  <div key={item.key}>
                    <span>
                      <strong>{item.label}</strong>
                      <small>{item.records} confirmed records</small>
                    </span>
                    <span>
                      {formatDuration(item.confirmedScreenPlaybackMs)}
                    </span>
                    <span>
                      {item.sessionCompletionPercent.toFixed(0)}% completed
                    </span>
                    <span>{item.failures} failures</span>
                  </div>
                ))}
              </div>
            </details>
          )}
        </section>
      )}

      <section className="activity-panel activity-records-panel">
        <header>
          <div>
            <h3>Playback records</h3>
          </div>
        </header>
        {records.length > 0 && (
          <div className="activity-table-wrap">
            <table className="activity-table activity-proof-table">
              <thead>
                <tr>
                  <th>Started</th>
                  <th>Screen</th>
                  <th>Presentation</th>
                  <th>Content</th>
                  <th>Duration</th>
                  <th>Result</th>
                  <th aria-label="Open details" />
                </tr>
              </thead>
              <tbody>
                {records.map((item) => (
                  <tr
                    key={item.id}
                    className="activity-clickable-row"
                    tabIndex={0}
                    onClick={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          "a, button, input, select, summary, details",
                        )
                      )
                        return;
                      setSelectedRecord(item);
                    }}
                    onKeyDown={(event) => {
                      if (
                        (event.target as HTMLElement).closest(
                          "a, button, input, select, summary, details",
                        )
                      )
                        return;
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedRecord(item);
                      }
                    }}
                  >
                    <td>
                      <time>{formatWhen(item.startedAt)}</time>
                    </td>
                    <td>
                      <Link to={`/screens/${item.screenId}?tab=activity`}>
                        {item.screenName}
                      </Link>
                      <small>{item.groupName}</small>
                    </td>
                    <td>
                      <strong>
                        <ResourceLink
                          type={item.presentationType}
                          id={item.presentationId}
                          label={
                            item.presentationName || item.presentationId || "—"
                          }
                        />
                      </strong>
                      <small>
                        {[
                          item.presentationType,
                          item.presentationRevision &&
                            `rev ${item.presentationRevision}`,
                          item.trigger,
                          item.scheduleId && `schedule ${item.scheduleId}`,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </small>
                    </td>
                    <td>
                      <strong>
                        <ResourceLink
                          type={item.contentType}
                          id={item.contentId}
                          label={
                            item.contentName ||
                            item.contentId ||
                            "Root presentation"
                          }
                        />
                      </strong>
                      <small>{item.contentType}</small>
                    </td>
                    <td>
                      {item.actualDurationMs == null
                        ? "In progress"
                        : formatDuration(item.actualDurationMs)}
                    </td>
                    <td>
                      <ResultBadge value={item.result} />
                    </td>
                    <td className="activity-row-disclosure">
                      <ChevronRight size={17} aria-hidden="true" />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!records.length && (
          <div className="activity-empty activity-empty--actionable">
            <MonitorCheck size={24} aria-hidden="true" />
            <h3>
              {hasActiveFilters
                ? "No playback matches the current filters"
                : "No confirmed playback found"}
            </h3>
            <p>
              {hasActiveFilters
                ? "Try adjusting or clearing the filters to see more records."
                : "No players reported proof of play during this date range. Try a longer range or check screen connectivity."}
            </p>
            <div className="activity-empty-actions">
              {hasActiveFilters ? (
                <button
                  type="button"
                  className="button button--secondary"
                  onClick={onClearFilters}
                >
                  Clear filters
                </button>
              ) : (
                <>
                  {canExtendRange && (
                    <button
                      type="button"
                      className="button button--secondary"
                      onClick={onExtendRange}
                    >
                      Last 7 days
                    </button>
                  )}
                  {onViewScreenEvents && (
                    <button
                      type="button"
                      className="button button--quiet"
                      onClick={onViewScreenEvents}
                    >
                      View screen events
                    </button>
                  )}
                </>
              )}
            </div>
          </div>
        )}
        <ActivityPagination
          pagination={pagination}
          nextCursor={query.data?.nextCursor}
        />
      </section>

      {selectedRecord && (
        <ProofDetailsDrawer
          record={selectedRecord}
          onClose={() => setSelectedRecord(null)}
        />
      )}
    </>
  );
}

function ProofDetailsDrawer({
  record,
  onClose,
}: {
  record: ProofRecord;
  onClose: () => void;
}) {
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

  return (
    <Drawer
      className="activity-detail-drawer"
      eyebrow="Playback record"
      title={record.contentName || record.presentationName || record.screenName}
      closeLabel="Close playback details"
      onClose={onClose}
    >
      <div className="activity-drawer-body">
        <div className="activity-drawer-result">
          <ResultBadge value={record.result} />
          <span>
            {record.actualDurationMs == null
              ? "Playback is still in progress"
              : `${formatDuration(record.actualDurationMs)} confirmed`}
          </span>
        </div>

        <section>
          <h3>Playback</h3>
          <dl className="activity-detail-list">
            <DetailRow
              label="Started"
              value={formatFullWhen(record.startedAt)}
            />
            <DetailRow
              label="Ended"
              value={record.endedAt ? formatFullWhen(record.endedAt) : "—"}
            />
            <DetailRow
              label="Screen"
              value={
                <Link to={`/screens/${record.screenId}?tab=activity`}>
                  {record.screenName}
                </Link>
              }
            />
            <DetailRow label="Group" value={record.groupName || "—"} />
            <DetailRow label="Trigger" value={record.trigger || "—"} />
          </dl>
        </section>

        <section>
          <h3>Content</h3>
          <dl className="activity-detail-list">
            <DetailRow
              label="Presentation"
              value={
                <ResourceLink
                  type={record.presentationType}
                  id={record.presentationId}
                  label={
                    record.presentationName || record.presentationId || "—"
                  }
                />
              }
            />
            <DetailRow
              label="Revision"
              value={record.presentationRevision || "—"}
            />
            <DetailRow
              label="Content"
              value={
                <ResourceLink
                  type={record.contentType}
                  id={record.contentId}
                  label={
                    record.contentName ||
                    record.contentId ||
                    "Root presentation"
                  }
                />
              }
            />
            <DetailRow label="Schedule ID" value={record.scheduleId || "—"} />
            <DetailRow label="Takeover ID" value={record.takeoverId || "—"} />
          </dl>
        </section>

        {entries.length > 0 && (
          <section>
            <h3>Technical metadata</h3>
            <dl className="activity-detail-list activity-detail-list--technical">
              {entries.map(([key, value]) => (
                <DetailRow
                  key={key}
                  label={humanize(key)}
                  value={formatTechnicalValue(value)}
                />
              ))}
            </dl>
          </section>
        )}
      </div>
    </Drawer>
  );
}

function DetailRow({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

function dimensionLabel(value: string) {
  return value === "presentation" ? "presentation" : value;
}

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

function formatTechnicalValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value == null) return "";
  try {
    return JSON.stringify(value);
  } catch {
    return "Details unavailable";
  }
}

export function EventsTab({
  range,
  filters,
}: {
  range: { from: string; to: string };
  filters: Record<string, string>;
}) {
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
    <section className="activity-panel">
      <header>
        <div>
          <h3>Screen Events</h3>
          <p>
            Technical state transitions and meaningful Player or server
            activity. Routine successful heartbeats are excluded.
          </p>
        </div>
      </header>
      <div className="activity-table-wrap">
        <table className="activity-table">
          <thead>
            <tr>
              <th>Severity</th>
              <th>Time</th>
              <th>Screen</th>
              <th>Event</th>
              <th>Related resource</th>
              <th>Result</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items?.map((item) => (
              <tr key={item.id}>
                <td>
                  <ResultBadge value={item.severity} />
                </td>
                <td>
                  <time>{formatWhen(item.timestamp)}</time>
                  <small>Received {formatWhen(item.receivedAt)}</small>
                </td>
                <td>
                  <Link to={`/screens/${item.screenId}?tab=activity`}>
                    {item.screenName}
                  </Link>
                  <small>{item.groupName}</small>
                </td>
                <td>
                  <strong>{humanize(item.eventType)}</strong>
                  <small>
                    {item.category} · seq {item.sequence ?? "server"}
                  </small>
                </td>
                <td>
                  {item.relatedId ? (
                    <>
                      <strong>
                        <ResourceLink
                          type={item.relatedType}
                          id={item.relatedId}
                          label={item.relatedId}
                        />
                      </strong>
                      <small>{item.relatedType}</small>
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td>
                  <ResultBadge value={item.result} />
                </td>
                <td>
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
      {!query.data?.items?.length && (
        <EmptyState message="No technical screen events matched these filters." />
      )}
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
    <section className="activity-panel">
      <header>
        <div>
          <h3>Audit Log</h3>
          <p>
            Authenticated user and administrator changes. Player behavior is
            kept in Screen Events.
          </p>
        </div>
      </header>
      <div className="activity-table-wrap">
        <table className="activity-table">
          <thead>
            <tr>
              <th>Time</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Resource</th>
              <th>Result</th>
              <th>Summary</th>
              <th>Details</th>
            </tr>
          </thead>
          <tbody>
            {query.data?.items?.map((item) => (
              <tr key={item.id}>
                <td>
                  <time>{formatWhen(item.timestamp)}</time>
                </td>
                <td>
                  <strong>{item.actorName}</strong>
                  <small>{item.actorUsername}</small>
                </td>
                <td>
                  <strong>{humanize(item.action)}</strong>
                  <small>{item.action}</small>
                </td>
                <td>
                  <strong>
                    <ResourceLink
                      type={item.resourceType}
                      id={item.resourceId}
                      label={item.resourceName || item.resourceId || "—"}
                    />
                  </strong>
                  <small>{item.resourceType}</small>
                </td>
                <td>
                  <ResultBadge value={item.result} />
                </td>
                <td>{item.summary}</td>
                <td>
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
      {!query.data?.items?.length && (
        <EmptyState message="No administrative changes matched these filters." />
      )}
      <ActivityPagination
        pagination={pagination}
        nextCursor={query.data?.nextCursor}
      />
    </section>
  );
}
