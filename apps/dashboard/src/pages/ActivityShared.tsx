import { useEffect, useState } from "react";
import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { CheckCircle2 } from "lucide-react";
import { translateKnown } from "../i18n";
import { Pagination } from "../components/Pagination";
import { Alert, AlertDescription } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Skeleton } from "../components/ui/skeleton";

export type ActivityResult =
  | "playing"
  | "completed"
  | "partial"
  | "skipped"
  | "failed"
  | "unknown"
  | "recovered"
  | "success";

export type Overview = {
  range: { from: string; to: string };
  cards: {
    screensWithReportingGaps: number;
    /** Wall-clock screen time: the union of root presentation intervals. */
    confirmedScreenPlaybackMs: number;
    /** Sum of child content intervals; may exceed wall clock across zones. */
    contentExposureMs: number;
    playbackFailures: number;
    interruptedPlays: number;
    takeoverActivations: number;
    failedPlayerUpdates: number;
    recentAdministrativeChanges: number;
  };
  /**
   * Measured right now rather than over the selected range. Every measured
   * screen is in exactly one of the four states, so they sum to `measured`.
   * `online` counts reachability and deliberately overlaps the others.
   */
  fleet: {
    measured: number;
    online: number;
    healthy: number;
    impaired: number;
    offline: number;
    unmeasured: number;
  };
  timeline: {
    id: string;
    timestamp: string;
    domain: string;
    severity: string;
    description: string;
    screenId?: string;
    resourceId?: string;
  }[];
};

export type ProofRecord = {
  id: string;
  startedAt: string;
  endedAt?: string;
  screenId: string;
  screenName: string;
  groupName?: string;
  presentationType?: string;
  presentationId?: string;
  presentationRevision?: string;
  presentationName?: string;
  contentType?: string;
  contentId?: string;
  contentName?: string;
  playlistItemId?: string;
  layoutPlacementId?: string;
  actualDurationMs?: number;
  expectedDurationMs?: number;
  result: ActivityResult;
  trigger?: string;
  scheduleId?: string;
  takeoverId?: string;
  manifestVersion?: number;
  failureCode?: string;
  sourceId?: string;
  selectedRecordId?: string;
  selectionDate?: string;
  sourceCachedAt?: string;
  sourceRevision?: string;
  snapshotHash?: string;
  sessionType:
    "presentation" | "content" | "layout_placement" | "playlist_item";
  terminalReason?: string;
  details: Record<string, unknown>;
};

export type ProofPage = { items: ProofRecord[]; nextCursor?: string };
export type ProofSummary = {
  dimension: string;
  items: {
    key: string;
    label: string;
    confirmedScreenPlaybackMs: number;
    contentExposureMs: number;
    records: number;
    completed: number;
    failures: number;
    partial: number;
    unknown: number;
    interrupted: number;
    /**
     * The share of sessions that completed or ran partially. Deliberately not
     * called coverage: nothing here compares actual playback against what was
     * scheduled to play.
     */
    sessionCompletionPercent: number;
  }[];
};

export type ScreenEvent = {
  id: string;
  timestamp: string;
  receivedAt: string;
  screenId: string;
  screenName: string;
  groupName?: string;
  sequence?: number;
  eventType: string;
  category: string;
  severity: string;
  description: string;
  relatedType?: string;
  relatedId?: string;
  result: string;
  manifestVersion?: number;
  failureCode?: string;
  failureMessage?: string;
  details: Record<string, unknown>;
};
export type EventPage = { items: ScreenEvent[]; nextCursor?: string };

export type AuditRecord = {
  id: string;
  timestamp: string;
  actorId?: string;
  actorName: string;
  actorUsername?: string;
  action: string;
  resourceType: string;
  resourceId?: string;
  resourceName?: string;
  result: string;
  ipAddress?: string;
  requestId?: string;
  summary: string;
  metadata: Record<string, unknown>;
};
export type AuditPage = { items: AuditRecord[]; nextCursor?: string };

export async function activityRequest<T>(path: string): Promise<T> {
  const response = await fetch(`/api/v1/activity${path}`, {
    credentials: "same-origin",
  });
  const body = (await response.json().catch(() => ({}))) as {
    data?: T;
    error?: { message?: string };
  };
  if (!response.ok || !body.data)
    throw new Error(
      body.error?.message ??
        translateKnown(
          "activity:shared.loadFailed",
          "Activity data could not be loaded.",
        ),
    );
  return body.data;
}

export function activityParams(
  range: { from: string; to: string },
  values: Record<string, string>,
) {
  const params = new URLSearchParams({ from: range.from, to: range.to });
  for (const [key, value] of Object.entries(values)) {
    if (value) params.set(key, value);
  }
  return params;
}

type CursorPagination = {
  cursor: string;
  canGoBack: boolean;
  next: (cursor: string) => void;
  previous: () => void;
};

export function useActivityCursor(resetKey: string): CursorPagination {
  const [history, setHistory] = useState<string[]>([""]);
  useEffect(() => setHistory([""]), [resetKey]);
  return {
    cursor: history[history.length - 1] ?? "",
    canGoBack: history.length > 1,
    next: (cursor) => setHistory((current) => [...current, cursor]),
    previous: () =>
      setHistory((current) =>
        current.length > 1 ? current.slice(0, -1) : current,
      ),
  };
}

export function ActivityPagination({
  pagination,
  nextCursor,
}: {
  pagination: CursorPagination;
  nextCursor?: string;
}) {
  const { t } = useTranslation("activity");
  if (!pagination.canGoBack && !nextCursor) return null;
  return (
    <Pagination
      className="activity-pagination"
      label={t("shared.paginationLabel")}
      previous={pagination.previous}
      previousDisabled={!pagination.canGoBack}
      next={() => nextCursor && pagination.next(nextCursor)}
      nextDisabled={!nextCursor}
    />
  );
}

export function ResourceLink({
  type,
  id,
  label,
}: {
  type?: string;
  id?: string;
  label: string;
}) {
  if (!id) return <>{label}</>;
  const path =
    type === "screen"
      ? `/screens/${id}`
      : type === "playlist"
        ? `/playlists/${id}`
        : type === "layout"
          ? `/layouts/${id}`
          : type === "schedule"
            ? `/schedules/${id}`
            : ["asset", "media", "widget", "source"].includes(type ?? "")
              ? `/assets?search=${encodeURIComponent(id)}`
              : type === "user"
                ? `/settings/users`
                : undefined;
  return path ? <Link to={path}>{label}</Link> : <>{label}</>;
}

export function TechnicalDetails({
  value,
}: {
  value: Record<string, unknown>;
}) {
  const entries = Object.entries(value).filter(
    ([, item]) => item != null && item !== "",
  );
  const { t } = useTranslation("activity");
  if (!entries.length) return <span>—</span>;
  return (
    <Collapsible className="grid gap-1 text-xs">
      <CollapsibleTrigger className="w-fit cursor-pointer text-left font-medium text-primary hover:underline">
        {t("shared.viewDetails")}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <dl className="grid gap-1 rounded-lg border border-border bg-muted/50 p-2">
          {entries.map(([key, item]) => (
            <div key={key} className="flex flex-wrap gap-x-2">
              <dt className="shrink-0 text-muted-foreground">
                {humanize(key)}
              </dt>
              <dd className="min-w-0 flex-1 break-words">
                {formatTechnicalValue(item, t("shared.detailsUnavailable"))}
              </dd>
            </div>
          ))}
        </dl>
      </CollapsibleContent>
    </Collapsible>
  );
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

export function ResultBadge({ value }: { value: string }) {
  const variant =
    value === "failed" || value === "critical" || value === "error"
      ? "destructive"
      : value === "completed" ||
          value === "playing" ||
          value === "success" ||
          value === "recovered"
        ? "default"
        : "secondary";
  return <Badge variant={variant}>{humanize(value)}</Badge>;
}

export function Loading() {
  const { t } = useTranslation("activity");
  return (
    <div className="grid gap-2" aria-label={t("shared.loadingActivity")}>
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
      <Skeleton className="h-12 w-full" />
    </div>
  );
}
export function ErrorNotice({ error }: { error: Error }) {
  return (
    <Alert variant="destructive">
      <AlertDescription>{error.message}</AlertDescription>
    </Alert>
  );
}
export function EmptyState({ message }: { message: string }) {
  const { t } = useTranslation("activity");
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <CheckCircle2 size={22} aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{t("shared.noResults")}</EmptyTitle>
        <EmptyDescription>{message}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

export function formatWhen(value: string) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
/** A whole day, spelled out for a group heading in the reader's locale. */
export function formatDay(value: string) {
  return new Date(value).toLocaleDateString([], {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
export function formatDuration(milliseconds: number) {
  const seconds = Math.max(0, Math.round(milliseconds / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${hours}h ${minutes}m`
    : minutes
      ? `${minutes}m ${remainder}s`
      : `${remainder}s`;
}
export function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replaceAll(".", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}
