import type { ComponentType } from "react";
import { Link } from "react-router";
import { HeaderLink } from "./HeaderLink";
import { useTranslation } from "react-i18next";
import { Play, TriangleAlert, Wifi } from "lucide-react";
import { buildActivityLink } from "../../pages/activityLinks";
import { Card } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import type { UptimeBucket } from "../../api/types";
import type { FleetSummary } from "./attention";
import { Sparkline } from "./Sparkline";

/**
 * Player-confirmed playback from the server's fleet health, or why there is
 * no figure. A missing figure is never shown as zero.
 */
export type ConfirmedPlaying =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; playing: number; measured: number };

/**
 * The fleet in one Card of three figures. Every figure has the same anatomy
 * (icon and label, value over its total, one short line), so they align
 * whatever they hold. The figures overlap: a screen can be online, playing,
 * and on the attention list at once. The headline stays for assistive
 * technology, where the figures alone would lack a summary. Each cell has a
 * soft color identity and a faint 24-hour trend drawn from real uptime data.
 */
export function FleetStatus({
  summary,
  attentionCount,
  attentionPending,
  confirmed,
  trend = [],
}: {
  summary: FleetSummary;
  attentionCount: number;
  /** Incident reasons are still loading, so the count may yet grow. */
  attentionPending: boolean;
  confirmed: ConfirmedPlaying;
  /** Hourly fleet uptime for the last 24 hours, for the cell sparklines. */
  trend?: UptimeBucket[];
}) {
  const { t } = useTranslation("activity");
  const { total, online } = summary;
  const series = trendSeries(trend);
  const headline =
    attentionCount > 0
      ? t("operations.fleet.needAttention", { count: attentionCount, total })
      : online === total
        ? t("operations.fleet.allOnline", { count: total })
        : t("operations.fleet.someOnline", { online, total });

  return (
    <Card
      size="sm"
      role="region"
      aria-labelledby="fleet-status-heading"
      aria-describedby="fleet-status-scope"
      data-testid="fleet-status"
      className="gap-0 py-0"
    >
      <h2 id="fleet-status-heading" className="sr-only">
        {headline}
      </h2>
      <p id="fleet-status-scope" className="sr-only">
        {t("operations.fleet.scopeNote")}
      </p>
      <div className="flex justify-end px-(--card-spacing) pt-2">
        <HeaderLink to="/screens" label={t("operations.allScreens")} />
      </div>
      <ul className="grid flex-1 grid-cols-3 grid-rows-[auto_auto_auto] divide-x divide-border">
        <StatusMetric
          icon={Wifi}
          identity="online"
          trend={series.connected}
          label={t("operations.fleet.online")}
          detail={t("operations.fleet.onlineDetail")}
          value={online}
          total={total}
        />
        <PlayingMetric confirmed={confirmed} trend={series.playing} />
        <StatusMetric
          icon={TriangleAlert}
          identity="attention"
          trend={series.unhealthy}
          label={t("operations.fleet.attention")}
          detail={t("operations.fleet.attentionDetail")}
          value={
            attentionPending && attentionCount === 0 ? null : attentionCount
          }
          total={total}
          loadingLabel={t("operations.fleet.attentionLoading")}
        />
      </ul>
    </Card>
  );
}

/**
 * The three trend lines, each from the same hourly uptime report the Fleet
 * health card reads. Connected is every reporting share (up plus impaired),
 * playing is the healthy share (up), and unhealthy is impaired plus down: the
 * time-based cousin of the attention list, which has no history of its own.
 * An hour with no measurement stays null so the line breaks there.
 */
function trendSeries(buckets: UptimeBucket[]) {
  const measured = (
    bucket: UptimeBucket,
    value: (bucket: UptimeBucket) => number,
  ) => (bucket.uptimePercent === null ? null : value(bucket));
  return {
    connected: buckets.map((bucket) =>
      measured(bucket, (b) => b.upPercent + b.impairedPercent),
    ),
    playing: buckets.map((bucket) => measured(bucket, (b) => b.upPercent)),
    unhealthy: buckets.map((bucket) =>
      measured(bucket, (b) => b.impairedPercent + b.downPercent),
    ),
  };
}

type Identity = "online" | "playing" | "attention";

/** A soft color per figure, for its icon chip and its trend line. */
const identityClass: Record<Identity, { chip: string; line: string }> = {
  online: {
    chip: "bg-emerald-500/10 text-emerald-700 dark:bg-emerald-400/15 dark:text-emerald-300",
    line: "text-emerald-500 dark:text-emerald-400",
  },
  playing: {
    chip: "bg-cyan-500/10 text-cyan-700 dark:bg-cyan-400/15 dark:text-cyan-300",
    line: "text-cyan-500 dark:text-cyan-400",
  },
  attention: {
    chip: "bg-rose-500/10 text-rose-700 dark:bg-rose-400/15 dark:text-rose-300",
    line: "text-rose-500 dark:text-rose-400",
  },
};

/**
 * One figure. `value` is null while it loads, and `unavailable` replaces the
 * number when it could not be measured, so neither is ever shown as zero.
 */
function StatusMetric({
  icon: Icon,
  identity,
  trend = [],
  label,
  detail,
  value,
  total,
  unavailable,
  loadingLabel,
  to,
  ariaLabel,
}: {
  icon: ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
  identity: Identity;
  trend?: (number | null)[];
  label: string;
  detail: string;
  value: number | null;
  total?: number;
  unavailable?: string;
  loadingLabel?: string;
  to?: string;
  ariaLabel?: string;
}) {
  const body = (
    <>
      <Sparkline
        values={trend}
        className={`absolute inset-x-0 bottom-0 h-7 w-full ${identityClass[identity].line}`}
      />
      <span className="relative flex items-center gap-2 text-xs leading-4 font-medium text-muted-foreground">
        <span
          className={`flex size-6 shrink-0 items-center justify-center rounded-md ${identityClass[identity].chip}`}
        >
          <Icon className="size-3.5" aria-hidden />
        </span>
        <span className="sm:truncate">{label}</span>
      </span>
      <span className="relative flex min-h-8 items-baseline gap-0.5">
        {unavailable ? (
          <strong className="text-2xl leading-8 font-semibold text-muted-foreground">
            —
          </strong>
        ) : value === null ? (
          <span role="status" aria-label={loadingLabel} className="self-center">
            <Skeleton className="h-6 w-12" />
          </span>
        ) : (
          <>
            <strong className="text-2xl leading-8 font-semibold tracking-tight tabular-nums">
              {value}
            </strong>
            {total !== undefined && (
              <span className="text-sm text-muted-foreground tabular-nums">
                /{total}
              </span>
            )}
          </>
        )}
      </span>
      <span className="relative text-xs text-muted-foreground sm:truncate">
        {unavailable ?? detail}
      </span>
    </>
  );
  const cell =
    "relative row-span-3 grid min-w-0 grid-rows-subgrid gap-y-0.5 overflow-hidden px-(--card-spacing) pt-1 pb-3 max-sm:px-3";
  return (
    <li className="row-span-3 grid min-w-0 grid-rows-subgrid">
      {to ? (
        <Link
          className={`${cell} outline-none hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:ring-inset`}
          to={to}
          aria-label={ariaLabel}
        >
          {body}
        </Link>
      ) : (
        <div className={cell}>{body}</div>
      )}
    </li>
  );
}

function PlayingMetric({
  confirmed,
  trend,
}: {
  confirmed: ConfirmedPlaying;
  trend: (number | null)[];
}) {
  const { t } = useTranslation("activity");
  const shared = {
    icon: Play,
    identity: "playing" as const,
    trend,
    label: t("operations.fleet.playing"),
    detail: t("operations.fleet.playingDetail"),
  };
  if (confirmed.state === "loading") {
    return (
      <StatusMetric
        {...shared}
        value={null}
        loadingLabel={t("operations.fleet.playingLoading")}
      />
    );
  }
  if (confirmed.state === "unavailable") {
    return (
      <StatusMetric
        {...shared}
        value={null}
        unavailable={t("operations.fleet.unavailable")}
      />
    );
  }
  return (
    <StatusMetric
      {...shared}
      value={confirmed.playing}
      total={confirmed.measured}
      to={buildActivityLink("overview")}
      ariaLabel={t("operations.fleet.playingLink", {
        playing: confirmed.playing,
        measured: confirmed.measured,
      })}
    />
  );
}

export function FleetStatusSkeleton() {
  const { t } = useTranslation("activity");
  return (
    <div role="status" aria-label={t("operations.fleet.loading")}>
      <Skeleton className="h-[5.5rem] w-full rounded-xl" />
    </div>
  );
}
