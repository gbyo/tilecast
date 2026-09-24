import { FileImage, FileVideo, Globe2 } from "lucide-react";
import type { Asset } from "../../api/types";
import { AssetPreview } from "../content/AssetPreview";
import { AspectRatio } from "../ui/aspect-ratio";
import { Badge } from "../ui/badge";
import { Card, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Checkbox } from "../ui/checkbox";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../ui/item";
import { Skeleton } from "../ui/skeleton";

export type ContentLibraryProps = {
  items: Asset[];
  selectedIds: Set<string>;
  disabledIds: Set<string>;
  highlightedIds: Set<string>;
  onToggle: (asset: Asset) => void;
};

export function contentTypeLabel(asset: Asset) {
  if (asset.type === "widget") {
    return asset.widget?.provider === "youtube"
      ? "YouTube Widget"
      : "Website Widget";
  }
  return asset.type === "image" ? "Image" : "Video";
}

function statusLabel(status: Asset["processingStatus"]) {
  return (
    {
      ready: "Ready",
      uploading: "Uploading",
      uploaded: "Uploaded",
      queued: "Waiting",
      inspecting: "Inspecting",
      processing: "Processing",
      failed: "Failed",
      deleting: "Deleting",
      deleted: "Deleted",
    } satisfies Record<Asset["processingStatus"], string>
  )[status];
}

// Each library entry is one native checkbox with a label stretched over the
// whole card or row, so clicking anywhere toggles it without nesting
// interactive elements. Only exceptional state earns a Badge.
function entryState(asset: Asset, disabledIds: Set<string>) {
  const alreadyAdded = disabledIds.has(asset.id);
  const status = asset.processingStatus;
  return {
    alreadyAdded,
    disabled: alreadyAdded || status !== "ready",
    badge:
      status === "failed"
        ? { label: "Failed", variant: "destructive" as const }
        : status !== "ready"
          ? { label: statusLabel(status), variant: "secondary" as const }
          : undefined,
  };
}

function EntryCheckbox({
  asset,
  checked,
  disabled,
  className,
  onToggle,
}: {
  asset: Asset;
  checked: boolean;
  disabled: boolean;
  className?: string;
  onToggle: (asset: Asset) => void;
}) {
  return (
    <Checkbox
      id={`content-picker-${asset.id}`}
      aria-labelledby={`content-picker-${asset.id}-name`}
      aria-describedby={`content-picker-${asset.id}-meta`}
      checked={checked}
      disabled={disabled}
      onCheckedChange={() => onToggle(asset)}
      className={className}
    />
  );
}

function EntryLabel({ asset, disabled }: { asset: Asset; disabled: boolean }) {
  return (
    <label
      id={`content-picker-${asset.id}-name`}
      htmlFor={`content-picker-${asset.id}`}
      className={`truncate after:absolute after:inset-0 ${disabled ? "cursor-not-allowed" : "cursor-pointer"}`}
    >
      {asset.name}
    </label>
  );
}

function entryMeta(asset: Asset, alreadyAdded: boolean) {
  return alreadyAdded
    ? `${contentTypeLabel(asset)} · Already added`
    : contentTypeLabel(asset);
}

export function ContentLibraryGrid({
  items,
  selectedIds,
  disabledIds,
  highlightedIds,
  onToggle,
}: ContentLibraryProps) {
  return (
    <ul className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
      {items.map((asset) => {
        const selected = selectedIds.has(asset.id);
        const { alreadyAdded, disabled, badge } = entryState(
          asset,
          disabledIds,
        );
        return (
          <li key={asset.id} className="min-w-0">
            <Card
              size="sm"
              data-selected={selected || undefined}
              data-disabled={disabled || undefined}
              className="relative gap-0 py-0 transition-shadow hover:ring-foreground/25 has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 data-disabled:hover:ring-foreground/10 data-selected:ring-2 data-selected:ring-primary"
            >
              <AspectRatio
                ratio={16 / 9}
                className="grid place-items-center overflow-hidden bg-muted text-muted-foreground group-data-disabled/card:opacity-50 [&>img]:size-full [&>img]:object-cover"
              >
                <AssetPreview asset={asset} />
              </AspectRatio>
              <EntryCheckbox
                asset={asset}
                checked={selected}
                disabled={disabled}
                onToggle={onToggle}
                className="absolute top-2 right-2 z-10 bg-background shadow-sm"
              />
              {(highlightedIds.has(asset.id) || badge) && (
                <div className="pointer-events-none absolute top-2 left-2 z-10 flex gap-1">
                  {highlightedIds.has(asset.id) && <Badge>New</Badge>}
                  {badge && (
                    <Badge variant={badge.variant}>{badge.label}</Badge>
                  )}
                </div>
              )}
              <CardHeader className="gap-0.5 px-3 py-2.5 group-data-disabled/card:opacity-60">
                <CardTitle className="flex min-w-0 text-sm">
                  <EntryLabel asset={asset} disabled={disabled} />
                </CardTitle>
                <CardDescription
                  id={`content-picker-${asset.id}-meta`}
                  className="truncate text-xs"
                >
                  {entryMeta(asset, alreadyAdded)}
                </CardDescription>
              </CardHeader>
            </Card>
          </li>
        );
      })}
    </ul>
  );
}

export function ContentLibraryList({
  items,
  selectedIds,
  disabledIds,
  highlightedIds,
  onToggle,
}: ContentLibraryProps) {
  return (
    <ItemGroup className="gap-1">
      {items.map((asset) => {
        const selected = selectedIds.has(asset.id);
        const { alreadyAdded, disabled, badge } = entryState(
          asset,
          disabledIds,
        );
        return (
          <Item
            key={asset.id}
            role="listitem"
            size="sm"
            variant={selected ? "muted" : "outline"}
            data-disabled={disabled || undefined}
            className="relative flex-nowrap hover:bg-muted/50 has-focus-visible:border-ring has-focus-visible:ring-[3px] has-focus-visible:ring-ring/50 data-disabled:*:data-[slot=item-content]:opacity-60 data-disabled:*:data-[slot=item-media]:opacity-50"
          >
            <EntryCheckbox
              asset={asset}
              checked={selected}
              disabled={disabled}
              onToggle={onToggle}
              className="relative z-10"
            />
            <ItemMedia
              variant="image"
              className="h-10 w-16 place-items-center bg-muted text-muted-foreground"
            >
              {asset.thumbnailUrl ? (
                <AssetPreview asset={asset} />
              ) : (
                <TypeIcon type={asset.type} />
              )}
            </ItemMedia>
            <ItemContent className="min-w-0 gap-0.5">
              <ItemTitle className="w-full min-w-0">
                <EntryLabel asset={asset} disabled={disabled} />
              </ItemTitle>
              <ItemDescription
                id={`content-picker-${asset.id}-meta`}
                className="truncate text-xs"
              >
                {entryMeta(asset, alreadyAdded)}
              </ItemDescription>
            </ItemContent>
            {(highlightedIds.has(asset.id) || badge) && (
              <ItemActions className="gap-1">
                {highlightedIds.has(asset.id) && <Badge>New</Badge>}
                {badge && <Badge variant={badge.variant}>{badge.label}</Badge>}
              </ItemActions>
            )}
          </Item>
        );
      })}
    </ItemGroup>
  );
}

function TypeIcon({ type }: { type: Asset["type"] }) {
  const Icon =
    type === "widget" ? Globe2 : type === "video" ? FileVideo : FileImage;
  return <Icon className="size-4" aria-hidden="true" />;
}

export function ContentLibraryLoading({ view }: { view: "grid" | "list" }) {
  return (
    <div aria-busy="true" aria-label="Loading content">
      {view === "grid" ? (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(9rem,1fr))] gap-3 sm:grid-cols-[repeat(auto-fill,minmax(11rem,1fr))]">
          {Array.from({ length: 8 }, (_, index) => (
            <div key={index} className="grid gap-2">
              <Skeleton className="aspect-video w-full rounded-xl" />
              <Skeleton className="h-4 w-3/4" />
              <Skeleton className="h-3 w-1/3" />
            </div>
          ))}
        </div>
      ) : (
        <div className="grid gap-2">
          {Array.from({ length: 6 }, (_, index) => (
            <Skeleton key={index} className="h-14 w-full" />
          ))}
        </div>
      )}
    </div>
  );
}
