import { CircleHelp, EllipsisVertical } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Link } from "react-router";
import { ActionMenuButton } from "../studio/ActionMenu";
import type { StudioActionGroup } from "../studio/ActionMenu";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../ui/table";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import {
  ScheduleStatusBadge,
  SchedulePresentationLabel,
  ScheduleTargets,
} from "./ScheduleCells";
import { schedulePath, type ScheduleRow } from "./scheduleLibraryModel";

// Columns appear as the container grows, not the viewport, because the
// sidebar takes a variable share. Schedule, Status, When, and Actions always
// stay.
const presentationColumn = "hidden @2xl:table-cell";
const targetsColumn = "hidden @4xl:table-cell";
const priorityColumn = "hidden @4xl:table-cell";
const updatedColumn = "hidden @5xl:table-cell";

function SchedulesTableHeader() {
  const { t } = useTranslation("schedules");
  return (
    <TableHeader>
      <TableRow className="hover:bg-transparent">
        <TableHead>{t("page.columns.schedule")}</TableHead>
        <TableHead>{t("page.columns.status")}</TableHead>
        <TableHead>{t("page.columns.when")}</TableHead>
        <TableHead className={presentationColumn}>
          {t("page.columns.presentation")}
        </TableHead>
        <TableHead className={targetsColumn}>
          {t("page.columns.targets")}
        </TableHead>
        <TableHead className={priorityColumn}>
          <span className="inline-flex items-center gap-1">
            {t("page.columns.priority")}
            <PriorityHelp />
          </span>
        </TableHead>
        <TableHead className={updatedColumn}>
          {t("page.columns.updated")}
        </TableHead>
        <TableHead className="w-12">
          <span className="sr-only">{t("page.columns.actions")}</span>
        </TableHead>
      </TableRow>
    </TableHeader>
  );
}

/**
 * Priority is one precedence rule, not the only one, so the help stays short
 * and says only that it decides overlaps between eligible schedules.
 */
function PriorityHelp() {
  const { t } = useTranslation("schedules");
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={t("page.priorityHelpLabel")}
          />
        }
      >
        <CircleHelp aria-hidden="true" />
      </TooltipTrigger>
      <TooltipContent>{t("page.priorityHelp")}</TooltipContent>
    </Tooltip>
  );
}

/** Desktop and tablet: Schedule-specific columns over a semantic table. */
export function SchedulesTable({
  rows,
  actionsFor,
}: {
  rows: readonly ScheduleRow[];
  actionsFor: (row: ScheduleRow) => StudioActionGroup[];
}) {
  const { t } = useTranslation("schedules");
  return (
    <div className="@container">
      <Table>
        <SchedulesTableHeader />
        <TableBody>
          {rows.map((row) => {
            const { schedule } = row;
            const label = t("page.actions.actionsFor", { name: schedule.name });
            return (
              <TableRow key={schedule.id}>
                <TableCell className="max-w-44 min-w-28 whitespace-normal">
                  <Link
                    to={schedulePath(schedule)}
                    className="block truncate rounded-sm font-medium outline-none hover:underline focus-visible:ring-[3px] focus-visible:ring-ring/50"
                    title={schedule.name}
                  >
                    {schedule.name}
                  </Link>
                  {schedule.description && (
                    // A span, not a <p>: the global `p { text-wrap: pretty }`
                    // rule re-enables wrapping and defeats `truncate`.
                    <span
                      className="block truncate text-xs text-muted-foreground"
                      title={schedule.description}
                    >
                      {schedule.description}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <ScheduleStatusBadge enabled={schedule.enabled} />
                </TableCell>
                <TableCell className="whitespace-normal">
                  <div className="min-w-36 tabular-nums">
                    {row.when.summary}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {row.when.detail}
                  </div>
                </TableCell>
                <TableCell className={`${presentationColumn} max-w-40`}>
                  <SchedulePresentationLabel presentation={row.presentation} />
                </TableCell>
                <TableCell
                  className={`${targetsColumn} max-w-40 text-muted-foreground`}
                >
                  <ScheduleTargets summary={row.targets} />
                </TableCell>
                <TableCell className={`${priorityColumn} tabular-nums`}>
                  {schedule.priority}
                </TableCell>
                <TableCell
                  className={`${updatedColumn} whitespace-nowrap text-muted-foreground`}
                >
                  {row.updated}
                </TableCell>
                <TableCell className="text-end">
                  <ActionMenuButton
                    label={label}
                    actions={actionsFor(row)}
                    variant="ghost"
                    size="icon-sm"
                    triggerIcon={<EllipsisVertical aria-hidden="true" />}
                  />
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

/** The real header stays, so the table does not shift when rows arrive. */
export function SchedulesTableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="@container">
      <Table>
        <SchedulesTableHeader />
        <TableBody aria-hidden="true">
          {Array.from({ length: rows }, (_, index) => (
            <TableRow key={index} className="hover:bg-transparent">
              <TableCell>
                <Skeleton className="h-4 w-40" />
                <Skeleton className="mt-1.5 h-3 w-28" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-5 w-16 rounded-4xl" />
              </TableCell>
              <TableCell>
                <Skeleton className="h-4 w-36" />
                <Skeleton className="mt-1.5 h-3 w-24" />
              </TableCell>
              <TableCell className={presentationColumn}>
                <Skeleton className="h-4 w-36" />
              </TableCell>
              <TableCell className={targetsColumn}>
                <Skeleton className="h-4 w-32" />
              </TableCell>
              <TableCell className={priorityColumn}>
                <Skeleton className="h-4 w-8" />
              </TableCell>
              <TableCell className={updatedColumn}>
                <Skeleton className="h-4 w-20" />
              </TableCell>
              <TableCell className="w-12">
                <Skeleton className="size-8" />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
