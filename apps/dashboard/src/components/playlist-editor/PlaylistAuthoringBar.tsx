import { ChevronDown, Info, PanelsTopLeft, Plus, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import type { PlaylistItem } from "../../api/types";
import { Button } from "../ui/button";
import { ButtonGroup, ButtonGroupSeparator } from "../ui/button-group";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Field, FieldLabel } from "../ui/field";
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
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import type {
  ImageDurationSummary,
  PlaylistTransition,
} from "./playlistEditorModel";

const transitionOptions = [
  { value: "mixed", label: "Mixed" },
  { value: "none", label: "None" },
  { value: "fade", label: "Fade" },
  { value: "crossfade", label: "Crossfade" },
];

// PlaylistAddButton is the one add composition for the editor: the common
// action stays one click away and Layouts sit behind the adjacent menu. The
// authoring bar and the empty timeline both render it.
export function PlaylistAddButton({
  onAddContent,
  onAddLayout,
}: {
  onAddContent: () => void;
  onAddLayout: () => void;
}) {
  return (
    <ButtonGroup aria-label="Add to playlist">
      <Button type="button" onClick={onAddContent}>
        <Plus aria-hidden="true" />
        Add content
      </Button>
      <ButtonGroupSeparator />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button type="button" size="icon" aria-label="More ways to add" />
          }
        >
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuItem onClick={onAddContent}>
            <Plus aria-hidden="true" />
            Media or Widget
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAddLayout}>
            <PanelsTopLeft aria-hidden="true" />
            Published Layout
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </ButtonGroup>
  );
}

export function PlaylistAuthoringBar({
  items,
  sourceType,
  canManage,
  transition,
  imageDuration,
  pending,
  onTransitionChange,
  onImageDurationChange,
  onAddContent,
  onAddLayout,
  onEditSource,
}: {
  items: PlaylistItem[];
  sourceType: "static" | "tag";
  canManage: boolean;
  transition: PlaylistTransition;
  imageDuration: ImageDurationSummary;
  pending: boolean;
  onTransitionChange: (value: PlaylistItem["transition"]) => void;
  onImageDurationChange: (seconds: number) => void;
  onAddContent: () => void;
  onAddLayout: () => void;
  onEditSource: () => void;
}) {
  const tagDriven = sourceType === "tag";
  const editable = canManage && !tagDriven;
  const hasImages = items.some((item) => item.assetType === "image");
  const [durationDraft, setDurationDraft] = useState("");

  useEffect(() => {
    setDurationDraft(
      imageDuration.kind === "value" ? String(imageDuration.seconds) : "",
    );
  }, [imageDuration]);

  const commitImageDuration = () => {
    const value = Number(durationDraft);
    if (durationDraft && Number.isFinite(value) && value > 0) {
      onImageDurationChange(value);
    }
  };

  // With nothing to edit, the empty timeline carries the add action instead.
  if (items.length === 0 && !tagDriven) return null;

  return (
    <div
      role="toolbar"
      aria-label="Playlist authoring"
      className="flex flex-wrap items-center gap-x-6 gap-y-3"
    >
      {tagDriven ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Tags className="size-4" aria-hidden="true" />
          Items come from media tags.
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={onEditSource}
          >
            Edit content source
          </Button>
        </p>
      ) : (
        canManage && (
          <PlaylistAddButton
            onAddContent={onAddContent}
            onAddLayout={onAddLayout}
          />
        )
      )}

      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <Field orientation="horizontal" className="w-auto gap-2">
          <FieldLabel htmlFor="playlist-transition" className="shrink-0">
            Transition
          </FieldLabel>
          <Select
            disabled={!editable || pending}
            value={transition}
            onValueChange={(next) => {
              if (next === "none" || next === "fade" || next === "crossfade") {
                onTransitionChange(next);
              }
            }}
            items={transitionOptions}
          >
            <SelectTrigger
              id="playlist-transition"
              className="w-32"
              aria-label="Playlist transition"
              aria-description="Applies to every item."
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {transition === "mixed" && (
                <SelectItem value="mixed">Mixed</SelectItem>
              )}
              <SelectItem value="none">None</SelectItem>
              <SelectItem value="fade">Fade</SelectItem>
              <SelectItem value="crossfade">Crossfade</SelectItem>
            </SelectContent>
          </Select>
          {transition === "crossfade" && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    aria-label="About crossfade audio"
                  />
                }
              >
                <Info aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                Crossfade blends visuals. Audio still changes at the normal item
                boundary.
              </TooltipContent>
            </Tooltip>
          )}
        </Field>

        {hasImages && (
          <Field orientation="horizontal" className="w-auto gap-2">
            <FieldLabel htmlFor="playlist-image-duration" className="shrink-0">
              Images
            </FieldLabel>
            <InputGroup className="w-28">
              <InputGroupInput
                id="playlist-image-duration"
                aria-label="Playlist image duration in seconds"
                aria-description="Updates every fixed-duration image item."
                type="number"
                inputMode="decimal"
                min="1"
                max="86400"
                disabled={!editable || pending}
                value={durationDraft}
                placeholder={imageDuration.kind === "mixed" ? "Mixed" : "Auto"}
                onChange={(event) => setDurationDraft(event.target.value)}
                onBlur={commitImageDuration}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    commitImageDuration();
                    event.currentTarget.blur();
                  }
                }}
              />
              <InputGroupAddon align="inline-end">
                <InputGroupText aria-hidden="true">s</InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        )}
      </div>
    </div>
  );
}
