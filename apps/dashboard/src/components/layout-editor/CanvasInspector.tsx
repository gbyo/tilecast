import { AlignCenter } from "lucide-react";
import type { LayoutDocument } from "../../api/types";
import { Field, FieldLabel } from "../ui/field";
import { Input } from "../ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { optionLabel } from "../../content/data-sources/shared";
import { NumberField } from "./PlacementInspector";

const canvasPresetOptions = [
  { value: "1920x1080", label: "1920 × 1080" },
  { value: "1080x1920", label: "1080 × 1920" },
  { value: "3840x2160", label: "3840 × 2160" },
  { value: "2160x3840", label: "2160 × 3840" },
];

export function CanvasInspector({
  document,
  update,
}: {
  document: LayoutDocument;
  update: (change: (draft: LayoutDocument) => void) => void;
}) {
  const presetValue = `${document.canvas.width}x${document.canvas.height}`;
  return (
    <div className="grid gap-4">
      <Field>
        <FieldLabel htmlFor="canvas-preset">Canvas preset</FieldLabel>
        <RheaSelect
          value={presetValue}
          onValueChange={(next) => {
            const [width, height] = (next || presetValue)
              .split("x")
              .map(Number);
            update((draft) => {
              draft.canvas.width = width!;
              draft.canvas.height = height!;
              draft.canvas.orientation =
                width! > height! ? "landscape" : "portrait";
              draft.placements = draft.placements.filter(
                (item) =>
                  item.x + item.width <= width! &&
                  item.y + item.height <= height!,
              );
            });
          }}
        >
          <SelectTrigger id="canvas-preset" aria-label="Canvas preset">
            <SelectValue>
              {optionLabel(canvasPresetOptions, presetValue)}
            </SelectValue>
          </SelectTrigger>
          <SelectContent>
            {canvasPresetOptions.map((option) => (
              <SelectItem key={option.value} value={option.value}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </RheaSelect>
      </Field>
      <div className="grid gap-4 sm:grid-cols-2">
        <NumberField
          label="Width"
          value={document.canvas.width}
          min={320}
          max={7680}
          onChange={(value) =>
            update((d) => {
              d.canvas.width = value;
              d.canvas.orientation = "custom";
            })
          }
        />
        <NumberField
          label="Height"
          value={document.canvas.height}
          min={320}
          max={7680}
          onChange={(value) =>
            update((d) => {
              d.canvas.height = value;
              d.canvas.orientation = "custom";
            })
          }
        />
      </div>
      <Field>
        <FieldLabel htmlFor="canvas-background">Background</FieldLabel>
        <Input
          id="canvas-background"
          type="color"
          value={document.canvas.backgroundColor.slice(0, 7)}
          onChange={(event) =>
            update((d) => (d.canvas.backgroundColor = event.target.value))
          }
        />
      </Field>
      <NumberField
        label="Safe area (%)"
        value={document.canvas.safeAreaPercent}
        min={0}
        max={20}
        step={1}
        onChange={(value) => update((d) => (d.canvas.safeAreaPercent = value))}
      />
      <div className="flex items-center gap-2 text-sm text-muted-foreground">
        <AlignCenter size={17} aria-hidden="true" />
        <span>
          {document.placements.length} layers · {document.canvas.orientation}
        </span>
      </div>
    </div>
  );
}
