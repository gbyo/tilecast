import { Grid2X2, List } from "lucide-react";
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
  className = "w-36",
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  className?: string;
}) {
  return (
    <Select
      items={options}
      value={value}
      onValueChange={(next) => onChange(next ?? "")}
    >
      <SelectTrigger
        aria-label={label}
        className={`${className} max-sm:flex-1`}
      >
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
  // A caller that only accepts media should not be offered app types that can
  // never match, and vice versa. The type filter only appears when there is
  // more than one type to choose between.
  const allowed = new Set(allowedTypes);
  const filters: {
    value: ContentPickerFilter;
    label: string;
    type?: "image" | "video" | "widget";
  }[] = [
    { value: "all", label: "All" },
    { value: "image", label: "Images", type: "image" },
    { value: "video", label: "Videos", type: "video" },
    { value: "source", label: "Sources", type: "widget" },
    { value: "website", label: "Websites", type: "widget" },
    { value: "youtube", label: "YouTube", type: "widget" },
    { value: "calendar", label: "Calendars", type: "widget" },
  ];
  const typeOptions = filters.filter(({ type }) => !type || allowed.has(type));
  return (
    <div className="flex flex-wrap items-center gap-2">
      <DashboardSearch
        autoFocus
        value={search}
        onValueChange={onSearch}
        label="Search content"
        placeholder="Search content"
        className="max-w-none basis-60"
      />
      {typeOptions.length > 2 && (
        <PickerSelect
          label="Content type"
          value={filter}
          onChange={(value) => onFilter(value as ContentPickerFilter)}
          options={typeOptions.map(({ value, label }) => ({
            value,
            label: value === "all" ? "All types" : label,
          }))}
          className="w-32"
        />
      )}
      {folders.length > 0 && onFolderFilter && (
        <PickerSelect
          label="Filter by folder"
          value={folderFilter}
          onChange={onFolderFilter}
          options={[
            { value: "", label: "All folders" },
            ...folders.map((folder) => ({
              value: folder.id,
              label: folder.name,
            })),
          ]}
        />
      )}
      {collections.length > 0 && onCollectionFilter && (
        <PickerSelect
          label="Filter by collection"
          value={collectionFilter}
          onChange={onCollectionFilter}
          options={[
            { value: "", label: "All collections" },
            ...collections.map((collection) => ({
              value: collection.id,
              label: collection.name,
            })),
          ]}
        />
      )}
      {tags.length > 0 && onTagFilter && (
        <PickerSelect
          label="Filter by tag"
          value={tagFilter}
          onChange={onTagFilter}
          options={[
            { value: "", label: "All tags" },
            ...tags.map((tag) => ({ value: tag.id, label: tag.name })),
          ]}
        />
      )}
      <PickerSelect
        className="w-44"
        label="Sort content"
        value={sort}
        onChange={onSort}
        options={[
          { value: "updated", label: "Recently updated" },
          { value: "newest", label: "Newest" },
          { value: "oldest", label: "Oldest" },
          { value: "name", label: "Name" },
        ]}
      />
      <ToggleGroup
        className="ml-auto"
        aria-label="Content view"
        variant="outline"
        spacing={0}
        multiple={false}
        value={[view]}
        onValueChange={(next) => {
          const first = next[0] as "grid" | "list" | undefined;
          if (first !== undefined) onView(first);
        }}
      >
        <ToggleGroupItem value="grid" aria-label="Grid view">
          <Grid2X2 size={16} aria-hidden="true" />
        </ToggleGroupItem>
        <ToggleGroupItem value="list" aria-label="List view">
          <List size={16} aria-hidden="true" />
        </ToggleGroupItem>
      </ToggleGroup>
    </div>
  );
}
