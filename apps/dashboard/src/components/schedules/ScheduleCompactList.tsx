import { EllipsisVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ActionMenuButton } from "../studio/ActionMenu";
import type { StudioActionGroup } from "../studio/ActionMenu";
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
  SchedulePresentationLabel,
  ScheduleStatusBadge,
  ScheduleTargets,
} from "./ScheduleCells";
import { schedulePath, type ScheduleRow } from "./scheduleLibraryModel";

/**
 * Phones: a native list with a fixed reading order. Name and actions first,
 * then status and what it presents, then when, then where and priority.
 */
export function ScheduleCompactList({
  rows,
  actionsFor,
}: {
  rows: readonly ScheduleRow[];
  actionsFor: (row: ScheduleRow) => StudioActionGroup[];
}) {
  const { t } = useTranslation("schedules");
  return (
    <ItemGroup render={<ul />} className="gap-1">
      {rows.map((row) => {
        const { schedule } = row;
        return (
          <Item key={schedule.id} size="sm" variant="outline" render={<li />}>
            <ItemContent className="min-w-0">
              <ItemTitle className="max-w-full">
                <Link
                  to={schedulePath(schedule)}
                  className="truncate rounded-sm outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                >
                  {schedule.name}
                </Link>
              </ItemTitle>
              <div className="flex min-w-0 items-center gap-2 text-sm">
                <ScheduleStatusBadge enabled={schedule.enabled} />
                <SchedulePresentationLabel presentation={row.presentation} />
              </div>
              <ItemDescription className="line-clamp-2 text-xs tabular-nums">
                {`${row.when.summary} · ${row.when.detail}`}
              </ItemDescription>
              <ItemDescription className="flex min-w-0 gap-1 text-xs">
                <ScheduleTargets summary={row.targets} />
                <span aria-hidden="true">·</span>
                <span className="shrink-0 tabular-nums">
                  {t("page.priorityValue", { priority: schedule.priority })}
                </span>
              </ItemDescription>
            </ItemContent>
            <ItemActions className="self-start">
              <ActionMenuButton
                label={t("page.actions.actionsFor", { name: schedule.name })}
                actions={actionsFor(row)}
                variant="ghost"
                size="icon-sm"
                triggerIcon={<EllipsisVertical aria-hidden="true" />}
              />
            </ItemActions>
          </Item>
        );
      })}
    </ItemGroup>
  );
}

export function ScheduleCompactListSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div aria-hidden="true" className="flex flex-col gap-1">
      {Array.from({ length: rows }, (_, index) => (
        <Item key={index} size="sm" variant="outline">
          <ItemContent>
            <Skeleton className="h-4 w-2/5" />
            <div className="flex items-center gap-2">
              <Skeleton className="h-5 w-16 rounded-4xl" />
              <Skeleton className="h-4 w-1/3" />
            </div>
            <Skeleton className="h-3 w-3/5" />
            <Skeleton className="h-3 w-1/2" />
          </ItemContent>
          <Skeleton className="size-8" />
        </Item>
      ))}
    </div>
  );
}
