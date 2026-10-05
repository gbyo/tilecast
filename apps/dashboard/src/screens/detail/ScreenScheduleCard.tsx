import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { CalendarClock } from "lucide-react";
import type { PlaylistAssignment, Schedule } from "../../api/types";
import { Button } from "../../components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../../components/ui/card";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../../components/ui/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../../components/ui/item";
import { Badge } from "../../components/ui/badge";
import { Skeleton } from "../../components/ui/skeleton";
import { scheduleQueries } from "../../data/schedules";
import { useFormatLocale } from "../../i18n";
import { scheduleWeekdayLabels } from "../../schedules/scheduleBuilderModel";
import {
  activeSchedule,
  nextPrediction,
  splitRelevantSchedules,
  type PlaybackPlan,
  type RelevantSchedule,
} from "./screenPlaybackModel";

function windowLabel(
  window: { start?: string; end?: string } | undefined,
  locale: string,
): string | null {
  if (!window?.start || !window?.end) return null;
  const options: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
  };
  const start = new Date(window.start).toLocaleTimeString(locale, options);
  const end = new Date(window.end).toLocaleTimeString(locale, options);
  return `${start}–${end}`;
}

/** Operator time context from the full schedule record, when available. */
function scheduleTimeContext(
  schedule: Schedule | undefined,
  locale: string,
  weekdays: (value: number) => string,
): string | null {
  if (!schedule) return null;
  if (schedule.type === "weekly") {
    const days = [...schedule.daysOfWeek]
      .sort((a, b) => a - b)
      .map(weekdays)
      .join(" · ");
    const hours =
      schedule.dailyStart && schedule.dailyEnd
        ? `${schedule.dailyStart}–${schedule.dailyEnd}`
        : null;
    return [days || null, hours].filter(Boolean).join(" · ") || null;
  }
  if (schedule.oneTimeStart && schedule.oneTimeEnd) {
    return `${new Date(schedule.oneTimeStart).toLocaleString(locale)}–${new Date(schedule.oneTimeEnd).toLocaleString(locale)}`;
  }
  return null;
}

function ScheduleRow({
  row,
  detail,
  active,
  window,
}: {
  row: RelevantSchedule;
  detail?: Schedule;
  active: boolean;
  window?: { start?: string; end?: string };
}) {
  const { t } = useTranslation("screens");
  const { t: tSchedules } = useTranslation("schedules");
  const locale = useFormatLocale();
  const occurrence = windowLabel(window, locale);
  const time =
    occurrence ??
    scheduleTimeContext(
      detail,
      locale,
      (value) => scheduleWeekdayLabels(value, tSchedules).short,
    );
  const kindLabel =
    row.presentationType === "layout"
      ? t("playbackPlan.types.layout")
      : t("playbackPlan.types.playlist");
  const description = [row.playlistName || kindLabel, time]
    .filter(Boolean)
    .join(" · ");
  return (
    <Item
      size="sm"
      variant="outline"
      render={<Link to={`/schedules/${row.id}`} />}
      className={active ? "border-primary/40" : undefined}
    >
      <ItemMedia variant="icon" className="text-muted-foreground">
        <CalendarClock aria-hidden="true" />
      </ItemMedia>
      <ItemContent>
        <ItemTitle>{row.name}</ItemTitle>
        {description && <ItemDescription>{description}</ItemDescription>}
      </ItemContent>
      <ItemActions>
        {active ? (
          <Badge>{t("screenSchedule.active")}</Badge>
        ) : row.enabled ? (
          <Badge variant="outline">{t("screenSchedule.enabled")}</Badge>
        ) : (
          <Badge variant="secondary">{t("screenSchedule.disabled")}</Badge>
        )}
      </ItemActions>
    </Item>
  );
}

function NextSection({
  plan,
  futurePlan,
  futureState,
}: {
  plan?: PlaybackPlan;
  futurePlan?: PlaybackPlan;
  futureState: "loading" | "error" | "ready";
}) {
  const { t } = useTranslation("screens");
  const locale = useFormatLocale();
  const prediction = nextPrediction(plan, futurePlan, futureState);
  if (prediction.state === "unknown") return null;
  if (prediction.state === "loading") {
    return (
      <section aria-label={t("screenSchedule.next")} className="min-w-0">
        <h3 className="text-sm font-semibold">{t("screenSchedule.next")}</h3>
        <Skeleton
          className="mt-2 h-4 w-1/2"
          aria-label={t("screenSchedule.nextLoading")}
        />
      </section>
    );
  }
  const time = new Date(prediction.at).toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  if (prediction.state === "failed") {
    return (
      <section aria-label={t("screenSchedule.next")} className="min-w-0">
        <h3 className="text-sm font-semibold">
          {t("screenSchedule.nextEvaluation")}
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">{time}</p>
      </section>
    );
  }
  if (prediction.state === "unchanged") {
    return (
      <section aria-label={t("screenSchedule.next")} className="min-w-0">
        <h3 className="text-sm font-semibold">
          {t("screenSchedule.nextEvaluation")}
        </h3>
        <p className="mt-1 text-sm">
          {time} ·{" "}
          <span className="text-muted-foreground">
            {t("screenSchedule.stillExpected", {
              name: prediction.name ?? t("playback.missingContent"),
            })}
          </span>
        </p>
      </section>
    );
  }
  const followUp =
    prediction.source === "assignment"
      ? t("screenSchedule.defaultResumes")
      : prediction.source === "schedule"
        ? t("screenSchedule.scheduledStarts", {
            name: prediction.scheduleName,
          })
        : prediction.source === "takeover"
          ? t("playback.takeoverOverrides")
          : t("playback.showNowOverrides");
  return (
    <section aria-label={t("screenSchedule.next")} className="min-w-0">
      <h3 className="text-sm font-semibold">{t("screenSchedule.next")}</h3>
      <p className="mt-1 text-sm">
        {time} → {prediction.name ?? t("playback.missingContent")}
      </p>
      <p className="text-sm text-muted-foreground">{followUp}</p>
    </section>
  );
}

export function ScreenScheduleCard({
  screenId,
  assignment,
  plan,
  futurePlan,
  futureState,
  loading,
}: {
  screenId: string;
  assignment?: PlaylistAssignment;
  plan?: PlaybackPlan;
  futurePlan?: PlaybackPlan;
  futureState: "loading" | "error" | "ready";
  loading: boolean;
}) {
  const { t } = useTranslation("screens");
  const active = activeSchedule(plan, assignment);
  const { content, displayControl } = splitRelevantSchedules(
    assignment?.relevantSchedules,
  );
  // Full records supply time context; the assignment rows remain the
  // membership authority so a list failure cannot hide affecting schedules.
  const schedules = useQuery(scheduleQueries.list());
  const details = new Map(
    (schedules.data?.items ?? [])
      .filter((schedule): schedule is Schedule => schedule != null)
      .map((schedule) => [schedule.id, schedule]),
  );
  const others = content.filter((row) => row.id !== active?.scheduleId);
  const activeRow = content.find((row) => row.id === active?.scheduleId);

  return (
    <Card className="min-w-0">
      <CardHeader>
        <CardTitle>{t("screenSchedule.title")}</CardTitle>
        <CardDescription>{t("screenSchedule.body")}</CardDescription>
        <CardAction>
          <Link
            to="/schedules"
            className="text-sm font-medium underline underline-offset-4"
          >
            {t("screenSchedule.viewAll")}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="min-w-0 space-y-5">
        {loading && !assignment ? (
          <div
            role="status"
            aria-label={t("screenSchedule.loading")}
            className="space-y-2"
          >
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : content.length === 0 ? (
          <Empty className="gap-2 border border-dashed py-6">
            <EmptyHeader>
              <EmptyTitle className="text-sm">
                {t("screenSchedule.emptyTitle")}
              </EmptyTitle>
              <EmptyDescription>
                {t("screenSchedule.emptyBody")}
              </EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button
                size="sm"
                render={<Link to={`/schedules/new?screen=${screenId}`} />}
              >
                {t("screenSchedule.addSchedule")}
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {active && activeRow && (
              <section
                aria-label={t("screenSchedule.activeNow")}
                className="min-w-0"
              >
                <h3 className="text-sm font-semibold">
                  {t("screenSchedule.activeNow")}
                </h3>
                <ItemGroup className="mt-2">
                  <ScheduleRow
                    row={{
                      ...activeRow,
                      playlistName:
                        active.presentationName ?? activeRow.playlistName,
                    }}
                    detail={details.get(active.scheduleId)}
                    active
                    window={active.window}
                  />
                </ItemGroup>
              </section>
            )}
            <NextSection
              plan={plan}
              futurePlan={futurePlan}
              futureState={futureState}
            />
            {others.length > 0 && (
              <section
                aria-label={t("screenSchedule.others")}
                className="min-w-0"
              >
                <h3 className="text-sm font-semibold">
                  {t("screenSchedule.others")}
                </h3>
                <ItemGroup className="mt-2 gap-2">
                  {others.map((row) => (
                    <ScheduleRow
                      key={row.id}
                      row={row}
                      detail={details.get(row.id)}
                      active={false}
                    />
                  ))}
                </ItemGroup>
              </section>
            )}
            <div className="flex flex-wrap items-center justify-between gap-2">
              <Button
                variant="outline"
                size="sm"
                render={<Link to={`/schedules/new?screen=${screenId}`} />}
              >
                {t("screenSchedule.addSchedule")}
              </Button>
              <Link
                to="/schedules"
                className="text-sm font-medium underline underline-offset-4"
              >
                {t("screenSchedule.viewAll")}
              </Link>
            </div>
          </>
        )}
        {displayControl.length > 0 && (
          <p className="text-sm text-muted-foreground">
            {t("screenSchedule.displayControlNote", {
              count: displayControl.length,
            })}{" "}
            <Link to="/schedules" className="underline underline-offset-4">
              {t("screenSchedule.viewAll")}
            </Link>
          </p>
        )}
      </CardContent>
    </Card>
  );
}
