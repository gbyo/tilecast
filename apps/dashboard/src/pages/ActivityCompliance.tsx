import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { MetricTile } from "../components/MetricTile";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  activityParams,
  activityRequest,
  EmptyState,
  ErrorNotice,
  formatDuration,
  humanize,
  Loading,
} from "./ActivityShared";

type ComplianceBreakdown = {
  key: string;
  label: string;
  measurableExpectedMs: number;
  confirmedMs: number;
  missedMs: number;
  compliancePercent: number | null;
  windows: number;
  lateStarts: number;
  earlyEndings: number;
  neverStarted: number;
  offlineMisses: number;
  topFailureReason?: string;
};

type ComplianceReport = {
  measurableExpectedMs: number;
  confirmedMs: number;
  missedMs: number;
  compliancePercent: number | null;
  takeoverOverriddenMs: number;
  cancelledMs: number;
  notMeasurableMs: number;
  windows: number;
  lateStarts: number;
  earlyEndings: number;
  neverStarted: number;
  offlineMisses: number;
  failedWindows: number;
  partialWindows: number;
  breakdown: ComplianceBreakdown[];
  dimension: string;
};

const dimensions = [
  { value: "screen", label: "Screen" },
  { value: "location", label: "Location" },
  { value: "group", label: "Group" },
  { value: "presentation", label: "Presentation" },
  { value: "schedule", label: "Schedule" },
  { value: "date", label: "Date" },
  { value: "reason", label: "Failure reason" },
];

function formatPercent(value: number | null) {
  // Null means nothing measurable was expected. Showing 0% would say every
  // expected play was missed, when in fact none was expected.
  return value == null ? "No data" : `${value.toFixed(1)}%`;
}

const emptyReport: ComplianceReport = {
  measurableExpectedMs: 0,
  confirmedMs: 0,
  missedMs: 0,
  compliancePercent: null,
  takeoverOverriddenMs: 0,
  cancelledMs: 0,
  notMeasurableMs: 0,
  windows: 0,
  lateStarts: 0,
  earlyEndings: 0,
  neverStarted: 0,
  offlineMisses: 0,
  failedWindows: 0,
  partialWindows: 0,
  breakdown: [],
  dimension: "screen",
};

function formatMinutes(milliseconds: number) {
  return `${Math.round(milliseconds / 60_000).toLocaleString()} min`;
}

/**
 * Expected versus actual playback.
 *
 * Compliance is confirmed screen-time over *measurable* expected screen-time.
 * Time an operator deliberately stopped, and time a takeover took over, are
 * excluded from the denominator and reported separately — neither is playback
 * that went missing.
 */
export function CompliancePanel({ range }: { range: ResolvedTimeRange }) {
  const [dimension, setDimension] = useState("screen");
  const params = activityParams(range, { dimension });
  const query = useQuery({
    queryKey: ["activity", "compliance", params.toString()],
    queryFn: () => activityRequest<ComplianceReport>(`/compliance?${params}`),
  });

  if (query.isLoading) return <Loading />;
  if (query.error) return <ErrorNotice error={query.error} />;
  if (!query.data) return null;
  // An older server may not send every figure, and Go marshals empty slices as
  // null. Defaulting once here keeps each tile from having to guard.
  const data: ComplianceReport = {
    ...emptyReport,
    ...query.data,
    breakdown: query.data.breakdown ?? [],
  };
  const breakdown = data.breakdown;

  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-label="Playback compliance"
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <h3 className="text-base font-semibold">
            Expected versus actual playback
          </h3>
          <p className="text-sm text-muted-foreground">
            Measured over {range.label} against what was expected at the time,
            not against the current configuration. Takeover and intentionally
            stopped time is excluded from the percentage and shown separately.
          </p>
        </div>
        <label className="grid gap-1 text-xs font-medium">
          <span>Break down by</span>
          <Select
            items={dimensions}
            value={dimension}
            onValueChange={(next) => {
              if (next) setDimension(next);
            }}
          >
            <SelectTrigger
              size="sm"
              className="w-40"
              aria-label="Break down by"
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dimensions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      </header>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <MetricTile
          label="Playback compliance"
          value={formatPercent(data.compliancePercent)}
          hint="Confirmed over measurable expected time"
        />
        <MetricTile
          label="Expected screen-minutes"
          value={formatMinutes(data.measurableExpectedMs)}
          hint={`${data.windows.toLocaleString()} windows`}
        />
        <MetricTile
          label="Confirmed screen-minutes"
          value={formatMinutes(data.confirmedMs)}
          hint="Player-confirmed root playback"
        />
        <MetricTile
          label="Missed screen-minutes"
          value={formatMinutes(data.missedMs)}
          hint="Expected but not confirmed"
        />
        <MetricTile
          label="Late starts"
          value={data.lateStarts}
          hint={`${data.earlyEndings.toLocaleString()} ended early`}
        />
        <MetricTile
          label="Never started"
          value={data.neverStarted}
          hint={`${data.offlineMisses.toLocaleString()} while offline`}
        />
      </div>

      <div className="grid gap-1.5">
        <h4 className="text-sm font-semibold">Excluded from the percentage</h4>
        <ul className="grid gap-1 text-sm">
          <li className="flex items-center justify-between gap-2">
            <span>Takeover overrode normal playback</span>
            <span className="tabular-nums">
              {formatMinutes(data.takeoverOverriddenMs)}
            </span>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span>Playback intentionally stopped</span>
            <span className="tabular-nums">
              {formatMinutes(data.cancelledMs)}
            </span>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span>Too short to measure</span>
            <span className="tabular-nums">
              {formatMinutes(data.notMeasurableMs)}
            </span>
          </li>
        </ul>
      </div>

      {breakdown.length === 0 ? (
        <EmptyState message="No expected playback was recorded in this range." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[42rem] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th className="px-3 py-2 font-medium">
                  {humanize(data.dimension)}
                </th>
                <th className="px-3 py-2 text-right font-medium">Compliance</th>
                <th className="px-3 py-2 text-right font-medium">Expected</th>
                <th className="px-3 py-2 text-right font-medium">Confirmed</th>
                <th className="px-3 py-2 text-right font-medium">Missed</th>
                <th className="px-3 py-2 text-right font-medium">
                  Main reason
                </th>
              </tr>
            </thead>
            <tbody>
              {breakdown.map((item) => (
                <tr
                  key={item.key || item.label}
                  className="border-b border-border last:border-0"
                >
                  {/* Labels come from the server already readable — a screen or
                      location name must not be re-cased into "Lobby North". */}
                  <td className="px-3 py-2">{item.label}</td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatPercent(item.compliancePercent)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDuration(item.measurableExpectedMs)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDuration(item.confirmedMs)}
                  </td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {formatDuration(item.missedMs)}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {/* Named only when time actually went missing. */}
                    {item.missedMs > 0 && item.topFailureReason
                      ? humanize(item.topFailureReason)
                      : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
