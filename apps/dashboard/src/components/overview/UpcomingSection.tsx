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
import {
  formatScheduleTime,
  formatUntil,
  formatUntilShort,
  useNow,
} from "./format";
import { listBleed, rowBleed } from "./layout";
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
          <Skeleton className="h-11 w-full" />
          <Skeleton className="h-11 w-full" />
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
        <ItemGroup className={listBleed}>
          {changes.map(({ schedule, at, kind }) => {
            const zone = displayZone(schedule, defaultTimezone);
            return (
              <Item
                key={`${schedule.id}-${kind}`}
                size="xs"
                render={<Link to={`/schedules/${schedule.id}`} />}
                className={rowBleed}
              >
                <span className="flex w-10 shrink-0 justify-center self-start rounded-md bg-muted py-0.5 text-xs font-medium tabular-nums">
                  <span aria-hidden="true">
                    {formatUntilShort(at, now, locale)}
                  </span>
                  <span className="sr-only">
                    {formatUntil(at, now, locale)}
                  </span>
                </span>
                <ItemContent className="min-w-0">
                  <ItemTitle className="max-w-full">
                    <span className="truncate">{schedule.name}</span>
                  </ItemTitle>
                  <ItemDescription className="line-clamp-1">
                    {[
                      t(
                        kind === "starts"
                          ? "operations.upcomingStartsAt"
                          : "operations.upcomingEndsAt",
                        { time: formatScheduleTime(at, zone, locale) },
                      ),
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
