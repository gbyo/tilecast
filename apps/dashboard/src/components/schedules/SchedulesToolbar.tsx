import { ArrowUpDown } from "lucide-react";
import { useTranslation } from "react-i18next";
import { DashboardSearch } from "../DashboardListToolbar";
import { CollectionToolbar } from "../collection/CollectionToolbar";
import { useTypedFilter } from "../FilterBar";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import type { ScheduleSort } from "../../api/types";
import { ScheduleFacetChips, ScheduleFilters } from "./ScheduleFilters";
import {
  activeScheduleFacetCount,
  scheduleSortOptions,
  type ScheduleFacetKey,
  type ScheduleFacetValues,
} from "./scheduleLibraryModel";

export type SchedulesToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  facets: ScheduleFacetValues;
  onFacetChange: (key: ScheduleFacetKey, value: string) => void;
  onClearFacets: () => void;
  sort: ScheduleSort;
  onSortChange: (value: ScheduleSort) => void;
};

/**
 * Search, Filters, and Sort. Schedules have one useful presentation, so there
 * is no view control. Active facets surface as chips on a second row only
 * while there are any. Phones put Search on its own row; exactly one
 * arrangement of each control is mounted.
 */
export function SchedulesToolbar({
  search,
  onSearchChange,
  facets,
  onFacetChange,
  onClearFacets,
  sort,
  onSortChange,
}: SchedulesToolbarProps) {
  const { t } = useTranslation("schedules");
  const compact = useCompactLayout();
  const typedSearch = useTypedFilter(search, onSearchChange);

  return (
    <CollectionToolbar
      label={t("toolbar.groupLabel")}
      search={
        <div className="contents" onBlur={typedSearch.onBlur}>
          <DashboardSearch
            value={typedSearch.value}
            onValueChange={typedSearch.onChange}
            label={t("toolbar.search")}
            placeholder={t("toolbar.search")}
            className="max-w-none"
          />
        </div>
      }
      filters={
        <ScheduleFilters
          values={facets}
          onChange={onFacetChange}
          onReset={onClearFacets}
        />
      }
      organize={
        <ScheduleSortMenu
          sort={sort}
          onSortChange={onSortChange}
          compact={compact}
        />
      }
      below={
        activeScheduleFacetCount(facets) > 0 ? (
          <ScheduleFacetChips
            values={facets}
            onChange={onFacetChange}
            onClear={onClearFacets}
          />
        ) : undefined
      }
    />
  );
}

/**
 * Sort is a compact menu so its current value costs no permanent width. The
 * label gives way to the icon below the xl width on desktop; the accessible
 * name and tooltip keep stating the current sort either way. On phones the
 * button reads just "Sort", pushed to the end of its row.
 */
function ScheduleSortMenu({
  sort,
  onSortChange,
  compact,
}: {
  sort: ScheduleSort;
  onSortChange: (value: ScheduleSort) => void;
  compact: boolean;
}) {
  const { t } = useTranslation("schedules");
  const current = scheduleSortOptions.find((option) => option.value === sort);
  const currentLabel = current ? t(current.labelKey) : sort;
  const name = t("toolbar.sortButtonLabel", { value: currentLabel });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" className={compact ? "ml-auto" : ""} />
        }
        aria-label={name}
        title={name}
      >
        <ArrowUpDown aria-hidden="true" />
        {compact ? (
          t("toolbar.sortShort")
        ) : (
          <span className="max-xl:sr-only">{currentLabel}</span>
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("toolbar.sortMenuTitle")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(next) => onSortChange(next as ScheduleSort)}
          >
            {scheduleSortOptions.map((option) => (
              <DropdownMenuRadioItem
                key={option.value}
                value={option.value}
                closeOnClick
              >
                {t(option.labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
