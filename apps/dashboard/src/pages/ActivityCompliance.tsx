import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  MetricTile,
  Select,
  type ResolvedTimeRange,
} from "../components/legacy-ui";
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
      className="activity-panel activity-compliance"
      aria-label="Playback compliance"
    >
      <header>
        <div>
          <h3>Expected versus actual playback</h3>
          <p>
            Measured over {range.label} against what was expected at the time,
            not against the current configuration. Takeover and intentionally
            stopped time is excluded from the percentage and shown separately.
          </p>
        </div>
        <label className="activity-group-by">
          <span>Break down by</span>
          <Select
            value={dimension}
            onChange={(event) => setDimension(event.target.value)}
          >
            {dimensions.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </Select>
        </label>
      </header>

      <div className="activity-compliance__tiles">
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

      <div className="activity-compliance__excluded">
        <h4>Excluded from the percentage</h4>
        <ul>
          <li>
            <span>Takeover overrode normal playback</span>
            <span>{formatMinutes(data.takeoverOverriddenMs)}</span>
          </li>
          <li>
            <span>Playback intentionally stopped</span>
            <span>{formatMinutes(data.cancelledMs)}</span>
          </li>
          <li>
            <span>Too short to measure</span>
            <span>{formatMinutes(data.notMeasurableMs)}</span>
          </li>
        </ul>
      </div>

      {breakdown.length === 0 ? (
        <EmptyState message="No expected playback was recorded in this range." />
      ) : (
        <div className="activity-compliance__table">
          <div className="activity-compliance__row activity-compliance__row--head">
            <span>{humanize(data.dimension)}</span>
            <span>Compliance</span>
            <span>Expected</span>
            <span>Confirmed</span>
            <span>Missed</span>
            <span>Main reason</span>
          </div>
          {breakdown.map((item) => (
            <div
              key={item.key || item.label}
              className="activity-compliance__row"
            >
              {/* Labels come from the server already readable — a screen or
                  location name must not be re-cased into "Lobby North". */}
              <span>{item.label}</span>
              <span>{formatPercent(item.compliancePercent)}</span>
              <span>{formatDuration(item.measurableExpectedMs)}</span>
              <span>{formatDuration(item.confirmedMs)}</span>
              <span>{formatDuration(item.missedMs)}</span>
              <span>
                {/* Named only when time actually went missing. */}
                {item.missedMs > 0 && item.topFailureReason
                  ? humanize(item.topFailureReason)
                  : "—"}
              </span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
