import { Grid2X2, List } from "lucide-react";
import type {
  ContentCollection,
  ContentFolder,
  ContentTag,
} from "../../api/types";
import { ToggleGroup } from "../ToggleGroup";
import {
  Select as RheaSelect,
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
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  placeholder?: string;
}) {
  const selected = options.find((option) => option.value === value);
  return (
    <RheaSelect value={value} onValueChange={(next) => onChange(next ?? "")}>
      <SelectTrigger aria-label={label} size="sm">
        <SelectValue placeholder={placeholder}>
          {selected?.label ?? placeholder ?? value}
        </SelectValue>
      </SelectTrigger>
      <SelectContent>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </RheaSelect>
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
  return (
    <div className="content-picker-toolbar">
      <DashboardSearch
        autoFocus
        value={search}
        onValueChange={onSearch}
        label="Search content"
        placeholder="Search content"
      />
      <ToggleGroup
        className="content-picker-filters"
        label="Content type"
        value={filter}
        onValueChange={onFilter}
        items={filters
          .filter(({ type }) => !type || allowed.has(type))
          .map(({ value, label }) => ({ value, label }))}
      />
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
        label="Content view"
        value={view}
        onValueChange={onView}
        items={[
          {
            value: "grid",
            label: <Grid2X2 size={16} aria-label="Grid view" />,
          },
          {
            value: "list",
            label: <List size={16} aria-label="List view" />,
          },
        ]}
      />
    </div>
  );
}
