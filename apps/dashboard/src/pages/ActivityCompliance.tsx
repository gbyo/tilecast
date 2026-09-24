import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { translateKnown } from "../i18n";
import { MetricTile } from "../components/MetricTile";
import type { ResolvedTimeRange } from "../components/TimeRangePicker";
import { Field, FieldLabel } from "../components/ui/field";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import {
  activityParams,
  activityRequest,
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

// Dimension structures hold translation keys, never rendered text. Labels are
// resolved with t() at render so the panel follows language changes.
const dimensions = [
  { value: "screen", labelKey: "compliance.dimensions.screen" },
  { value: "location", labelKey: "compliance.dimensions.location" },
  { value: "group", labelKey: "compliance.dimensions.group" },
  { value: "presentation", labelKey: "compliance.dimensions.presentation" },
  { value: "schedule", labelKey: "compliance.dimensions.schedule" },
  { value: "date", labelKey: "compliance.dimensions.date" },
  { value: "reason", labelKey: "compliance.dimensions.reason" },
] as const;

function formatPercent(value: number | null) {
  // Null means nothing measurable was expected. Showing 0% would say every
  // expected play was missed, when in fact none was expected.
  return value == null
    ? translateKnown("activity:shared.noData", "No data")
    : `${value.toFixed(1)}%`;
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
  const { t } = useTranslation("activity");
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

  const dimensionOptions = dimensions.map((item) => ({
    value: item.value,
    label: t(item.labelKey),
  }));

  return (
    <section
      className="grid gap-3 rounded-xl border border-border p-4"
      aria-label={t("compliance.label")}
    >
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 flex-1 gap-1">
          <h3 className="text-base font-semibold">{t("compliance.title")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("compliance.description", { range: range.label })}
          </p>
        </div>
        <Field className="gap-1">
          <FieldLabel htmlFor="playback-compliance-dimension">
            {t("compliance.breakdownBy")}
          </FieldLabel>
          <Select
            items={dimensionOptions}
            value={dimension}
            onValueChange={(next) => {
              if (next) setDimension(next);
            }}
          >
            <SelectTrigger
              id="playback-compliance-dimension"
              size="sm"
              className="w-40"
              aria-label={t("compliance.breakdownBy")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {dimensionOptions.map((item) => (
                <SelectItem key={item.value} value={item.value}>
                  {item.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>
      </header>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
        <MetricTile
          label={t("compliance.tiles.compliance")}
          value={formatPercent(data.compliancePercent)}
          hint={t("compliance.tiles.complianceHint")}
        />
        <MetricTile
          label={t("compliance.tiles.expected")}
          value={formatMinutes(data.measurableExpectedMs)}
          hint={t("compliance.tiles.windows", {
            count: data.windows,
            display: data.windows.toLocaleString(),
          })}
        />
        <MetricTile
          label={t("compliance.tiles.confirmed")}
          value={formatMinutes(data.confirmedMs)}
          hint={t("compliance.tiles.confirmedHint")}
        />
        <MetricTile
          label={t("compliance.tiles.missed")}
          value={formatMinutes(data.missedMs)}
          hint={t("compliance.tiles.missedHint")}
        />
        <MetricTile
          label={t("compliance.tiles.lateStarts")}
          value={data.lateStarts}
          hint={t("compliance.tiles.endedEarly", {
            count: data.earlyEndings,
            display: data.earlyEndings.toLocaleString(),
          })}
        />
        <MetricTile
          label={t("compliance.tiles.neverStarted")}
          value={data.neverStarted}
          hint={t("compliance.tiles.whileOffline", {
            count: data.offlineMisses,
            display: data.offlineMisses.toLocaleString(),
          })}
        />
      </div>

      <div className="grid gap-1.5">
        <h4 className="text-sm font-semibold">
          {t("compliance.excludedTitle")}
        </h4>
        <ul className="grid gap-1 text-sm">
          <li className="flex items-center justify-between gap-2">
            <span>{t("compliance.takeoverExcluded")}</span>
            <span className="tabular-nums">
              {formatMinutes(data.takeoverOverriddenMs)}
            </span>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span>{t("compliance.cancelledExcluded")}</span>
            <span className="tabular-nums">
              {formatMinutes(data.cancelledMs)}
            </span>
          </li>
          <li className="flex items-center justify-between gap-2">
            <span>{t("compliance.notMeasurable")}</span>
            <span className="tabular-nums">
              {formatMinutes(data.notMeasurableMs)}
            </span>
          </li>
        </ul>
      </div>

      {breakdown.length === 0 ? (
        <EmptyState message={t("compliance.empty")} />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table className="w-full min-w-[42rem] text-sm">
            <TableHeader>
              <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
                <TableHead className="px-3 py-2 font-medium">
                  {humanize(data.dimension)}
                </TableHead>
                <TableHead className="px-3 py-2 text-right font-medium">
                  {t("compliance.table.compliance")}
                </TableHead>
                <TableHead className="px-3 py-2 text-right font-medium">
                  {t("compliance.table.expected")}
                </TableHead>
                <TableHead className="px-3 py-2 text-right font-medium">
                  {t("compliance.table.confirmed")}
                </TableHead>
                <TableHead className="px-3 py-2 text-right font-medium">
                  {t("compliance.table.missed")}
                </TableHead>
                <TableHead className="px-3 py-2 text-right font-medium">
                  {t("compliance.table.mainReason")}
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {breakdown.map((item) => (
                <TableRow
                  key={item.key || item.label}
                  className="border-b border-border last:border-0"
                >
                  {/* Labels come from the server already readable — a screen or
                      location name must not be re-cased into "Lobby North". */}
                  <TableCell className="px-3 py-2">{item.label}</TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {formatPercent(item.compliancePercent)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {formatDuration(item.measurableExpectedMs)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {formatDuration(item.confirmedMs)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right tabular-nums">
                    {formatDuration(item.missedMs)}
                  </TableCell>
                  <TableCell className="px-3 py-2 text-right">
                    {/* Named only when time actually went missing. */}
                    {item.missedMs > 0 && item.topFailureReason
                      ? humanize(item.topFailureReason)
                      : "—"}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </section>
  );
}
