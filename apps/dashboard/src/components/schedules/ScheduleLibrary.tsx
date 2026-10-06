import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { Schedule } from "../../api/types";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import { useFormatLocale } from "../../i18n";
import type { StudioActionGroup } from "../studio/ActionMenu";
import {
  ScheduleCompactList,
  ScheduleCompactListSkeleton,
} from "./ScheduleCompactList";
import { SchedulesTable, SchedulesTableSkeleton } from "./SchedulesTable";
import {
  schedulePath,
  scheduleRows,
  type ScheduleRow,
} from "./scheduleLibraryModel";

/**
 * The loaded Schedules. Schedules are operational data, so there is one
 * presentation: a table, or on phones a native list instead of a horizontally
 * scrolling table. Exactly one of them is mounted.
 */
export function ScheduleLibrary({
  items,
  now,
  canManage,
  deleting,
  onDelete,
}: {
  items: readonly Schedule[];
  now: Date;
  canManage: boolean;
  deleting: boolean;
  onDelete: (schedule: Schedule) => void;
}) {
  const { t } = useTranslation("schedules");
  const locale = useFormatLocale();
  const navigate = useNavigate();
  const compact = useCompactLayout();
  const rows = useMemo(
    () => scheduleRows(items, t, locale, now),
    [items, t, locale, now],
  );
  // Opening is always offered so the menu is never the only way in: read-only
  // roles get a single entry, managers get Edit and Delete.
  const actionsFor = ({ schedule }: ScheduleRow): StudioActionGroup[] => [
    {
      actions: [
        {
          id: "open",
          label: canManage ? t("page.actions.edit") : t("page.actions.open"),
          icon: canManage ? "edit" : "open",
          onSelect: () => void navigate(schedulePath(schedule)),
        },
      ],
    },
    {
      actions: canManage
        ? [
            {
              id: "delete",
              label: t("page.actions.delete"),
              icon: "delete",
              role: "destructive",
              disabled: deleting,
              onSelect: () => onDelete(schedule),
            },
          ]
        : [],
    },
  ];
  return compact ? (
    <ScheduleCompactList rows={rows} actionsFor={actionsFor} />
  ) : (
    <SchedulesTable rows={rows} actionsFor={actionsFor} />
  );
}

/** A placeholder shaped like the representation that is about to appear. */
export function ScheduleLibrarySkeleton() {
  const { t } = useTranslation("schedules");
  const compact = useCompactLayout();
  return (
    <div role="status" aria-label={t("page.loading")}>
      {compact ? <ScheduleCompactListSkeleton /> : <SchedulesTableSkeleton />}
    </div>
  );
}
