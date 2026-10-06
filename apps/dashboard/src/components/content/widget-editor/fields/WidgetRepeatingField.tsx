/**
 * A repeating group as an Accordion: each item is named by its first
 * filled-in text, opens to its own fields, and can be removed. New items
 * open ready to fill in, and the declared item limit is respected.
 */
import { visibleAuthoringFields } from "@tilecast/widget-sdk";
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
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
import { useDeferredFocus, useStableRowIds } from "./rowIdentity";

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

export function WidgetRepeatingField(props: InspectorFieldProps) {
  const { field, path, value, onChange, readOnly, errorFor } = props;
  const { focusPath, focusNonce } = props;
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
  const limit = field.maximumItems ?? 0;
  // Row ids keep an item's open state and focus with the right item while
  // others are added or removed. They are editor-only (see rowIdentity).
  const rows = useStableRowIds(items.length);
  const focusLater = useDeferredFocus();
  const [open, setOpen] = useState<string[]>([]);

  // Open the item that holds a problem the editor wants to show. Adjusted
  // while rendering, so a newly mounted field opens it on its first paint.
  const [handledFocus, setHandledFocus] = useState(0);
  if (handledFocus !== focusNonce) {
    setHandledFocus(focusNonce);
    if (focusPath?.startsWith(`${path}.`)) {
      const index = Number(focusPath.slice(path.length + 1).split(".")[0]);
      const rowId = rows.ids[index];
      if (rowId && !open.includes(rowId)) setOpen([...open, rowId]);
    }
  }

  const update = (index: number, next: WidgetConfiguration) =>
    onChange(items.map((item, position) => (position === index ? next : item)));
  const remove = (index: number) => {
    rows.removeAt(index);
    onChange(items.filter((_, position) => position !== index));
    // The Remove button leaves with its item. Hand focus to a neighbor, or
    // to Add when no item is left.
    const neighbor = rows.ids[index + 1] ?? rows.ids[index - 1];
    focusLater(neighbor ? `${id}-trigger-${neighbor}` : `${id}-add`);
  };
  const add = () => {
    const rowId = rows.append();
    setOpen((current) => [...current, rowId]);
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
            const rowId = rows.ids[index]!;
            const name =
              itemSummary(item, itemFields) ??
              t("widgets.editor.repeat.item", { index: index + 1 });
            const itemPath = `${path}.${index}`;
            const visible = visibleAuthoringFields(itemFields, item);
            return (
              <AccordionItem key={rowId} value={rowId} className="px-3">
                <AccordionTrigger
                  id={`${id}-trigger-${rowId}`}
                  className="py-3"
                >
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
          id={`${id}-add`}
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
