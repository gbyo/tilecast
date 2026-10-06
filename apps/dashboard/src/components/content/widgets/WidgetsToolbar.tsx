import {
  ArrowUpDown,
  ChevronDown,
  Grid2X2,
  LayoutGrid,
  List,
} from "lucide-react";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useCompactLayout } from "../../../hooks/use-compact-layout";
import { DashboardSearch } from "../../DashboardListToolbar";
import { useTypedFilter } from "../../FilterBar";
import { Button } from "../../ui/button";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxGroup,
  ComboboxInput,
  ComboboxItem,
  ComboboxLabel,
  ComboboxList,
} from "../../ui/combobox";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../../ui/dropdown-menu";
import { SingleToggleGroup } from "../SingleToggleGroup";
import {
  isWidgetSort,
  humanizeProvider,
  widgetSortOptions,
  type WidgetSort,
  type WidgetTypeGroup,
  type WidgetTypeOption,
  type WidgetView,
} from "./widgetLibraryModel";

export type WidgetsToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  /** Selected provider ID; blank means every Widget type. */
  provider: string;
  onProviderChange: (value: string) => void;
  typeGroups: readonly WidgetTypeGroup[];
  sort: WidgetSort;
  onSortChange: (value: WidgetSort) => void;
  view: WidgetView;
  onViewChange: (value: WidgetView) => void;
};

/**
 * The library's discovery and display controls: search, Widget type, sort, and
 * view. Widget type is the one facet the server supports, so it sits directly
 * in the toolbar instead of behind a Filters button. Phones keep search on its
 * own row, keep type directly reachable, and fold sort and view into one View
 * options menu; exactly one arrangement is mounted.
 */
export function WidgetsToolbar({
  search,
  onSearchChange,
  provider,
  onProviderChange,
  typeGroups,
  sort,
  onSortChange,
  view,
  onViewChange,
}: WidgetsToolbarProps) {
  const { t } = useTranslation("content");
  const compact = useCompactLayout();
  // Typing waits for a pause before it reaches the server query.
  const typedSearch = useTypedFilter(search, onSearchChange);

  return (
    <div
      className="flex flex-wrap items-center gap-2"
      role="group"
      aria-label={t("widgets.list.toolbar.groupLabel")}
    >
      <div className="contents" onBlur={typedSearch.onBlur}>
        <DashboardSearch
          value={typedSearch.value}
          onValueChange={typedSearch.onChange}
          label={t("widgets.list.search")}
          placeholder={t("widgets.list.search")}
          className={
            compact ? "max-w-none basis-full" : "max-w-none min-w-40 basis-40"
          }
        />
      </div>
      <WidgetTypeCombobox
        provider={provider}
        onProviderChange={onProviderChange}
        groups={typeGroups}
        className={compact ? "min-w-0 flex-1 basis-40" : "w-52"}
      />
      {compact ? (
        <WidgetViewOptionsMenu
          sort={sort}
          onSortChange={onSortChange}
          view={view}
          onViewChange={onViewChange}
        />
      ) : (
        <>
          <WidgetSortMenu sort={sort} onSortChange={onSortChange} />
          <SingleToggleGroup
            label={t("widgets.list.view")}
            variant="outline"
            spacing={0}
            value={view}
            onChange={onViewChange}
            options={[
              {
                value: "grid",
                label: <Grid2X2 aria-hidden="true" />,
                text: t("widgets.list.gridView"),
              },
              {
                value: "list",
                label: <List aria-hidden="true" />,
                text: t("widgets.list.listView"),
              },
            ]}
          />
        </>
      )}
    </div>
  );
}

/**
 * Widget type, grouped by the same categories as the creation gallery and
 * searchable by name. Blank means all types, so the "All" entry and the clear
 * button both mean the same thing.
 */
function WidgetTypeCombobox({
  provider,
  onProviderChange,
  groups,
  className,
}: {
  provider: string;
  onProviderChange: (value: string) => void;
  groups: readonly WidgetTypeGroup[];
  className?: string;
}) {
  const { t } = useTranslation("content");
  const all = useMemo<WidgetTypeOption>(
    () => ({ value: "", label: t("widgets.list.allTypes") }),
    [t],
  );
  const items = useMemo<WidgetTypeGroup[]>(
    () => [{ value: "", items: [all] }, ...groups],
    [all, groups],
  );
  // "All" is the empty selection, so the input stays empty and shows the
  // placeholder; typing then filters at once instead of extending a label.
  const selected = useMemo(
    () =>
      provider === ""
        ? null
        : (groups
            .flatMap((group) => group.items)
            .find((item) => item.value === provider) ?? {
            // Kept visible even if the catalog is unavailable, so an applied
            // filter never reads as "All".
            value: provider,
            label: humanizeProvider(provider),
          }),
    [groups, provider],
  );
  const label = t("widgets.list.filterProvider");
  return (
    <Combobox
      items={items}
      value={selected}
      disabled={groups.length === 0 && provider === ""}
      isItemEqualToValue={(item: WidgetTypeOption, next: WidgetTypeOption) =>
        item.value === next.value
      }
      itemToStringLabel={(item: WidgetTypeOption) => item.label}
      onValueChange={(next: WidgetTypeOption | null) =>
        onProviderChange(next?.value ?? "")
      }
    >
      <ComboboxInput
        aria-label={label}
        placeholder={all.label}
        showClear={provider !== ""}
        // Typing replaces the chosen type instead of extending its name.
        onFocus={(event) => event.currentTarget.select()}
        disabled={groups.length === 0 && provider === ""}
        className={className}
      />
      <ComboboxContent className="min-w-64">
        <ComboboxEmpty>{t("widgets.list.noMatchingTypes")}</ComboboxEmpty>
        <ComboboxList>
          {(group: WidgetTypeGroup) => (
            <ComboboxGroup key={group.value || "all"} items={group.items}>
              {group.value !== "" && (
                <ComboboxLabel>{group.value}</ComboboxLabel>
              )}
              <ComboboxCollection>
                {(item: WidgetTypeOption) => (
                  <ComboboxItem key={item.value} value={item}>
                    {item.label}
                  </ComboboxItem>
                )}
              </ComboboxCollection>
            </ComboboxGroup>
          )}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

function useSortLabel() {
  const { t } = useTranslation("content");
  return {
    t,
    sortLabel: (value: WidgetSort) => {
      const option = widgetSortOptions.find((item) => item.value === value);
      return option ? t(option.labelKey) : value;
    },
  };
}

function SortRadioItems({ closeOnClick }: { closeOnClick?: boolean }) {
  const { t } = useTranslation("content");
  return widgetSortOptions.map((option) => (
    <DropdownMenuRadioItem
      key={option.value}
      value={option.value}
      closeOnClick={closeOnClick}
    >
      {t(option.labelKey)}
    </DropdownMenuRadioItem>
  ));
}

/**
 * Sort is a compact menu rather than a Select so its current value costs
 * little width. The label gives way to the icon below the xl width; the
 * accessible name and tooltip keep stating the current sort either way.
 */
function WidgetSortMenu({
  sort,
  onSortChange,
}: {
  sort: WidgetSort;
  onSortChange: (value: WidgetSort) => void;
}) {
  const { t, sortLabel } = useSortLabel();
  const name = t("widgets.list.sort.buttonLabel", { value: sortLabel(sort) });
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" />}
        aria-label={name}
        title={name}
      >
        <ArrowUpDown aria-hidden="true" />
        <span className="max-xl:sr-only">{sortLabel(sort)}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-52">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {t("widgets.list.sort.menuTitle")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(next) => {
              if (isWidgetSort(String(next))) onSortChange(next as WidgetSort);
            }}
          >
            <SortRadioItems closeOnClick />
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** Phone layout: sort and view share one menu with a radio group each. */
function WidgetViewOptionsMenu({
  sort,
  onSortChange,
  view,
  onViewChange,
}: {
  sort: WidgetSort;
  onSortChange: (value: WidgetSort) => void;
  view: WidgetView;
  onViewChange: (value: WidgetView) => void;
}) {
  const { t } = useTranslation("content");
  return (
    <DropdownMenu>
      <DropdownMenuTrigger render={<Button variant="outline" />}>
        <LayoutGrid aria-hidden="true" />
        {t("widgets.list.toolbar.viewOptions")}
        <ChevronDown aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {t("widgets.list.sort.menuTitle")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(next) => {
              if (isWidgetSort(String(next))) onSortChange(next as WidgetSort);
            }}
          >
            <SortRadioItems />
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("widgets.list.view")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={view}
            onValueChange={(next) => {
              const value = String(next);
              if (value === "grid" || value === "list") onViewChange(value);
            }}
          >
            <DropdownMenuRadioItem value="grid">
              {t("widgets.list.viewGrid")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="list">
              {t("widgets.list.viewList")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
