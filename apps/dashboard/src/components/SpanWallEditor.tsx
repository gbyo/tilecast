import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { ScreenGroup, SpanPanel, SpanStatus } from "../api/types";
import { Alert, AlertDescription } from "./ui/alert";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "./ui/accordion";
import { Button } from "./ui/button";
import { ButtonGroup } from "./ui/button-group";
import { Field, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "./ui/item";
import { Progress, ProgressValue } from "./ui/progress";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type LayoutsT = TFunction<"layouts", undefined>;
type Canvas = { width: number; height: number };

type Props = {
  group: ScreenGroup;
  manageable: boolean;
  csrfToken: string;
  /**
   * The group is still Mirror and this wall has never been saved. Discarding
   * then means going back to Mirror, which the caller owns.
   */
  onDiscardNewWall?: () => void;
};

const DEFAULT_CANVAS: Canvas = { width: 3840, height: 1080 };

const presets = [
  { label: "2 × 1", columns: 2, canvas: { width: 3840, height: 1080 } },
  { label: "1 × 2", columns: 1, canvas: { width: 1920, height: 2160 } },
  { label: "2 × 2", columns: 2, canvas: { width: 3840, height: 2160 } },
] as const;

function preset(
  screens: ScreenGroup["screens"],
  width: number,
  height: number,
  columns: number,
): SpanPanel[] {
  const safeColumns = Math.max(1, Math.min(columns, screens.length || 1));
  const rows = Math.max(1, Math.ceil(screens.length / safeColumns));
  return screens.map((screen, index) => {
    const row = Math.floor(index / safeColumns);
    const column = index % safeColumns;
    const x = Math.floor((column * width) / safeColumns);
    const right = Math.floor(((column + 1) * width) / safeColumns);
    const y = Math.floor((row * height) / rows);
    const bottom = Math.floor(((row + 1) * height) / rows);
    return {
      screenId: screen.id,
      screenName: screen.name,
      order: index,
      x,
      y,
      width: right - x,
      height: bottom - y,
      rotation: 0,
      bezelLeft: 0,
      bezelTop: 0,
      bezelRight: 0,
      bezelBottom: 0,
    };
  });
}

const rotationOptions = [0, 90, 180, 270].map((value) => ({
  value: String(value),
  label: `${value}°`,
}));

function preparationStatusLabel(
  status: string | undefined,
  t: LayoutsT,
): string {
  switch (status) {
    case "queued":
      return t("spanWall.preparationQueued");
    case "processing":
      return t("spanWall.preparationProcessing");
    case "ready":
      return t("spanWall.preparationReady");
    case "failed":
      return t("spanWall.preparationFailed");
    default:
      return t("spanWall.preparationIdle");
  }
}

const bezelKeys = [
  "bezelLeft",
  "bezelTop",
  "bezelRight",
  "bezelBottom",
] as const;

export function SpanWallEditor({
  group,
  manageable,
  csrfToken,
  onDiscardNewWall,
}: Props) {
  const { t } = useTranslation(["layouts", "common"]);
  const client = useQueryClient();
  const saved = group.displayMode === "span";
  const status = useQuery({
    queryKey: ["screen-groups", group.id, "span"],
    queryFn: () => api.spanStatus(group.id),
    enabled: saved,
    refetchInterval: 10_000,
  });
  // An unsaved wall starts as a draft and is dirty from the first frame, so
  // choosing Span never changes the server until the person saves.
  const [canvas, setCanvas] = useState<Canvas>(DEFAULT_CANVAS);
  const [panels, setPanels] = useState<SpanPanel[]>(() =>
    saved ? [] : preset(group.screens, 3840, 1080, 2),
  );
  const [dirty, setDirty] = useState(!saved);
  useEffect(() => {
    if (dirty || !status.data) return;
    setCanvas(status.data.geometry.canvas);
    setPanels(status.data.geometry.panels);
  }, [dirty, status.data]);

  const save = useMutation({
    mutationFn: () =>
      api.updateSpanGeometry(
        group.id,
        { displayMode: "span", canvas, panels },
        csrfToken,
      ),
    onSuccess: () => {
      setDirty(false);
      void client.invalidateQueries({ queryKey: ["screen-groups", group.id] });
      void client.invalidateQueries({ queryKey: ["screen-groups"] });
    },
  });

  const screenNames = useMemo(
    () => new Map(group.screens.map((screen) => [screen.id, screen.name])),
    [group.screens],
  );
  const preparationByScreen = useMemo(() => {
    const map = new Map<string, SpanStatus["preparations"][number]>();
    for (const item of status.data?.preparations ?? [])
      map.set(item.screenId, item);
    return map;
  }, [status.data]);

  const setPanel = (screenId: string, key: keyof SpanPanel, value: number) => {
    setDirty(true);
    setPanels((current) =>
      current.map((panel) =>
        panel.screenId === screenId ? { ...panel, [key]: value } : panel,
      ),
    );
  };

  const discard = () => {
    if (!saved) {
      onDiscardNewWall?.();
      return;
    }
    if (status.data) {
      setCanvas(status.data.geometry.canvas);
      setPanels(status.data.geometry.panels);
    }
    setDirty(false);
    save.reset();
  };

  const canvasField = (key: keyof Canvas, label: string) => (
    <Field className="w-44">
      <FieldLabel htmlFor={`span-canvas-${key}`}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={`span-canvas-${key}`}
          type="number"
          min={320}
          max={16384}
          disabled={!manageable}
          value={canvas[key]}
          onChange={(event) => {
            setDirty(true);
            setCanvas({ ...canvas, [key]: Number(event.target.value) });
          }}
        />
        <InputGroupAddon align="inline-end">
          {t("spanWall.unitPx")}
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );

  return (
    <section className="grid gap-5">
      <div className="grid gap-3">
        <h3 className="text-sm font-semibold">{t("spanWall.canvasTitle")}</h3>
        <div className="flex flex-wrap items-end gap-3">
          {canvasField("width", t("spanWall.canvasWidth"))}
          {canvasField("height", t("spanWall.canvasHeight"))}
          {manageable && (
            <div className="grid gap-1.5">
              <span className="text-sm font-medium">
                {t("spanWall.presetsTitle")}
              </span>
              <ButtonGroup aria-label={t("spanWall.presetsLabel")}>
                {presets.map((item) => (
                  <Button
                    key={item.label}
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setCanvas({ ...item.canvas });
                      setPanels(
                        preset(
                          group.screens,
                          item.canvas.width,
                          item.canvas.height,
                          item.columns,
                        ),
                      );
                      setDirty(true);
                    }}
                  >
                    {item.label}
                  </Button>
                ))}
              </ButtonGroup>
            </div>
          )}
        </div>
      </div>

      <div
        className="relative min-h-40 w-full overflow-hidden rounded-lg border border-border bg-black"
        style={{
          aspectRatio: `${Math.max(canvas.width, 1)} / ${Math.max(canvas.height, 1)}`,
        }}
        role="img"
        aria-label={t("spanWall.previewLabel")}
      >
        {panels.map((panel) => (
          <div
            className="absolute flex flex-col items-center justify-center gap-1 overflow-hidden border border-sky-300 bg-sky-900 text-slate-50"
            key={panel.screenId}
            style={{
              left: `${(panel.x / canvas.width) * 100}%`,
              top: `${(panel.y / canvas.height) * 100}%`,
              width: `${(panel.width / canvas.width) * 100}%`,
              height: `${(panel.height / canvas.height) * 100}%`,
              transform: `rotate(${panel.rotation}deg)`,
            }}
          >
            <strong className="text-sm">
              {screenNames.get(panel.screenId) ?? t("spanWall.unknownScreen")}
            </strong>
            <small className="text-xs text-sky-200">
              {panel.width} × {panel.height}
            </small>
          </div>
        ))}
      </div>

      <div className="grid gap-1">
        <h3 className="text-sm font-semibold">{t("spanWall.panelsTitle")}</h3>
        <Accordion className="border-y border-border">
          {panels.map((panel) => (
            <AccordionItem key={panel.screenId} value={panel.screenId}>
              <AccordionTrigger className="items-center py-3">
                <span className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-3">
                  <span className="truncate">
                    {screenNames.get(panel.screenId) ?? panel.screenId}
                  </span>
                  <span className="text-xs font-normal text-muted-foreground tabular-nums">
                    {panel.width}×{panel.height} · {panel.rotation}°
                  </span>
                </span>
              </AccordionTrigger>
              <AccordionContent>
                <div className="grid gap-4">
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-5">
                    {(["x", "y", "width", "height"] as const).map((key) => (
                      <Field key={key}>
                        <FieldLabel htmlFor={`span-${panel.screenId}-${key}`}>
                          {t(`spanWall.panelFields.${key}`)}
                        </FieldLabel>
                        <InputGroup>
                          <InputGroupInput
                            id={`span-${panel.screenId}-${key}`}
                            type="number"
                            min={0}
                            value={panel[key]}
                            disabled={!manageable}
                            onChange={(event) =>
                              setPanel(
                                panel.screenId,
                                key,
                                Number(event.target.value),
                              )
                            }
                          />
                          <InputGroupAddon align="inline-end">
                            {t("spanWall.unitPx")}
                          </InputGroupAddon>
                        </InputGroup>
                      </Field>
                    ))}
                    <Field>
                      <FieldLabel htmlFor={`span-${panel.screenId}-rotation`}>
                        {t("spanWall.rotationLabel")}
                      </FieldLabel>
                      <Select
                        items={rotationOptions}
                        value={String(panel.rotation)}
                        disabled={!manageable}
                        onValueChange={(next) =>
                          setPanel(
                            panel.screenId,
                            "rotation",
                            Number(next ?? panel.rotation),
                          )
                        }
                      >
                        <SelectTrigger
                          id={`span-${panel.screenId}-rotation`}
                          aria-label={t("spanWall.rotationLabel")}
                        >
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {rotationOptions.map((option) => (
                            <SelectItem key={option.value} value={option.value}>
                              {option.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </Field>
                  </div>
                  <div className="grid gap-2">
                    <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                      {t("spanWall.bezelTitle")}
                    </p>
                    <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                      {bezelKeys.map((key) => (
                        <Field key={key}>
                          <FieldLabel htmlFor={`span-${panel.screenId}-${key}`}>
                            {t(`spanWall.bezelFields.${key}`)}
                          </FieldLabel>
                          <InputGroup>
                            <InputGroupInput
                              id={`span-${panel.screenId}-${key}`}
                              type="number"
                              min={0}
                              value={panel[key]}
                              disabled={!manageable}
                              onChange={(event) =>
                                setPanel(
                                  panel.screenId,
                                  key,
                                  Number(event.target.value),
                                )
                              }
                            />
                            <InputGroupAddon align="inline-end">
                              {t("spanWall.unitPx")}
                            </InputGroupAddon>
                          </InputGroup>
                        </Field>
                      ))}
                    </div>
                    <p className="text-xs text-muted-foreground">
                      {t("spanWall.bezelHint")}
                    </p>
                  </div>
                </div>
              </AccordionContent>
            </AccordionItem>
          ))}
        </Accordion>
      </div>

      {save.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("spanWall.saveFailed")}</AlertDescription>
        </Alert>
      )}
      {status.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("spanWall.statusFailed")}</AlertDescription>
        </Alert>
      )}

      {manageable && (dirty || save.isPending) && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/50 px-4 py-3">
          <p className="text-sm font-medium" role="status">
            {saved ? t("spanWall.unsavedChanges") : t("spanWall.unsavedWall")}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="ghost"
              disabled={save.isPending}
              onClick={discard}
            >
              {t("spanWall.discardAction")}
            </Button>
            <Button
              type="button"
              disabled={save.isPending}
              onClick={() => save.mutate()}
            >
              {save.isPending
                ? t("common:actions.saving")
                : t("spanWall.saveAction")}
            </Button>
          </div>
        </div>
      )}

      {saved && panels.length > 0 && (
        <section className="grid gap-2" aria-live="polite">
          <h3 className="text-sm font-semibold">
            {t("spanWall.preparationTitle")}
          </h3>
          <ItemGroup className="gap-1">
            {panels.map((panel) => {
              const item = preparationByScreen.get(panel.screenId);
              const percent =
                item?.progress != null ? Math.round(item.progress * 100) : null;
              return (
                <div key={panel.screenId} role="listitem">
                  <Item size="xs" variant="outline">
                    <ItemContent>
                      <ItemTitle>
                        {screenNames.get(panel.screenId) ?? panel.screenId}
                      </ItemTitle>
                      {percent !== null && item?.status === "processing" && (
                        <Progress
                          value={percent}
                          aria-label={t("spanWall.preparationProgress", {
                            name:
                              screenNames.get(panel.screenId) ?? panel.screenId,
                          })}
                          className="w-full max-w-xs"
                        >
                          <ProgressValue>{() => `${percent}%`}</ProgressValue>
                        </Progress>
                      )}
                    </ItemContent>
                    <ItemDescription className="m-0 line-clamp-none">
                      {preparationStatusLabel(item?.status, t)}
                    </ItemDescription>
                  </Item>
                </div>
              );
            })}
          </ItemGroup>
        </section>
      )}
    </section>
  );
}
