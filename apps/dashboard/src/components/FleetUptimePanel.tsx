import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import { CircleAlert, TrendingDown, TrendingUp } from "lucide-react";
import { api } from "../api/client";
import type {
  UptimeBucket,
  UptimeReport,
  UptimeScreen,
  UptimeState,
  UptimeWindow,
} from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import {
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./ui/chart";
import { Skeleton } from "./ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";

const windows: { key: UptimeWindow; label: string }[] = [
  { key: "24h", label: "24 hours" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
];

const chartConfig = {
  up: { label: "Up", color: "var(--color-emerald-600)" },
  impaired: { label: "Impaired", color: "var(--color-amber-500)" },
  down: { label: "Down", color: "var(--color-red-600)" },
  unknown: { label: "No data", color: "var(--color-muted)" },
} satisfies ChartConfig;

const stateLabels: Record<UptimeState, string> = {
  up: "Up",
  impaired: "Impaired",
  down: "Down",
  unknown: "No data",
};

const stateClass: Record<UptimeState, string> = {
  up: "bg-emerald-600",
  impaired: "bg-amber-500",
  down: "bg-red-600",
  unknown: "bg-muted-foreground/30",
};

export function FleetUptimePanel({
  description = "Measured player time spent connected and playing.",
}: {
  description?: string;
} = {}) {
  const [activeWindow, setActiveWindow] = useState<UptimeWindow>("24h");
  const query = useQuery({
    queryKey: ["fleet-uptime", activeWindow],
    queryFn: () => api.fleetUptime(activeWindow),
    refetchInterval: 60_000,
  });
  const report = query.data;

  return (
    <section
      className="space-y-4 border-t border-border pt-5"
      aria-labelledby="uptime-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="uptime-heading" className="text-base font-semibold">
            Fleet health
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">{description}</p>
        </div>
        <ToggleGroup
          multiple={false}
          value={[activeWindow]}
          onValueChange={(value) => {
            const selected = value[0];
            if (selected === "24h" || selected === "7d" || selected === "30d") {
              setActiveWindow(selected);
            }
          }}
          aria-label="Uptime window"
          variant="outline"
          size="sm"
          spacing={0}
        >
          {windows.map((option) => (
            <ToggleGroupItem
              key={option.key}
              value={option.key}
              aria-label={option.label}
            >
              {option.key}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {query.isLoading ? (
        <div className="space-y-3" aria-label="Loading fleet health">
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      ) : query.isError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Uptime could not be loaded</AlertTitle>
          <AlertDescription>
            Refresh the page or check the Tilecast server connection.
          </AlertDescription>
        </Alert>
      ) : !report || report.screensTracked === 0 ? (
        <div className="py-5 text-sm text-muted-foreground">
          No screens to measure.{" "}
          <Link className="underline underline-offset-4" to="/screens/pair">
            Pair a screen
          </Link>{" "}
          to start recording state.
        </div>
      ) : report.uptimePercent === null ? (
        <div className="py-5">
          <p className="font-medium">No player state recorded yet</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Uptime appears once paired players report connection and playback
            state for this window.
          </p>
        </div>
      ) : (
        <UptimeBody report={report} />
      )}
    </section>
  );
}

function UptimeBody({ report }: { report: UptimeReport }) {
  const chartData = report.buckets.map((bucket) => ({
    ...bucket,
    tick: bucket.start,
  }));
  return (
    <>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-3xl font-semibold tabular-nums tracking-tight">
            {formatPercent(report.uptimePercent)}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            Up · {report.windowLabel}
          </div>
        </div>
        <UptimeTrend report={report} />
        <dl className="ml-0 flex min-w-0 basis-full flex-wrap gap-x-5 gap-y-2 text-sm sm:ml-auto sm:w-auto sm:basis-auto">
          <Metric label="Down" value={formatSeconds(report.downSeconds)} />
          <Metric
            label="Impaired"
            value={formatSeconds(report.impairedSeconds)}
          />
          <Metric
            label="Screens with downtime"
            value={`${report.screensWithDowntime} of ${report.screensTracked}`}
          />
        </dl>
      </div>

      <ChartContainer
        config={chartConfig}
        className="h-48 w-full aspect-auto"
        initialDimension={{ width: 720, height: 192 }}
        role="img"
        aria-label={chartDescription(report)}
      >
        <BarChart data={chartData} accessibilityLayer>
          <CartesianGrid vertical={false} />
          <XAxis
            dataKey="tick"
            tickLine={false}
            axisLine={false}
            tickMargin={8}
            interval="preserveStartEnd"
            tickFormatter={(value: string) => formatAxis(value, report.window)}
          />
          <YAxis
            domain={[0, 100]}
            tickLine={false}
            axisLine={false}
            width={34}
            tickFormatter={(value: number) => `${value}%`}
          />
          <ChartTooltip
            cursor={false}
            content={
              <ChartTooltipContent
                labelFormatter={(_label, payload) => {
                  const start = readString(
                    payload?.[0]?.payload as unknown,
                    "start",
                  );
                  return typeof start === "string"
                    ? formatRange(start, report.bucketSeconds)
                    : report.windowLabel;
                }}
                formatter={(value, name) => (
                  <span className="flex items-center justify-between gap-4">
                    <span>
                      {chartConfig[String(name) as keyof typeof chartConfig]
                        ?.label ?? String(name)}
                    </span>
                    <span className="font-mono font-medium tabular-nums">
                      {Number(value).toFixed(1)}%
                    </span>
                  </span>
                )}
              />
            }
          />
          <Bar dataKey="upPercent" stackId="health" fill="var(--color-up)" />
          <Bar
            dataKey="impairedPercent"
            stackId="health"
            fill="var(--color-impaired)"
          />
          <Bar
            dataKey="downPercent"
            stackId="health"
            fill="var(--color-down)"
          />
          <Bar
            dataKey="unknownPercent"
            stackId="health"
            fill="var(--color-unknown)"
          />
        </BarChart>
      </ChartContainer>

      <div
        className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
        aria-label="Chart legend"
      >
        {(Object.keys(stateLabels) as UptimeState[]).map((state) => (
          <span key={state} className="inline-flex items-center gap-1.5">
            <span
              className={`size-2 rounded-full ${stateClass[state]}`}
              aria-hidden="true"
            />
            {stateLabels[state]}
          </span>
        ))}
      </div>

      <details className="border-t border-border pt-3">
        <summary className="cursor-pointer text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          Per screen · {screenBreakdown(report)}
        </summary>
        <div className="mt-3 divide-y divide-border">
          {report.screens.map((screen) => (
            <ScreenRow
              key={screen.screenId}
              screen={screen}
              bucketSeconds={report.bucketSeconds}
              buckets={report.buckets}
            />
          ))}
        </div>
        {report.screens.length < report.screensTracked && (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the lowest {report.screens.length} of{" "}
            {report.screensTracked} screens.
          </p>
        )}
      </details>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function screenBreakdown(report: UptimeReport) {
  const parts = [`${report.screensTracked} screens`];
  parts.push(
    report.screensWithDowntime > 0
      ? `${report.screensWithDowntime} with downtime`
      : "none with downtime",
  );
  if (report.screensUnmeasured > 0) {
    parts.push(`${report.screensUnmeasured} not measured yet`);
  }
  return parts.join(" · ");
}

function ScreenRow({
  screen,
  buckets,
  bucketSeconds,
}: {
  screen: UptimeScreen;
  buckets: UptimeBucket[];
  bucketSeconds: number;
}) {
  return (
    <div className="grid grid-cols-[minmax(9rem,1fr)_minmax(7rem,2fr)_4rem] items-center gap-x-3 gap-y-1 py-2 text-sm sm:grid-cols-[minmax(11rem,1fr)_minmax(8rem,2fr)_4rem_minmax(8rem,auto)]">
      <Link
        className="truncate font-medium hover:underline"
        to={`/screens/${screen.screenId}`}
      >
        {screen.screenName}
      </Link>
      <div
        className="flex h-3 min-w-0 gap-px overflow-hidden rounded-sm"
        role="img"
        aria-label={`${screen.screenName}: ${formatPercent(screen.uptimePercent)} up${screen.downSeconds > 0 ? `, ${formatSeconds(screen.downSeconds)} down` : ""}`}
      >
        {screen.buckets.map((state, index) => (
          <span
            key={buckets[index]?.start ?? index}
            className={`min-w-0 flex-1 ${stateClass[state]}`}
            title={`${stateLabels[state]} · ${formatRange(buckets[index]?.start, bucketSeconds)}`}
          />
        ))}
      </div>
      <span className="text-right font-medium tabular-nums">
        {formatPercent(screen.uptimePercent)}
      </span>
      <span className="col-span-3 text-xs text-muted-foreground sm:col-span-1">
        {screen.downSeconds > 0
          ? `${formatSeconds(screen.downSeconds)} down`
          : screen.impairedSeconds > 0
            ? `${formatSeconds(screen.impairedSeconds)} impaired`
            : screen.uptimePercent === null
              ? "Not reporting yet"
              : "No interruptions"}
      </span>
    </div>
  );
}

function UptimeTrend({ report }: { report: UptimeReport }) {
  if (report.uptimePercent === null || report.previousUptimePercent === null) {
    return (
      <span className="text-xs text-muted-foreground">
        No comparable earlier window
      </span>
    );
  }
  const delta = report.uptimePercent - report.previousUptimePercent;
  if (Math.abs(delta) < 0.05) {
    return (
      <span className="text-xs text-muted-foreground">
        Unchanged from the previous window
      </span>
    );
  }
  const Icon = delta > 0 ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${delta > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {`${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)} points vs previous window`}
    </span>
  );
}

function chartDescription(report: UptimeReport) {
  const bucketsWithDowntime = report.buckets.filter(
    (bucket) => bucket.downPercent > 0,
  ).length;
  return `${report.windowLabel}: ${formatPercent(report.uptimePercent)} up across ${report.screensTracked} screens, ${formatSeconds(report.downSeconds)} down, with downtime in ${bucketsWithDowntime} of ${report.buckets.length} intervals.`;
}

function readString(value: unknown, key: string): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : undefined;
}

function formatRange(start: string | undefined, bucketSeconds: number) {
  if (!start) return "";
  const from = new Date(start);
  const to = new Date(from.getTime() + bucketSeconds * 1000);
  return `${from.toLocaleString([], { month: "short", day: "numeric", hour: "numeric" })}–${to.toLocaleTimeString([], { hour: "numeric" })}`;
}

function formatAxis(start: string, window: UptimeWindow) {
  const value = new Date(start);
  return window === "24h"
    ? value.toLocaleTimeString([], { hour: "numeric" })
    : window === "7d"
      ? value.toLocaleDateString([], { weekday: "short" })
      : value.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatPercent(value: number | null) {
  if (value === null) return "—";
  return value === 100 ? "100%" : `${value.toFixed(1)}%`;
}

function formatSeconds(seconds: number) {
  if (seconds <= 0) return "None";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
}
