import type { ReactNode } from "react";
import type { ContentTag } from "../../api/types";
import { Alert, AlertDescription } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../ui/field";
import { Input } from "../ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
  InputGroupText,
} from "../ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
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
import { Spinner } from "../ui/spinner";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../ui/tabs";
import { Textarea } from "../ui/textarea";
import { Toggle } from "../ui/toggle";

export type PlaylistDetailsTab = "general" | "source" | "usage";

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
  tab,
  canManage,
  sourceType,
  name,
  description,
  tagMatch,
  tagIds,
  tagImageSeconds,
  tags,
  usage,
  metadataDirty,
  tagRuleDirty,
  metadataSaving,
  tagRuleSaving,
  metadataError,
  tagRuleError,
  onTabChange,
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
  tab: PlaylistDetailsTab;
  canManage: boolean;
  sourceType: "static" | "tag";
  name: string;
  description: string;
  tagMatch: "any" | "all";
  tagIds: string[];
  tagImageSeconds: number;
  tags: ContentTag[];
  /** The Used By composition shown under the Usage tab. */
  usage: ReactNode;
  metadataDirty: boolean;
  tagRuleDirty: boolean;
  metadataSaving: boolean;
  tagRuleSaving: boolean;
  metadataError?: string;
  tagRuleError?: string;
  onTabChange: (tab: PlaylistDetailsTab) => void;
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
  const body = (
    <Tabs
      value={tab}
      onValueChange={(value) => onTabChange(value as PlaylistDetailsTab)}
      className="min-h-0 flex-1 gap-0"
    >
      <TabsList variant="line" className="mx-4 shrink-0">
        <TabsTrigger value="general">General</TabsTrigger>
        <TabsTrigger value="source">Content source</TabsTrigger>
        <TabsTrigger value="usage">Usage</TabsTrigger>
      </TabsList>
      <div className="min-h-0 flex-1 overflow-y-auto border-t px-4 pt-5 pb-4">
        <TabsContent value="general">
          <FieldGroup>
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
              <FieldDescription>
                Saved separately from timeline edits.
              </FieldDescription>
            </Field>
            {metadataError && (
              <Alert variant="destructive">
                <AlertDescription>{metadataError}</AlertDescription>
              </Alert>
            )}
            <div>
              <Button
                type="button"
                disabled={!canManage || !metadataDirty || metadataSaving}
                onClick={onSaveMetadata}
              >
                {metadataSaving && <Spinner aria-hidden="true" />}
                Save details
              </Button>
            </div>
          </FieldGroup>
        </TabsContent>

        <TabsContent value="source">
          <FieldGroup>
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
              <FieldDescription>
                Choose a manual timeline, or let matching ready media appear
                from tags.
              </FieldDescription>
            </Field>

            {sourceType === "tag" && (
              <>
                <Field>
                  <FieldLabel htmlFor="playlist-details-match">
                    Match
                  </FieldLabel>
                  <Select
                    disabled={!canManage}
                    value={tagMatch}
                    onValueChange={(next) =>
                      onTagMatchChange(next as "any" | "all")
                    }
                    items={tagMatchOptions}
                  >
                    <SelectTrigger
                      id="playlist-details-match"
                      aria-label="Match"
                    >
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
                <FieldSet>
                  <FieldLegend variant="label">Media tags</FieldLegend>
                  <div className="flex flex-wrap gap-2">
                    {tags.length ? (
                      tags.map((tag) => (
                        <Toggle
                          key={tag.id}
                          variant="outline"
                          size="sm"
                          pressed={tagIds.includes(tag.id)}
                          disabled={!canManage}
                          onPressedChange={() => onTagToggle(tag.id)}
                        >
                          <span
                            className="size-2 rounded-full"
                            style={{ backgroundColor: tag.color }}
                            aria-hidden="true"
                          />
                          {tag.name}
                        </Toggle>
                      ))
                    ) : (
                      <span className="text-sm text-muted-foreground">
                        No tags available
                      </span>
                    )}
                  </div>
                  {tagIds.length === 0 && (
                    <FieldDescription>
                      Select at least one tag before saving this source.
                    </FieldDescription>
                  )}
                </FieldSet>
                <Field>
                  <FieldLabel htmlFor="playlist-details-image-duration">
                    Image duration
                  </FieldLabel>
                  <InputGroup className="w-32">
                    <InputGroupInput
                      id="playlist-details-image-duration"
                      type="number"
                      min="1"
                      max="86400"
                      disabled={!canManage}
                      value={tagImageSeconds}
                      onChange={(event) =>
                        onTagImageSecondsChange(Number(event.target.value))
                      }
                    />
                    <InputGroupAddon align="inline-end">
                      <InputGroupText>seconds</InputGroupText>
                    </InputGroupAddon>
                  </InputGroup>
                  <FieldDescription>
                    Applied to matching image content.
                  </FieldDescription>
                </Field>
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
                disabled={
                  !canManage ||
                  !tagRuleDirty ||
                  tagRuleSaving ||
                  (sourceType === "tag" && tagIds.length === 0)
                }
                onClick={onSaveTagRule}
              >
                {tagRuleSaving && <Spinner aria-hidden="true" />}
                Save content source
              </Button>
            </div>
          </FieldGroup>
        </TabsContent>

        <TabsContent value="usage">{usage}</TabsContent>
      </div>
    </Tabs>
  );

  if (desktop) {
    return (
      <Sheet
        open={open}
        onOpenChange={(open) => {
          if (!open) onClose();
        }}
      >
        <SheetContent side="right" className="gap-0 overflow-hidden">
          <SheetHeader>
            <SheetTitle>Playlist details</SheetTitle>
            <SheetDescription>
              Name, content source, and where this playlist plays.
            </SheetDescription>
          </SheetHeader>
          {body}
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
        <DrawerHeader>
          <DrawerTitle>Playlist details</DrawerTitle>
          <DrawerDescription>
            Name, content source, and where this playlist plays.
          </DrawerDescription>
        </DrawerHeader>
        {body}
        <DrawerFooter className="border-t">
          <DrawerClose render={<Button type="button" variant="outline" />}>
            Done
          </DrawerClose>
        </DrawerFooter>
      </DrawerContent>
    </Drawer>
  );
}
