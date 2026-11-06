import { TriangleAlert } from "lucide-react";
import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import type { PlaybackAgenda } from "../../api/domains/playbackPlan";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { PlaybackCalendarBlock } from "./PlaybackCalendarBlock";
import { agendaDate, calendarDay, hoursSince } from "./playbackAgendaModel";

const hourHeight = 56;
const hourMs = 60 * 60_000;
const columns =
  "grid grid-cols-[3.5rem_minmax(0,1fr)] @4xl/agenda:grid-cols-[4rem_repeat(7,minmax(0,1fr))]";

export function PlaybackWeekCalendar({
  agenda,
  start,
  now,
  dayIndex,
  onDayChange,
  locale,
  screen,
}: {
  agenda: PlaybackAgenda;
  start: Date;
  now: Date;
  dayIndex: number;
  onDayChange: (index: number) => void;
  locale: string;
  screen: { id: string; name: string };
}) {
  const { t } = useTranslation(["schedules", "screens"]);
  const viewport = useRef<HTMLDivElement>(null);
  const days = Array.from({ length: 7 }, (_, index) =>
    calendarDay(agenda.segments, agendaDate(start, index)),
  );
  const maxHours = Math.max(24, ...days.map((day) => day.hours));
  const today = agendaDate(now).getTime();
  const weekday = new Intl.DateTimeFormat(locale, { weekday: "short" });
  const dayNumber = new Intl.DateTimeFormat(locale, { day: "numeric" });
  const fullDay = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });
  const hourLabel = new Intl.DateTimeFormat(locale, { hour: "numeric" });
  const changeHourLabel = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
  });
  const timezone = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  const hasAllDay = days.some((day) => day.allDay);

  useEffect(() => {
    if (viewport.current) viewport.current.scrollTop = 7 * hourHeight;
  }, []);

  function dayLabel(day: (typeof days)[number]) {
    const label = fullDay.format(day.date);
    return day.allDay?.overlaps.length ||
      day.blocks.some((block) => block.overlaps.length)
      ? t("agenda.dayWithOverlap", { day: label })
      : label;
  }

  return (
    <div className="space-y-2">
      <ToggleGroup
        className="grid w-full grid-cols-7 gap-0.5 rounded-lg border bg-card p-1 @4xl/agenda:hidden"
        aria-label={t("agenda.days")}
        value={[String(dayIndex)]}
        onValueChange={(values) => {
          if (values[0] !== undefined) onDayChange(Number(values[0]));
        }}
      >
        {days.map((day, index) => (
          <ToggleGroupItem
            key={index}
            value={String(index)}
            aria-label={dayLabel(day)}
            className="h-12 min-w-0 flex-col gap-0 rounded-md px-0.5 tabular-nums"
          >
            <span className="text-[0.6875rem] text-muted-foreground">
              {weekday.format(day.date)}
            </span>
            <span className="text-sm font-semibold">
              {dayNumber.format(day.date)}
            </span>
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <div
        ref={viewport}
        role="region"
        aria-label={t("agenda.calendarFor", { screen: screen.name })}
        tabIndex={0}
        className="relative isolate h-[min(68dvh,46rem)] min-h-72 overflow-y-auto rounded-xl border bg-card outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <div className={`sticky top-0 z-30 border-b bg-card ${columns}`}>
          <div
            aria-hidden="true"
            className="flex min-w-0 flex-col justify-end gap-1 px-1.5 pb-2 text-end text-[0.625rem] text-muted-foreground"
          >
            {hasAllDay ? t("agenda.allDay") : null}
          </div>
          {days.map((day, index) => (
            <div
              key={index}
              className={`min-w-0 border-s ${index === dayIndex ? "" : "hidden @4xl/agenda:block"}`}
            >
              <div className="flex min-h-14 items-center gap-2 px-2 py-1.5 @4xl/agenda:min-h-17 @4xl/agenda:flex-col @4xl/agenda:justify-center @4xl/agenda:gap-0.5">
                <span className="text-xs font-medium text-muted-foreground @4xl/agenda:text-[0.6875rem] @4xl/agenda:uppercase">
                  <span className="@4xl/agenda:hidden">
                    {fullDay.format(day.date)}
                  </span>
                  <span className="hidden @4xl/agenda:inline">
                    {weekday.format(day.date)}
                  </span>
                </span>
                <span
                  aria-current={
                    day.date.getTime() === today ? "date" : undefined
                  }
                  className="hidden size-8 items-center justify-center rounded-full text-lg font-semibold tabular-nums aria-[current=date]:bg-primary aria-[current=date]:text-primary-foreground @4xl/agenda:inline-flex"
                >
                  {dayNumber.format(day.date)}
                </span>
                {day.hours !== 24 ? (
                  <span className="text-[0.625rem] text-muted-foreground">
                    {t("agenda.clockChange")}
                  </span>
                ) : null}
              </div>
              {hasAllDay ? (
                <div className="min-h-8 px-1 pb-1.5">
                  {day.allDay ? (
                    <PlaybackCalendarBlock
                      block={day.allDay}
                      day={day.date}
                      dayEnd={day.end}
                      locale={locale}
                      allDay
                    />
                  ) : null}
                </div>
              ) : null}
            </div>
          ))}
        </div>

        <div className={columns}>
          <div
            className={`relative text-end ${days[dayIndex]?.hours === 24 ? "" : "invisible @4xl/agenda:visible"}`}
            aria-hidden="true"
          >
            {Array.from({ length: 24 }, (_, hour) => (
              <div
                key={hour}
                className="absolute inset-x-0 pe-2 pt-1 text-[0.625rem] text-muted-foreground tabular-nums"
                style={{ top: hour * hourHeight }}
              >
                {hourLabel.format(new Date(2000, 0, 1, hour))}
              </div>
            ))}
          </div>
          {days.map((day, index) => {
            const current = day.date.getTime() === today;
            const elapsed = day.date.getTime() < today;
            return (
              <div
                key={index}
                role="group"
                aria-label={dayLabel(day)}
                data-calendar-day={index}
                className={`relative min-w-0 border-s ${elapsed ? "bg-muted/30" : ""} ${index === dayIndex ? "" : "hidden @4xl/agenda:block"}`}
                style={{ height: maxHours * hourHeight }}
              >
                <div
                  aria-hidden="true"
                  className="pointer-events-none absolute inset-0"
                  style={{
                    backgroundImage:
                      "linear-gradient(to bottom, var(--border) 1px, transparent 1px)",
                    backgroundSize: `100% ${hourHeight}px`,
                  }}
                />
                {day.hours !== 24
                  ? Array.from({ length: Math.ceil(day.hours) }, (_, hour) => (
                      <div
                        key={hour}
                        aria-hidden="true"
                        className="pointer-events-none absolute inset-x-1 z-20 pt-0.5 text-end"
                        style={{ top: hour * hourHeight }}
                      >
                        <span className="rounded bg-card px-1 text-[0.625rem] text-muted-foreground">
                          {changeHourLabel.format(
                            new Date(day.date.getTime() + hour * hourMs),
                          )}
                        </span>
                      </div>
                    ))
                  : null}
                {day.blocks.map((block) => {
                  const top = hoursSince(block.start, day.date) * hourHeight;
                  const height =
                    hoursSince(block.end, block.start) * hourHeight;
                  return (
                    <PlaybackCalendarBlock
                      key={block.start.getTime()}
                      block={block}
                      day={day.date}
                      dayEnd={day.end}
                      locale={locale}
                      compact={height < 36}
                      showPresentation={height >= 54}
                      style={{ top: top + 1, height: Math.max(8, height - 2) }}
                    />
                  );
                })}
                {current ? (
                  <div
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-x-0 z-20 border-t-2 border-[var(--tc-status-danger)] before:absolute before:start-0 before:-top-1 before:size-1.5 before:rounded-full before:bg-[var(--tc-status-danger)]"
                    style={{ top: hoursSince(now, day.date) * hourHeight }}
                  />
                ) : null}
              </div>
            );
          })}
        </div>
      </div>
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <Link
            className="font-medium text-foreground underline-offset-3 hover:underline"
            to={`/screens/${screen.id}`}
          >
            {screen.name}
          </Link>
          <span aria-hidden="true">·</span>
          <span>{t("agenda.expectedPlayback")}</span>
          <span aria-hidden="true">·</span>
          <span>{t("agenda.timezone", { timezone })}</span>
        </span>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden="true"
              className="size-2.5 rounded-sm bg-[var(--tc-action-primary-soft)]"
            />
            {t("screens:playbackPlan.sources.schedule")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2.5 rounded-sm bg-muted" />
            {t("agenda.fallback")}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <TriangleAlert
              aria-hidden="true"
              className="size-3.5 text-[var(--tc-viz-impaired)]"
            />
            {t("agenda.overlap")}
          </span>
        </div>
      </div>
    </div>
  );
}
