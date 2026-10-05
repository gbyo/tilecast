import { SlidersHorizontal } from "lucide-react";
import { useId, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { FilterChips, type FilterDefinition } from "../FilterBar";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../ui/combobox";
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
  activeMediaFacetCount,
  mediaStatusOptions,
  type MediaFacetEntity,
  type MediaFacetKey,
  type MediaFacetSources,
  type MediaFacetValues,
} from "./mediaToolbarModel";

// Radio items need a non-empty value, so "any" travels as a sentinel and is
// translated back to the empty string the page stores.
const ANY = "__any__";

type FacetChange = (key: MediaFacetKey, value: string) => void;
type FacetOption = { value: string; label: string };

/**
 * One Filters entry point for the four organizational facets. Phones get a
 * bottom Drawer; everything wider gets a Popover. Both render the same form
 * over the same state, and exactly one of them is mounted.
 */
export function MediaFilters({
  values,
  onChange,
  onReset,
  sources,
}: {
  values: MediaFacetValues;
  onChange: FacetChange;
  onReset: () => void;
  sources: MediaFacetSources;
}) {
  const { t } = useTranslation("content");
  const compact = useCompactLayout();
  const [open, setOpen] = useState(false);
  const count = activeMediaFacetCount(values);
  const label =
    count > 0 ? t("media.toolbar.filtersActive", { count }) : undefined;
  const trigger = (
    <Button variant="outline" aria-label={label}>
      <SlidersHorizontal aria-hidden="true" />
      {t("media.toolbar.filters")}
      {count > 0 && <Badge variant="secondary">{count}</Badge>}
    </Button>
  );
  const form = (
    <MediaFilterForm values={values} onChange={onChange} sources={sources} />
  );

  if (compact) {
    return (
      <Drawer open={open} onOpenChange={setOpen} showSwipeHandle>
        <DrawerTrigger render={trigger} />
        <DrawerContent className="max-h-[calc(100dvh-2rem)]">
          <DrawerHeader>
            <DrawerTitle>{t("media.toolbar.filtersTitle")}</DrawerTitle>
            <DrawerDescription>
              {t("media.toolbar.filtersDescription")}
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
              {t("media.toolbar.filtersReset")}
            </Button>
            <DrawerClose render={<Button type="button" />}>
              {t("media.toolbar.filtersDone")}
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
        className="max-h-(--available-height) w-[min(34rem,calc(100vw-2rem))] gap-0 overflow-y-auto p-0"
        aria-label={t("media.toolbar.filtersTitle")}
      >
        <div className="px-4 pt-4 pb-3">
          <h3 className="text-sm font-semibold">
            {t("media.toolbar.filtersTitle")}
          </h3>
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
            {t("media.toolbar.filtersReset")}
          </Button>
          <Button type="button" size="sm" onClick={() => setOpen(false)}>
            {t("media.toolbar.filtersDone")}
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function facetOptions(
  entities: readonly MediaFacetEntity[],
  label: (entity: MediaFacetEntity) => string,
): FacetOption[] {
  return entities.map((entity) => ({ value: entity.id, label: label(entity) }));
}

function MediaFilterForm({
  values,
  onChange,
  sources,
}: {
  values: MediaFacetValues;
  onChange: FacetChange;
  sources: MediaFacetSources;
}) {
  const { t } = useTranslation("content");
  const id = useId();
  const { folders, collections, tags } = sources;
  const folderOptions = useMemo(
    () =>
      facetOptions(folders, (folder) =>
        t("media.toolbar.folderOption", {
          name: folder.name,
          count: folder.assetCount ?? 0,
        }),
      ),
    [folders, t],
  );
  const collectionOptions = useMemo(
    () =>
      facetOptions(collections, (collection) =>
        t("media.toolbar.collectionOption", {
          name: collection.name,
          count: collection.assetCount ?? 0,
        }),
      ),
    [collections, t],
  );
  const tagOptions = useMemo(
    () =>
      facetOptions(tags, (tag) =>
        t("media.toolbar.tagOption", {
          name: tag.name,
          count: tag.assetCount ?? 0,
        }),
      ),
    [tags, t],
  );

  return (
    <FieldGroup className="gap-5">
      <div className="grid items-start gap-x-8 gap-y-5 sm:grid-cols-2">
        <StatusFacet
          idPrefix={`${id}-status`}
          value={values.status}
          onChange={(next) => onChange("status", next)}
        />
        <div className="grid content-start gap-5">
          <FacetCombobox
            id={`${id}-folder`}
            label={t("media.toolbar.facets.folder")}
            placeholder={t("picker.toolbar.allFolders")}
            empty={t(
              folderOptions.length === 0
                ? "media.toolbar.noFolders"
                : "media.toolbar.noMatchingFolders",
            )}
            options={folderOptions}
            value={values.folder}
            onChange={(next) => onChange("folder", next)}
          />
          <FacetCombobox
            id={`${id}-collection`}
            label={t("media.toolbar.facets.collection")}
            placeholder={t("picker.toolbar.allCollections")}
            empty={t(
              collectionOptions.length === 0
                ? "media.toolbar.noCollections"
                : "media.toolbar.noMatchingCollections",
            )}
            options={collectionOptions}
            value={values.collection}
            onChange={(next) => onChange("collection", next)}
          />
          <FacetCombobox
            id={`${id}-tag`}
            label={t("media.toolbar.facets.tag")}
            placeholder={t("picker.toolbar.allTags")}
            empty={t(
              tagOptions.length === 0
                ? "media.toolbar.noTags"
                : "media.toolbar.noMatchingTags",
            )}
            options={tagOptions}
            value={values.tag}
            onChange={(next) => onChange("tag", next)}
          />
        </div>
      </div>
    </FieldGroup>
  );
}

function StatusFacet({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation("content");
  const legendId = `${idPrefix}-legend`;
  const options = [
    { value: ANY, label: t("media.toolbar.filterAny") },
    ...mediaStatusOptions.map((option) => ({
      value: option.value,
      label: t(option.labelKey),
    })),
  ];
  return (
    <FieldSet className="content-start gap-2">
      <FieldLegend variant="label" id={legendId} className="mb-0">
        {t("media.toolbar.facets.status")}
      </FieldLegend>
      <RadioGroup
        aria-labelledby={legendId}
        value={value || ANY}
        onValueChange={(next) => onChange(next === ANY ? "" : String(next))}
        className="gap-1.5"
      >
        {options.map((option) => {
          const optionId = `${idPrefix}-${option.value}`;
          return (
            <Field
              key={option.value}
              orientation="horizontal"
              className="gap-2"
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

/**
 * Folders, collections, and tags can grow without bound, so each is a
 * type-to-find picker rather than a long Select. One value per facet; clearing
 * the input means "all".
 */
function FacetCombobox({
  id,
  label,
  placeholder,
  empty,
  options,
  value,
  onChange,
}: {
  id: string;
  label: string;
  placeholder: string;
  empty: string;
  options: readonly FacetOption[];
  value: string;
  onChange: (value: string) => void;
}) {
  const selected = options.find((option) => option.value === value) ?? null;
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Combobox
        items={options}
        value={selected}
        isItemEqualToValue={(item: FacetOption, next: FacetOption) =>
          item.value === next.value
        }
        itemToStringLabel={(item: FacetOption) => item.label}
        onValueChange={(next: FacetOption | null) =>
          onChange(next?.value ?? "")
        }
      >
        <ComboboxInput
          id={id}
          aria-label={label}
          placeholder={placeholder}
          showClear
          className="w-full"
        />
        <ComboboxContent>
          <ComboboxEmpty>{empty}</ComboboxEmpty>
          <ComboboxList>
            {(item: FacetOption) => (
              <ComboboxItem key={item.value} value={item}>
                {item.label}
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </Field>
  );
}

/**
 * The active facets, as removable chips. Shown outside the Filters surface so a
 * narrowed library never reads as an empty one. Clearing removes only the
 * facets — never search, media type, sort, or view.
 */
export function MediaFacetChips({
  values,
  onChange,
  onClear,
  sources,
}: {
  values: MediaFacetValues;
  onChange: FacetChange;
  onClear: () => void;
  sources: MediaFacetSources;
}) {
  const { t } = useTranslation("content");
  const definitions = useMemo<FilterDefinition[]>(() => {
    const named = (entities: readonly MediaFacetEntity[]) =>
      entities.map((entity) => ({ value: entity.id, label: entity.name }));
    return [
      {
        key: "status",
        kind: "select",
        label: t("media.toolbar.facets.status"),
        allLabel: t("media.toolbar.filterAny"),
        options: mediaStatusOptions.map((option) => ({
          value: option.value,
          label: t(option.labelKey),
        })),
      },
      {
        key: "folder",
        kind: "select",
        label: t("media.toolbar.facets.folder"),
        allLabel: t("picker.toolbar.allFolders"),
        options: named(sources.folders),
      },
      {
        key: "collection",
        kind: "select",
        label: t("media.toolbar.facets.collection"),
        allLabel: t("picker.toolbar.allCollections"),
        options: named(sources.collections),
      },
      {
        key: "tag",
        kind: "select",
        label: t("media.toolbar.facets.tag"),
        allLabel: t("picker.toolbar.allTags"),
        options: named(sources.tags),
      },
    ];
  }, [sources, t]);
  return (
    <FilterChips
      definitions={definitions}
      values={values}
      onChange={(key, value) => onChange(key as MediaFacetKey, value)}
      onClear={onClear}
      clearLabel={t("media.toolbar.clearFilters")}
    />
  );
}
