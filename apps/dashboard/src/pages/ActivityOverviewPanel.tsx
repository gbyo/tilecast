import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  CircleHelp,
  MonitorCheck,
  MonitorX,
  Radio,
  TriangleAlert,
} from "lucide-react";
import {
  MetricTile,
  type MetricDelta,
  type MetricDirection,
} from "../components/MetricTile";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";
import { Badge } from "../components/ui/badge";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { FleetUptimePanel } from "../components/FleetUptimePanel";
import {
  activityParams,
  activityRequest,
  ErrorNotice,
  formatDay,
  formatDuration,
  formatWhen,
  humanize,
  Loading,
} from "./ActivityShared";
import type { Overview } from "./ActivityShared";
import { useActivityLinkBuilder, type ActivityTabName } from "./activityLinks";
import {
  IncidentAnalyticsPanel,
  NeedsAttentionPanel,
} from "./ActivityIncidents";
import { CompliancePanel } from "./ActivityCompliance";

// Metric structures hold translation keys, never rendered text. Labels are
// resolved with t() at render so the page follows language changes.
type MetricSpec = {
  key: keyof Overview["cards"];
  labelKey:
    | "overview.metrics.confirmedPlayback"
    | "overview.metrics.contentExposure"
    | "overview.metrics.playbackFailures"
    | "overview.metrics.interruptedPlays"
    | "overview.metrics.takeoverActivations"
    | "overview.metrics.reportingGaps"
    | "overview.metrics.failedUpdates"
    | "overview.metrics.adminChanges";
  direction: MetricDirection;
  /**
   * The records behind the number, as a destination tab and the filters that
   * select exactly the rows the metric counted. The date range is added by the
   * link builder from the range the reader currently has selected.
   */
  destination: { tab: ActivityTabName; filters?: Record<string, string> };
  hintKey?:
    | "overview.metrics.confirmedPlaybackHint"
    | "overview.metrics.contentExposureHint"
    | "overview.metrics.interruptedPlaysHint";
  format?: (value: number) => string;
};

const primaryMetrics: MetricSpec[] = [
  {
    key: "confirmedScreenPlaybackMs",
    labelKey: "overview.metrics.confirmedPlayback",
    direction: "up-is-good",
    hintKey: "overview.metrics.confirmedPlaybackHint",
    destination: { tab: "proof", filters: { sessionType: "presentation" } },
    format: formatDuration,
  },
  {
    key: "contentExposureMs",
    labelKey: "overview.metrics.contentExposure",
    direction: "up-is-good",
    hintKey: "overview.metrics.contentExposureHint",
    destination: { tab: "proof", filters: { sessionType: "content" } },
    format: formatDuration,
  },
  {
    key: "playbackFailures",
    labelKey: "overview.metrics.playbackFailures",
    direction: "up-is-bad",
    destination: { tab: "proof", filters: { result: "failed" } },
  },
  {
    key: "interruptedPlays",
    labelKey: "overview.metrics.interruptedPlays",
    direction: "up-is-bad",
    // Only unexpected endings. A scheduled changeover also ends playback early
    // and is exactly what was asked for, so result=partial would over-report.
    hintKey: "overview.metrics.interruptedPlaysHint",
    destination: { tab: "proof", filters: { terminalReason: "unexpected" } },
  },
];

const secondaryMetrics: MetricSpec[] = [
  {
    key: "takeoverActivations",
    labelKey: "overview.metrics.takeoverActivations",
    direction: "neutral",
    destination: { tab: "events", filters: { category: "takeovers" } },
  },
  {
    key: "screensWithReportingGaps",
    labelKey: "overview.metrics.reportingGaps",
    direction: "up-is-bad",
    // Heartbeat gaps are warning-level connectivity events, so filtering to
    // errors would open a report that excludes most of what was counted.
    destination: { tab: "events", filters: { category: "connectivity" } },
  },
  {
    key: "failedPlayerUpdates",
    labelKey: "overview.metrics.failedUpdates",
    direction: "up-is-bad",
    destination: {
      tab: "events",
      filters: { category: "updates", result: "failed" },
    },
  },
  {
    key: "recentAdministrativeChanges",
    labelKey: "overview.metrics.adminChanges",
    direction: "neutral",
    destination: { tab: "audit", filters: { result: "success" } },
  },
];

type FleetSpec = {
  key: keyof Overview["fleet"];
  labelKey:
    | "overview.fleetStates.online.label"
    | "overview.fleetStates.healthy.label"
    | "overview.fleetStates.impaired.label"
    | "overview.fleetStates.offline.label"
    | "overview.fleetStates.unmeasured.label";
  hintKey:
    | "overview.fleetStates.online.hint"
    | "overview.fleetStates.healthy.hint"
    | "overview.fleetStates.impaired.hint"
    | "overview.fleetStates.offline.hint"
    | "overview.fleetStates.unmeasured.hint";
  icon: typeof MonitorCheck;
  destination?: { tab: ActivityTabName; filters?: Record<string, string> };
};

/**
 * Online is listed first and apart from the rest: it is reachability only, and
 * conflating it with health is exactly what the old single count did. The four
 * states below it partition the measured fleet.
 */
const fleetStates: FleetSpec[] = [
  {
    key: "online",
    labelKey: "overview.fleetStates.online.label",
    hintKey: "overview.fleetStates.online.hint",
    icon: Radio,
  },
  {
    key: "healthy",
    labelKey: "overview.fleetStates.healthy.label",
    hintKey: "overview.fleetStates.healthy.hint",
    icon: MonitorCheck,
  },
  {
    key: "impaired",
    labelKey: "overview.fleetStates.impaired.label",
    hintKey: "overview.fleetStates.impaired.hint",
    icon: TriangleAlert,
    destination: { tab: "events", filters: { category: "reliability" } },
  },
  {
    key: "offline",
    labelKey: "overview.fleetStates.offline.label",
    hintKey: "overview.fleetStates.offline.hint",
    icon: MonitorX,
    destination: { tab: "events", filters: { category: "connectivity" } },
  },
  {
    key: "unmeasured",
    labelKey: "overview.fleetStates.unmeasured.label",
    hintKey: "overview.fleetStates.unmeasured.hint",
    icon: CircleHelp,
  },
];

export function OverviewTab({
  range,
  canViewScreenEvents,
  canViewAudit,
}: {
  range: ResolvedTimeRange;
  canViewScreenEvents: boolean;
  canViewAudit: boolean;
}) {
  const { t } = useTranslation("activity");
  const activityLink = useActivityLinkBuilder();
  const query = useQuery({
    queryKey: ["activity", "overview", range.from, range.to],
    queryFn: () =>
      activityRequest<Overview>(
        `/overview?${activityParams(range, {}).toString()}`,
      ),
    refetchInterval: 30_000,
  });
  // The comparison period is fetched separately so a delta reflects the same
  // measurement over the window immediately before this one.
  const previous = useQuery({
    queryKey: [
      "activity",
      "overview",
      range.previous?.from,
      range.previous?.to,
    ],
    queryFn: () =>
      activityRequest<Overview>(
        `/overview?${activityParams(range.previous!, {}).toString()}`,
      ),
    enabled: Boolean(range.previous),
  });

  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  const data = query.data;
  if (!data) return null;
  // Older servers marshal empty Go slices as null.
  const timeline = data.timeline ?? [];

  function deltaFor(spec: MetricSpec): MetricDelta | undefined {
    const comparison = range.previous;
    if (!comparison || !previous.data) return undefined;
    return {
      change:
        Number(data!.cards[spec.key]) - Number(previous.data.cards[spec.key]),
      comparisonLabel: comparison.label,
      direction: spec.direction,
      format: spec.format,
    };
  }

  function tile(spec: MetricSpec) {
    const raw = Number(data!.cards[spec.key]);
    const canOpen =
      spec.destination.tab !== "events"
        ? spec.destination.tab !== "audit" || canViewAudit
        : canViewScreenEvents;
    return (
      <MetricTile
        key={spec.key}
        label={t(spec.labelKey)}
        value={spec.format ? spec.format(raw) : raw}
        hint={
          spec.hintKey
            ? t(spec.hintKey)
            : t("overview.duringRange", { range: range.label })
        }
        to={
          canOpen
            ? activityLink(spec.destination.tab, spec.destination.filters)
            : undefined
        }
        delta={deltaFor(spec)}
      />
    );
  }

  // Older servers predate fleet health; showing zeroes would assert an all-down
  // fleet, so the section is omitted until the server reports it.
  const fleet = data.fleet;

  return (
    <div className="grid gap-4">
      {fleet && (
        <section
          className="grid gap-3 rounded-xl border border-border p-4"
          aria-label={t("overview.fleetLabel")}
        >
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("overview.fleetTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("overview.fleetDescription", { measured: fleet.measured })}
            </p>
          </header>
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-5">
            {fleetStates.map((state) => (
              <MetricTile
                key={state.key}
                icon={state.icon}
                label={t(state.labelKey)}
                value={fleet[state.key]}
                hint={t(state.hintKey)}
                to={
                  state.destination && canViewScreenEvents
                    ? activityLink(
                        state.destination.tab,
                        state.destination.filters,
                      )
                    : undefined
                }
              />
            ))}
          </div>
        </section>
      )}

      <NeedsAttentionPanel />

      <FleetUptimePanel description={t("overview.uptimeDescription")} />

      <section className="grid gap-2" aria-label={t("overview.activityTotals")}>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {primaryMetrics.map(tile)}
        </div>
        <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
          {secondaryMetrics.map(tile)}
        </div>
      </section>

      <CompliancePanel range={range} />

      <IncidentAnalyticsPanel range={range} />

      <ImportantTimeline items={timeline} />
    </div>
  );
}

function ImportantTimeline({ items }: { items: Overview["timeline"] }) {
  const { t } = useTranslation("activity");
  const [domain, setDomain] = useState("all");
  const domains = useMemo(
    () => [...new Set(items.map((item) => item.domain))].sort(),
    [items],
  );
  const visible = useMemo(
    () => items.filter((item) => domain === "all" || item.domain === domain),
    [domain, items],
  );
  // Events arrive newest first, so day groups keep that order. Grouping keys on
  // the local calendar date rather than a formatted string, so the split does
  // not depend on how a locale happens to render a date.
  const days = useMemo(() => {
    const grouped = new Map<string, Overview["timeline"]>();
    for (const item of visible) {
      const at = new Date(item.timestamp);
      const key = `${at.getFullYear()}-${at.getMonth()}-${at.getDate()}`;
      const bucket = grouped.get(key);
      if (bucket) bucket.push(item);
      else grouped.set(key, [item]);
    }
    return [...grouped.values()];
  }, [visible]);

  return (
    <section className="grid gap-3 rounded-xl border border-border p-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid gap-1">
          <h3 className="text-base font-semibold">
            {t("overview.timelineTitle")}
          </h3>
          <p className="text-sm text-muted-foreground">
            {t("overview.timelineDescription")}
          </p>
        </div>
        {domains.length > 1 && (
          <ToggleGroup
            aria-label={t("overview.timelineFilter")}
            multiple={false}
            value={[domain]}
            onValueChange={(next) => {
              if (next[0] !== undefined) setDomain(next[0]);
            }}
          >
            <ToggleGroupItem value="all">{t("overview.all")}</ToggleGroupItem>
            {domains.map((value) => (
              <ToggleGroupItem key={value} value={value}>
                {humanize(value)}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        )}
      </header>
      {visible.length === 0 ? (
        <Empty className="min-h-40 p-6">
          <EmptyHeader>
            <EmptyTitle>{t("overview.emptyTimelineTitle")}</EmptyTitle>
            <EmptyDescription>{t("overview.emptyTimeline")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="grid gap-4">
          {days.map((entries) => (
            <section key={entries[0]!.id} className="grid gap-2">
              <h4 className="text-sm font-semibold">
                {formatDay(entries[0]!.timestamp)}
              </h4>
              <ol className="grid gap-2">
                {entries.map((item) => (
                  <li
                    key={`${item.domain}-${item.id}`}
                    className="flex flex-wrap items-baseline gap-x-3 gap-y-1 rounded-xl border border-border p-3 text-sm"
                  >
                    <time className="shrink-0 text-xs text-muted-foreground tabular-nums">
                      {formatWhen(item.timestamp)}
                    </time>
                    <Badge variant="secondary">{item.domain}</Badge>
                    <p className="min-w-0 flex-1">{item.description}</p>
                  </li>
                ))}
              </ol>
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
