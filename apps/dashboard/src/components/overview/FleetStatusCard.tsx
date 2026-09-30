import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { TriangleAlert } from "lucide-react";
import type { ScreenStatus } from "../../api/types";
import { buildActivityLink } from "../../pages/activityLinks";
import { buttonVariants } from "../ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
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

export function FleetStatusCard({
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
    <Card
      size="sm"
      role="region"
      aria-labelledby="fleet-status-heading"
      data-testid="fleet-status"
    >
      <CardHeader>
        <CardTitle id="fleet-status-heading" role="heading" aria-level={2}>
          {headline}
        </CardTitle>
        <CardDescription>
          {breakdown || t("operations.fleet.liveNote")}
        </CardDescription>
        <CardAction>
          <Link
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "max-sm:h-10",
            })}
            to="/screens"
          >
            {t("operations.allScreens")}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        <div
          aria-hidden="true"
          className="flex h-1.5 w-full gap-px overflow-hidden rounded-full bg-muted"
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
        <ul className="grid grid-cols-3 gap-2 text-left">
          <li className="grid content-start gap-0.5">
            <span className="text-xs text-muted-foreground">
              {t("operations.fleet.online")}
            </span>
            <strong className="text-xl font-semibold tabular-nums">
              {online}
              <span className="text-sm font-normal text-muted-foreground">
                /{total}
              </span>
            </strong>
          </li>
          <li className="grid content-start gap-0.5">
            <span className="text-xs text-muted-foreground">
              {t("operations.fleet.playing")}
            </span>
            <Playing confirmed={confirmed} />
          </li>
          <li className="grid content-start gap-0.5">
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
              <strong className="flex items-center gap-1.5 text-xl font-semibold tabular-nums">
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
        </ul>
      </CardContent>
      <CardFooter className="text-xs text-muted-foreground">
        {t("operations.fleet.scopeNote")}
      </CardFooter>
    </Card>
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
      <>
        <strong className="text-xl font-semibold text-muted-foreground">
          —
        </strong>
        <span className="text-xs text-muted-foreground">
          {t("operations.fleet.unavailable")}
        </span>
      </>
    );
  }
  return (
    <Link
      className="-m-1 grid content-start gap-0.5 rounded-md p-1 hover:bg-muted"
      to={buildActivityLink("overview")}
      aria-label={t("operations.fleet.playingLink", {
        playing: confirmed.playing,
        measured: confirmed.measured,
      })}
    >
      <strong className="text-xl font-semibold tabular-nums">
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
    <Card size="sm" role="status" aria-label={t("operations.fleet.loading")}>
      <CardHeader>
        <Skeleton className="h-5 w-56 max-w-full" />
        <Skeleton className="h-4 w-40 max-w-full" />
      </CardHeader>
      <CardContent>
        <Skeleton className="h-1.5 w-full" />
        <div className="grid grid-cols-3 gap-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      </CardContent>
    </Card>
  );
}
