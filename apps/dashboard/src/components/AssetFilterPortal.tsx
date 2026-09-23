import { Popover, Select } from "./legacy-ui";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Filter, RotateCcw } from "lucide-react";
import { useLocation } from "react-router";

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
    <Popover
      label="Filter assets"
      className="asset-filter-menu"
      panelClassName="asset-filter-menu__panel"
      align="end"
      trigger={(props) => (
        <button type="button" className="button button--quiet" {...props}>
          <Filter size={16} aria-hidden="true" />
          Filters
          {activeCount > 0 && (
            <span className="signal-popover__count">{activeCount}</span>
          )}
        </button>
      )}
    >
      <div className="signal-popover__header">
        <div>
          <strong>Filter assets</strong>
          <span>Show only the files you need.</span>
        </div>
        <button
          type="button"
          className="button button--quiet button--compact"
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
        </button>
      </div>
      <label>
        Type
        <Select
          value={type}
          onChange={(event) => {
            setType(event.target.value);
            setRevision((value) => value + 1);
          }}
        >
          <option value="media">All media</option>
          <option value="image">Images</option>
          <option value="video">Videos</option>
        </Select>
      </label>
      {filters.map((filter) => (
        <label key={filter.label}>
          {filter.title}
          <Select
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
          </Select>
        </label>
      ))}
    </Popover>
  );
}
