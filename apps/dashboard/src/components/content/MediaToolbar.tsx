import {
  ArrowUpDown,
  ChevronDown,
  Grid2X2,
  LayoutGrid,
  List,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { DashboardSearch } from "../DashboardListToolbar";
import { useTypedFilter } from "../FilterBar";
import { Button } from "../ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import { MediaFacetChips, MediaFilters } from "./MediaFilters";
import { SingleToggleGroup } from "./SingleToggleGroup";
import {
  activeMediaFacetCount,
  mediaSortOptions,
  mediaTypeOptions,
  type MediaFacetKey,
  type MediaFacetSources,
  type MediaFacetValues,
  type MediaView,
} from "./mediaToolbarModel";

export type MediaToolbarProps = {
  search: string;
  onSearchChange: (value: string) => void;
  facets: MediaFacetValues;
  onFacetChange: (key: MediaFacetKey, value: string) => void;
  onClearFacets: () => void;
  sources: MediaFacetSources;
  type: string;
  onTypeChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  view: MediaView;
  onViewChange: (value: MediaView) => void;
};

/**
 * The library's discovery and display controls: Search, Filters, media type,
 * sort, and view. Active facets surface as chips on a second row only while
 * there are any. Phones keep Search on its own row and fold type, sort, and
 * view into one View options menu; exactly one arrangement is mounted.
 */
export function MediaToolbar({
  search,
  onSearchChange,
  facets,
  onFacetChange,
  onClearFacets,
  sources,
  type,
  onTypeChange,
  sort,
  onSortChange,
  view,
  onViewChange,
}: MediaToolbarProps) {
  const { t } = useTranslation("content");
  const compact = useCompactLayout();
  const typedSearch = useTypedFilter(search, onSearchChange);
  const facetsActive = activeMediaFacetCount(facets) > 0;

  return (
    <div className="space-y-2">
      <div
        className="flex flex-wrap items-center gap-2"
        role="group"
        aria-label={t("media.toolbar.groupLabel")}
      >
        <div className="contents" onBlur={typedSearch.onBlur}>
          <DashboardSearch
            value={typedSearch.value}
            onValueChange={typedSearch.onChange}
            label={t("media.toolbar.search")}
            placeholder={t("media.toolbar.search")}
            className={
              compact ? "max-w-none basis-full" : "max-w-none min-w-40 basis-40"
            }
          />
        </div>
        <MediaFilters
          values={facets}
          onChange={onFacetChange}
          onReset={onClearFacets}
          sources={sources}
        />
        {compact ? (
          <MediaViewOptionsMenu
            type={type}
            onTypeChange={onTypeChange}
            sort={sort}
            onSortChange={onSortChange}
            view={view}
            onViewChange={onViewChange}
          />
        ) : (
          <>
            <MediaTypeToggle type={type} onTypeChange={onTypeChange} />
            <MediaSortMenu sort={sort} onSortChange={onSortChange} />
            <MediaViewToggle view={view} onViewChange={onViewChange} />
          </>
        )}
      </div>
      {facetsActive && (
        <MediaFacetChips
          values={facets}
          onChange={onFacetChange}
          onClear={onClearFacets}
          sources={sources}
        />
      )}
    </div>
  );
}

function useOptionLabels() {
  const { t } = useTranslation("content");
  const sortLabel = (value: string) => {
    const option = mediaSortOptions.find((item) => item.value === value);
    return option ? t(option.labelKey) : value;
  };
  return { t, sortLabel };
}

function MediaTypeToggle({
  type,
  onTypeChange,
}: {
  type: string;
  onTypeChange: (value: string) => void;
}) {
  const { t } = useTranslation("content");
  return (
    <SingleToggleGroup
      label={t("media.toolbar.typeFilters")}
      variant="outline"
      spacing={0}
      value={type}
      onChange={onTypeChange}
      options={mediaTypeOptions.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
        text: t(option.labelKey),
      }))}
    />
  );
}

/**
 * Sort is a compact menu rather than a Select so its current value costs no
 * permanent width. The label gives way to the icon below the xl width; the
 * accessible name and tooltip keep stating the current sort either way.
 */
function MediaSortMenu({
  sort,
  onSortChange,
}: {
  sort: string;
  onSortChange: (value: string) => void;
}) {
  const { t, sortLabel } = useOptionLabels();
  const name = t("media.toolbar.sortButtonLabel", { value: sortLabel(sort) });
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
            {t("media.toolbar.sortMenuTitle")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(next) => onSortChange(String(next))}
          >
            {mediaSortOptions.map((option) => (
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

function MediaViewToggle({
  view,
  onViewChange,
}: {
  view: MediaView;
  onViewChange: (value: MediaView) => void;
}) {
  const { t } = useTranslation("content");
  return (
    <SingleToggleGroup
      label={t("media.toolbar.viewLabel")}
      variant="outline"
      spacing={0}
      value={view}
      onChange={onViewChange}
      options={[
        {
          value: "grid",
          label: <Grid2X2 aria-hidden="true" />,
          text: t("picker.toolbar.gridView"),
        },
        {
          value: "list",
          label: <List aria-hidden="true" />,
          text: t("picker.toolbar.listView"),
        },
      ]}
    />
  );
}

/**
 * Phone layout: media type, sort, and view share one menu. It organizes what
 * is shown, so it is kept apart from Filters, which narrows the data.
 */
function MediaViewOptionsMenu({
  type,
  onTypeChange,
  sort,
  onSortChange,
  view,
  onViewChange,
}: {
  type: string;
  onTypeChange: (value: string) => void;
  sort: string;
  onSortChange: (value: string) => void;
  view: MediaView;
  onViewChange: (value: MediaView) => void;
}) {
  const { t } = useOptionLabels();
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="outline" className="ml-auto" />}
      >
        <LayoutGrid aria-hidden="true" />
        {t("media.toolbar.viewOptions")}
        <ChevronDown aria-hidden="true" className="text-muted-foreground" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-56">
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {t("media.toolbar.typeFilters")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={type}
            onValueChange={(next) => onTypeChange(String(next))}
          >
            {mediaTypeOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>
            {t("media.toolbar.sortMenuTitle")}
          </DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sort}
            onValueChange={(next) => onSortChange(String(next))}
          >
            {mediaSortOptions.map((option) => (
              <DropdownMenuRadioItem key={option.value} value={option.value}>
                {t(option.labelKey)}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
        <DropdownMenuSeparator />
        <DropdownMenuGroup>
          <DropdownMenuLabel>{t("media.toolbar.viewLabel")}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={view}
            onValueChange={(next) => onViewChange(next as MediaView)}
          >
            <DropdownMenuRadioItem value="grid">
              {t("media.toolbar.viewGrid")}
            </DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="list">
              {t("media.toolbar.viewList")}
            </DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
