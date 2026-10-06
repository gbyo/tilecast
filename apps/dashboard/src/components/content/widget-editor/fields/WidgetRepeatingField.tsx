/**
 * A repeating group as an Accordion: each item is named by its first
 * filled-in text, opens to its own fields, and can be removed. New items
 * open ready to fill in, and the declared item limit is respected.
 */
import { visibleAuthoringFields } from "@tilecast/widget-sdk";
import { Plus, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldTitle,
} from "@/components/ui/field";
import type { ContentDefinitionField } from "@/api/types";
import type { WidgetConfiguration } from "../widgetEditorModel";
import { WidgetInspectorField } from "./WidgetInspectorField";
import { fieldDomId, type InspectorFieldProps } from "./fieldContext";

const summaryControls = new Set(["text", "multiline_text", "url"]);

function itemSummary(
  item: WidgetConfiguration,
  itemFields: readonly ContentDefinitionField[],
): string | null {
  for (const field of itemFields) {
    if (!summaryControls.has(field.control)) continue;
    const value = item[field.key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return null;
}

let nextKey = 0;
const newKey = () => `item-${++nextKey}`;

export function WidgetRepeatingField(props: InspectorFieldProps) {
  const { field, path, value, onChange, readOnly, errorFor, focusPath } = props;
  const { t } = useTranslation("content");
  const id = fieldDomId(path);
  const error = errorFor(path);
  const items: WidgetConfiguration[] = Array.isArray(value)
    ? value.map((item) =>
        item && typeof item === "object" && !Array.isArray(item)
          ? (item as WidgetConfiguration)
          : {},
      )
    : [];
  const itemFields = field.itemFields ?? [];
  // Stable keys keep an item's open state and focus while others are
  // added or removed. A list replaced from outside (discard) gets new ones.
  const keys = useRef<string[]>([]);
  if (keys.current.length !== items.length)
    keys.current = items.map((_, index) => keys.current[index] ?? newKey());
  const [open, setOpen] = useState<string[]>([]);
  const limit = field.maximumItems ?? 0;

  // Open the item that holds a problem the editor wants to show.
  useEffect(() => {
    if (!focusPath?.startsWith(`${path}.`)) return;
    const index = Number(focusPath.slice(path.length + 1).split(".")[0]);
    const key = keys.current[index];
    if (key)
      setOpen((current) =>
        current.includes(key) ? current : [...current, key],
      );
  }, [focusPath, path]);

  const update = (index: number, next: WidgetConfiguration) =>
    onChange(items.map((item, position) => (position === index ? next : item)));
  const remove = (index: number) => {
    keys.current = keys.current.filter((_, position) => position !== index);
    onChange(items.filter((_, position) => position !== index));
  };
  const add = () => {
    const key = newKey();
    keys.current = [...keys.current, key];
    setOpen((current) => [...current, key]);
    const defaults = Object.fromEntries(
      itemFields
        .filter((entry) => entry.default !== undefined)
        .map((entry) => [entry.key, structuredClone(entry.default)]),
    );
    onChange([...items, defaults]);
  };

  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldTitle id={`${id}-label`}>{field.label}</FieldTitle>
      {field.description && (
        <FieldDescription id={`${id}-description`}>
          {field.description}
        </FieldDescription>
      )}
      {items.length > 0 ? (
        <Accordion
          multiple
          value={open}
          onValueChange={(next) => setOpen(next as string[])}
          aria-labelledby={`${id}-label`}
          className="rounded-md border border-border"
        >
          {items.map((item, index) => {
            const key = keys.current[index]!;
            const name =
              itemSummary(item, itemFields) ??
              t("widgets.editor.repeat.item", { index: index + 1 });
            const itemPath = `${path}.${index}`;
            const visible = visibleAuthoringFields(itemFields, item);
            return (
              <AccordionItem key={key} value={key} className="px-3">
                <AccordionTrigger className="py-3">
                  <span className="min-w-0 truncate">{name}</span>
                </AccordionTrigger>
                <AccordionContent className="grid gap-5 pb-4">
                  {visible.map((itemField) => (
                    <WidgetInspectorField
                      key={itemField.key}
                      {...props}
                      field={itemField}
                      path={`${itemPath}.${itemField.key}`}
                      value={item[itemField.key]}
                      values={item}
                      fields={itemFields}
                      onChange={(next) =>
                        update(index, { ...item, [itemField.key]: next })
                      }
                    />
                  ))}
                  {!readOnly && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      className="justify-self-start text-destructive hover:text-destructive"
                      aria-label={t("widgets.editor.repeat.removeLabel", {
                        name,
                      })}
                      onClick={() => remove(index)}
                    >
                      <Trash2 aria-hidden="true" />
                      {t("widgets.editor.repeat.remove")}
                    </Button>
                  )}
                </AccordionContent>
              </AccordionItem>
            );
          })}
        </Accordion>
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("widgets.editor.repeat.empty")}
        </p>
      )}
      {!readOnly && items.length < limit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="justify-self-start"
          onClick={add}
        >
          <Plus aria-hidden="true" />
          {t("widgets.editor.repeat.add")}
        </Button>
      )}
      {!readOnly && limit > 0 && items.length >= limit && (
        <p className="text-xs text-muted-foreground">
          {t("widgets.editor.repeat.limit", { count: limit })}
        </p>
      )}
      {error && <FieldError id={`${id}-error`}>{error}</FieldError>}
    </Field>
  );
}
