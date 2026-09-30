import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import type { ScreenStatus } from "../../api/types";
import { buildActivityLink } from "../../pages/activityLinks";
import { buttonVariants } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import type { FleetSummary } from "./attention";

/**
 * Player-confirmed playback from the server's fleet health, or why there is
 * no figure. A missing figure is never shown as zero.
 */
export type ConfirmedPlaying =
  | { state: "loading" }
  | { state: "unavailable" }
  | { state: "ready"; playing: number; measured: number };

// Status structures hold translation keys, never rendered text.
const statusLabelKeys: Record<
  ScreenStatus,
  | "statusLabels.online"
  | "statusLabels.recent"
  | "statusLabels.stale"
  | "statusLabels.offline"
  | "statusLabels.disabled"
  | "statusLabels.revoked"
> = {
  online: "statusLabels.online",
  recent: "statusLabels.recent",
  stale: "statusLabels.stale",
  offline: "statusLabels.offline",
  disabled: "statusLabels.disabled",
  revoked: "statusLabels.revoked",
};

const barClass: Record<ScreenStatus, string> = {
  online: "bg-emerald-600",
  recent: "bg-emerald-600/40",
  stale: "bg-amber-500",
  offline: "bg-red-600",
  disabled: "bg-muted-foreground/40",
  revoked: "bg-muted-foreground/40",
};

// Order the bar and the breakdown from healthy to unhealthy.
const statusOrder: ScreenStatus[] = [
  "online",
  "recent",
  "stale",
  "offline",
  "revoked",
  "disabled",
];

/**
 * The fleet in one compact strip under the page header: a headline, three
 * figures, and a proportional bar. On a phone it becomes a small bordered
 * group so the three figures stay together.
 */
export function FleetStatus({
  summary,
  attentionCount,
  attentionPending,
  confirmed,
}: {
  summary: FleetSummary;
  attentionCount: number;
  /** Incident reasons are still loading, so the count may yet grow. */
  attentionPending: boolean;
  confirmed: ConfirmedPlaying;
}) {
  const { t } = useTranslation("activity");
  const { total, online, byStatus } = summary;
  const headline =
    attentionCount > 0
      ? t("operations.fleet.needAttention", { count: attentionCount, total })
      : online === total
        ? t("operations.fleet.allOnline", { count: total })
        : t("operations.fleet.someOnline", { online, total });
  const breakdown = statusOrder
    .filter((status) => status !== "online" && byStatus[status] > 0)
    .map((status) => `${t(statusLabelKeys[status])} ${byStatus[status]}`)
    .join(" · ");

  return (
    <section
      aria-labelledby="fleet-status-heading"
      data-testid="fleet-status"
      className="grid gap-2 max-sm:rounded-xl max-sm:border max-sm:p-3"
    >
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <h2
            id="fleet-status-heading"
            className="text-base font-medium leading-snug"
          >
            {headline}
          </h2>
          <p className="text-xs text-muted-foreground">
            {breakdown || t("operations.fleet.liveNote")}
          </p>
        </div>
        <ul className="grid w-full grid-cols-3 gap-2 sm:flex sm:w-auto sm:items-end sm:gap-6">
          <li className="grid content-start">
            <span className="text-xs text-muted-foreground">
              {t("operations.fleet.online")}
            </span>
            <strong className="text-xl font-semibold leading-tight tabular-nums">
              {online}
              <span className="text-sm font-normal text-muted-foreground">
                /{total}
              </span>
            </strong>
          </li>
          <li className="grid content-start">
            <span className="text-xs text-muted-foreground">
              {t("operations.fleet.playing")}
            </span>
            <Playing confirmed={confirmed} />
          </li>
          <li className="grid content-start">
            <span className="text-xs text-muted-foreground">
              {t("operations.fleet.attention")}
            </span>
            {attentionPending && attentionCount === 0 ? (
              <span
                role="status"
                aria-label={t("operations.fleet.attentionLoading")}
              >
                <Skeleton className="h-7 w-8" />
              </span>
            ) : (
              <strong className="flex items-center gap-1.5 text-xl font-semibold leading-tight tabular-nums">
                {attentionCount > 0 && (
                  <TriangleAlert
                    className="size-4 text-destructive"
                    aria-hidden="true"
                  />
                )}
                {attentionCount}
              </strong>
            )}
          </li>
          <li className="hidden sm:block">
            <Link
              className={buttonVariants({ variant: "outline", size: "sm" })}
              to="/screens"
            >
              {t("operations.allScreens")}
            </Link>
          </li>
        </ul>
      </div>
      <div
        aria-hidden="true"
        className="flex h-1 w-full gap-px overflow-hidden rounded-full bg-muted"
      >
        {statusOrder
          .filter((status) => byStatus[status] > 0)
          .map((status) => (
            <span
              key={status}
              className={barClass[status]}
              style={{ flexGrow: byStatus[status], flexBasis: 0 }}
            />
          ))}
      </div>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          {t("operations.fleet.scopeNote")}
        </p>
        <Link
          className={buttonVariants({
            variant: "ghost",
            size: "sm",
            className: "shrink-0 sm:hidden",
          })}
          to="/screens"
        >
          {t("operations.allScreens")}
        </Link>
      </div>
    </section>
  );
}

function Playing({ confirmed }: { confirmed: ConfirmedPlaying }) {
  const { t } = useTranslation("activity");
  if (confirmed.state === "loading") {
    return (
      <span role="status" aria-label={t("operations.fleet.playingLoading")}>
        <Skeleton className="h-7 w-12" />
      </span>
    );
  }
  if (confirmed.state === "unavailable") {
    return (
      <span className="flex items-baseline gap-1.5">
        <strong className="text-xl font-semibold leading-tight text-muted-foreground">
          —
        </strong>
        <span className="text-xs text-muted-foreground">
          {t("operations.fleet.unavailable")}
        </span>
      </span>
    );
  }
  return (
    <Link
      className="-m-1 flex items-baseline gap-1.5 rounded-md p-1 hover:bg-muted"
      to={buildActivityLink("overview")}
      aria-label={t("operations.fleet.playingLink", {
        playing: confirmed.playing,
        measured: confirmed.measured,
      })}
    >
      <strong className="text-xl font-semibold leading-tight tabular-nums">
        {confirmed.playing}
      </strong>
      <span className="text-xs text-muted-foreground">
        {t("operations.fleet.playingHint", { measured: confirmed.measured })}
      </span>
    </Link>
  );
}

export function FleetStatusSkeleton() {
  const { t } = useTranslation("activity");
  return (
    <div
      role="status"
      aria-label={t("operations.fleet.loading")}
      className="grid gap-2"
    >
      <Skeleton className="h-10 w-64 max-w-full" />
      <Skeleton className="h-1 w-full" />
    </div>
  );
}
