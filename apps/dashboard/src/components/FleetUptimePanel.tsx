import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { translateKnown } from "../i18n";
import { Area, AreaChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  CircleAlert,
  CircleCheck,
  CircleHelp,
  CircleX,
  TrendingDown,
  TrendingUp,
  TriangleAlert,
} from "lucide-react";
import { api } from "../api/client";
import type {
  UptimeBucket,
  UptimeReport,
  UptimeScreen,
  UptimeState,
  UptimeWindow,
} from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "./ui/empty";
import {
  ChartContainer,
  ChartLegend,
  ChartLegendContent,
  ChartTooltip,
  ChartTooltipContent,
  type ChartConfig,
} from "./ui/chart";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "./ui/card";
import { LoadReveal } from "./overview/LoadReveal";
import { Skeleton } from "./ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./studio/StudioCollapsible";

// Window and state structures hold translation keys, never rendered text.
// Labels are resolved with t() at render so the panel follows language
// changes.
const windows: {
  key: UptimeWindow;
  labelKey: "uptime.windows.24h" | "uptime.windows.7d" | "uptime.windows.30d";
}[] = [
  { key: "24h", labelKey: "uptime.windows.24h" },
  { key: "7d", labelKey: "uptime.windows.7d" },
  { key: "30d", labelKey: "uptime.windows.30d" },
];

const chartColors = {
  up: "var(--color-emerald-600)",
  impaired: "var(--color-amber-500)",
  down: "var(--color-red-600)",
  unknown: "var(--color-muted)",
} as const;

const stateLabelKeys: Record<
  UptimeState,
  | "uptime.states.up"
  | "uptime.states.impaired"
  | "uptime.states.down"
  | "uptime.states.unknown"
> = {
  up: "uptime.states.up",
  impaired: "uptime.states.impaired",
  down: "uptime.states.down",
  unknown: "uptime.states.unknown",
};

const stateClass: Record<UptimeState, string> = {
  up: "bg-emerald-600",
  impaired: "bg-amber-500",
  down: "bg-red-600",
  unknown: "bg-muted-foreground/30",
};

export function FleetUptimePanel({
  description,
}: {
  description?: string;
} = {}) {
  const { t } = useTranslation("activity");
  const [activeWindow, setActiveWindow] = useState<UptimeWindow>("24h");
  const query = useQuery({
    queryKey: ["fleet-uptime", activeWindow],
    queryFn: () => api.fleetUptime(activeWindow),
    // Keep the current chart mounted while an uncached window is fetched so
    // Recharts can animate directly to the next dataset instead of flashing
    // through the initial-loading skeleton on first selection.
    placeholderData: (previousData) => previousData,
    refetchInterval: 60_000,
  });
  const report = query.data;

  return (
    <Card size="sm" role="region" aria-labelledby="uptime-heading">
      <CardHeader className="gap-0">
        <CardTitle
          id="uptime-heading"
          role="heading"
          aria-level={2}
          className="flex min-h-8 items-center max-sm:min-h-10"
        >
          {t("uptime.title")}
        </CardTitle>
        <CardDescription>
          {description ?? t("uptime.defaultDescription")}
        </CardDescription>
        <CardAction>
          <ToggleGroup
            multiple={false}
            value={[activeWindow]}
            onValueChange={(value) => {
              const selected = value[0];
              if (
                selected === "24h" ||
                selected === "7d" ||
                selected === "30d"
              ) {
                setActiveWindow(selected);
              }
            }}
            aria-label={t("uptime.windowLabel")}
            variant="outline"
            size="sm"
            spacing={0}
          >
            {windows.map((option) => (
              <ToggleGroupItem
                key={option.key}
                value={option.key}
                aria-label={t(option.labelKey)}
                className="min-h-8 min-w-11"
              >
                {option.key}
              </ToggleGroupItem>
            ))}
          </ToggleGroup>
        </CardAction>
      </CardHeader>
      <CardContent>
        <LoadReveal
          loading={query.isLoading}
          skeleton={
            <div aria-label={t("uptime.loading")}>
              <div className="grid gap-3">
                <div className="grid gap-0.5">
                  <Skeleton className="h-8 w-24" />
                  <Skeleton className="h-5 w-40" />
                  <Skeleton className="h-4 w-32" />
                </div>
                <div className="grid grid-cols-3 gap-x-4 border-t pt-3">
                  {[0, 1, 2].map((cell) => (
                    <div key={cell} className="grid gap-0.5">
                      <Skeleton className="h-4 w-12" />
                      <Skeleton className="h-5 w-16" />
                    </div>
                  ))}
                </div>
              </div>
              <Skeleton className="h-36 w-full rounded-xl sm:h-44" />
              <div className="border-t border-border pt-3">
                <Skeleton className="h-5 w-48" />
              </div>
            </div>
          }
        >
          {query.isError ? (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{t("uptime.loadFailed")}</AlertTitle>
              <AlertDescription>{t("shared.refreshHint")}</AlertDescription>
            </Alert>
          ) : !report || report.screensTracked === 0 ? (
            <Empty className="border-0 py-5">
              <EmptyHeader>
                <EmptyDescription>
                  <Trans
                    i18nKey="uptime.emptyState"
                    ns="activity"
                    components={{
                      pairLink: (
                        <Link
                          className="underline underline-offset-4"
                          to="/screens/pair"
                        />
                      ),
                    }}
                  />
                </EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : report.uptimePercent === null ? (
            <Empty className="border-0 py-5">
              <EmptyHeader>
                <EmptyTitle>{t("uptime.noStateTitle")}</EmptyTitle>
                <EmptyDescription>{t("uptime.noStateHint")}</EmptyDescription>
              </EmptyHeader>
            </Empty>
          ) : (
            <UptimeBody report={report} />
          )}
        </LoadReveal>
      </CardContent>
    </Card>
  );
}

function UptimeBody({ report }: { report: UptimeReport }) {
  const { t } = useTranslation("activity");
  const [screensOpen, setScreensOpen] = useState(false);
  const chartConfig = {
    up: {
      label: t("uptime.states.up"),
      color: chartColors.up,
      icon: CircleCheck,
    },
    impaired: {
      label: t("uptime.states.impaired"),
      color: chartColors.impaired,
      icon: TriangleAlert,
    },
    down: {
      label: t("uptime.states.down"),
      color: chartColors.down,
      icon: CircleX,
    },
    unknown: {
      label: t("uptime.states.unknown"),
      color: chartColors.unknown,
      icon: CircleHelp,
    },
  } satisfies ChartConfig;
  const chartData = report.buckets.map((bucket) => ({
    ...bucket,
    tick: Date.parse(bucket.start),
  }));
  const lastBucket = chartData.at(-1);
  if (lastBucket) {
    // Area charts plot points rather than bucket widths. Repeat the newest
    // bucket at the report boundary so the final stepped segment spans the
    // interval it represents instead of ending at its start timestamp.
    chartData.push({
      ...lastBucket,
      tick: Date.parse(report.range.to),
    });
  }
  const hasChartData = chartData.length > 0;
  return (
    <>
      <div className="grid gap-3">
        <div className="grid gap-0.5">
          <div className="text-2xl font-semibold tabular-nums tracking-tight">
            {formatPercent(report.uptimePercent)}
          </div>
          <div className="text-sm text-muted-foreground">
            {t("uptime.upNow", { window: report.windowLabel })}
          </div>
          <UptimeTrend report={report} />
        </div>
        <dl className="grid grid-cols-3 gap-x-4 border-t pt-3 text-sm">
          <Metric
            label={t("uptime.downLabel")}
            value={formatSeconds(report.downSeconds)}
          />
          <Metric
            label={t("uptime.impairedLabel")}
            value={formatSeconds(report.impairedSeconds)}
          />
          <Metric
            label={t("uptime.downtimeLabel")}
            value={t("uptime.downtimeValue", {
              down: report.screensWithDowntime,
              tracked: report.screensTracked,
            })}
          />
        </dl>
      </div>

      {hasChartData ? (
        <>
          <ChartContainer
            config={chartConfig}
            className="aspect-auto h-36 w-full sm:h-44"
            initialDimension={{ width: 720, height: 192 }}
            role="img"
            aria-label={chartDescription(report, t)}
          >
            <AreaChart data={chartData} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="tick"
                type="number"
                scale="time"
                domain={["dataMin", "dataMax"]}
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                interval="preserveStartEnd"
                tickFormatter={(value: number) =>
                  formatAxis(value, report.window)
                }
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
                    formatter={(value, name) => {
                      const itemConfig =
                        chartConfig[String(name) as keyof typeof chartConfig];
                      const Icon = itemConfig?.icon;
                      return (
                        <>
                          {Icon ? <Icon aria-hidden="true" /> : null}
                          <span className="flex flex-1 items-center justify-between gap-4">
                            <span>{itemConfig?.label ?? String(name)}</span>
                            <span className="font-mono font-medium tabular-nums">
                              {formatTooltipPercent(value)}
                            </span>
                          </span>
                        </>
                      );
                    }}
                  />
                }
              />
              <Area
                dataKey="downPercent"
                name="down"
                type="stepAfter"
                stackId="health"
                fill="var(--color-down)"
                fillOpacity={0.55}
                stroke="var(--color-down)"
              />
              <Area
                dataKey="impairedPercent"
                name="impaired"
                type="stepAfter"
                stackId="health"
                fill="var(--color-impaired)"
                fillOpacity={0.45}
                stroke="var(--color-impaired)"
              />
              <Area
                dataKey="unknownPercent"
                name="unknown"
                type="stepAfter"
                stackId="health"
                fill="var(--color-unknown)"
                fillOpacity={0.3}
                stroke="var(--color-unknown)"
              />
              <Area
                dataKey="upPercent"
                name="up"
                type="stepAfter"
                stackId="health"
                fill="var(--color-up)"
                fillOpacity={0.28}
                stroke="var(--color-up)"
              />
              <ChartLegend content={<ChartLegendContent nameKey="name" />} />
            </AreaChart>
          </ChartContainer>
        </>
      ) : (
        <p className="text-sm text-muted-foreground">{t("uptime.noChart")}</p>
      )}

      <Collapsible
        open={screensOpen}
        onOpenChange={setScreensOpen}
        className="border-t border-border pt-3"
      >
        <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          <span>
            {t("uptime.perScreenTitle")} · {screenBreakdown(report, t)}
          </span>
          <CollapsibleChevron size={16} />
        </CollapsibleTrigger>
        <CollapsibleContent className="mt-3 divide-y divide-border">
          {report.screens.map((screen) => (
            <ScreenRow
              key={screen.screenId}
              screen={screen}
              bucketSeconds={report.bucketSeconds}
              buckets={report.buckets}
            />
          ))}
        </CollapsibleContent>
        {report.screens.length < report.screensTracked && (
          <p className="mt-2 text-xs text-muted-foreground">
            {t("uptime.showingLowest", {
              shown: report.screens.length,
              count: report.screensTracked,
            })}
          </p>
        )}
      </Collapsible>
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="truncate text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 font-medium tabular-nums">{value}</dd>
    </div>
  );
}

function screenBreakdown(report: UptimeReport, t: TFunction<"activity">) {
  const parts = [t("uptime.screens", { count: report.screensTracked })];
  parts.push(
    report.screensWithDowntime > 0
      ? t("uptime.withDowntime", { count: report.screensWithDowntime })
      : t("uptime.noDowntime"),
  );
  if (report.screensUnmeasured > 0) {
    parts.push(t("uptime.unmeasured", { count: report.screensUnmeasured }));
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
  const { t } = useTranslation("activity");
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_4rem] items-center gap-x-3 gap-y-1 py-2 text-sm sm:grid-cols-[minmax(11rem,1fr)_minmax(8rem,2fr)_4rem_minmax(8rem,auto)]">
      <Link
        className="truncate font-medium hover:underline"
        to={`/screens/${screen.screenId}`}
      >
        {screen.screenName}
      </Link>
      <div
        className="col-span-2 row-start-2 flex h-3 min-w-0 gap-px overflow-hidden rounded-sm sm:col-span-1 sm:col-start-2 sm:row-start-1"
        role="img"
        aria-label={
          screen.downSeconds > 0
            ? t("uptime.rowAriaDown", {
                name: screen.screenName,
                percent: formatPercent(screen.uptimePercent),
                down: formatSeconds(screen.downSeconds),
              })
            : t("uptime.rowAria", {
                name: screen.screenName,
                percent: formatPercent(screen.uptimePercent),
              })
        }
      >
        {screen.buckets.map((state, index) => (
          <span
            key={buckets[index]?.start ?? index}
            className={`min-w-0 flex-1 ${stateClass[state]}`}
            title={t("uptime.rowTitle", {
              state: t(stateLabelKeys[state]),
              range: formatRange(buckets[index]?.start, bucketSeconds),
            })}
          />
        ))}
      </div>
      <span className="text-right font-medium tabular-nums">
        {formatPercent(screen.uptimePercent)}
      </span>
      <span className="col-span-2 row-start-3 text-xs text-muted-foreground sm:col-span-1 sm:col-start-4 sm:row-start-1">
        {screen.downSeconds > 0
          ? t("uptime.rowDown", {
              value: formatSeconds(screen.downSeconds),
            })
          : screen.impairedSeconds > 0
            ? t("uptime.rowImpaired", {
                value: formatSeconds(screen.impairedSeconds),
              })
            : screen.uptimePercent === null
              ? t("uptime.notReporting")
              : t("uptime.noInterruptions")}
      </span>
    </div>
  );
}

function UptimeTrend({ report }: { report: UptimeReport }) {
  const { t } = useTranslation("activity");
  if (report.uptimePercent === null || report.previousUptimePercent === null) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("uptime.trendNone")}
      </span>
    );
  }
  const delta = report.uptimePercent - report.previousUptimePercent;
  if (Math.abs(delta) < 0.05) {
    return (
      <span className="text-xs text-muted-foreground">
        {t("uptime.trendFlat")}
      </span>
    );
  }
  const Icon = delta > 0 ? TrendingUp : TrendingDown;
  return (
    <span
      className={`inline-flex items-center gap-1 text-xs ${
        delta > 0
          ? "text-emerald-700 dark:text-emerald-400"
          : "text-red-700 dark:text-red-400"
      }`}
    >
      <Icon className="size-3.5" aria-hidden="true" />
      {t("uptime.trendDelta", {
        delta: `${delta > 0 ? "+" : "−"}${Math.abs(delta).toFixed(1)}`,
      })}
    </span>
  );
}

function chartDescription(report: UptimeReport, t: TFunction<"activity">) {
  const bucketsWithDowntime = report.buckets.filter(
    (bucket) => bucket.downPercent > 0,
  ).length;
  return t("uptime.chartDescription", {
    window: report.windowLabel,
    percent: formatPercent(report.uptimePercent),
    screens: t("uptime.chartScreens", { count: report.screensTracked }),
    down: formatSeconds(report.downSeconds),
    downtimeBuckets: bucketsWithDowntime,
    totalBuckets: report.buckets.length,
  });
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
  return `${from.toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
  })}–${to.toLocaleTimeString([], { hour: "numeric" })}`;
}

function formatAxis(start: string | number, window: UptimeWindow) {
  const value = new Date(start);
  return window === "24h"
    ? value.toLocaleTimeString([], { hour: "numeric" })
    : window === "7d"
      ? value.toLocaleDateString([], { weekday: "short" })
      : value.toLocaleDateString([], { month: "short", day: "numeric" });
}

function formatPercent(value: number | null) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  return value === 100 ? "100%" : `${value.toFixed(1)}%`;
}

function formatTooltipPercent(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? `${numeric.toFixed(1)}%` : "—";
}

function formatSeconds(seconds: number) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  if (seconds <= 0) return translateKnown("activity:shared.none", "None");
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m`;
  return `${Math.round(seconds)}s`;
}
