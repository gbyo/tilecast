import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import type { ScreenGroup, SpanPanel, SpanStatus } from "../api/types";

type LayoutsT = TFunction<"layouts", undefined>;
import { Alert, AlertDescription } from "./ui/alert";
import { Button } from "./ui/button";
import { Field, FieldLabel } from "./ui/field";
import { InputGroup, InputGroupAddon, InputGroupInput } from "./ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

type Props = {
  group: ScreenGroup;
  manageable: boolean;
  csrfToken: string;
};

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
export function SpanWallEditor({ group, manageable, csrfToken }: Props) {
  const { t } = useTranslation(["layouts", "common"]);
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["screen-groups", group.id, "span"],
    queryFn: () => api.spanStatus(group.id),
    enabled: group.displayMode === "span",
    refetchInterval: 10_000,
  });
  const [canvas, setCanvas] = useState({ width: 1920, height: 1080 });
  const [panels, setPanels] = useState<SpanPanel[]>([]);
  const [dirty, setDirty] = useState(false);
  useEffect(() => {
    if (dirty || !status.data) return;
    setCanvas(status.data.geometry.canvas);
    setPanels(status.data.geometry.panels);
  }, [dirty, status.data]);

  const update = useMutation({
    mutationFn: (input: {
      displayMode?: "mirror" | "span";
      canvas?: { width: number; height: number };
      panels?: SpanPanel[];
    }) => api.updateSpanGeometry(group.id, input, csrfToken),
    onSuccess: () => {
      setDirty(false);
      void client.invalidateQueries({ queryKey: ["screen-groups", group.id] });
      void client.invalidateQueries({
        queryKey: ["screen-groups", group.id, "span"],
      });
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

  if (group.displayMode !== "span") {
    return (
      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="grid gap-1">
          <h3 className="text-base font-semibold">{t("spanWall.modeTitle")}</h3>
          <p className="text-sm text-muted-foreground">
            {t("spanWall.modeDescription")}
          </p>
        </header>
        {manageable && (
          <div>
            <Button
              type="button"
              variant="secondary"
              disabled={group.screens.length === 0 || update.isPending}
              onClick={() => {
                setCanvas({ width: 3840, height: 1080 });
                setPanels(preset(group.screens, 3840, 1080, 2));
                update.mutate({
                  displayMode: "span",
                  canvas: { width: 3840, height: 1080 },
                  panels: preset(group.screens, 3840, 1080, 2),
                });
              }}
            >
              {update.isPending
                ? t("spanWall.switchBusy")
                : t("spanWall.switchAction")}
            </Button>
          </div>
        )}
      </section>
    );
  }

  return (
    <section className="grid gap-4 rounded-xl border border-border p-4">
      <header className="grid gap-1">
        <h3 className="text-base font-semibold">{t("spanWall.title")}</h3>
        <p className="text-sm text-muted-foreground">
          {t("spanWall.description")}
        </p>
      </header>
      <div className="flex flex-wrap items-end gap-3">
        <Field className="min-w-32">
          <FieldLabel htmlFor="span-canvas-width">
            {t("spanWall.canvasWidth")}
          </FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="span-canvas-width"
              type="number"
              min={320}
              max={16384}
              value={canvas.width}
              onChange={(event) => {
                setDirty(true);
                setCanvas({ ...canvas, width: Number(event.target.value) });
              }}
            />
            <InputGroupAddon align="inline-end">px</InputGroupAddon>
          </InputGroup>
        </Field>
        <Field className="min-w-32">
          <FieldLabel htmlFor="span-canvas-height">
            {t("spanWall.canvasHeight")}
          </FieldLabel>
          <InputGroup>
            <InputGroupInput
              id="span-canvas-height"
              type="number"
              min={320}
              max={16384}
              value={canvas.height}
              onChange={(event) => {
                setDirty(true);
                setCanvas({ ...canvas, height: Number(event.target.value) });
              }}
            />
            <InputGroupAddon align="inline-end">px</InputGroupAddon>
          </InputGroup>
        </Field>
        <div
          className="flex items-center gap-2"
          aria-label={t("spanWall.presetsLabel")}
        >
          <span className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
            {t("spanWall.presetsTitle")}
          </span>
          {[
            { label: "2 × 1", columns: 2 },
            { label: "1 × 2", columns: 1 },
            { label: "2 × 2", columns: 2 },
          ].map((item, index) => (
            <Button
              key={item.label}
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => {
                const nextCanvas =
                  index === 1
                    ? { width: 1920, height: 2160 }
                    : index === 2
                      ? { width: 3840, height: 2160 }
                      : { width: 3840, height: 1080 };
                setCanvas(nextCanvas);
                setPanels(
                  preset(
                    group.screens,
                    nextCanvas.width,
                    nextCanvas.height,
                    item.columns,
                  ),
                );
                setDirty(true);
              }}
            >
              {item.label}
            </Button>
          ))}
        </div>
        {manageable && (
          <div className="flex items-center gap-2">
            <Button
              type="button"
              disabled={!dirty || update.isPending}
              onClick={() =>
                update.mutate({ displayMode: "span", canvas, panels })
              }
            >
              {update.isPending
                ? t("common:actions.saving")
                : t("spanWall.saveAction")}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={update.isPending}
              onClick={() => update.mutate({ displayMode: "mirror" })}
            >
              {t("spanWall.returnAction")}
            </Button>
          </div>
        )}
      </div>
      {update.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("spanWall.saveFailed")}</AlertDescription>
        </Alert>
      )}
      <div className="grid gap-4 lg:grid-cols-2">
        <div
          className="relative min-h-48 overflow-hidden rounded-xl border border-border bg-black"
          style={{
            aspectRatio: `${Math.max(canvas.width, 1)} / ${Math.max(canvas.height, 1)}`,
          }}
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
        <div className="grid max-h-[30rem] gap-3 overflow-auto">
          {panels.map((panel) => (
            <fieldset
              key={panel.screenId}
              className="grid gap-2 rounded-xl border border-border p-3"
            >
              <legend className="px-1 text-sm font-semibold">
                {screenNames.get(panel.screenId) ?? panel.screenId}
              </legend>
              <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
                {(["x", "y", "width", "height"] as const).map((key) => (
                  <Field key={key}>
                    <FieldLabel htmlFor={`span-${panel.screenId}-${key}`}>
                      {key.toUpperCase()}
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
                      <InputGroupAddon align="inline-end">px</InputGroupAddon>
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
            </fieldset>
          ))}
        </div>
      </div>
      {status.isError && (
        <Alert variant="destructive">
          <AlertDescription>{t("spanWall.statusFailed")}</AlertDescription>
        </Alert>
      )}
      {panels.length > 0 && (
        <div
          className="flex flex-wrap gap-x-3 gap-y-1 border-t border-border pt-3 text-sm"
          aria-live="polite"
        >
          <strong className="basis-full">
            {t("spanWall.preparationTitle")}
          </strong>
          {panels.map((panel) => {
            const item = preparationByScreen.get(panel.screenId);
            return (
              <span key={panel.screenId}>
                {screenNames.get(panel.screenId) ?? panel.screenId}:{" "}
                <b>{preparationStatusLabel(item?.status, t)}</b>
                {item?.progress != null
                  ? ` ${Math.round(item.progress * 100)}%`
                  : ""}
              </span>
            );
          })}
        </div>
      )}
    </section>
  );
}
