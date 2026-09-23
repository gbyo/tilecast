import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router";
import { api } from "../api/client";
import type {
  NoiseHistoryDay,
  NoiseHistoryPoint,
  NoiseHistoryRange,
  NoiseHistorySummary,
} from "../api/types";
import { ToggleGroup, ViewTabs } from "../components/legacy-ui";
import { MetricTile } from "../components/legacy-ui/MetricTile";
import { Alert, AlertDescription } from "../components/ui/alert";
import { buttonVariants } from "../components/ui/button";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";

const granularityOptions = [
  { value: "raw", label: "10-second records" },
  { value: "minute", label: "1-minute summaries" },
  { value: "daily", label: "Daily summaries" },
];

const ranges: { value: NoiseHistoryRange; label: string }[] = [
  { value: "today", label: "Today" },
  { value: "yesterday", label: "Yesterday" },
  { value: "7d", label: "7 days" },
  { value: "30d", label: "30 days" },
];

/** How wide one returned point is, for drawing gaps rather than bridging them. */
const resolutionMs: Record<string, number> = {
  minute: 60_000,
  fifteenMinutes: 900_000,
  hour: 3_600_000,
};

type DailyMeasure = "average" | "loud" | "events";

const dailyMeasures: { value: DailyMeasure; label: string }[] = [
  { value: "average", label: "Average level" },
  { value: "loud", label: "Time too loud" },
  { value: "events", label: "Warning events" },
];

/** Durations read as hours, minutes, and seconds rather than as milliseconds. */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/** A share of monitored time, or nothing at all when nothing was monitored. */
export function formatShare(part: number, whole: number): string {
  if (whole <= 0) return "—";
  return `${Math.round((part / whole) * 100)}%`;
}

function formatLevel(level: number | null | undefined): string {
  if (level === null || level === undefined || !Number.isFinite(level)) {
    return "—";
  }
  return String(Math.round(level));
}

/**
 * Break the series wherever monitoring stopped.
 *
 * A gap is a period nobody measured, and joining a line straight across one
 * would draw a room that was never listened to as though it had been quiet.
 */
export function splitSeries(
  points: NoiseHistoryPoint[],
  widthMs: number,
): NoiseHistoryPoint[][] {
  const segments: NoiseHistoryPoint[][] = [];
  let current: NoiseHistoryPoint[] = [];
  let previous = 0;
  for (const point of points) {
    const at = Date.parse(point.at);
    if (current.length > 0 && at - previous > widthMs * 1.5) {
      segments.push(current);
      current = [];
    }
    current.push(point);
    previous = at;
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

function NoiseHistoryTabs({ id }: { id: string }) {
  const navigate = useNavigate();
  return (
    <ViewTabs
      label="Noise Meter"
      value="history"
      items={[
        { value: "settings", label: "Settings" },
        { value: "history", label: "History" },
      ]}
      onValueChange={(value) => {
        if (value === "settings") void navigate(`/plugins/noise-meter/${id}`);
      }}
    />
  );
}

/**
 * The timeline graph: average and peak Noise Level over the selected range,
 * against the instance's own two thresholds.
 *
 * Deliberately plain SVG in the application's own visual language rather than a
 * charting dependency and a dashboard aesthetic Tilecast does not use anywhere
 * else.
 */
function NoiseTimeline({
  points,
  resolution,
  warningLevel,
  loudLevel,
  from,
  to,
}: {
  points: NoiseHistoryPoint[];
  resolution: string;
  warningLevel: number;
  loudLevel: number;
  from: string;
  to: string;
}) {
  const width = 1000;
  const height = 240;
  const start = Date.parse(from);
  const span = Math.max(1, Date.parse(to) - start);
  const x = (at: string) => ((Date.parse(at) - start) / span) * width;
  const y = (level: number) =>
    height - (Math.min(100, Math.max(0, level)) / 100) * height;
  const segments = splitSeries(points, resolutionMs[resolution] ?? 60_000);
  const line = (
    segment: NoiseHistoryPoint[],
    pick: (p: NoiseHistoryPoint) => number,
  ) =>
    segment
      .map(
        (point, index) =>
          `${index === 0 ? "M" : "L"}${x(point.at).toFixed(1)} ${y(pick(point)).toFixed(1)}`,
      )
      .join(" ");
  const ticks = Math.min(6, Math.max(2, Math.round(span / 3_600_000)));
  const labels = Array.from({ length: ticks + 1 }, (_, index) => {
    const at = new Date(start + (span / ticks) * index);
    return {
      x: (width / ticks) * index,
      label:
        span > 36 * 3_600_000
          ? at.toLocaleDateString(undefined, { month: "short", day: "numeric" })
          : at.toLocaleTimeString(undefined, {
              hour: "numeric",
              minute: "2-digit",
            }),
    };
  });
  return (
    <figure className="grid gap-2">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Noise Level over time. Warning level ${warningLevel}, too loud level ${loudLevel}.`}
        className="h-60 w-full rounded-xl border border-border bg-muted/30"
      >
        <rect
          x="0"
          y="0"
          width={width}
          height={y(warningLevel)}
          className="fill-red-500/10"
        />
        <rect
          x="0"
          y={y(loudLevel)}
          width={width}
          height={Math.max(0, y(warningLevel) - y(loudLevel))}
          className="fill-amber-500/10"
        />
        <line
          x1="0"
          x2={width}
          y1={y(loudLevel)}
          y2={y(loudLevel)}
          className="stroke-red-500 [stroke-dasharray:6_4] [stroke-width:1] [vector-effect:non-scaling-stroke]"
        />
        <line
          x1="0"
          x2={width}
          y1={y(warningLevel)}
          y2={y(warningLevel)}
          className="stroke-amber-500 [stroke-dasharray:6_4] [stroke-width:1] [vector-effect:non-scaling-stroke]"
        />
        {segments.map((segment, index) => (
          <path
            key={`peak-${index}`}
            d={line(segment, (point) => point.peakLevel)}
            className="noise-chart__peak fill-none stroke-muted-foreground opacity-55 [stroke-width:1] [vector-effect:non-scaling-stroke]"
          />
        ))}
        {segments.map((segment, index) => (
          <path
            key={`avg-${index}`}
            d={line(segment, (point) => point.averageLevel)}
            className="noise-chart__average fill-none stroke-primary [stroke-width:2] [vector-effect:non-scaling-stroke]"
          />
        ))}
      </svg>
      <div
        className="relative h-5 text-xs text-muted-foreground"
        aria-hidden="true"
      >
        {labels.map((tick) => (
          <span
            key={tick.x}
            style={{ left: `${(tick.x / width) * 100}%` }}
            className="absolute -translate-x-1/2 whitespace-nowrap"
          >
            {tick.label}
          </span>
        ))}
      </div>
      <figcaption className="flex flex-wrap gap-4 text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-[3px] w-3 bg-primary" />
          Average
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-muted-foreground" />
          Peak
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-amber-500" />
          Warning {warningLevel}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-red-500" />
          Too loud {loudLevel}
        </span>
      </figcaption>
    </figure>
  );
}

/** Daily comparison. A day nobody monitored is absent, never a zero. */
function DailyComparison({
  days,
  measure,
}: {
  days: NoiseHistoryDay[];
  measure: DailyMeasure;
}) {
  const value = (day: NoiseHistoryDay) =>
    measure === "average"
      ? day.averageLevel
      : measure === "loud"
        ? day.loudMs
        : day.triggerCount;
  const label = (day: NoiseHistoryDay) =>
    measure === "average"
      ? formatLevel(day.averageLevel)
      : measure === "loud"
        ? formatDuration(day.loudMs)
        : String(day.triggerCount);
  const highest = Math.max(1, ...days.map(value));
  return (
    <ol className="flex min-h-50 list-none items-end gap-2 overflow-x-auto p-0">
      {days.map((day) => (
        <li
          key={day.date}
          className="grid h-45 min-w-11 flex-1 content-end justify-items-center gap-1"
        >
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            {label(day)}
          </span>
          <span
            className="min-h-0.5 w-3/5 rounded-t bg-primary"
            style={{ height: `${Math.max(2, (value(day) / highest) * 100)}%` }}
          />
          <span className="text-xs whitespace-nowrap text-muted-foreground">
            {new Date(`${day.date}T00:00:00`).toLocaleDateString(undefined, {
              weekday: "short",
              day: "numeric",
            })}
          </span>
        </li>
      ))}
    </ol>
  );
}

function SummaryTiles({ summary }: { summary: NoiseHistorySummary }) {
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label="Average noise level"
          value={formatLevel(summary.averageLevel)}
          hint="Relative, not decibels"
        />
        <MetricTile
          label="Peak noise level"
          value={formatLevel(summary.peakLevel)}
        />
        <MetricTile
          label="Time too loud"
          value={formatDuration(summary.loudMs)}
        />
        <MetricTile
          label="Warning events"
          value={String(summary.warningEvents)}
          hint="Times the bar appeared"
        />
      </div>
      <dl className="grid gap-3 rounded-xl border border-border bg-muted/50 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">
            Time in normal range
          </dt>
          <dd className="text-sm font-medium tabular-nums">
            {formatDuration(summary.normalMs)}{" "}
            <small className="font-normal text-muted-foreground">
              {formatShare(summary.normalMs, summary.monitoredMs)}
            </small>
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">
            Time in warning range
          </dt>
          <dd className="text-sm font-medium tabular-nums">
            {formatDuration(summary.warningMs)}{" "}
            <small className="font-normal text-muted-foreground">
              {formatShare(summary.warningMs, summary.monitoredMs)}
            </small>
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">
            Longest continuous too loud
          </dt>
          <dd className="text-sm font-medium tabular-nums">
            {formatDuration(summary.longestLoudMs)}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">Loudest 15 minutes</dt>
          <dd className="text-sm font-medium tabular-nums">
            {summary.loudestWindowAt
              ? `${formatLevel(summary.loudestWindowLevel)} · ${new Date(
                  summary.loudestWindowAt,
                ).toLocaleString(undefined, {
                  month: "short",
                  day: "numeric",
                  hour: "numeric",
                  minute: "2-digit",
                })}`
              : "—"}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">Monitored time</dt>
          <dd className="text-sm font-medium tabular-nums">
            {formatDuration(summary.monitoredMs)}
          </dd>
        </div>
      </dl>
    </>
  );
}

export function NoiseMeterHistoryPage() {
  const { id = "" } = useParams();
  const [range, setRange] = useState<NoiseHistoryRange>("today");
  const [screenId, setScreenId] = useState("");
  const [measure, setMeasure] = useState<DailyMeasure>("average");
  const [granularity, setGranularity] = useState("raw");
  const timezone = useMemo(
    () => Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC",
    [],
  );
  const params = useMemo(() => {
    const search = new URLSearchParams({ range, tz: timezone });
    if (screenId) search.set("screenId", screenId);
    return search;
  }, [range, screenId, timezone]);

  const instance = useQuery({
    queryKey: ["noise-meter", id],
    queryFn: () => api.noiseMeter(id),
    enabled: Boolean(id),
  });
  const screens = useQuery({
    queryKey: ["noise-history-screens", id, range, timezone],
    queryFn: () =>
      api.noiseHistoryScreens(id, new URLSearchParams({ range, tz: timezone })),
    enabled: Boolean(id),
  });
  const summary = useQuery({
    queryKey: ["noise-history-summary", id, params.toString()],
    queryFn: () => api.noiseHistorySummary(id, params),
    enabled: Boolean(id),
  });
  const series = useQuery({
    queryKey: ["noise-history-series", id, params.toString()],
    queryFn: () => api.noiseHistorySeries(id, params),
    enabled: Boolean(id),
  });
  const daily = useQuery({
    queryKey: ["noise-history-daily", id, params.toString()],
    queryFn: () => api.noiseHistoryDaily(id, params),
    enabled: Boolean(id) && (range === "7d" || range === "30d"),
  });

  const available = screens.data?.items ?? [];
  const multipleScreens = available.length > 1;
  const exportHref = `/api/v1/plugins/noise-meter/instances/${id}/history/export.csv?${new URLSearchParams(
    { ...Object.fromEntries(params), granularity },
  )}`;
  const empty =
    !summary.isLoading &&
    !summary.isError &&
    (summary.data?.summary.buckets ?? 0) === 0;

  return (
    <main className="mx-auto grid w-full max-w-6xl gap-4 px-4 py-6 sm:px-6">
      <header className="grid gap-1">
        <Link
          to="/plugins/noise-meter"
          className="inline-flex w-fit items-center gap-1 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft size={15} aria-hidden="true" /> Noise Meter
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {instance.data?.name ?? "Noise Meter"}
        </h1>
        <p className="text-sm text-muted-foreground">
          Measurements the player recorded locally and delivered on its ordinary
          heartbeat.
        </p>
      </header>
      <NoiseHistoryTabs id={id} />
      <Alert>
        <AlertDescription>
          Noise history stores relative noise-level measurements for graphs and
          reports. Tilecast never records or stores microphone audio. Levels are
          relative to each player&rsquo;s own microphone and are not calibrated
          decibel measurements.
        </AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-end gap-4">
        <ToggleGroup
          label="Date range"
          value={range}
          items={ranges}
          onValueChange={setRange}
        />
        {multipleScreens && (
          <Field>
            <FieldLabel htmlFor="noise-history-screen">Screen</FieldLabel>
            <RheaSelect
              value={screenId || "all"}
              onValueChange={(value) =>
                setScreenId(!value || value === "all" ? "" : value)
              }
            >
              <SelectTrigger id="noise-history-screen">
                <SelectValue>
                  {screenId
                    ? (available.find((screen) => screen.screenId === screenId)
                        ?.name ?? screenId)
                    : "All screens (combined)"}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All screens (combined)</SelectItem>
                {available.map((screen) => (
                  <SelectItem key={screen.screenId} value={screen.screenId}>
                    {screen.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
            <FieldDescription>
              Levels are relative to each player&apos;s own microphone, so
              screens are compared with care.
            </FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="noise-history-granularity">Export</FieldLabel>
          <RheaSelect
            value={granularity}
            onValueChange={(value) => setGranularity(value ?? "raw")}
          >
            <SelectTrigger id="noise-history-granularity">
              <SelectValue>
                {granularityOptions.find((o) => o.value === granularity)?.label}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {granularityOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </RheaSelect>
        </Field>
        <a
          href={exportHref}
          title="Export the selected range and screen"
          className={buttonVariants({ variant: "secondary" })}
        >
          <Download size={15} aria-hidden="true" /> Export CSV
        </a>
      </div>

      {summary.isError && (
        <Alert variant="destructive">
          <AlertDescription>History could not be loaded.</AlertDescription>
        </Alert>
      )}

      {!multipleScreens && available.length === 1 && (
        <p className="text-sm text-muted-foreground">
          Showing <strong>{available[0]!.name}</strong>.
        </p>
      )}
      {multipleScreens && !screenId && (
        <p className="text-sm text-muted-foreground">
          Combining {available.length} screens. Each player&rsquo;s levels come
          from its own microphone, so a combined view describes the group rather
          than comparing rooms.
        </p>
      )}

      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No measurements in this range</EmptyTitle>
            <EmptyDescription>
              History appears once a targeted Linux player has been measuring
              and has delivered a heartbeat.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {summary.data && <SummaryTiles summary={summary.data.summary} />}
          <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <header>
              <h2 className="text-sm font-semibold">Noise level over time</h2>
              <p className="text-sm text-muted-foreground">
                Average and peak, against this meter&apos;s own thresholds.
                Periods with no monitoring are left blank.
              </p>
            </header>
            {series.data && instance.data && series.data.points.length > 0 ? (
              <NoiseTimeline
                points={series.data.points}
                resolution={series.data.resolution}
                warningLevel={instance.data.warningLevel}
                loudLevel={instance.data.loudLevel}
                from={series.data.range.from}
                to={series.data.range.to}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                No measurements to draw yet.
              </p>
            )}
          </section>
          {(range === "7d" || range === "30d") && (
            <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
              <header className="flex flex-wrap items-end justify-between gap-3">
                <div className="grid gap-0.5">
                  <h2 className="text-sm font-semibold">Daily comparison</h2>
                  <p className="text-sm text-muted-foreground">
                    Days without monitoring are omitted rather than shown as
                    silent.
                  </p>
                </div>
                <ToggleGroup
                  label="Daily measure"
                  value={measure}
                  items={dailyMeasures}
                  onValueChange={setMeasure}
                />
              </header>
              {(daily.data?.days.length ?? 0) > 0 ? (
                <DailyComparison days={daily.data!.days} measure={measure} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  No days with measurements yet.
                </p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
