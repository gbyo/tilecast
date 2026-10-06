import {
  LayoutPanelTop,
  ListVideo,
  MonitorCog,
  type LucideIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { Badge } from "../ui/badge";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type {
  SchedulePresentation,
  ScheduleTargetSummary,
} from "./scheduleLibraryModel";

/**
 * Enabled is configuration, not playback: a schedule can be enabled and still
 * be outside its window or lose to a higher priority. Text carries the state;
 * the variant only reinforces it.
 */
export function ScheduleStatusBadge({ enabled }: { enabled: boolean }) {
  const { t } = useTranslation("schedules");
  return (
    <Badge variant={enabled ? "secondary" : "outline"}>
      {enabled ? t("page.enabled") : t("page.disabled")}
    </Badge>
  );
}

const presentationIcons: Record<SchedulePresentation["kind"], LucideIcon> = {
  playlist: ListVideo,
  layout: LayoutPanelTop,
  display_control: MonitorCog,
};

/** What a schedule does: an icon for the kind, then plain text. */
export function SchedulePresentationLabel({
  presentation,
}: {
  presentation: SchedulePresentation;
}) {
  const Icon = presentationIcons[presentation.kind];
  return (
    <span className="flex min-w-0 items-center gap-1.5">
      <Icon
        className="size-4 shrink-0 text-muted-foreground"
        aria-hidden="true"
      />
      <span className="truncate" title={presentation.label}>
        {presentation.label}
      </span>
    </span>
  );
}

/**
 * The first two targets, then a count. When some are hidden, the full list is
 * in a tooltip on a focusable element and in the accessible name, so it is
 * never reachable by pointer alone.
 */
export function ScheduleTargets({
  summary,
  className,
}: {
  summary: ScheduleTargetSummary;
  className?: string;
}) {
  const { t } = useTranslation("schedules");
  if (summary.hidden === 0)
    return (
      <span className={className ?? "block truncate"} title={summary.text}>
        {summary.text}
      </span>
    );
  const all = summary.names.join(", ");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            tabIndex={0}
            role="group"
            aria-label={t("page.targetsHelpLabel", { names: all })}
            className={`${className ?? "block truncate"} rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50`}
          />
        }
      >
        {summary.text}
      </TooltipTrigger>
      <TooltipContent className="max-w-80">{all}</TooltipContent>
    </Tooltip>
  );
}
