import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { Link, useParams } from "react-router";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  XAxis,
  YAxis,
} from "recharts";
import { api } from "../api/client";
import type {
  NoiseHistoryDay,
  NoiseHistoryPoint,
  NoiseHistoryRange,
  NoiseHistorySummary,
} from "../api/types";
import type { PluginsT } from "../plugins/pluginCatalog";
import { ResourceTabs } from "../components/ResourceTabs";
import { MetricTile } from "../components/MetricTile";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "../components/ui/chart";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { useOrganizationRegionalProfile } from "../settings/regionalProfile";

function granularityOptions(t: PluginsT) {
  return [
    { value: "raw", label: t("history.granularity.raw") },
    { value: "minute", label: t("history.granularity.minute") },
    { value: "daily", label: t("history.granularity.daily") },
  ];
}

function rangeOptions(
  t: PluginsT,
): { value: NoiseHistoryRange; label: string }[] {
  return [
    { value: "today", label: t("history.ranges.today") },
    { value: "yesterday", label: t("history.ranges.yesterday") },
    { value: "7d", label: t("history.ranges.sevenDays") },
    { value: "30d", label: t("history.ranges.thirtyDays") },
  ];
}

/** How wide one returned point is, for drawing gaps rather than bridging them. */
const resolutionMs: Record<string, number> = {
  minute: 60_000,
  fifteenMinutes: 900_000,
  hour: 3_600_000,
};

function noiseChartConfig(t: PluginsT): ChartConfig {
  return {
    averageLevel: {
      label: t("history.chart.average"),
      color: "var(--chart-1)",
    },
    peakLevel: { label: t("history.chart.peak"), color: "var(--chart-2)" },
    warning: {
      label: t("history.summary.warningLabel"),
      color: "#d97706",
    },
    loud: { label: t("history.summary.loudLabel"), color: "#dc2626" },
  };
}

type DailyMeasure = "average" | "loud" | "events";

function dailyMeasureOptions(t: PluginsT): {
  value: DailyMeasure;
  label: string;
}[] {
  return [
    { value: "average", label: t("history.measures.average") },
    { value: "loud", label: t("history.measures.loud") },
    { value: "events", label: t("history.measures.events") },
  ];
}

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

type NoiseChartDatum = {
  at: number;
  averageLevel: number | null;
  peakLevel: number | null;
};

/** Add null samples where monitoring gaps must remain visible in a Recharts line. */
export function buildNoiseChartData(
  points: NoiseHistoryPoint[],
  widthMs: number,
): NoiseChartDatum[] {
  const segments = splitSeries(points, widthMs);
  const data: NoiseChartDatum[] = [];
  for (const [index, segment] of segments.entries()) {
    if (index > 0) {
      const previous = segments[index - 1]?.at(-1);
      const next = segment[0];
      if (previous && next) {
        const previousAt = Date.parse(previous.at);
        const nextAt = Date.parse(next.at);
        data.push({
          at: previousAt + (nextAt - previousAt) / 2,
          averageLevel: null,
          peakLevel: null,
        });
      }
    }
    data.push(
      ...segment.map((point) => ({
        at: Date.parse(point.at),
        averageLevel: point.averageLevel,
        peakLevel: point.peakLevel,
      })),
    );
  }
  return data;
}

function NoiseHistoryTabs({ id, t }: { id: string; t: PluginsT }) {
  return (
    <ResourceTabs
      label={t("noiseMeter.tabs.label")}
      tabs={[
        {
          label: t("noiseMeter.tabs.settings"),
          to: `/plugins/noise-meter/${id}`,
        },
        {
          label: t("noiseMeter.tabs.history"),
          to: `/plugins/noise-meter/${id}/history`,
        },
      ]}
    />
  );
}

/** Average and peak levels over time, with the meter's own thresholds. */
function NoiseTimeline({
  points,
  resolution,
  warningLevel,
  loudLevel,
  from,
  to,
  t,
}: {
  points: NoiseHistoryPoint[];
  resolution: string;
  warningLevel: number;
  loudLevel: number;
  from: string;
  to: string;
  t: PluginsT;
}) {
  const start = Date.parse(from);
  const span = Math.max(1, Date.parse(to) - start);
  const tickCount = Math.min(6, Math.max(2, Math.round(span / 3_600_000)));
  const ticks = Array.from(
    { length: tickCount + 1 },
    (_, index) => start + (span / tickCount) * index,
  );
  const tickLabel = (value: number) => {
    const at = new Date(value);
    return span > 36 * 3_600_000
      ? at.toLocaleDateString(undefined, { month: "short", day: "numeric" })
      : at.toLocaleTimeString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
  };
  const chartData = buildNoiseChartData(
    points,
    resolutionMs[resolution] ?? 60_000,
  );
  const descriptionId = "noise-timeline-description";
  return (
    <figure className="grid gap-2">
      <ChartContainer
        config={noiseChartConfig(t)}
        className="h-[300px] min-h-[280px] w-full"
        role="group"
        aria-label={t("history.chart.ariaLabel")}
        aria-describedby={descriptionId}
      >
        <LineChart
          accessibilityLayer
          data={chartData}
          margin={{ top: 12, right: 12, bottom: 0, left: 0 }}
        >
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="at"
            type="number"
            domain={[start, start + span]}
            ticks={ticks}
            tickFormatter={tickLabel}
            tickLine={false}
            axisLine={false}
            minTickGap={24}
          />
          <YAxis
            type="number"
            domain={[0, 100]}
            ticks={[0, 20, 40, 60, 80, 100]}
            tickLine={false}
            axisLine={false}
            width={32}
          />
          <ReferenceArea
            y1={warningLevel}
            y2={100}
            fill="var(--color-loud)"
            fillOpacity={0.08}
          />
          <ReferenceArea
            y1={loudLevel}
            y2={warningLevel}
            fill="var(--color-warning)"
            fillOpacity={0.1}
          />
          <ReferenceLine
            y={warningLevel}
            stroke="var(--color-warning)"
            strokeDasharray="6 4"
          />
          <ReferenceLine
            y={loudLevel}
            stroke="var(--color-loud)"
            strokeDasharray="6 4"
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                indicator="line"
                labelFormatter={(value) =>
                  new Date(Number(value)).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })
                }
                formatter={(value, name) => (
                  <div className="flex min-w-32 items-center justify-between gap-4">
                    <span>{name}</span>
                    <span className="font-mono tabular-nums">
                      {formatLevel(Number(value))}
                    </span>
                  </div>
                )}
              />
            }
          />
          <ChartLegend content={<ChartLegendContent />} />
          <Line
            dataKey="averageLevel"
            name={t("history.chart.average")}
            type="linear"
            stroke="var(--color-averageLevel)"
            strokeWidth={2}
            dot={false}
            activeDot={{ r: 3 }}
            connectNulls={false}
          />
          <Line
            dataKey="peakLevel"
            name={t("history.chart.peak")}
            type="linear"
            stroke="var(--color-peakLevel)"
            strokeWidth={1}
            strokeDasharray="4 3"
            dot={false}
            activeDot={{ r: 3 }}
            connectNulls={false}
          />
        </LineChart>
      </ChartContainer>
      <figcaption id={descriptionId} className="sr-only">
        {t("history.chart.description", {
          warning: warningLevel,
          loud: loudLevel,
        })}
      </figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 border-t border-dashed border-amber-600" />
          {t("history.chart.warning", { level: warningLevel })}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 border-t border-dashed border-red-600" />
          {t("history.chart.tooLoud", { level: loudLevel })}
        </li>
      </ul>
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

function SummaryTiles({
  summary,
  t,
}: {
  summary: NoiseHistorySummary;
  t: PluginsT;
}) {
  return (
    <>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <MetricTile
          label={t("history.summary.averageLabel")}
          value={formatLevel(summary.averageLevel)}
          hint={t("history.summary.averageHint")}
        />
        <MetricTile
          label={t("history.summary.peakLabel")}
          value={formatLevel(summary.peakLevel)}
        />
        <MetricTile
          label={t("history.summary.loudLabel")}
          value={formatDuration(summary.loudMs)}
        />
        <MetricTile
          label={t("history.summary.eventsLabel")}
          value={String(summary.warningEvents)}
          hint={t("history.summary.eventsHint")}
        />
      </div>
      <dl className="grid gap-3 rounded-xl border border-border bg-muted/50 p-4 sm:grid-cols-2 lg:grid-cols-3">
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">
            {t("history.summary.normalLabel")}
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
            {t("history.summary.warningLabel")}
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
            {t("history.summary.longestLabel")}
          </dt>
          <dd className="text-sm font-medium tabular-nums">
            {formatDuration(summary.longestLoudMs)}
          </dd>
        </div>
        <div className="grid gap-0.5">
          <dt className="text-xs text-muted-foreground">
            {t("history.summary.loudestLabel")}
          </dt>
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
          <dt className="text-xs text-muted-foreground">
            {t("history.summary.monitoredLabel")}
          </dt>
          <dd className="text-sm font-medium tabular-nums">
            {formatDuration(summary.monitoredMs)}
          </dd>
        </div>
      </dl>
    </>
  );
}

export function NoiseMeterHistoryPage() {
  const { t } = useTranslation("plugins");
  const { id = "" } = useParams();
  const [range, setRange] = useState<NoiseHistoryRange>("today");
  const [screenId, setScreenId] = useState("");
  const [measure, setMeasure] = useState<DailyMeasure>("average");
  const [granularity, setGranularity] = useState("raw");
  const regional = useOrganizationRegionalProfile();
  const timezone = regional.timezone;
  const ranges = rangeOptions(t);
  const granularities = granularityOptions(t);
  const measures = dailyMeasureOptions(t);
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
          <ArrowLeft size={15} aria-hidden="true" /> {t("history.backLink")}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {instance.data?.name ?? t("history.titleFallback")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("history.subtitle")}</p>
      </header>
      <NoiseHistoryTabs id={id} t={t} />
      <Alert>
        <AlertDescription>{t("history.privacyNotice")}</AlertDescription>
      </Alert>

      <div className="flex flex-wrap items-end gap-4">
        <ToggleGroup
          aria-label={t("history.rangeLabel")}
          multiple={false}
          value={[range]}
          onValueChange={(next) => {
            const first = next[0] as NoiseHistoryRange | undefined;
            if (first !== undefined) setRange(first);
          }}
        >
          {ranges.map((item) => (
            <ToggleGroupItem key={item.value} value={item.value}>
              {item.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {multipleScreens && (
          <Field>
            <FieldLabel htmlFor="noise-history-screen">
              {t("history.screenLabel")}
            </FieldLabel>
            <Select
              items={[
                { value: "all", label: t("history.allScreens") },
                ...available.map((screen) => ({
                  value: screen.screenId,
                  label: screen.name,
                })),
              ]}
              value={screenId || "all"}
              onValueChange={(value) =>
                setScreenId(!value || value === "all" ? "" : value)
              }
            >
              <SelectTrigger id="noise-history-screen">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("history.allScreens")}</SelectItem>
                {available.map((screen) => (
                  <SelectItem key={screen.screenId} value={screen.screenId}>
                    {screen.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription>{t("history.screenHint")}</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="noise-history-granularity">
            {t("history.exportLabel")}
          </FieldLabel>
          <Select
            items={granularities}
            value={granularity}
            onValueChange={(value) => setGranularity(value ?? "raw")}
          >
            <SelectTrigger id="noise-history-granularity">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {granularities.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
        <a
          href={exportHref}
          title={t("history.exportTitle")}
          className={buttonVariants({ variant: "secondary" })}
        >
          <Download size={15} aria-hidden="true" /> {t("history.exportAction")}
        </a>
      </div>

      {summary.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("history.loadError")}</AlertDescription>
        </Alert>
      )}

      {!multipleScreens && available.length === 1 && (
        <p className="text-sm text-muted-foreground">
          <Trans
            ns="plugins"
            i18nKey="history.showingSingle"
            values={{ name: available[0]!.name }}
            components={{ strong: <strong /> }}
          />
        </p>
      )}
      {multipleScreens && !screenId && (
        <p className="text-sm text-muted-foreground">
          {t("history.combining", { count: available.length })}
        </p>
      )}

      {empty ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("history.emptyTitle")}</EmptyTitle>
            <EmptyDescription>{t("history.emptyDescription")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {summary.data && (
            <SummaryTiles summary={summary.data.summary} t={t} />
          )}
          <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
            <header>
              <h2 className="text-sm font-semibold">
                {t("history.chartTitle")}
              </h2>
              <p className="text-sm text-muted-foreground">
                {t("history.chartDescription")}
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
                t={t}
              />
            ) : (
              <p className="text-sm text-muted-foreground">
                {t("history.chartEmpty")}
              </p>
            )}
          </section>
          {(range === "7d" || range === "30d") && (
            <section className="grid gap-3 rounded-xl border border-border bg-card p-4 sm:p-5">
              <header className="flex flex-wrap items-end justify-between gap-3">
                <div className="grid gap-0.5">
                  <h2 className="text-sm font-semibold">
                    {t("history.dailyTitle")}
                  </h2>
                  <p className="text-sm text-muted-foreground">
                    {t("history.dailyDescription")}
                  </p>
                </div>
                <ToggleGroup
                  aria-label={t("history.dailyMeasureLabel")}
                  multiple={false}
                  value={[measure]}
                  onValueChange={(next) => {
                    const first = next[0] as DailyMeasure | undefined;
                    if (first !== undefined) setMeasure(first);
                  }}
                >
                  {measures.map((item) => (
                    <ToggleGroupItem key={item.value} value={item.value}>
                      {item.label}
                    </ToggleGroupItem>
                  ))}
                </ToggleGroup>
              </header>
              {(daily.data?.days.length ?? 0) > 0 ? (
                <DailyComparison days={daily.data!.days} measure={measure} />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("history.dailyEmpty")}
                </p>
              )}
            </section>
          )}
        </>
      )}
    </main>
  );
}
