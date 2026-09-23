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
import {
  EmptyState,
  Field,
  Notice,
  PageHeader,
  Panel,
  SectionHeader,
  Select,
  ToggleGroup,
  ViewTabs,
} from "../components/legacy-ui";
import { MetricTile } from "../components/legacy-ui/MetricTile";
import "./NoiseMeterHistoryPage.css";

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
    <figure className="noise-chart">
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`Noise Level over time. Warning level ${warningLevel}, too loud level ${loudLevel}.`}
      >
        <rect
          x="0"
          y="0"
          width={width}
          height={y(warningLevel)}
          className="noise-chart__band noise-chart__band--loud"
        />
        <rect
          x="0"
          y={y(loudLevel)}
          width={width}
          height={Math.max(0, y(warningLevel) - y(loudLevel))}
          className="noise-chart__band noise-chart__band--warning"
        />
        <line
          x1="0"
          x2={width}
          y1={y(loudLevel)}
          y2={y(loudLevel)}
          className="noise-chart__threshold noise-chart__threshold--loud"
        />
        <line
          x1="0"
          x2={width}
          y1={y(warningLevel)}
          y2={y(warningLevel)}
          className="noise-chart__threshold"
        />
        {segments.map((segment, index) => (
          <path
            key={`peak-${index}`}
            d={line(segment, (point) => point.peakLevel)}
            className="noise-chart__peak"
          />
        ))}
        {segments.map((segment, index) => (
          <path
            key={`avg-${index}`}
            d={line(segment, (point) => point.averageLevel)}
            className="noise-chart__average"
          />
        ))}
      </svg>
      <div className="noise-chart__axis" aria-hidden="true">
        {labels.map((tick) => (
          <span key={tick.x} style={{ left: `${(tick.x / width) * 100}%` }}>
            {tick.label}
          </span>
        ))}
      </div>
      <figcaption className="noise-chart__legend">
        <span className="noise-chart__key noise-chart__key--average">
          Average
        </span>
        <span className="noise-chart__key noise-chart__key--peak">Peak</span>
        <span className="noise-chart__key noise-chart__key--warning">
          Warning {warningLevel}
        </span>
        <span className="noise-chart__key noise-chart__key--loud">
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
    <ol className="noise-daily">
      {days.map((day) => (
        <li key={day.date}>
          <span className="noise-daily__value">{label(day)}</span>
          <span
            className="noise-daily__bar"
            style={{ height: `${Math.max(2, (value(day) / highest) * 100)}%` }}
          />
          <span className="noise-daily__date">
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
      <div className="noise-metrics">
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
      <dl className="noise-secondary">
        <div>
          <dt>Time in normal range</dt>
          <dd>
            {formatDuration(summary.normalMs)}{" "}
            <small>{formatShare(summary.normalMs, summary.monitoredMs)}</small>
          </dd>
        </div>
        <div>
          <dt>Time in warning range</dt>
          <dd>
            {formatDuration(summary.warningMs)}{" "}
            <small>{formatShare(summary.warningMs, summary.monitoredMs)}</small>
          </dd>
        </div>
        <div>
          <dt>Longest continuous too loud</dt>
          <dd>{formatDuration(summary.longestLoudMs)}</dd>
        </div>
        <div>
          <dt>Loudest 15 minutes</dt>
          <dd>
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
        <div>
          <dt>Monitored time</dt>
          <dd>{formatDuration(summary.monitoredMs)}</dd>
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
    <main className="page plugins-page">
      <PageHeader
        eyebrow={
          <Link className="back-link" to="/plugins/noise-meter">
            <ArrowLeft size={15} /> Noise Meter
          </Link>
        }
        title={instance.data?.name ?? "Noise Meter"}
        description="Measurements the player recorded locally and delivered on its ordinary heartbeat."
      />
      <NoiseHistoryTabs id={id} />
      <Notice>
        Noise history stores relative noise-level measurements for graphs and
        reports. Tilecast never records or stores microphone audio. Levels are
        relative to each player&rsquo;s own microphone and are not calibrated
        decibel measurements.
      </Notice>

      <div className="noise-controls">
        <ToggleGroup
          label="Date range"
          value={range}
          items={ranges}
          onValueChange={setRange}
        />
        {multipleScreens && (
          <Field
            label="Screen"
            description="Levels are relative to each player's own microphone, so screens are compared with care."
          >
            <Select
              name="screenId"
              value={screenId}
              onChange={(event) => setScreenId(event.target.value)}
            >
              <option value="">All screens (combined)</option>
              {available.map((screen) => (
                <option key={screen.screenId} value={screen.screenId}>
                  {screen.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Export">
          <Select
            name="granularity"
            value={granularity}
            onChange={(event) => setGranularity(event.target.value)}
          >
            <option value="raw">10-second records</option>
            <option value="minute">1-minute summaries</option>
            <option value="daily">Daily summaries</option>
          </Select>
        </Field>
        <a
          className="button button--secondary"
          href={exportHref}
          title="Export the selected range and screen"
        >
          <Download size={15} /> Export CSV
        </a>
      </div>

      {summary.isError && (
        <Notice variant="danger">History could not be loaded.</Notice>
      )}

      {!multipleScreens && available.length === 1 && (
        <p className="noise-scope">
          Showing <strong>{available[0]!.name}</strong>.
        </p>
      )}
      {multipleScreens && !screenId && (
        <p className="noise-scope">
          Combining {available.length} screens. Each player&rsquo;s levels come
          from its own microphone, so a combined view describes the group rather
          than comparing rooms.
        </p>
      )}

      {empty ? (
        <EmptyState
          title="No measurements in this range"
          message="History appears once a targeted Linux player has been measuring and has delivered a heartbeat."
        />
      ) : (
        <>
          {summary.data && <SummaryTiles summary={summary.data.summary} />}
          <Panel className="plugin-form__section">
            <SectionHeader
              title="Noise level over time"
              description="Average and peak, against this meter's own thresholds. Periods with no monitoring are left blank."
            />
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
              <p className="noise-scope">No measurements to draw yet.</p>
            )}
          </Panel>
          {(range === "7d" || range === "30d") && (
            <Panel className="plugin-form__section">
              <SectionHeader
                title="Daily comparison"
                description="Days without monitoring are omitted rather than shown as silent."
                actions={
                  <ToggleGroup
                    label="Daily measure"
                    value={measure}
                    items={dailyMeasures}
                    onValueChange={setMeasure}
                  />
                }
              />
              {(daily.data?.days.length ?? 0) > 0 ? (
                <DailyComparison days={daily.data!.days} measure={measure} />
              ) : (
                <p className="noise-scope">No days with measurements yet.</p>
              )}
            </Panel>
          )}
        </>
      )}
    </main>
  );
}
