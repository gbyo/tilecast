/**
 * The media library's discovery controls. Four organizational facets live
 * behind one Filters surface and show as chips; media type, sort, and view
 * stay visible on their own and are never counted as filters.
 */
export const mediaFacetKeys = [
  "status",
  "folder",
  "collection",
  "tag",
] as const;

export type MediaFacetKey = (typeof mediaFacetKeys)[number];
export type MediaFacetValues = Record<MediaFacetKey, string>;

export type MediaView = "grid" | "list";

export function activeMediaFacetCount(values: MediaFacetValues) {
  return mediaFacetKeys.filter((key) => values[key] !== "").length;
}

/** `media` is the API's "every supported media type" scope; it reads "All". */
export const mediaTypeOptions = [
  { value: "media", labelKey: "picker.toolbar.filterAll" },
  { value: "image", labelKey: "picker.toolbar.filterImages" },
  { value: "video", labelKey: "picker.toolbar.filterVideos" },
] as const;

export const mediaSortOptions = [
  { value: "updated", labelKey: "picker.toolbar.sortRecent" },
  { value: "newest", labelKey: "picker.toolbar.sortNewest" },
  { value: "oldest", labelKey: "picker.toolbar.sortOldest" },
  { value: "name", labelKey: "picker.toolbar.sortName" },
] as const;

export const mediaStatusOptions = [
  { value: "ready", labelKey: "media.status.ready" },
  { value: "queued", labelKey: "media.status.waiting" },
  { value: "inspecting", labelKey: "media.status.inspecting" },
  { value: "processing", labelKey: "media.status.processing" },
  { value: "failed", labelKey: "media.status.failed" },
] as const;

/** The slice of a folder, collection, or tag the facet pickers need. */
export type MediaFacetEntity = {
  id: string;
  name: string;
  assetCount?: number;
};

export type MediaFacetSources = {
  folders: readonly MediaFacetEntity[];
  collections: readonly MediaFacetEntity[];
  tags: readonly MediaFacetEntity[];
};
