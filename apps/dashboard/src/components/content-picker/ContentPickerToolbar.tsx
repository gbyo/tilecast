import { Grid2X2, List } from "lucide-react";
import { useTranslation } from "react-i18next";
import type {
  ContentCollection,
  ContentFolder,
  ContentTag,
} from "../../api/types";
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
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => onChange(next ?? "")}
    >
      <SelectTrigger aria-label={label} className="w-44 max-sm:flex-1">
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
  // A caller that only accepts media should not be offered app tabs that can never
  // match, and vice versa. "All" stays only when there is more than one thing to pick.
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
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-6 py-3 max-md:px-4">
      <DashboardSearch
        autoFocus
        value={search}
        onValueChange={onSearch}
        label={t("picker.toolbar.searchContent")}
        placeholder={t("picker.toolbar.searchContent")}
        clearLabel={t("picker.toolbar.clearContentSearch")}
      />
      <ToggleGroup
        className="max-w-full overflow-x-auto"
        aria-label={t("picker.toolbar.contentType")}
        multiple={false}
        value={[filter]}
        onValueChange={(next) => {
          const first = next[0] as ContentPickerFilter | undefined;
          if (first !== undefined) onFilter(first);
        }}
      >
        {filters
          .filter(({ type }) => !type || allowed.has(type))
          .map(({ value, label }) => (
            <ToggleGroupItem key={value} value={value}>
              {label}
            </ToggleGroupItem>
          ))}
      </ToggleGroup>
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
        />
      )}
      <PickerSelect
        label={t("picker.toolbar.sortContent")}
        value={sort}
        onChange={onSort}
        options={[
          { value: "updated", label: t("picker.toolbar.sortRecent") },
          { value: "newest", label: t("picker.toolbar.sortNewest") },
          { value: "oldest", label: t("picker.toolbar.sortOldest") },
          { value: "name", label: t("picker.toolbar.sortName") },
        ]}
      />
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
        <ToggleGroupItem value="grid" aria-label={t("picker.toolbar.gridView")}>
          <Grid2X2 size={16} aria-hidden="true" />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label={t("picker.toolbar.listView")}>
          <List size={16} aria-hidden="true" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
