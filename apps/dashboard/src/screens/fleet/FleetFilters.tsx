import { SlidersHorizontal } from "lucide-react";
import { useId, useState } from "react";
import { useTranslation } from "react-i18next";
import type { Location } from "../../api/types";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../../components/ui/combobox";
import {
  Drawer,
  DrawerClose,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
  DrawerTrigger,
} from "../../components/ui/drawer";
import {
  Field,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../../components/ui/field";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../../components/ui/popover";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { useCompactLayout } from "../../hooks/use-compact-layout";
import {
  activeFleetFilterCount,
  fleetOrientationOptions,
  fleetPlayingOptions,
  fleetStatusOptions,
  fleetUpdateOptions,
  type FleetFilterKey,
  type FleetFilterValues,
} from "./fleetModel";

// Radio and Select items need a non-empty value, so "any" travels as a
// sentinel and is translated back to the empty string the page stores.
const ANY = "__any__";

type NamedOption = { id: string; name: string };

export type FleetFilterSources = {
  locations: readonly Location[];
  /** Raw platform ids reported by the fleet, already de-duplicated. */
  platforms: readonly { value: string; label: string }[];
  displayGroups: readonly NamedOption[];
};

type FilterChange = (key: FleetFilterKey, value: string) => void;

/**
 * One Filters entry point. Phones get a bottom Drawer; everything wider gets
 * a Popover. Both render the same form over the same state, and exactly one
 * of them is mounted.
 */
export function FleetFilters({
  values,
  onChange,
  onReset,
  sources,
}: {
  values: FleetFilterValues;
  onChange: FilterChange;
  onReset: () => void;
  sources: FleetFilterSources;
}) {
  const { t } = useTranslation("screens");
  const compact = useCompactLayout();
  const [open, setOpen] = useState(false);
  const count = activeFleetFilterCount(values);
  const label = count > 0 ? t("list.filtersActive", { count }) : undefined;
  const trigger = (
    <Button variant="outline" aria-label={label}>
      <SlidersHorizontal aria-hidden="true" />
      {t("list.filters")}
      {count > 0 && <Badge variant="secondary">{count}</Badge>}
    </Button>
  );
  const form = (
    <FleetFilterForm values={values} onChange={onChange} sources={sources} />
  );

  if (compact) {
    return (
      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerTrigger render={trigger} />
        <DrawerContent className="max-h-[calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>{t("list.filtersTitle")}</DrawerTitle>
            <DrawerDescription>
              {t("list.filtersDescription")}
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
              {t("list.filtersReset")}
            </Button>
            <DrawerClose render={<Button type="button" />}>
              {t("list.filtersDone")}
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
        className="max-h-(--available-height) w-[min(36rem,calc(100vw-2rem))] gap-0 overflow-y-auto p-0"
        aria-label={t("list.filtersTitle")}
      >
        <div className="px-4 pt-4 pb-3">
          <h3 className="text-sm font-semibold">{t("list.filtersTitle")}</h3>
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
            {t("list.filtersReset")}
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            {t("list.filtersDone")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function FleetFilterForm({
  values,
  onChange,
  sources,
}: {
  values: FleetFilterValues;
  onChange: FilterChange;
  sources: FleetFilterSources;
}) {
  const { t } = useTranslation("screens");
  const id = useId();
  const selectedLocation =
    sources.locations.find((item) => item.id === values.location) ?? null;
  const groupItems: NamedOption[] = [
    { id: "any", name: t("list.syncOptions.any") },
    { id: "none", name: t("list.syncOptions.none") },
    ...sources.displayGroups,
  ];
  const selectedGroup =
    groupItems.find((item) => item.id === values.syncGroup) ?? null;
  const platformItems = [
    { value: ANY, label: t("list.allPlatforms") },
    ...sources.platforms,
  ];

  return (
    <FieldGroup className="gap-5">
      <div className="grid items-start gap-x-8 gap-y-5 sm:grid-cols-2">
        <div className="grid content-start gap-5">
          <RadioFacet
            idPrefix={`${id}-status`}
            legend={t("list.statusFilter")}
            value={values.status}
            onChange={(next) => onChange("status", next)}
            anyLabel={t("list.filterAny")}
            options={fleetStatusOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          />
          <RadioFacet
            idPrefix={`${id}-update`}
            legend={t("list.updateFilter")}
            value={values.update}
            onChange={(next) => onChange("update", next)}
            anyLabel={t("list.filterAny")}
            options={fleetUpdateOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          />
          <RadioFacet
            idPrefix={`${id}-orientation`}
            legend={t("list.orientationFilter")}
            value={values.orientation}
            onChange={(next) => onChange("orientation", next)}
            anyLabel={t("list.filterAny")}
            inline
            options={fleetOrientationOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          />
        </div>
        <div className="grid content-start gap-5">
          <Field>
            <FieldLabel htmlFor={`${id}-location`}>
              {t("list.locationFilter")}
            </FieldLabel>
            <Combobox
              items={sources.locations}
              value={selectedLocation}
              itemToStringLabel={(item: Location) => item.name}
              onValueChange={(next: Location | null) =>
                onChange("location", next?.id ?? "")
              }
            >
              <ComboboxInput
                id={`${id}-location`}
                aria-label={t("list.locationFilter")}
                placeholder={t("list.allLocations")}
                showClear
                className="w-full"
              />
              <ComboboxContent>
                <ComboboxEmpty>{t("list.noMatchingLocations")}</ComboboxEmpty>
                <ComboboxList>
                  {(item: Location) => (
                    <ComboboxItem key={item.id} value={item}>
                      {item.name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-platform`}>
              {t("list.platformFilter")}
            </FieldLabel>
            <Select
              items={platformItems}
              value={values.platform || ANY}
              onValueChange={(next) =>
                onChange("platform", !next || next === ANY ? "" : next)
              }
            >
              <SelectTrigger id={`${id}-platform`} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {platformItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-group`}>
              {t("list.groupFilter")}
            </FieldLabel>
            <Combobox
              items={groupItems}
              value={selectedGroup}
              itemToStringLabel={(item: NamedOption) => item.name}
              onValueChange={(next: NamedOption | null) =>
                onChange("syncGroup", next?.id ?? "")
              }
            >
              <ComboboxInput
                id={`${id}-group`}
                aria-label={t("list.groupFilter")}
                placeholder={t("list.syncOptions.all")}
                showClear
                className="w-full"
              />
              <ComboboxContent>
                <ComboboxEmpty>{t("list.noMatchingGroups")}</ComboboxEmpty>
                <ComboboxList>
                  {(item: NamedOption) => (
                    <ComboboxItem key={item.id} value={item}>
                      {item.name}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
          </Field>
          <RadioFacet
            idPrefix={`${id}-playing`}
            legend={t("list.playingFilter")}
            value={values.playing}
            onChange={(next) => onChange("playing", next)}
            anyLabel={t("list.filterAnything")}
            options={fleetPlayingOptions.map((option) => ({
              value: option.value,
              label: t(option.labelKey),
            }))}
          />
        </div>
      </div>
    </FieldGroup>
  );
}

function RadioFacet({
  idPrefix,
  legend,
  value,
  onChange,
  anyLabel,
  options,
  inline = false,
}: {
  idPrefix: string;
  legend: string;
  value: string;
  onChange: (value: string) => void;
  anyLabel: string;
  options: readonly { value: string; label: string }[];
  /** Lays a short set out in one wrapping row. */
  inline?: boolean;
}) {
  const legendId = `${idPrefix}-legend`;
  const all = [{ value: ANY, label: anyLabel }, ...options];
  return (
    <FieldSet className="content-start gap-2">
      <FieldLegend variant="label" id={legendId} className="mb-0">
        {legend}
      </FieldLegend>
      <RadioGroup
        aria-labelledby={legendId}
        value={value || ANY}
        onValueChange={(next) => onChange(next === ANY ? "" : String(next))}
        className={inline ? "flex flex-wrap gap-x-4 gap-y-1.5" : "gap-1.5"}
      >
        {all.map((option) => {
          const optionId = `${idPrefix}-${option.value}`;
          return (
            <Field
              key={option.value}
              orientation="horizontal"
              className={inline ? "w-auto gap-2" : "gap-2"}
            >
              <RadioGroupItem
                value={option.value}
                id={optionId}
                aria-labelledby={`${optionId}-label`}
              />
              <FieldLabel
                id={`${optionId}-label`}
                htmlFor={optionId}
                className="font-normal"
              >
                {option.label}
              </FieldLabel>
            </Field>
          );
        })}
      </RadioGroup>
    </FieldSet>
  );
}
