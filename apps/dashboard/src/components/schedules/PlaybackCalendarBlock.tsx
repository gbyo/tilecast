import { TriangleAlert } from "lucide-react";
import type { CSSProperties } from "react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { Badge } from "../ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "../ui/popover";
import type { PlaybackBlock } from "./playbackAgendaModel";

export function PlaybackCalendarBlock({
  block,
  day,
  dayEnd,
  allDay,
  style,
  compact,
  showPresentation,
  locale,
}: {
  block: PlaybackBlock;
  day: Date;
  dayEnd: Date;
  allDay?: boolean;
  style?: CSSProperties;
  compact?: boolean;
  showPresentation?: boolean;
  locale: string;
}) {
  const { t } = useTranslation(["schedules", "screens"]);
  const selection = block.selection;
  const time = new Intl.DateTimeFormat(locale, {
    hour: "numeric",
    minute: "2-digit",
    timeZoneName:
      day.getTimezoneOffset() === dayEnd.getTimezoneOffset()
        ? undefined
        : "short",
  });
  const dateLabel = new Intl.DateTimeFormat(locale, {
    weekday: "long",
    month: "short",
    day: "numeric",
  }).format(day);
  const range = (start: Date, end: Date) =>
    t("agenda.timeRange", {
      from: time.format(start),
      to:
        end.getTime() === dayEnd.getTime()
          ? t("agenda.midnight")
          : time.format(end),
    });
  const timeLabel = allDay ? t("agenda.allDay") : range(block.start, block.end);
  const name = selection
    ? selection.name || t("agenda.unnamedContent")
    : t("agenda.noContent");
  const title = selection?.scheduleName || name;
  const source = selection?.source;
  const fallback = source === "assignment";
  const overlap = block.overlaps.length > 0;
  const sourceLabel = fallback
    ? t("agenda.fallback")
    : source
      ? t(`screens:playbackPlan.sources.${source}`)
      : t("agenda.noContent");
  const label = [
    name,
    selection?.scheduleName,
    timeLabel,
    overlap ? t("agenda.overlap") : null,
  ]
    .filter(Boolean)
    .join(", ");
  const kind = !selection
    ? "empty"
    : fallback
      ? "fallback"
      : source === "schedule"
        ? "scheduled"
        : "override";

  return (
    <Popover>
      <PopoverTrigger
        type="button"
        aria-label={label}
        data-calendar-block={kind}
        style={style}
        className={[
          "group flex min-w-0 items-start gap-1 overflow-hidden rounded-md px-2 text-start text-xs leading-4 outline-none transition-colors focus-visible:z-20 focus-visible:ring-2 focus-visible:ring-ring",
          "data-[calendar-block=scheduled]:bg-[var(--tc-action-primary-soft)] data-[calendar-block=scheduled]:hover:bg-[var(--tc-status-info-bg)]",
          "data-[calendar-block=override]:bg-[var(--tc-status-warning-bg)]",
          "data-[calendar-block=fallback]:bg-muted/55 data-[calendar-block=fallback]:text-muted-foreground data-[calendar-block=fallback]:hover:bg-muted",
          "data-[calendar-block=empty]:border data-[calendar-block=empty]:border-border data-[calendar-block=empty]:bg-background data-[calendar-block=empty]:text-muted-foreground data-[calendar-block=empty]:hover:bg-muted",
          allDay ? "h-6 w-full items-center" : "absolute inset-x-1 z-10 py-0.5",
        ].join(" ")}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-semibold">{title}</span>
          {!allDay && !compact ? (
            <span className="block truncate text-[0.6875rem] font-normal opacity-90">
              {fallback ? sourceLabel : timeLabel}
            </span>
          ) : null}
          {showPresentation && title !== name ? (
            <span className="block truncate text-[0.6875rem] font-normal opacity-80">
              {name}
            </span>
          ) : null}
        </span>
        {overlap ? (
          <TriangleAlert
            aria-hidden="true"
            className="mt-0.5 size-3 shrink-0 text-[var(--tc-viz-impaired)]"
          />
        ) : null}
      </PopoverTrigger>

      <PopoverContent
        align="start"
        className="max-h-[min(24rem,var(--available-height))] w-76 max-w-[calc(100vw-2rem)] overflow-y-auto p-3"
      >
        <PopoverHeader>
          <PopoverTitle className="wrap-anywhere">{name}</PopoverTitle>
          <PopoverDescription>
            {dateLabel} · {timeLabel}
          </PopoverDescription>
        </PopoverHeader>
        <Badge variant={fallback || !selection ? "outline" : "secondary"}>
          {sourceLabel}
        </Badge>
        {selection?.source === "schedule" && selection.selectionId ? (
          <Link
            className="text-sm wrap-anywhere underline underline-offset-3"
            to={`/schedules/${selection.selectionId}`}
          >
            {selection.scheduleName || t("agenda.unnamedSchedule")}
          </Link>
        ) : null}
        {overlap ? (
          <div className="space-y-2 border-t pt-2">
            <p className="flex items-center gap-1.5 text-xs font-semibold">
              <TriangleAlert
                aria-hidden="true"
                className="size-3.5 shrink-0 text-[var(--tc-viz-impaired)]"
              />
              {t("agenda.overlap")}
            </p>
            {block.overlaps.map((window) => (
              <div key={window.start.getTime()} className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  {range(window.start, window.end)}
                </p>
                <ul className="space-y-1.5">
                  {window.candidates.map((schedule) => (
                    <li key={schedule.id} className="text-xs wrap-anywhere">
                      <Link
                        className="underline underline-offset-3"
                        to={`/schedules/${schedule.id}`}
                      >
                        {schedule.name || t("agenda.unnamedSchedule")}
                      </Link>
                      <p className="text-muted-foreground">
                        {t(`screens:playbackPlan.reasons.${schedule.reason}`)}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
