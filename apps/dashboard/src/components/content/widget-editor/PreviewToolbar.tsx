/**
 * The controls for how the preview is viewed: frame, zoom, preview time,
 * and fullscreen. Every one of them is viewing state; none changes the draft.
 */
import { Clock, Expand, Minimize, Minus, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { ButtonGroup } from "@/components/ui/button-group";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { PreviewTimeControl } from "@/content/PreviewTimeControl";
import { parsePreviewTimeInput, type PreviewTime } from "@/content/previewTime";
import type { PreviewFrame } from "@/content/WidgetPreviewHost";
import { useFormatLocale } from "@/i18n";
import {
  CUSTOM_BOUNDS,
  PREVIEW_FRAMES,
  clampFrameSide,
  type FrameKey,
} from "./previewFrames";
import type { PreviewView } from "./usePreviewView";
import { MAX_ZOOM, MIN_ZOOM } from "./usePreviewView";

export function PreviewToolbar({
  view,
  recommended,
  showTime,
  compact,
  fullscreen,
}: {
  view: PreviewView;
  /** Offered as its own frame when it is not one of the named presets. */
  recommended: PreviewFrame | null;
  showTime: boolean;
  compact: boolean;
  fullscreen: { active: boolean; toggle: () => void };
}) {
  const { t } = useTranslation(["content", "common"]);
  const frameKeys: FrameKey[] = [
    ...PREVIEW_FRAMES.map((entry) => entry.key),
    ...(recommended ? (["recommended"] as const) : []),
    "custom",
  ];
  const frameLabel = (key: FrameKey) =>
    key === "recommended" && recommended
      ? t("widgets.editor.preview.frames.recommended", {
          width: recommended.width,
          height: recommended.height,
        })
      : t(`widgets.editor.preview.frames.${key}`);
  const percent = Math.round(view.scale * 100);
  return (
    <div
      role="toolbar"
      aria-label={t("widgets.editor.preview.toolbar")}
      className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
    >
      <Select
        value={view.frameKey}
        onValueChange={(next) => view.chooseFrame(next as FrameKey)}
        items={frameKeys.map((key) => ({ value: key, label: frameLabel(key) }))}
      >
        <SelectTrigger
          size="sm"
          aria-label={t("widgets.editor.preview.frame")}
          className={compact ? "max-w-44" : undefined}
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {frameKeys.map((key) => (
            <SelectItem key={key} value={key}>
              {frameLabel(key)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {view.frameKey === "custom" && (
        <CustomFrameControl value={view.custom} onChange={view.setCustom} />
      )}
      {!compact && (
        <ButtonGroup aria-label={t("widgets.editor.preview.zoom")}>
          <IconButton
            label={t("widgets.editor.preview.zoomOut")}
            disabled={view.scale <= MIN_ZOOM + 0.001}
            onClick={() => view.zoomBy(-1)}
          >
            <Minus aria-hidden="true" />
          </IconButton>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-pressed={view.zoom === "fit"}
            aria-label={t("widgets.editor.preview.fitLabel", { percent })}
            onClick={() => view.setZoom("fit")}
            className="min-w-16 tabular-nums"
          >
            {view.zoom === "fit"
              ? t("widgets.editor.preview.fit")
              : t("widgets.editor.preview.percent", { percent })}
          </Button>
          <IconButton
            label={t("widgets.editor.preview.zoomIn")}
            disabled={view.scale >= MAX_ZOOM - 0.001}
            onClick={() => view.zoomBy(1)}
          >
            <Plus aria-hidden="true" />
          </IconButton>
        </ButtonGroup>
      )}
      <div className="flex-1" />
      {showTime && (
        <PreviewTimeButton
          value={view.previewTime}
          onChange={view.setPreviewTime}
          compact={compact}
        />
      )}
      <IconButton
        label={
          fullscreen.active
            ? t("widgets.editor.preview.exitFullscreen")
            : t("widgets.editor.preview.fullscreen")
        }
        pressed={fullscreen.active}
        onClick={fullscreen.toggle}
      >
        {fullscreen.active ? (
          <Minimize aria-hidden="true" />
        ) : (
          <Expand aria-hidden="true" />
        )}
      </IconButton>
    </div>
  );
}

function PreviewTimeButton({
  value,
  onChange,
  compact,
}: {
  value: PreviewTime;
  onChange: (next: PreviewTime) => void;
  compact: boolean;
}) {
  const { t } = useTranslation("content");
  const locale = useFormatLocale();
  const fixedInstant =
    value.mode === "fixed" ? parsePreviewTimeInput(value.value) : null;
  const instantText = fixedInstant?.toLocaleString(locale, {
    dateStyle: "medium",
    timeStyle: "short",
  });
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant={fixedInstant ? "secondary" : "outline"}
            size="sm"
            aria-label={
              fixedInstant
                ? t("widgets.editor.preview.timeFixed", { time: instantText })
                : t("widgets.editor.preview.timeLive")
            }
          />
        }
      >
        <Clock aria-hidden="true" />
        <span className={compact ? "sr-only" : undefined}>
          {fixedInstant ? instantText : t("widgets.editor.preview.time")}
        </span>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <PreviewTimeControl value={value} onChange={onChange} />
      </PopoverContent>
    </Popover>
  );
}

function IconButton({
  label,
  pressed,
  disabled,
  onClick,
  children,
}: {
  label: string;
  pressed?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            aria-label={label}
            aria-pressed={pressed}
            disabled={disabled}
            onClick={onClick}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

function CustomFrameControl({
  value,
  onChange,
}: {
  value: PreviewFrame;
  onChange: (frame: PreviewFrame) => void;
}) {
  const { t } = useTranslation("content");
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="tabular-nums"
            aria-label={t("widgets.editor.preview.customSizeLabel", {
              width: value.width,
              height: value.height,
            })}
          />
        }
      >
        {t("widgets.editor.preview.customSize", {
          width: value.width,
          height: value.height,
        })}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-64">
        <div className="grid grid-cols-2 gap-3">
          <Field>
            <FieldLabel htmlFor="widget-preview-width">
              {t("widgets.editor.preview.width")}
            </FieldLabel>
            <Input
              id="widget-preview-width"
              type="number"
              min={CUSTOM_BOUNDS.min}
              max={CUSTOM_BOUNDS.max}
              value={value.width}
              onChange={(event) =>
                onChange({
                  ...value,
                  width: clampFrameSide(Number(event.target.value)),
                })
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="widget-preview-height">
              {t("widgets.editor.preview.height")}
            </FieldLabel>
            <Input
              id="widget-preview-height"
              type="number"
              min={CUSTOM_BOUNDS.min}
              max={CUSTOM_BOUNDS.max}
              value={value.height}
              onChange={(event) =>
                onChange({
                  ...value,
                  height: clampFrameSide(Number(event.target.value)),
                })
              }
            />
          </Field>
        </div>
      </PopoverContent>
    </Popover>
  );
}
