import { ChevronDown, Info, PanelsTopLeft, Plus, Tags } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
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
  { value: "mixed", labelKey: "model.transition.mixed" },
  { value: "none", labelKey: "model.transition.none" },
  { value: "fade", labelKey: "model.transition.fade" },
  { value: "crossfade", labelKey: "model.transition.crossfade" },
] as const;

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
  const { t } = useTranslation("playlists");
  return (
    <ButtonGroup aria-label={t("authoring.addGroup")}>
      <Button type="button" onClick={onAddContent}>
        <Plus aria-hidden="true" />
        {t("timeline.addContent")}
      </Button>
      <ButtonGroupSeparator />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              type="button"
              size="icon"
              aria-label={t("authoring.moreWaysToAdd")}
            />
          }
        >
          <ChevronDown aria-hidden="true" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-44">
          <DropdownMenuItem onClick={onAddContent}>
            <Plus aria-hidden="true" />
            {t("authoring.mediaOrWidget")}
          </DropdownMenuItem>
          <DropdownMenuItem onClick={onAddLayout}>
            <PanelsTopLeft aria-hidden="true" />
            {t("authoring.publishedLayout")}
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
  const { t } = useTranslation("playlists");
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
      aria-label={t("authoring.toolbarLabel")}
      className="flex flex-wrap items-center gap-x-6 gap-y-3"
    >
      {tagDriven ? (
        <p className="flex items-center gap-2 text-sm text-muted-foreground">
          <Tags className="size-4" aria-hidden="true" />
          {t("authoring.tagSourceNote")}
          <Button
            type="button"
            variant="link"
            className="h-auto p-0"
            onClick={onEditSource}
          >
            {t("authoring.editSource")}
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
            {t("defaults.transitionLabel")}
          </FieldLabel>
          <Select
            disabled={!editable || pending}
            value={transition}
            onValueChange={(next) => {
              if (next === "none" || next === "fade" || next === "crossfade") {
                onTransitionChange(next);
              }
            }}
            items={transitionOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          >
            <SelectTrigger
              id="playlist-transition"
              className="w-32"
              aria-label={t("defaults.transitionAria")}
              aria-description={t("authoring.transitionDescription")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {transitionOptions
                .filter(
                  (option) =>
                    option.value !== "mixed" || transition === "mixed",
                )
                .map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {t(option.labelKey)}
                  </SelectItem>
                ))}
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
                    aria-label={t("authoring.crossfadeInfo")}
                  />
                }
              >
                <Info aria-hidden="true" />
              </TooltipTrigger>
              <TooltipContent className="max-w-64">
                {t("authoring.crossfadeTooltip")}
              </TooltipContent>
            </Tooltip>
          )}
        </Field>

        {hasImages && (
          <Field orientation="horizontal" className="w-auto gap-2">
            <FieldLabel htmlFor="playlist-image-duration" className="shrink-0">
              {t("authoring.imagesLabel")}
            </FieldLabel>
            <InputGroup className="w-28">
              <InputGroupInput
                id="playlist-image-duration"
                aria-label={t("defaults.imageDurationAria")}
                aria-description={t("authoring.imageDurationDescription")}
                type="number"
                inputMode="decimal"
                min="1"
                max="86400"
                disabled={!editable || pending}
                value={durationDraft}
                placeholder={
                  imageDuration.kind === "mixed"
                    ? t("authoring.imageDurationMixed")
                    : t("authoring.imageDurationAuto")
                }
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
                <InputGroupText aria-hidden="true">
                  {t("units.secondsShort")}
                </InputGroupText>
              </InputGroupAddon>
            </InputGroup>
          </Field>
        )}
      </div>
    </div>
  );
}
