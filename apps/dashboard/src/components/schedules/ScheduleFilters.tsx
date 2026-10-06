import type { ParseKeys } from "i18next";
import { SlidersHorizontal } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilterChips, type FilterDefinition } from "../FilterBar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "../ui/drawer";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../ui/field";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { RadioGroup, RadioGroupItem } from "../ui/radio-group";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import {
  activeScheduleFacetCount,
  schedulePresentationOptions,
  scheduleStatusOptions,
  scheduleTypeOptions,
  type ScheduleFacetKey,
  type ScheduleFacetValues,
} from "./scheduleLibraryModel";

// Radio items need a non-empty value, so "any" travels as a sentinel and is
// translated back to the empty string the page stores.
const ANY = "__any__";

type FacetChange = (key: ScheduleFacetKey, value: string) => void;

/**
 * One Filters entry point for the three Schedule facets. Phones get a bottom
 * Drawer; everything wider gets a Popover. Both render the same form over the
 * same state, and exactly one of them is mounted.
 */
export function ScheduleFilters({
  values,
  onChange,
  onReset,
}: {
  values: ScheduleFacetValues;
  onChange: FacetChange;
  onReset: () => void;
}) {
  const { t } = useTranslation("schedules");
  const compact = useCompactLayout();
  const [open, setOpen] = useState(false);
  const count = activeScheduleFacetCount(values);
  const label = count > 0 ? t("toolbar.filtersActive", { count }) : undefined;
  const trigger = (
    <Button variant="outline" aria-label={label}>
      <SlidersHorizontal aria-hidden="true" />
      {t("toolbar.filters")}
      {count > 0 && <Badge variant="secondary">{count}</Badge>}
    </Button>
  );
  const form = <ScheduleFilterForm values={values} onChange={onChange} />;

  if (compact) {
    return (
      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerTrigger render={trigger} />
        <DrawerContent className="max-h-[calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>{t("toolbar.filtersTitle")}</DrawerTitle>
            <DrawerDescription>
              {t("toolbar.filtersDescription")}
            </DrawerDescription>
          </DrawerHeader>
          <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">{form}</div>
          <DrawerFooter className="flex-row justify-between border-t pt-4">
            <Button
              type="button"
              variant="ghost"
              disabled={count === 0}
              onClick={onReset}
            >
              {t("toolbar.filtersReset")}
            </Button>
            <DrawerClose render={<Button type="button" />}>
              {t("toolbar.filtersDone")}
            </DrawerClose>
          </DrawerFooter>
        </DrawerContent>
      </Drawer>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={trigger} />
      <PopoverContent
        align="start"
        className="max-h-(--available-height) w-[min(30rem,calc(100vw-2rem))] gap-0 overflow-y-auto p-0"
        aria-label={t("toolbar.filtersTitle")}
      >
        <div className="px-4 pt-4 pb-3">
          <h3 className="text-sm font-semibold">{t("toolbar.filtersTitle")}</h3>
        </div>
        <div className="px-4 pb-4">{form}</div>
        <div className="sticky bottom-0 flex items-center justify-between border-t bg-popover px-4 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={count === 0}
            onClick={onReset}
          >
            {t("toolbar.filtersReset")}
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            {t("toolbar.filtersDone")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

type FacetOption = { value: string; labelKey: ParseKeys<"schedules"> };

function ScheduleFilterForm({
  values,
  onChange,
}: {
  values: ScheduleFacetValues;
  onChange: FacetChange;
}) {
  const { t } = useTranslation("schedules");
  const id = useId();
  return (
    <FieldGroup className="gap-5">
      <div className="grid items-start gap-x-8 gap-y-5 sm:grid-cols-3">
        <FacetRadios
          idPrefix={`${id}-status`}
          legend={t("toolbar.facets.status")}
          value={values.enabled}
          options={scheduleStatusOptions}
          onChange={(next) => onChange("enabled", next)}
        />
        <FacetRadios
          idPrefix={`${id}-type`}
          legend={t("toolbar.facets.type")}
          value={values.type}
          options={scheduleTypeOptions}
          onChange={(next) => onChange("type", next)}
        />
        <FacetRadios
          idPrefix={`${id}-presentation`}
          legend={t("toolbar.facets.presentation")}
          value={values.presentationType}
          options={schedulePresentationOptions}
          onChange={(next) => onChange("presentationType", next)}
        />
      </div>
    </FieldGroup>
  );
}

/**
 * A small, fixed, mutually exclusive facet: radios, with "Any" first. These
 * are too few for a combobox and too visible a choice for a hidden Select.
 */
function FacetRadios({
  idPrefix,
  legend,
  value,
  options,
  onChange,
}: {
  idPrefix: string;
  legend: string;
  value: string;
  options: readonly FacetOption[];
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("schedules");
  const legendId = `${idPrefix}-legend`;
  const items = [
    { value: ANY, label: t("toolbar.filterAny") },
    ...options.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
    })),
  ];
  return (
    <FieldSet className="content-start gap-2">
      <FieldLegend variant="label" id={legendId} className="mb-0">
        {legend}
      </FieldLegend>
      <RadioGroup
        aria-labelledby={legendId}
        value={value || ANY}
        onValueChange={(next) => onChange(next === ANY ? "" : String(next))}
        className="gap-1.5"
      >
        {items.map((item) => {
          const itemId = `${idPrefix}-${item.value}`;
          return (
            <Field key={item.value} orientation="horizontal" className="gap-2">
              <RadioGroupItem
                value={item.value}
                id={itemId}
                aria-labelledby={`${itemId}-label`}
              />
              <FieldLabel
                id={`${itemId}-label`}
                htmlFor={itemId}
                className="font-normal"
              >
                {item.label}
              </FieldLabel>
            </Field>
          );
        })}
      </RadioGroup>
    </FieldSet>
  );
}

/**
 * The active facets, as removable chips with human labels. Search is already
 * visible in its own field and sort is not a filter, so neither appears here,
 * and clearing never touches them.
 */
export function ScheduleFacetChips({
  values,
  onChange,
  onClear,
}: {
  values: ScheduleFacetValues;
  onChange: FacetChange;
  onClear: () => void;
}) {
  const { t } = useTranslation("schedules");
  const definitions = useMemo<FilterDefinition[]>(() => {
    const options = (list: readonly FacetOption[]) =>
      list.map((option) => ({
        value: option.value,
        label: t(option.labelKey),
      }));
    return [
      {
        key: "enabled",
        kind: "select",
        label: t("toolbar.facets.status"),
        allLabel: t("toolbar.filterAny"),
        options: options(scheduleStatusOptions),
      },
      {
        key: "type",
        kind: "select",
        label: t("toolbar.facets.type"),
        allLabel: t("toolbar.filterAny"),
        options: options(scheduleTypeOptions),
      },
      {
        key: "presentationType",
        kind: "select",
        label: t("toolbar.facets.presentation"),
        allLabel: t("toolbar.filterAny"),
        options: options(schedulePresentationOptions),
      },
    ];
  }, [t]);
  return (
    <FilterChips
      definitions={definitions}
      values={values}
      onChange={(key, value) => onChange(key as ScheduleFacetKey, value)}
      onClear={onClear}
      clearLabel={t("toolbar.clearFilters")}
    />
  );
}
