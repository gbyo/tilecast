import type {
  ContentCollection,
  ContentFolder,
  ContentTag,
} from "../../api/types";
import { Select, ToggleGroup, ViewToggle } from "../legacy-ui";
import { DashboardSearch } from "../DashboardListToolbar";

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
        <Select
          aria-label="Filter by folder"
          value={folderFilter}
          onChange={(event) => onFolderFilter(event.target.value)}
        >
          <option value="">All folders</option>
          {folders.map((folder) => (
            <option key={folder.id} value={folder.id}>
              {folder.name}
            </option>
          ))}
        </Select>
      )}
      {collections.length > 0 && onCollectionFilter && (
        <Select
          aria-label="Filter by collection"
          value={collectionFilter}
          onChange={(event) => onCollectionFilter(event.target.value)}
        >
          <option value="">All collections</option>
          {collections.map((collection) => (
            <option key={collection.id} value={collection.id}>
              {collection.name}
            </option>
          ))}
        </Select>
      )}
      {tags.length > 0 && onTagFilter && (
        <Select
          aria-label="Filter by tag"
          value={tagFilter}
          onChange={(event) => onTagFilter(event.target.value)}
        >
          <option value="">All tags</option>
          {tags.map((tag) => (
            <option key={tag.id} value={tag.id}>
              {tag.name}
            </option>
          ))}
        </Select>
      )}
      <Select
        aria-label="Sort content"
        value={sort}
        onChange={(event) => onSort(event.target.value)}
      >
        <option value="updated">Recently updated</option>
        <option value="newest">Newest</option>
        <option value="oldest">Oldest</option>
        <option value="name">Name</option>
      </Select>
      <ViewToggle value={view} onValueChange={onView} label="Content view" />
    </div>
  );
}
