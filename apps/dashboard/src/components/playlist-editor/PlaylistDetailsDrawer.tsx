import { Save, Tag, X } from "lucide-react";
import type { ContentTag } from "../../api/types";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerHeader,
  DrawerTitle,
} from "../ui/drawer";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "../ui/sheet";
import { Textarea } from "../ui/textarea";

const sourceTypeOptions = [
  { value: "static", label: "Manual timeline" },
  { value: "tag", label: "Automatically from media tags" },
];

const tagMatchOptions = [
  { value: "any", label: "Any selected tag" },
  { value: "all", label: "All selected tags" },
];

export function PlaylistDetailsDrawer({
  desktop,
  open,
  canManage,
  sourceType,
  name,
  description,
  tagMatch,
  tagIds,
  tagImageSeconds,
  tags,
  metadataDirty,
  tagRuleDirty,
  metadataSaving,
  tagRuleSaving,
  metadataError,
  tagRuleError,
  onClose,
  onNameChange,
  onDescriptionChange,
  onSourceTypeChange,
  onTagMatchChange,
  onTagToggle,
  onTagImageSecondsChange,
  onSaveMetadata,
  onSaveTagRule,
}: {
  desktop: boolean;
  open: boolean;
  canManage: boolean;
  sourceType: "static" | "tag";
  name: string;
  description: string;
  tagMatch: "any" | "all";
  tagIds: string[];
  tagImageSeconds: number;
  tags: ContentTag[];
  metadataDirty: boolean;
  tagRuleDirty: boolean;
  metadataSaving: boolean;
  tagRuleSaving: boolean;
  metadataError?: string;
  tagRuleError?: string;
  onClose: () => void;
  onNameChange: (value: string) => void;
  onDescriptionChange: (value: string) => void;
  onSourceTypeChange: (value: "static" | "tag") => void;
  onTagMatchChange: (value: "any" | "all") => void;
  onTagToggle: (tagId: string) => void;
  onTagImageSecondsChange: (value: number) => void;
  onSaveMetadata: () => void;
  onSaveTagRule: () => void;
}) {
  const sections = (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 pb-4">
      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Details</h3>
        <Field>
          <FieldLabel htmlFor="playlist-details-name">Name</FieldLabel>
          <Input
            id="playlist-details-name"
            disabled={!canManage}
            value={name}
            onChange={(event) => onNameChange(event.target.value)}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="playlist-details-description">
            Description
          </FieldLabel>
          <Textarea
            id="playlist-details-description"
            disabled={!canManage}
            value={description}
            onChange={(event) => onDescriptionChange(event.target.value)}
          />
        </Field>
        {metadataError && (
          <Alert variant="destructive">
            <AlertDescription>{metadataError}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            type="button"
            size="sm"
            disabled={!canManage || !metadataDirty || metadataSaving}
            onClick={onSaveMetadata}
          >
            <Save size={14} aria-hidden="true" />
            {metadataSaving ? "Saving…" : "Save details"}
          </Button>
        </div>
      </section>

      <section className="grid gap-3">
        <h3 className="text-sm font-medium">Content source</h3>
        <p className="text-sm text-muted-foreground">
          Choose a manual timeline or let matching ready media appear from tags.
        </p>
        <Field>
          <FieldLabel htmlFor="playlist-details-source">Source</FieldLabel>
          <Select
            disabled={!canManage}
            value={sourceType}
            onValueChange={(next) =>
              onSourceTypeChange(next as "static" | "tag")
            }
            items={sourceTypeOptions}
          >
            <SelectTrigger id="playlist-details-source" aria-label="Source">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {sourceTypeOptions.map((option) => (
                <SelectItem key={option.value} value={option.value}>
                  {option.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Field>

        {sourceType === "tag" && (
          <>
            <Field>
              <FieldLabel htmlFor="playlist-details-match">Match</FieldLabel>
              <Select
                disabled={!canManage}
                value={tagMatch}
                onValueChange={(next) =>
                  onTagMatchChange(next as "any" | "all")
                }
                items={tagMatchOptions}
              >
                <SelectTrigger id="playlist-details-match" aria-label="Match">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {tagMatchOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field>
              <span className="text-sm font-medium">Media tags</span>
              <div className="flex flex-wrap gap-2">
                {tags.length ? (
                  tags.map((tag) => {
                    const active = tagIds.includes(tag.id);
                    return (
                      <Button
                        key={tag.id}
                        type="button"
                        variant={active ? "default" : "outline"}
                        size="sm"
                        aria-pressed={active}
                        disabled={!canManage}
                        onClick={() => onTagToggle(tag.id)}
                      >
                        <span
                          className="size-2 rounded-full"
                          style={{ backgroundColor: tag.color }}
                          aria-hidden="true"
                        />
                        {tag.name}
                      </Button>
                    );
                  })
                ) : (
                  <span className="text-sm text-muted-foreground">
                    No tags available
                  </span>
                )}
              </div>
            </Field>
            <Field>
              <FieldLabel htmlFor="playlist-details-image-duration">
                Image duration
              </FieldLabel>
              <div className="flex items-center gap-2">
                <Input
                  id="playlist-details-image-duration"
                  className="w-28"
                  type="number"
                  min="1"
                  max="86400"
                  disabled={!canManage}
                  value={tagImageSeconds}
                  onChange={(event) =>
                    onTagImageSecondsChange(Number(event.target.value))
                  }
                />
                <span className="text-sm text-muted-foreground">seconds</span>
              </div>
              <FieldDescription>
                Applied to matching image content.
              </FieldDescription>
            </Field>
            {tagIds.length === 0 && (
              <p className="text-sm text-muted-foreground">
                Select at least one tag before saving this source.
              </p>
            )}
          </>
        )}
        {tagRuleError && (
          <Alert variant="destructive">
            <AlertDescription>{tagRuleError}</AlertDescription>
          </Alert>
        )}
        <div>
          <Button
            type="button"
            size="sm"
            disabled={
              !canManage ||
              !tagRuleDirty ||
              tagRuleSaving ||
              (sourceType === "tag" && tagIds.length === 0)
            }
            onClick={onSaveTagRule}
          >
            <Tag size={14} aria-hidden="true" />
            {tagRuleSaving ? "Saving…" : "Save content source"}
          </Button>
        </div>
      </section>
    </div>
  );
  const eyebrow =
    sourceType === "tag" ? "Tag-driven playlist" : "Playlist settings";
  const closeButton = (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="absolute top-2 right-3"
      aria-label="Close playlist details"
      onClick={onClose}
    >
      <X aria-hidden="true" />
    </Button>
  );

  if (desktop) {
    return (
      <Sheet
        open={open}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent
          side="right"
          showCloseButton={false}
          className="overflow-hidden"
        >
          <SheetHeader className="relative pr-12">
            <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
              {eyebrow}
            </p>
            <SheetTitle>Playlist details</SheetTitle>
            <SheetDescription>
              Name and description are saved separately from timeline edits.
            </SheetDescription>
            {closeButton}
          </SheetHeader>
          {sections}
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Drawer
      open={open}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      showSwipeHandle
    >
      <DrawerContent className="max-h-[calc(100dvh-2rem)]">
        <DrawerHeader className="relative pr-12">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {eyebrow}
          </p>
          <DrawerTitle>Playlist details</DrawerTitle>
          <DrawerDescription>
            Name and description are saved separately from timeline edits.
          </DrawerDescription>
          {closeButton}
        </DrawerHeader>
        {sections}
      </DrawerContent>
    </Drawer>
  );
}
