import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./ui/empty";
import { Skeleton } from "./ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import { AlertTriangle, Activity } from "lucide-react";
import {
  activityRequest,
  formatDuration,
  formatWhen,
  humanize,
} from "../pages/ActivityShared";
import { buildActivityLink } from "../pages/activityLinks";

type TimelineEntry = {
  id: string;
  timestamp: string;
  domain: string;
  kind: string;
  severity: string;
  title: string;
  description?: string;
  endedAt?: string;
  durationMs?: number;
  result?: string;
  linkType?: string;
  linkId?: string;
};

type ScreenTimeline = {
  range: { from: string; to: string };
  status: {
    currentPresentation?: string;
    currentItem?: string;
    currentIncident?: string;
    currentIncidentId?: string;
    lastHealthyPlayback?: string;
    lastManifestActivation?: string;
    lastHeartbeatAt?: string;
    playerVersion?: string;
    health: string;
    healthReason: string;
  };
  entries: TimelineEntry[];
};

/**
 * The domains a reader would filter by. These are the Screen Events categories
 * plus the two derived sources — state intervals and incidents — that have no
 * event of their own but belong in the same history.
 */
type ScreensT = TFunction<"screens", undefined>;

const domains = [
  { value: "", labelKey: "timeline.domains.all" },
  { value: "playback", labelKey: "timeline.domains.playback" },
  { value: "connectivity", labelKey: "timeline.domains.connectivity" },
  { value: "reliability", labelKey: "timeline.domains.reliability" },
  { value: "scheduling", labelKey: "timeline.domains.scheduling" },
  { value: "manifest", labelKey: "timeline.domains.manifest" },
  { value: "commands", labelKey: "timeline.domains.commands" },
  { value: "updates", labelKey: "timeline.domains.updates" },
  { value: "takeovers", labelKey: "timeline.domains.takeovers" },
  { value: "state", labelKey: "timeline.domains.state" },
  { value: "incidents", labelKey: "timeline.domains.incidents" },
  { value: "audit", labelKey: "timeline.domains.audit" },
] as const;

const ranges = [
  { value: "24h", labelKey: "timeline.ranges.day" },
  { value: "7d", labelKey: "timeline.ranges.week" },
  { value: "30d", labelKey: "timeline.ranges.month" },
] as const;

function formatOptional(value: string | undefined, t: ScreensT) {
  return value ? formatWhen(value) : t("shared.notReported");
}

/**
 * The main diagnostic view for one screen: everything that happened to it, in
 * one order. The compact proof and event columns beside it remain a summary.
 */
export function ScreenTimeline({ screenId }: { screenId: string }) {
  const { t } = useTranslation("screens");
  const [domain, setDomain] = useState("");
  const [range, setRange] = useState("24h");
  const query = useQuery({
    queryKey: ["activity", "screen-timeline", screenId, domain, range],
    queryFn: () =>
      activityRequest<ScreenTimeline>(
        `/screens/${screenId}/timeline?range=${range}${domain ? `&domain=${domain}` : ""}`,
      ),
    refetchInterval: 30_000,
  });

  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-border bg-card p-4"
      aria-labelledby="screen-timeline-title"
    >
      <header className="flex min-w-0 flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h3 id="screen-timeline-title" className="text-sm font-semibold">
            {t("timeline.title")}
          </h3>
          <p className="mt-1 max-w-[62ch] text-sm text-muted-foreground">
            {t("timeline.body")}
          </p>
        </div>
        <ToggleGroup
          aria-label={t("timeline.rangeLabel")}
          value={[range]}
          onValueChange={(values) => values[0] && setRange(values[0])}
          multiple={false}
          variant="outline"
          size="sm"
          spacing={1}
          className="flex-wrap"
        >
          {ranges.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value}>
              {t(item.labelKey)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </header>

      {query.data?.status && <CurrentStatus status={query.data.status} t={t} />}

      <ToggleGroup
        aria-label={t("timeline.domainLabel")}
        value={[domain || "__all__"]}
        onValueChange={(values) => {
          if (values[0]) setDomain(values[0] === "__all__" ? "" : values[0]);
        }}
        multiple={false}
        variant="outline"
        size="sm"
        spacing={1}
        className="flex-wrap"
      >
        {domains.map((item) => (
          <ToggleGroupItem
            key={item.value || "__all__"}
            value={item.value || "__all__"}
          >
            {t(item.labelKey)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>

      {query.isLoading && (
        <div className="space-y-2" aria-label={t("timeline.loading")}>
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}
      {query.error && (
        <Alert variant="destructive">
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>{t("timeline.loadError")}</AlertTitle>
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      )}
      {query.data &&
        // Go marshals an empty slice as null, so the collection is defaulted
        // rather than indexed into blindly.
        ((query.data.entries ?? []).length === 0 ? (
          <Empty className="min-h-36 border-dashed p-5">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <Activity aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle role="heading" aria-level={4}>
                {domain ? t("timeline.emptyDomain") : t("timeline.emptyNone")}
              </EmptyTitle>
              <EmptyDescription>{t("timeline.emptyHint")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ol className="divide-y divide-border">
            {(query.data.entries ?? []).map((entry) => (
              <li
                key={entry.id}
                className={`grid min-w-0 gap-x-3 gap-y-1 border-l-2 py-3 pl-3 sm:grid-cols-[8rem_7rem_minmax(0,1fr)] ${entry.severity === "critical" || entry.severity === "error" ? "border-l-destructive" : entry.severity === "warning" ? "border-l-amber-500" : "border-l-transparent"}`}
              >
                <time
                  className="text-xs text-muted-foreground"
                  dateTime={entry.timestamp}
                >
                  {formatWhen(entry.timestamp)}
                </time>
                <Badge variant="secondary" className="justify-self-start">
                  {humanize(entry.domain)}
                </Badge>
                <div className="grid min-w-0 gap-1">
                  <strong className="text-sm font-medium">{entry.title}</strong>
                  {entry.description && (
                    <p className="break-words text-sm text-muted-foreground">
                      {entry.description}
                    </p>
                  )}
                  <span className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
                    {entry.durationMs != null && (
                      <span>{formatDuration(entry.durationMs)}</span>
                    )}
                    {/* An interval with no end is still running, which is a
                        different statement from one that ended. */}
                    {(entry.kind === "interval" || entry.kind === "session") &&
                      entry.endedAt === undefined &&
                      entry.durationMs == null && (
                        <span>{t("timeline.stillOpen")}</span>
                      )}
                    {entry.result && <span>{humanize(entry.result)}</span>}
                    {entry.linkType === "incident" ? (
                      <Link
                        className="underline underline-offset-4"
                        to={buildActivityLink("incidents")}
                      >
                        {t("timeline.viewIncident")}
                      </Link>
                    ) : (
                      entry.linkId && (
                        <TimelineResourceLink
                          type={entry.linkType}
                          id={entry.linkId}
                        />
                      )
                    )}
                  </span>
                </div>
              </li>
            ))}
          </ol>
        ))}
    </section>
  );
}

function CurrentStatus({
  status,
  t,
}: {
  status: ScreenTimeline["status"];
  t: ScreensT;
}) {
  return (
    <dl className="grid gap-3 rounded-xl border border-border bg-muted/30 p-3 sm:grid-cols-2 xl:grid-cols-4">
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factHealth")}
        </dt>
        <dd className="mt-1 grid gap-1 text-sm">
          <Badge
            variant={
              status.health === "offline"
                ? "destructive"
                : status.health === "impaired"
                  ? "secondary"
                  : "outline"
            }
            className="justify-self-start"
          >
            {humanize(status.health)}
          </Badge>
          {/* The reason is shown beside the classification so it is never an
              unexplained label. */}
          <small>{humanize(status.healthReason)}</small>
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factPresentation")}
        </dt>
        <dd className="mt-1 break-words text-sm">
          {status.currentPresentation || t("shared.notReported")}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factItem")}
        </dt>
        <dd className="mt-1 break-words text-sm">
          {status.currentItem || t("shared.notReported")}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factIncident")}
        </dt>
        <dd className="mt-1 break-words text-sm">
          {status.currentIncident ? (
            <Link
              className="underline underline-offset-4"
              to={buildActivityLink("incidents")}
            >
              {status.currentIncident}
            </Link>
          ) : (
            t("shared.none")
          )}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factLastHealthy")}
        </dt>
        <dd className="mt-1 text-sm">
          {formatOptional(status.lastHealthyPlayback, t)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factActivation")}
        </dt>
        <dd className="mt-1 text-sm">
          {formatOptional(status.lastManifestActivation, t)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factHeartbeat")}
        </dt>
        <dd className="mt-1 text-sm">
          {formatOptional(status.lastHeartbeatAt, t)}
        </dd>
      </div>
      <div>
        <dt className="text-xs text-muted-foreground">
          {t("timeline.factVersion")}
        </dt>
        <dd className="mt-1 text-sm">
          {status.playerVersion || t("shared.notReported")}
        </dd>
      </div>
    </dl>
  );
}

function TimelineResourceLink({ type, id }: { type?: string; id: string }) {
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
                ? "/settings/users"
                : undefined;
  const { t } = useTranslation("screens");
  return path ? (
    <Link className="underline underline-offset-4" to={path}>
      {t("timeline.openResource")}
    </Link>
  ) : (
    t("timeline.openResource")
  );
}
