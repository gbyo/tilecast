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

const filterKeys: {
  value: ContentPickerFilter;
  labelKey:
    | "picker.toolbar.filterAll"
    | "picker.toolbar.filterImages"
    | "picker.toolbar.filterVideos"
    | "picker.toolbar.filterSources"
    | "picker.toolbar.filterWebsites"
    | "picker.toolbar.filterYouTube"
    | "picker.toolbar.filterCalendars";
  type?: "image" | "video" | "widget";
}[] = [
  { value: "all", labelKey: "picker.toolbar.filterAll" },
  { value: "image", labelKey: "picker.toolbar.filterImages", type: "image" },
  { value: "video", labelKey: "picker.toolbar.filterVideos", type: "video" },
  { value: "source", labelKey: "picker.toolbar.filterSources", type: "widget" },
  {
    value: "website",
    labelKey: "picker.toolbar.filterWebsites",
    type: "widget",
  },
  {
    value: "youtube",
    labelKey: "picker.toolbar.filterYouTube",
    type: "widget",
  },
  {
    value: "calendar",
    labelKey: "picker.toolbar.filterCalendars",
    type: "widget",
  },
];

const sortKeys = [
  { value: "updated", labelKey: "picker.toolbar.sortRecent" },
  { value: "newest", labelKey: "picker.toolbar.sortNewest" },
  { value: "oldest", labelKey: "picker.toolbar.sortOldest" },
  { value: "name", labelKey: "picker.toolbar.sortName" },
] as const;

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
  const { t } = useTranslation("content");
  // A caller that only accepts media should not be offered app tabs that can never
  // match, and vice versa. "All" stays only when there is more than one thing to pick.
  const allowed = new Set(allowedTypes);
  const filters = filterKeys.filter(({ type }) => !type || allowed.has(type));
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/50 px-6 py-3 max-md:px-4">
      <DashboardSearch
        autoFocus
        value={search}
        onValueChange={onSearch}
        label={t("picker.toolbar.search")}
        placeholder={t("picker.toolbar.search")}
      />
      <ToggleGroup
        className="max-w-full overflow-x-auto"
        aria-label={t("picker.toolbar.typeLabel")}
        multiple={false}
        value={[filter]}
        onValueChange={(next) => {
          const first = next[0] as ContentPickerFilter | undefined;
          if (first !== undefined) onFilter(first);
        }}
      >
        {filters.map(({ value, labelKey }) => (
          <ToggleGroupItem key={value} value={value}>
            {t(labelKey)}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      {folders.length > 0 && onFolderFilter && (
        <PickerSelect
          label={t("picker.toolbar.folderFilter")}
          value={folderFilter}
          onChange={onFolderFilter}
          options={[
            { value: "", label: t("picker.toolbar.foldersAll") },
            ...folders.map((folder) => ({
              value: folder.id,
              label: folder.name,
            })),
          ]}
        />
      )}
      {collections.length > 0 && onCollectionFilter && (
        <PickerSelect
          label={t("picker.toolbar.collectionFilter")}
          value={collectionFilter}
          onChange={onCollectionFilter}
          options={[
            { value: "", label: t("picker.toolbar.collectionsAll") },
            ...collections.map((collection) => ({
              value: collection.id,
              label: collection.name,
            })),
          ]}
        />
      )}
      {tags.length > 0 && onTagFilter && (
        <PickerSelect
          label={t("picker.toolbar.tagFilter")}
          value={tagFilter}
          onChange={onTagFilter}
          options={[
            { value: "", label: t("picker.toolbar.tagsAll") },
            ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
          ]}
        />
      )}
      <PickerSelect
        label={t("picker.toolbar.sortLabel")}
        value={sort}
        onChange={onSort}
        options={sortKeys.map(({ value, labelKey }) => ({
          value,
          label: t(labelKey),
        }))}
      />
      <ToggleGroup
        aria-label={t("picker.toolbar.viewLabel")}
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
