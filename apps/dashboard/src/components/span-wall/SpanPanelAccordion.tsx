import { useTranslation } from "react-i18next";
import type { SpanPanel } from "../../api/types";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../ui/accordion";
import { Field, FieldLabel } from "../ui/field";
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
import { bezelKeys, geometryKeys, rotationOptions } from "./spanWallModel";

type NumericKey = (typeof geometryKeys)[number] | (typeof bezelKeys)[number];

function PixelField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  const { t } = useTranslation("layouts");
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <InputGroup>
        <InputGroupInput
          id={id}
          type="number"
          min={0}
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(Number(event.target.value))}
        />
        <InputGroupAddon align="inline-end">
          {t("spanWall.unitPx")}
        </InputGroupAddon>
      </InputGroup>
    </Field>
  );
}

/** Per-screen geometry, rotation, and bezel compensation, one panel at a time. */
export function SpanPanelAccordion({
  panels,
  screenNames,
  manageable,
  onChange,
}: {
  panels: readonly SpanPanel[];
  screenNames: ReadonlyMap<string, string>;
  manageable: boolean;
  onChange: (screenId: string, key: keyof SpanPanel, value: number) => void;
}) {
  const { t } = useTranslation("layouts");
  const numeric = (panel: SpanPanel, key: NumericKey, label: string) => (
    <PixelField
      key={key}
      id={`span-${panel.screenId}-${key}`}
      label={label}
      value={panel[key]}
      disabled={!manageable}
      onChange={(value) => onChange(panel.screenId, key, value)}
    />
  );
  return (
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
                  {geometryKeys.map((key) =>
                    numeric(panel, key, t(`spanWall.panelFields.${key}`)),
                  )}
                  <Field>
                    <FieldLabel htmlFor={`span-${panel.screenId}-rotation`}>
                      {t("spanWall.rotationLabel")}
                    </FieldLabel>
                    <Select
                      items={rotationOptions}
                      value={String(panel.rotation)}
                      disabled={!manageable}
                      onValueChange={(next) =>
                        onChange(
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
                    {bezelKeys.map((key) =>
                      numeric(panel, key, t(`spanWall.bezelFields.${key}`)),
                    )}
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
  );
}
