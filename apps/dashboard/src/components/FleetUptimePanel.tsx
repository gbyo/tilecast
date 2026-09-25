import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { translateKnown } from "../i18n";
import { Bar, BarChart, CartesianGrid, XAxis, YAxis } from "recharts";
import {
  ChevronDown,
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
import { Skeleton } from "./ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "./ui/toggle-group";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "./ui/collapsible";

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
            {t("uptime.title")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {description ?? t("uptime.defaultDescription")}
          </p>
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
            >
              {option.key}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      </div>

      {query.isLoading ? (
        <div className="space-y-3" aria-label={t("uptime.loading")}>
          <Skeleton className="h-8 w-32" />
          <Skeleton className="h-48 w-full rounded-xl" />
        </div>
      ) : query.isError ? (
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
    </section>
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
    tick: bucket.start,
  }));
  const hasChartData = chartData.length > 0;
  return (
    <>
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div>
          <div className="text-3xl font-semibold tabular-nums tracking-tight">
            {formatPercent(report.uptimePercent)}
          </div>
          <div className="mt-1 text-sm text-muted-foreground">
            {t("uptime.upNow", { window: report.windowLabel })}
          </div>
        </div>
        <UptimeTrend report={report} />
        <dl className="ml-0 flex min-w-0 basis-full flex-wrap gap-x-5 gap-y-2 text-sm sm:ml-auto sm:w-auto sm:basis-auto">
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
            className="h-48 w-full aspect-auto"
            initialDimension={{ width: 720, height: 192 }}
            role="img"
            aria-label={chartDescription(report, t)}
          >
            <BarChart data={chartData} accessibilityLayer>
              <CartesianGrid vertical={false} />
              <XAxis
                dataKey="tick"
                tickLine={false}
                axisLine={false}
                tickMargin={8}
                interval="preserveStartEnd"
                tickFormatter={(value: string) =>
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
                        chartConfig[
                          String(name) as keyof typeof chartConfig
                        ];
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
              <Bar
                dataKey="upPercent"
                name="up"
                stackId="health"
                fill="var(--color-up)"
              />
              <Bar
                dataKey="impairedPercent"
                name="impaired"
                stackId="health"
                fill="var(--color-impaired)"
              />
              <Bar
                dataKey="downPercent"
                name="down"
                stackId="health"
                fill="var(--color-down)"
              />
              <Bar
                dataKey="unknownPercent"
                name="unknown"
                stackId="health"
                fill="var(--color-unknown)"
              />
              <ChartLegend content={<ChartLegendContent nameKey="name" />} />
            </BarChart>
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
          <ChevronDown
            size={16}
            aria-hidden="true"
            className={screensOpen ? "rotate-180" : undefined}
          />
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
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
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
      <span className="col-span-3 text-xs text-muted-foreground sm:col-span-1">
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
      className={`inline-flex items-center gap-1 text-xs ${delta > 0 ? "text-emerald-700 dark:text-emerald-400" : "text-red-700 dark:text-red-400"}`}
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
