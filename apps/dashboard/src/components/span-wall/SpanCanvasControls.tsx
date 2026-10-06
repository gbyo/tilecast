import { useTranslation } from "react-i18next";
import { Button } from "../ui/button";
import { ButtonGroup } from "../ui/button-group";
import { Field, FieldLabel } from "../ui/field";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../ui/input-group";
import { spanPresets, type SpanCanvas, type SpanPreset } from "./spanWallModel";

/** Canvas size fields and the preset commands that replace the draft. */
export function SpanCanvasControls({
  canvas,
  manageable,
  onSizeChange,
  onPreset,
}: {
  canvas: SpanCanvas;
  manageable: boolean;
  onSizeChange: (key: keyof SpanCanvas, value: number) => void;
  onPreset: (preset: SpanPreset) => void;
}) {
  const { t } = useTranslation("layouts");
  const sizeField = (key: keyof SpanCanvas, label: string) => (
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
          onChange={(event) => onSizeChange(key, Number(event.target.value))}
        />
        <InputGroupAddon align="inline-end">
          {t("spanWall.unitPx")}
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
  return (
    <div className="grid gap-3">
      <h3 className="text-sm font-semibold">{t("spanWall.canvasTitle")}</h3>
      <div className="flex flex-wrap items-end gap-3">
        {sizeField("width", t("spanWall.canvasWidth"))}
        {sizeField("height", t("spanWall.canvasHeight"))}
        {manageable && (
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">
              {t("spanWall.presetsTitle")}
            </span>
            <ButtonGroup aria-label={t("spanWall.presetsLabel")}>
              {spanPresets.map((preset) => (
                <Button
                  key={preset.label}
                  type="button"
                  variant="outline"
                  onClick={() => onPreset(preset)}
                >
                  {preset.label}
                </Button>
              ))}
            </ButtonGroup>
          </div>
        )}
      </div>
    </div>
  );
}
