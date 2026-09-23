import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Filter, RotateCcw } from "lucide-react";
import { useLocation } from "react-router";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Popover as RheaPopover,
  PopoverContent,
  PopoverTrigger,
} from "./ui/popover";

type NativeFilter = {
  label: string;
  title: string;
};

const nativeFilters: NativeFilter[] = [
  { label: "Filter by status", title: "Status" },
  { label: "Filter by folder", title: "Folder" },
  { label: "Filter by collection", title: "Collection" },
  { label: "Filter by tag", title: "Tag" },
  { label: "Sort media", title: "Sort" },
];

function dispatchChange(element: HTMLSelectElement, value: string) {
  element.value = value;
  element.dispatchEvent(new Event("change", { bubbles: true }));
}

function typeButtons() {
  return Array.from(
    document.querySelectorAll<HTMLButtonElement>(
      ".content-page:not(.apps-page) .content-type-filters button",
    ),
  );
}

function currentType() {
  const selected = typeButtons().find(
    (button) => button.getAttribute("aria-pressed") === "true",
  );
  return selected?.textContent?.trim().toLowerCase() === "images"
    ? "image"
    : selected?.textContent?.trim().toLowerCase() === "videos"
      ? "video"
      : "media";
}

function setType(value: string) {
  const label =
    value === "image" ? "Images" : value === "video" ? "Videos" : "Media";
  typeButtons()
    .find((button) => button.textContent?.trim() === label)
    ?.click();
}

function nativeSelect(label: string) {
  return document.querySelector<HTMLSelectElement>(
    `.content-page:not(.apps-page) select[aria-label="${label}"]`,
  );
}

export function AssetFilterPortal() {
  const location = useLocation();
  const [target, setTarget] = useState<HTMLElement | null>(null);

  useEffect(() => {
    if (location.pathname !== "/assets") {
      setTarget(null);
      return;
    }
    const root = document.getElementById("root");
    if (!root) return;
    const findTarget = () =>
      setTarget(
        document.querySelector<HTMLElement>(
          ".content-page:not(.apps-page) .content-organizer__create",
        ) ??
          document.querySelector<HTMLElement>(
            ".content-page:not(.apps-page) > .page-header",
          ),
      );
    findTarget();
    const observer = new MutationObserver(findTarget);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [location.pathname]);

  return target ? createPortal(<AssetFilterMenu />, target) : null;
}

function AssetFilterMenu() {
  const [, setRevision] = useState(0);
  const toolbar = document.querySelector<HTMLElement>(
    ".content-page:not(.apps-page) .content-toolbar",
  );

  useEffect(() => {
    if (!toolbar) return;
    const observer = new MutationObserver(() =>
      setRevision((value) => value + 1),
    );
    observer.observe(toolbar, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["aria-pressed", "value"],
    });
    const update = () => setRevision((value) => value + 1);
    toolbar.addEventListener("change", update);
    toolbar.addEventListener("click", update);
    return () => {
      observer.disconnect();
      toolbar.removeEventListener("change", update);
      toolbar.removeEventListener("click", update);
    };
  }, [toolbar]);

  const filters = nativeFilters.map((filter) => ({
    ...filter,
    element: nativeSelect(filter.label),
  }));
  const type = currentType();
  const activeCount =
    (type === "media" ? 0 : 1) +
    filters.reduce((count, filter) => {
      if (!filter.element) return count;
      const isDefaultSort =
        filter.label === "Sort media" && filter.element.value === "updated";
      return count + (filter.element.value && !isDefaultSort ? 1 : 0);
    }, 0);

  return (
    <RheaPopover>
      <PopoverTrigger
        render={<Button variant="ghost" />}
        aria-label={`Filter assets${activeCount > 0 ? `, ${activeCount} active` : ""}`}
      >
        <Filter size={16} aria-hidden="true" />
        <span>Filters</span>
        {activeCount > 0 && <Badge variant="secondary">{activeCount}</Badge>}
      </PopoverTrigger>
      <PopoverContent align="end" aria-label="Filter assets" className="gap-3">
        <div className="flex items-start justify-between gap-3">
          <div className="grid gap-0.5">
            <strong className="text-sm">Filter assets</strong>
            <span className="text-xs text-muted-foreground">
              Show only the files you need.
            </span>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => {
              setType("media");
              for (const filter of filters) {
                if (!filter.element) continue;
                dispatchChange(
                  filter.element,
                  filter.label === "Sort media" ? "updated" : "",
                );
              }
              setRevision((value) => value + 1);
            }}
          >
            <RotateCcw size={14} aria-hidden="true" /> Clear
          </Button>
        </div>
        <label className="grid gap-1 text-xs font-medium">
          Type
          <select
            aria-label="Type"
            className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
            value={type}
            onChange={(event) => {
              setType(event.target.value);
              setRevision((value) => value + 1);
            }}
          >
            <option value="media">All media</option>
            <option value="image">Images</option>
            <option value="video">Videos</option>
          </select>
        </label>
        {filters.map((filter) => (
          <label key={filter.label} className="grid gap-1 text-xs font-medium">
            {filter.title}
            <select
              aria-label={filter.label}
              className="h-8 w-full rounded-md border border-input bg-background px-2 text-sm"
              value={filter.element?.value ?? ""}
              disabled={!filter.element}
              onChange={(event) => {
                if (filter.element)
                  dispatchChange(filter.element, event.target.value);
                setRevision((value) => value + 1);
              }}
            >
              {Array.from(filter.element?.options ?? []).map((option) => (
                <option key={option.value} value={option.value}>
                  {option.text}
                </option>
              ))}
            </select>
          </label>
        ))}
      </PopoverContent>
    </RheaPopover>
  );
}
