import { Link } from "react-router";
import { useTranslation } from "react-i18next";
import { ChevronRight, CircleAlert } from "lucide-react";
import type { TFunction } from "i18next";
import type { Schedule } from "../../api/types";
import { useFormatLocale } from "../../i18n";
import { Alert, AlertTitle } from "../ui/alert";
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
import { RailSection } from "./RailSection";
import { displayZone, type UpcomingChange } from "./upcoming";

function contentName(schedule: Schedule) {
  return schedule.layoutName || schedule.playlistName;
}

export function UpcomingSection({
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
    <RailSection
      id="coming-up-heading"
      title={t("operations.comingTitle")}
      action={{ label: t("operations.viewSchedules"), to: "/schedules" }}
    >
      {isLoading ? (
        <div
          role="status"
          aria-label={t("operations.schedulesLoading")}
          className="grid gap-1.5"
        >
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : isError ? (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("operations.schedulesFailed")}</AlertTitle>
        </Alert>
      ) : changes.length === 0 ? (
        <p className="py-1 text-sm text-muted-foreground">
          {t("operations.noUpcoming")}
        </p>
      ) : (
        <ItemGroup className="-mx-1 gap-0">
          {changes.map(({ schedule, at, kind }) => {
            const zone = displayZone(schedule, defaultTimezone);
            return (
              <Item
                key={`${schedule.id}-${kind}`}
                size="xs"
                render={<Link to={`/schedules/${schedule.id}`} />}
                className="min-h-11 py-1"
              >
                <ItemContent className="min-w-0 gap-0">
                  <ItemTitle className="max-w-full justify-between">
                    <span className="truncate">
                      {t(
                        kind === "starts"
                          ? "operations.upcomingStarts"
                          : "operations.upcomingEnds",
                        { name: schedule.name },
                      )}
                    </span>
                    <span className="shrink-0 text-xs font-medium tabular-nums">
                      {formatUntil(at, now, locale)}
                    </span>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-1">
                    {[
                      formatScheduleTime(at, zone, locale),
                      t("operations.upcomingDetail", {
                        content: contentName(schedule),
                        targets: targetLabel(schedule, t),
                      }),
                    ].join(" · ")}
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
    </RailSection>
  );
}

function targetLabel(schedule: Schedule, t: TFunction<"activity">) {
  if (schedule.targets.length === 0) return t("operations.targetsNone");
  if (schedule.targets.length === 1)
    return schedule.targets[0]?.name ?? t("operations.targetSingle");
  return t("operations.targets", { count: schedule.targets.length });
}
