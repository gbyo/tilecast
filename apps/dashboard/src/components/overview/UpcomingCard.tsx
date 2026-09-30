import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, CircleAlert } from "lucide-react";
import { useFormatLocale } from "../../i18n";
import { Alert, AlertTitle } from "../ui/alert";
import { buttonVariants } from "../ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { Empty, EmptyDescription, EmptyHeader } from "../ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../ui/item";
import { Skeleton } from "../ui/skeleton";
import { formatScheduleTime, formatUntil, useNow } from "./format";
import { displayZone, type UpcomingChange } from "./upcoming";
import type { Schedule } from "../../api/types";

function contentName(schedule: Schedule) {
  return schedule.layoutName || schedule.playlistName;
}

export function UpcomingCard({
  changes,
  defaultTimezone,
  isLoading,
  isError,
  loaded,
  total,
}: {
  changes: UpcomingChange[];
  defaultTimezone: string;
  isLoading: boolean;
  isError: boolean;
  /** Schedules the request returned, against the total that exist. */
  loaded: number;
  total: number;
}) {
  const { t } = useTranslation("activity");
  const locale = useFormatLocale();
  const now = useNow();
  return (
    <Card size="sm" role="region" aria-labelledby="coming-up-heading">
      <CardHeader>
        <CardTitle id="coming-up-heading" role="heading" aria-level={2}>
          {t("operations.comingTitle")}
        </CardTitle>
        <CardDescription>{t("operations.comingDescription")}</CardDescription>
        <CardAction>
          <Link
            className={buttonVariants({
              variant: "ghost",
              size: "sm",
              className: "max-sm:h-10",
            })}
            to="/schedules"
          >
            {t("operations.viewSchedules")}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent>
        {isLoading ? (
          <div
            role="status"
            aria-label={t("operations.schedulesLoading")}
            className="grid gap-2"
          >
            <Skeleton className="h-4 w-1/2" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : isError ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{t("operations.schedulesFailed")}</AlertTitle>
          </Alert>
        ) : changes.length === 0 ? (
          <Empty className="border-0 p-2">
            <EmptyHeader>
              <EmptyDescription>{t("operations.noUpcoming")}</EmptyDescription>
            </EmptyHeader>
          </Empty>
        ) : (
          <ItemGroup className="gap-0.5">
            {changes.map(({ schedule, at, kind }) => {
              const zone = displayZone(schedule, defaultTimezone);
              return (
                <Item
                  key={`${schedule.id}-${kind}`}
                  size="sm"
                  render={<Link to={`/schedules/${schedule.id}`} />}
                  className="min-h-11 px-2"
                >
                  <ItemContent className="min-w-0">
                    <p className="text-xs font-medium tabular-nums">
                      <span>{formatUntil(at, now, locale)}</span>
                      <span className="font-normal text-muted-foreground">
                        {" · "}
                        {formatScheduleTime(at, zone, locale)}
                      </span>
                    </p>
                    <ItemTitle className="max-w-full">
                      {t(
                        kind === "starts"
                          ? "operations.upcomingStarts"
                          : "operations.upcomingEnds",
                        { name: schedule.name },
                      )}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-1">
                      {t("operations.upcomingDetail", {
                        content: contentName(schedule),
                        targets: targetLabel(schedule, t),
                      })}
                    </ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <ChevronRight
                      className="size-4 text-muted-foreground"
                      aria-hidden="true"
                    />
                  </ItemActions>
                </Item>
              );
            })}
          </ItemGroup>
        )}
        {!isLoading && !isError && total > loaded && (
          <p className="text-xs text-muted-foreground">
            {t("operations.upcomingPartial", { shown: loaded, total })}
          </p>
        )}
      </CardContent>
    </Card>
  );
}

function targetLabel(
  schedule: Schedule,
  t: ReturnType<typeof useTranslation<"activity">>["t"],
) {
  if (schedule.targets.length === 0) return t("operations.targetsNone");
  if (schedule.targets.length === 1)
    return schedule.targets[0]?.name ?? t("operations.targetSingle");
  return t("operations.targets", { count: schedule.targets.length });
}
