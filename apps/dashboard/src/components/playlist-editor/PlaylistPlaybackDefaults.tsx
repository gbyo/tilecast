import { Info, SlidersHorizontal } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { PlaylistItem } from "../../api/types";
import { Button } from "../ui/button";
import { Field, FieldDescription, FieldLabel } from "../ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import {
  type ImageDurationSummary,
  type PlaylistTransition,
  transitionLabel,
} from "./playlistEditorModel";

const transitionOptions: {
  value: PlaylistTransition;
  labelKey:
    | "model.transition.mixed"
    | "model.transition.none"
    | "model.transition.fade"
    | "model.transition.crossfade";
}[] = [
  { value: "mixed", labelKey: "model.transition.mixed" },
  { value: "none", labelKey: "model.transition.none" },
  { value: "fade", labelKey: "model.transition.fade" },
  { value: "crossfade", labelKey: "model.transition.crossfade" },
];

export function PlaylistPlaybackDefaults({
  items,
  sourceType,
  canManage,
  transition,
  imageDuration,
  transitionPending,
  imageDurationPending,
  onTransitionChange,
  onImageDurationChange,
  onOpenDetails,
}: {
  items: PlaylistItem[];
  sourceType: "static" | "tag";
  canManage: boolean;
  transition: PlaylistTransition;
  imageDuration: ImageDurationSummary;
  transitionPending: boolean;
  imageDurationPending: boolean;
  onTransitionChange: (value: PlaylistItem["transition"]) => void;
  onImageDurationChange: (seconds: number) => void;
  onOpenDetails: () => void;
}) {
  const { t } = useTranslation("playlists");
  const tagDriven = sourceType === "tag";
  const hasImages = items.some((item) => item.assetType === "image");
  const transitionValue = transition === "mixed" ? "mixed" : transition;
  const [durationDraft, setDurationDraft] = useState("");

  useEffect(() => {
    setDurationDraft(
      imageDuration.kind === "value" ? String(imageDuration.seconds) : "",
    );
  }, [imageDuration]);

  const commitImageDuration = () => {
    const value = Number(durationDraft);
    if (Number.isFinite(value) && value > 0) {
      onImageDurationChange(value);
    }
  };

  return (
    <section aria-labelledby="playlist-playback-title" className="grid gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="grid min-w-0 gap-1">
          <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
            {t("defaults.eyebrow")}
          </p>
          <h2
            id="playlist-playback-title"
            className="text-lg font-semibold tracking-tight"
          >
            {t("defaults.title")}
          </h2>
          <p className="text-sm text-muted-foreground">
            {t("defaults.description")}
          </p>
        </div>
        <Button type="button" variant="ghost" size="sm" onClick={onOpenDetails}>
          <SlidersHorizontal size={14} aria-hidden="true" />
          {t("defaults.more")}
        </RheaButton>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="playlist-transition">
            {t("defaults.transitionLabel")}
          </FieldLabel>
          <RheaSelect
            disabled={
              !canManage || tagDriven || transitionPending || !items.length
            }
            value={transitionValue}
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
              aria-label={t("defaults.transitionAria")}
            >
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {transition === "mixed" && (
                <SelectItem value="mixed">
                  {t("model.transition.mixed")}
                </SelectItem>
              )}
              <SelectItem value="none">{t("model.transition.none")}</SelectItem>
              <SelectItem value="fade">{t("model.transition.fade")}</SelectItem>
              <SelectItem value="crossfade">
                {t("model.transition.crossfade")}
              </SelectItem>
            </SelectContent>
          </Select>
          <FieldDescription>
            {tagDriven
              ? t("defaults.transitionHintTag")
              : t("defaults.transitionHintManual")}
          </FieldDescription>
        </Field>

        <Field>
          <FieldLabel htmlFor="playlist-image-duration">
            {t("defaults.imageDurationLabel")}
          </FieldLabel>
          {!hasImages ? (
            <span className="text-sm text-muted-foreground">
              {t("defaults.noImages")}
            </span>
          ) : (
            <InputGroup className="w-40">
              <InputGroupInput
                id="playlist-image-duration"
                aria-label={t("defaults.imageDurationAria")}
                type="number"
                min="1"
                max="86400"
                disabled={!canManage || tagDriven || imageDurationPending}
                value={durationDraft}
                placeholder={
                  imageDuration.kind === "mixed"
                    ? t("model.transition.mixed")
                    : t("model.duration.playerDefaultsValue")
                }
                onChange={(event) => {
                  setDurationDraft(event.target.value);
                }}
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
                <span aria-hidden="true">{t("units.secondsShort")}</span>
              </InputGroupAddon>
            </InputGroup>
          )}
          <FieldDescription>
            {tagDriven
              ? t("defaults.imageHintTag")
              : imageDuration.kind === "player"
                ? t("defaults.imageHintPlayer")
                : t("defaults.imageHintFixed")}
          </FieldDescription>
        </Field>
      </div>

      <div
        className="flex items-start gap-2 rounded-lg bg-muted p-3 text-sm text-muted-foreground"
        role="note"
      >
        <Info size={15} aria-hidden="true" className="mt-0.5 shrink-0" />
        <span>
          {transition === "crossfade"
            ? tagDriven
              ? t("defaults.noteCrossfade")
              : t("defaults.noteCrossfadeAutosave")
            : tagDriven
              ? t("defaults.noteCurrent", {
                  transition: transitionLabel(transition, t),
                })
              : t("defaults.noteCurrentAutosave", {
                  transition: transitionLabel(transition, t),
                })}
        </span>
      </div>
    </section>
  );
}
