/**
 * The editor's main workspace: the live preview and the controls for how
 * it is viewed. Everything here (frame, zoom, fullscreen, preview time) is
 * a way of looking at the Widget and never changes the draft.
 */
import { useQueries } from "@tanstack/react-query";
import {
  AlertCircle,
  Clock,
  Expand,
  Info,
  Minimize,
  Minus,
  Plus,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { cn } from "cn";
import { api } from "@/api/client";
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
import { Spinner } from "@/components/ui/spinner";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useFormatLocale } from "@/i18n";
import { dataSourceKeysIn } from "@/content/DefinitionForm";
import { PreviewTimeControl } from "@/content/PreviewTimeControl";
import {
  initialPreviewTime,
  parsePreviewTimeInput,
  type PreviewTime,
} from "@/content/previewTime";
import type { PreviewFrame } from "@/content/WidgetPreviewHost";
import { previewsTime } from "./widgetAuthoring";
import type { WidgetEditorSession } from "./useWidgetEditorSession";
import { WidgetComponentPreview } from "./preview/WidgetComponentPreview";
import { WebIntegrationPreview } from "./preview/WebIntegrationPreview";
import type { PreviewStatus } from "./preview/previewStatus";

export const PREVIEW_FRAMES = [
  { key: "landscape", width: 960, height: 540 },
  { key: "portrait", width: 540, height: 960 },
  { key: "strip", width: 960, height: 240 },
  { key: "sidebar", width: 360, height: 960 },
  { key: "small", width: 320, height: 180 },
] as const;

type FrameKey = (typeof PREVIEW_FRAMES)[number]["key"] | "custom";

const CUSTOM_BOUNDS = {
  width: { min: 120, max: 3840 },
  height: { min: 48, max: 2160 },
} as const;
const ZOOM_STEPS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 2] as const;
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 2;
const STAGE_PADDING = 32;

function clampSize(value: number, axis: "width" | "height") {
  const bounds = CUSTOM_BOUNDS[axis];
  if (!Number.isFinite(value)) return bounds.min;
  return Math.max(bounds.min, Math.min(bounds.max, Math.round(value)));
}

function useStageFit(frame: PreviewFrame) {
  const stageRef = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState(1);
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return;
    const measure = () => {
      const width = stage.clientWidth - STAGE_PADDING * 2;
      const height = stage.clientHeight - STAGE_PADDING * 2;
      if (width <= 0 || height <= 0) return;
      const next = Math.min(width / frame.width, height / frame.height, 2);
      setFit((current) => (Math.abs(current - next) < 0.001 ? current : next));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    return () => observer.disconnect();
  }, [frame.width, frame.height]);
  return { stageRef, fit };
}

/** Data Sources with date selection make any Widget time-dependent. */
function useDateSelectedSources(session: WidgetEditorSession) {
  const ids = dataSourceKeysIn(
    session.definition.configurationSchema.fields,
    session.draft.configuration,
  );
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["definition-form-data-source", id],
      queryFn: () => api.getDataSource(id),
    })),
    combine: (results) =>
      results.some((result) => result.data?.dateSelection?.enabled === true),
  });
}

export function WidgetPreviewPane({
  session,
  csrf,
  compact,
}: {
  session: WidgetEditorSession;
  csrf: string;
  compact: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const locale = useFormatLocale();
  const recommendedFrame = session.definition.authoring?.recommendedFrame;
  const [frameKey, setFrameKey] = useState<FrameKey>(() =>
    recommendedFrame ? "custom" : "landscape",
  );
  const [custom, setCustom] = useState<PreviewFrame>(
    recommendedFrame ?? { width: 960, height: 540 },
  );
  const [zoom, setZoom] = useState<"fit" | number>("fit");
  const [previewTime, setPreviewTime] =
    useState<PreviewTime>(initialPreviewTime);
  const [status, setStatus] = useState<PreviewStatus>({ kind: "loading" });
  const frame =
    PREVIEW_FRAMES.find((entry) => entry.key === frameKey) ?? custom;
  const { stageRef, fit } = useStageFit(frame);
  const scale = zoom === "fit" ? fit : zoom;
  const paneRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(paneRef);
  const dateSelected = useDateSelectedSources(session);
  const showTime = previewsTime(session.definition) || dateSelected;

  const zoomBy = (direction: 1 | -1) => {
    const current = scale;
    const next =
      direction > 0
        ? ZOOM_STEPS.find((step) => step > current + 0.001)
        : [...ZOOM_STEPS].reverse().find((step) => step < current - 0.001);
    if (next !== undefined) setZoom(next);
  };
  const percent = Math.round(scale * 100);
  const frameLabel = (key: FrameKey) =>
    key === "custom"
      ? t("widgets.editor.preview.frames.custom")
      : t(`widgets.editor.preview.frames.${key}`);
  const fixedInstant =
    previewTime.mode === "fixed"
      ? parsePreviewTimeInput(previewTime.value)
      : null;
  const onStatus = useCallback((next: PreviewStatus) => setStatus(next), []);
  const authoring = session.authoring;
  const configuration = session.draft.configuration;

  const preview: ReactNode =
    authoring.kind === "component" ? (
      <WidgetComponentPreview
        component={authoring.component}
        fields={session.definition.configurationSchema.fields}
        configuration={configuration}
        managedDataSourceId={session.asset?.widget?.managedDataSourceId}
        previewTime={previewTime}
        frame={frame}
        scale={scale}
        onStatus={onStatus}
      />
    ) : (
      <WebIntegrationPreview
        provider={session.definition.id}
        configuration={configuration}
        csrf={csrf}
        canCompile={!session.readOnly}
        savedThumbnailUrl={session.asset?.thumbnailUrl}
        frame={frame}
        scale={scale}
        onStatus={onStatus}
      />
    );

  return (
    <div
      ref={paneRef}
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background",
        fullscreen.active ? "fixed inset-0 z-50 h-dvh" : "h-full",
      )}
    >
      <div
        role="toolbar"
        aria-label={t("widgets.editor.preview.toolbar")}
        className="flex shrink-0 flex-wrap items-center gap-2 border-b border-border px-3 py-2"
      >
        <Select
          value={frameKey}
          onValueChange={(next) => {
            setFrameKey(next as FrameKey);
            setZoom("fit");
          }}
          items={[...PREVIEW_FRAMES.map((entry) => entry.key), "custom"].map(
            (key) => ({ value: key, label: frameLabel(key as FrameKey) }),
          )}
        >
          <SelectTrigger
            size="sm"
            aria-label={t("widgets.editor.preview.frame")}
            className={compact ? "max-w-44" : undefined}
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {PREVIEW_FRAMES.map((entry) => (
              <SelectItem key={entry.key} value={entry.key}>
                {frameLabel(entry.key)}
              </SelectItem>
            ))}
            <SelectItem value="custom">{frameLabel("custom")}</SelectItem>
          </SelectContent>
        </Select>
        {frameKey === "custom" && (
          <CustomFrameControl value={custom} onChange={setCustom} />
        )}
        {!compact && (
          <ButtonGroup aria-label={t("widgets.editor.preview.zoom")}>
            <IconButton
              label={t("widgets.editor.preview.zoomOut")}
              disabled={scale <= MIN_ZOOM + 0.001}
              onClick={() => zoomBy(-1)}
            >
              <Minus aria-hidden="true" />
            </IconButton>
            <Button
              type="button"
              variant="outline"
              size="sm"
              aria-pressed={zoom === "fit"}
              aria-label={t("widgets.editor.preview.fitLabel", { percent })}
              onClick={() => setZoom("fit")}
              className="min-w-16 tabular-nums"
            >
              {zoom === "fit"
                ? t("widgets.editor.preview.fit")
                : t("widgets.editor.preview.percent", { percent })}
            </Button>
            <IconButton
              label={t("widgets.editor.preview.zoomIn")}
              disabled={scale >= MAX_ZOOM - 0.001}
              onClick={() => zoomBy(1)}
            >
              <Plus aria-hidden="true" />
            </IconButton>
          </ButtonGroup>
        )}
        <div className="flex-1" />
        {showTime && (
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant={fixedInstant ? "secondary" : "outline"}
                  size="sm"
                  aria-label={
                    fixedInstant
                      ? t("widgets.editor.preview.timeFixed", {
                          time: fixedInstant.toLocaleString(locale, {
                            dateStyle: "medium",
                            timeStyle: "short",
                          }),
                        })
                      : t("widgets.editor.preview.timeLive")
                  }
                />
              }
            >
              <Clock aria-hidden="true" />
              <span className={compact ? "sr-only" : undefined}>
                {fixedInstant
                  ? fixedInstant.toLocaleString(locale, {
                      dateStyle: "medium",
                      timeStyle: "short",
                    })
                  : t("widgets.editor.preview.time")}
              </span>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-80">
              <PreviewTimeControl
                value={previewTime}
                onChange={setPreviewTime}
              />
            </PopoverContent>
          </Popover>
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
      <div
        ref={stageRef}
        role="region"
        aria-label={t("widgets.editor.preview.region")}
        aria-busy={
          status.kind === "loading" || status.kind === "waiting"
            ? true
            : undefined
        }
        className="relative min-h-0 flex-1 overflow-auto bg-muted/50"
      >
        <div
          className="flex min-h-full min-w-full items-center justify-center"
          style={{ padding: STAGE_PADDING }}
        >
          <div className="shrink-0 shadow-sm ring-1 ring-border">{preview}</div>
        </div>
        <PreviewStatusNote status={status} />
      </div>
    </div>
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
              min={CUSTOM_BOUNDS.width.min}
              max={CUSTOM_BOUNDS.width.max}
              value={value.width}
              onChange={(event) =>
                onChange({
                  ...value,
                  width: clampSize(Number(event.target.value), "width"),
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
              min={CUSTOM_BOUNDS.height.min}
              max={CUSTOM_BOUNDS.height.max}
              value={value.height}
              onChange={(event) =>
                onChange({
                  ...value,
                  height: clampSize(Number(event.target.value), "height"),
                })
              }
            />
          </Field>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Silent when the preview is healthy. Otherwise one short line with an
 * icon, never color alone.
 */
function PreviewStatusNote({ status }: { status: PreviewStatus }) {
  const { t } = useTranslation("content");
  if (status.kind === "ready") return null;
  const text =
    status.kind === "loading"
      ? t("widgets.editor.preview.loading")
      : status.kind === "waiting"
        ? t("widgets.editor.preview.waiting")
        : status.message;
  const icon =
    status.kind === "loading" || status.kind === "waiting" ? (
      <Spinner aria-hidden="true" />
    ) : status.kind === "error" ? (
      <AlertCircle aria-hidden="true" />
    ) : (
      <Info aria-hidden="true" />
    );
  return (
    <div className="pointer-events-none absolute inset-x-3 bottom-3 flex justify-center">
      <p
        role={status.kind === "error" ? "alert" : "status"}
        className={cn(
          "pointer-events-auto flex max-w-xl items-start gap-2 rounded-md border border-border bg-background/95 px-3 py-2 text-xs shadow-sm [&_svg]:mt-px [&_svg]:size-3.5 [&_svg]:shrink-0",
          status.kind === "error" && "text-destructive",
        )}
      >
        {icon}
        <span className="grid gap-0.5">
          <span>{text}</span>
          {status.kind === "error" && status.detail && (
            <span className="text-muted-foreground">{status.detail}</span>
          )}
        </span>
      </p>
    </div>
  );
}

/**
 * Fullscreen through the browser where it is allowed; otherwise the pane
 * covers the window. Escape leaves either one and never touches the draft.
 */
function useFullscreen(target: React.RefObject<HTMLElement | null>) {
  const [overlay, setOverlay] = useState(false);
  const [native, setNative] = useState(false);
  useEffect(() => {
    const sync = () =>
      setNative(
        document.fullscreenElement !== null &&
          document.fullscreenElement === target.current,
      );
    document.addEventListener("fullscreenchange", sync);
    return () => document.removeEventListener("fullscreenchange", sync);
  }, [target]);
  useEffect(() => {
    if (!overlay) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOverlay(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [overlay]);
  const toggle = () => {
    if (native) {
      void document.exitFullscreen();
      return;
    }
    if (overlay) {
      setOverlay(false);
      return;
    }
    const element = target.current;
    if (element && typeof element.requestFullscreen === "function") {
      element.requestFullscreen().catch(() => setOverlay(true));
    } else {
      setOverlay(true);
    }
  };
  return { active: native || overlay, toggle };
}
