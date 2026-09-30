import { Grid2X2, List, SlidersHorizontal } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ContentCollection,
  ContentFolder,
  ContentTag,
} from "../../api/types";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "../ui/sheet";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { DashboardSearch } from "../DashboardListToolbar";

function PickerSelect({
  label,
  value,
  onChange,
  options,
  className = "w-36",
  showLabel = false,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  className?: string;
  showLabel?: boolean;
}) {
  const control = (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => onChange(next ?? "")}
    >
      <SelectTrigger aria-label={label} className={className}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
  if (!showLabel) return control;
  return (
    <div className="grid gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {control}
    </div>
  );
}

export type ContentPickerFilter =
  "all" | "image" | "video" | "source" | "website" | "youtube" | "calendar";

export function ContentPickerToolbar({
  search,
  filter,
  allowedTypes = ["image", "video", "widget"],
  sort,
  view,
  folders = [],
  collections = [],
  tags = [],
  folderFilter = "",
  collectionFilter = "",
  tagFilter = "",
  onSearch,
  onFilter,
  onFolderFilter,
  onCollectionFilter,
  onTagFilter,
  onSort,
  onView,
}: {
  search: string;
  filter: ContentPickerFilter;
  allowedTypes?: Array<"image" | "video" | "widget">;
  sort: string;
  view: "grid" | "list";
  folders?: ContentFolder[];
  collections?: ContentCollection[];
  tags?: ContentTag[];
  folderFilter?: string;
  collectionFilter?: string;
  tagFilter?: string;
  onSearch: (value: string) => void;
  onFilter: (value: ContentPickerFilter) => void;
  onFolderFilter?: (value: string) => void;
  onCollectionFilter?: (value: string) => void;
  onTagFilter?: (value: string) => void;
  onSort: (value: string) => void;
  onView: (value: "grid" | "list") => void;
}) {
  // A caller that only accepts media should not be offered app types that can
  // never match, and vice versa. The type filter only appears when there is
  // more than one type to choose between.
  const { t } = useTranslation(["content", "common"]);
  const allowed = new Set(allowedTypes);
  const filters: {
    value: ContentPickerFilter;
    label: string;
    type?: "image" | "video" | "widget";
  }[] = [
    { value: "all", label: t("picker.toolbar.filterAll") },
    { value: "image", label: t("picker.toolbar.filterImages"), type: "image" },
    { value: "video", label: t("picker.toolbar.filterVideos"), type: "video" },
    {
      value: "source",
      label: t("picker.toolbar.filterSources"),
      type: "widget",
    },
    {
      value: "website",
      label: t("picker.toolbar.filterWebsites"),
      type: "widget",
    },
    // i18n-ignore: brand name stays Latin in every language
    { value: "youtube", label: "YouTube", type: "widget" },
    {
      value: "calendar",
      label: t("picker.toolbar.filterCalendars"),
      type: "widget",
    },
  ];
  const typeOptions = filters.filter(({ type }) => !type || allowed.has(type));
  const activeFilterCount = [
    filter !== "all",
    Boolean(folderFilter),
    Boolean(collectionFilter),
    Boolean(tagFilter),
  ].filter(Boolean).length;

  const renderSecondaryControls = (mobile: boolean) => (
    <>
      {typeOptions.length > 2 && (
        <PickerSelect
          label={t("picker.toolbar.contentType")}
          value={filter}
          onChange={(value) => onFilter(value as ContentPickerFilter)}
          options={typeOptions.map(({ value, label }) => ({
            value,
            label: value === "all" ? t("picker.toolbar.allTypes") : label,
          }))}
          className={mobile ? "w-full" : "w-32"}
          showLabel={mobile}
        />
      )}
      {folders.length > 0 && onFolderFilter && (
        <PickerSelect
          label={t("picker.toolbar.filterByFolder")}
          value={folderFilter}
          onChange={onFolderFilter}
          options={[
            { value: "", label: t("picker.toolbar.allFolders") },
            ...folders.map((folder) => ({
              value: folder.id,
              label: folder.name,
            })),
          ]}
          className={mobile ? "w-full" : "w-36"}
          showLabel={mobile}
        />
      )}
      {collections.length > 0 && onCollectionFilter && (
        <PickerSelect
          label={t("picker.toolbar.filterByCollection")}
          value={collectionFilter}
          onChange={onCollectionFilter}
          options={[
            { value: "", label: t("picker.toolbar.allCollections") },
            ...collections.map((collection) => ({
              value: collection.id,
              label: collection.name,
            })),
          ]}
          className={mobile ? "w-full" : "w-36"}
          showLabel={mobile}
        />
      )}
      {tags.length > 0 && onTagFilter && (
        <PickerSelect
          label={t("picker.toolbar.filterByTag")}
          value={tagFilter}
          onChange={onTagFilter}
          options={[
            { value: "", label: t("picker.toolbar.allTags") },
            ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
          ]}
          className={mobile ? "w-full" : "w-36"}
          showLabel={mobile}
        />
      )}
      <PickerSelect
        className={mobile ? "w-full" : "w-44"}
        label={t("picker.toolbar.sortContent")}
        value={sort}
        onChange={onSort}
        options={[
          { value: "updated", label: t("picker.toolbar.sortRecent") },
          { value: "newest", label: t("picker.toolbar.sortNewest") },
          { value: "oldest", label: t("picker.toolbar.sortOldest") },
          { value: "name", label: t("picker.toolbar.sortName") },
        ]}
        showLabel={mobile}
      />
      <div className={mobile ? "grid gap-1.5" : "ml-auto"}>
        {mobile && (
          <span className="text-sm font-medium">
            {t("picker.toolbar.contentView")}
          </span>
        )}
        <ToggleGroup
          aria-label={t("picker.toolbar.contentView")}
          variant="outline"
          spacing={0}
          multiple={false}
          value={[view]}
          onValueChange={(next) => {
            const first = next[0] as "grid" | "list" | undefined;
            if (first !== undefined) onView(first);
          }}
        >
          <ToggleGroupItem
            value="grid"
            aria-label={t("picker.toolbar.gridView")}
          >
            <Grid2X2 size={16} aria-hidden="true" />
          </ToggleGroupItem>
          <ToggleGroupItem
            value="list"
            aria-label={t("picker.toolbar.listView")}
          >
            <List size={16} aria-hidden="true" />
          </ToggleGroupItem>
        </ToggleGroup>
      </div>
    </>
  );

  return (
    <div className="flex items-center gap-2">
      <DashboardSearch
        value={search}
        onValueChange={onSearch}
        label={t("picker.toolbar.searchContent")}
        placeholder={t("picker.toolbar.searchContent")}
        clearLabel={t("picker.toolbar.clearContentSearch")}
        className="max-w-none min-w-0 basis-60"
      />
      <div className="hidden min-w-0 flex-1 items-center gap-2 lg:flex">
        {renderSecondaryControls(false)}
      </div>
      <Sheet>
        <SheetTrigger
          render={
            <Button
              type="button"
              variant="outline"
              className="shrink-0 lg:hidden"
            />
          }
        >
          <SlidersHorizontal aria-hidden="true" />
          {t("common:filters.title")}
          {activeFilterCount > 0 && (
            <Badge variant="secondary">{activeFilterCount}</Badge>
          )}
        </SheetTrigger>
        <SheetContent
          side="bottom"
          className="max-h-[82dvh] gap-0 overflow-y-auto rounded-t-xl"
        >
          <SheetHeader>
            <SheetTitle>{t("common:filters.title")}</SheetTitle>
            <SheetDescription className="sr-only">
              {t("picker.toolbar.searchContent")}
            </SheetDescription>
          </SheetHeader>
          <div className="grid gap-4 px-4 pb-5">
            {renderSecondaryControls(true)}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
