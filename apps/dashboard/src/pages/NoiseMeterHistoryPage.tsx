import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Download } from "lucide-react";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Trans } from "react-i18next";
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
import { useFormatLocale } from "../i18n";

const granularityOptions = [
  { value: "raw", labelKey: "history.granularity.raw" },
  { value: "minute", labelKey: "history.granularity.minute" },
  { value: "daily", labelKey: "history.granularity.daily" },
] as const;

const ranges = [
  { value: "today", labelKey: "history.ranges.today" },
  { value: "yesterday", labelKey: "history.ranges.yesterday" },
  { value: "7d", labelKey: "history.ranges.sevenDays" },
  { value: "30d", labelKey: "history.ranges.thirtyDays" },
] as const satisfies readonly {
  value: NoiseHistoryRange;
  labelKey: `history.ranges.${string}`;
}[];

/** How wide one returned point is, for drawing gaps rather than bridging them. */
const resolutionMs: Record<string, number> = {
  minute: 60_000,
  fifteenMinutes: 900_000,
  hour: 3_600_000,
};

const noiseChartConfig = {
  averageLevel: { label: "Average", color: "var(--chart-1)" },
  peakLevel: { label: "Peak", color: "var(--chart-2)" },
  warning: { label: "Warning threshold", color: "#d97706" },
  loud: { label: "Too-loud threshold", color: "#dc2626" },
} satisfies ChartConfig;

type DailyMeasure = "average" | "loud" | "events";

const dailyMeasures = [
  { value: "average", labelKey: "history.measures.average" },
  { value: "loud", labelKey: "history.measures.loud" },
  { value: "events", labelKey: "history.measures.events" },
] as const;

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

function NoiseHistoryTabs({ id }: { id: string }) {
  const { t } = useTranslation("plugins");
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
}: {
  points: NoiseHistoryPoint[];
  resolution: string;
  warningLevel: number;
  loudLevel: number;
  from: string;
  to: string;
}) {
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
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
          ? at.toLocaleDateString(locale, { month: "short", day: "numeric" })
          : at.toLocaleTimeString(locale, {
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
        aria-label={t("history.chart.aria", {
          warning: warningLevel,
          loud: loudLevel,
        })}
        className="h-60 w-full rounded-xl border border-border bg-muted/30"
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
          {t("history.chart.average")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-muted-foreground" />
          {t("history.chart.peak")}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-amber-500" />
          {t("history.chart.warning", { level: warningLevel })}
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 bg-red-500" />
          {t("history.chart.tooLoud", { level: loudLevel })}
        </span>
      </figcaption>
      <ul className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 border-t border-dashed border-amber-600" />
          Warning {warningLevel}
        </li>
        <li className="inline-flex items-center gap-1.5">
          <span className="inline-block h-0.5 w-3 border-t border-dashed border-red-600" />
          Too loud {loudLevel}
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
  const locale = useFormatLocale();
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
            {new Date(`${day.date}T00:00:00`).toLocaleDateString(locale, {
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
  const { t } = useTranslation("plugins");
  const locale = useFormatLocale();
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
                ).toLocaleString(locale, {
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
          <ArrowLeft size={15} aria-hidden="true" /> {t("history.backLink")}
        </Link>
        <h1 className="text-xl font-semibold tracking-tight">
          {instance.data?.name ?? t("history.titleFallback")}
        </h1>
        <p className="text-sm text-muted-foreground">{t("history.subtitle")}</p>
      </header>
      <NoiseHistoryTabs id={id} />
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
              {t(item.labelKey)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        {multipleScreens && (
          <Field>
            <FieldLabel htmlFor="noise-history-screen">
              {t("history.screenLabel")}
            </FieldLabel>
            <RheaSelect
              items={[
                { value: "all", label: "All screens (combined)" },
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
                <SelectValue>
                  {screenId
                    ? (available.find((screen) => screen.screenId === screenId)
                        ?.name ?? screenId)
                    : t("history.allScreens")}
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">{t("history.allScreens")}</SelectItem>
                {available.map((screen) => (
                  <SelectItem key={screen.screenId} value={screen.screenId}>
                    {screen.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
            <FieldDescription>{t("history.screenHint")}</FieldDescription>
          </Field>
        )}
        <Field>
          <FieldLabel htmlFor="noise-history-granularity">
            {t("history.exportLabel")}
          </FieldLabel>
          <RheaSelect
            items={granularityOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
            value={granularity}
            onValueChange={(value) => setGranularity(value ?? "raw")}
          >
            <SelectTrigger id="noise-history-granularity">
              <SelectValue>
                {t(
                  granularityOptions.find((o) => o.value === granularity)
                    ?.labelKey ?? "history.granularity.raw",
                )}
              </SelectValue>
            </SelectTrigger>
            <SelectContent>
              {granularityOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {t(option.labelKey)}
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
            i18nKey="history.showingSingle"
            ns="plugins"
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
          {summary.data && <SummaryTiles summary={summary.data.summary} />}
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
                  {dailyMeasures.map((item) => (
                    <ToggleGroupItem key={item.value} value={item.value}>
                      {t(item.labelKey)}
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
