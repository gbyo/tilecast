import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type {
  FormDataSource,
  FormTypedDataset,
  FormView,
  FormViewInput,
} from "../api/types";
import { api, ApiError } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button as RheaButton } from "../components/ui/button";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { toast } from "../components/ui/toast";
import {
  availableOutputFields,
  isTimeField,
  operatorsForType,
} from "./outputFields";
import { formToneBadgeProps } from "./formBadge";
import { slugifyKey } from "./formKeys";

// Rhea Select has no empty-string item, so the "none" choice in each legacy
// native select is an explicit sentinel mapped back to "" in the handler.
const NONE_VALUE = "__none__";

function emptyView(): FormViewInput {
  return {
    key: "",
    name: "",
    includedStates: [],
    fieldFilters: [],
    timeFilter: { enabled: false },
    sort: [],
    outputFields: [],
    recordLimit: 100,
    position: 0,
  };
}

function toInput(view: FormView): FormViewInput {
  return {
    key: view.key,
    name: view.name,
    includedStates: [...view.includedStates],
    fieldFilters: view.fieldFilters.map((f) => ({ ...f })),
    timeFilter: { ...view.timeFilter },
    sort: view.sort.map((s) => ({ ...s })),
    outputFields: [...view.outputFields],
    recordLimit: view.recordLimit,
    position: view.position,
  };
}

// ViewsEditor manages a form's saved views: list, create, edit, duplicate, delete (blocked when the
// dataset is referenced), with field-aware filters, a live preview against the unsaved proposal, and
// unsaved-navigation protection. Editing an existing view keeps its key immutable.
export function ViewsEditor({
  form,
  csrf,
}: {
  form: FormDataSource;
  csrf: string;
}) {
  const { t } = useTranslation("forms");
  const [mode, setMode] = useState<"list" | "edit" | "new">("list");
  const [draft, setDraft] = useState<FormViewInput>(emptyView);
  const [isNew, setIsNew] = useState(true);

  const openNew = () => {
    setDraft(emptyView());
    setIsNew(true);
    setMode("new");
  };
  const openEdit = (view: FormView) => {
    setDraft(toInput(view));
    setIsNew(false);
    setMode("edit");
  };
  const openDuplicate = (view: FormView) => {
    const copy = toInput(view);
    setDraft({
      ...copy,
      key: "",
      name: t("views.copyName", { name: view.name }),
    });
    setIsNew(true);
    setMode("new");
  };

  if (mode === "list") {
    return (
      <ViewList
        form={form}
        csrf={csrf}
        onNew={openNew}
        onEdit={openEdit}
        onDuplicate={openDuplicate}
      />
    );
  }
  return (
    <ViewForm
      form={form}
      csrf={csrf}
      draft={draft}
      setDraft={setDraft}
      isNew={isNew}
      onDone={() => setMode("list")}
    />
  );
}

function ViewList({
  form,
  csrf,
  onNew,
  onEdit,
  onDuplicate,
}: {
  form: FormDataSource;
  csrf: string;
  onNew: () => void;
  onEdit: (view: FormView) => void;
  onDuplicate: (view: FormView) => void;
}) {
  const { t } = useTranslation(["forms", "common"]);
  const queryClient = useQueryClient();
  const [error, setError] = useState("");
  const remove = useMutation({
    mutationFn: (viewId: string) => api.deleteFormView(form.id, viewId, csrf),
    onSuccess: () => {
      toast.add({ title: "Form view saved.", type: "success" });
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["form-outputs", form.id],
      });
      setError("");
    },
    onError: (err) => {
      if (err instanceof ApiError && err.status === 409) {
        setError(err.message);
      } else {
        setError(
          err instanceof Error ? err.message : t("views.deleteFallback"),
        );
      }
    },
  });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <RheaButton variant="default" onClick={onNew}>
          {t("views.newView")}
        </RheaButton>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("views.viewInUse")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {form.views.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>{t("views.noViews")}</EmptyTitle>
            <EmptyDescription>{t("views.noViewsHint")}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("views.tableName")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("views.tableKey")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  {t("views.tableStates")}
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">{t("views.tableActions")}</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {form.views.map((view) => (
                <tr
                  key={view.id}
                  className="border-b border-border last:border-0"
                >
                  <td className="px-3 py-2">{view.name}</td>
                  <td className="px-3 py-2">
                    <code className="text-xs">{view.key}</code>
                  </td>
                  <td className="px-3 py-2">
                    {view.includedStates.join(", ") || "—"}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <RheaButton
                        variant="ghost"
                        size="sm"
                        onClick={() => onEdit(view)}
                      >
                        {t("common:actions.edit")}
                      </RheaButton>
                      <RheaButton
                        variant="ghost"
                        size="sm"
                        onClick={() => onDuplicate(view)}
                      >
                        {t("views.duplicate")}
                      </RheaButton>
                      <RheaButton
                        variant="ghost"
                        size="sm"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(view.id)}
                      >
                        {t("common:actions.delete")}
                      </RheaButton>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ViewForm({
  form,
  csrf,
  draft,
  setDraft,
  isNew,
  onDone,
}: {
  form: FormDataSource;
  csrf: string;
  draft: FormViewInput;
  setDraft: (next: FormViewInput) => void;
  isNew: boolean;
  onDone: () => void;
}) {
  const { t } = useTranslation(["forms", "common"]);
  const queryClient = useQueryClient();
  const fields = useMemo(() => availableOutputFields(form, t), [form, t]);
  const fieldType = (key: string) =>
    fields.find((f) => f.key === key)?.type ?? "text";
  const timeFields = fields.filter((f) => isTimeField(f.type));
  const [baseline] = useState(() => JSON.stringify(draft));
  const [preview, setPreview] = useState<FormTypedDataset | null>(null);
  const [error, setError] = useState("");

  const dirty = JSON.stringify(draft) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );

  useEffect(() => {
    const handler = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, []);

  const update = (patch: Partial<FormViewInput>) =>
    setDraft({ ...draft, ...patch });

  const save = useMutation({
    mutationFn: () =>
      api.upsertFormView(
        form.id,
        { ...draft, key: draft.key || slugifyKey(draft.name) },
        csrf,
      ),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["form-outputs", form.id],
      });
      onDone();
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : t("views.saveFallback")),
  });

  const runPreview = useMutation({
    mutationFn: () =>
      api.previewFormView(
        form.id,
        { ...draft, key: draft.key || slugifyKey(draft.name) || "preview" },
        csrf,
      ),
    onSuccess: (dataset) => {
      setPreview(dataset);
      setError("");
    },
    onError: (err) =>
      setError(err instanceof Error ? err.message : t("views.previewFallback")),
  });

  const toggleState = (key: string) => {
    const has = draft.includedStates.includes(key);
    update({
      includedStates: has
        ? draft.includedStates.filter((s) => s !== key)
        : [...draft.includedStates, key],
    });
  };

  const addOutputField = (key: string) => {
    if (!key || draft.outputFields.includes(key)) return;
    update({ outputFields: [...draft.outputFields, key] });
  };
  const moveOutputField = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.outputFields.length) return;
    const next = [...draft.outputFields];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved!);
    update({ outputFields: next });
  };

  const nameMissing = draft.name.trim() === "";

  return (
    <div className="grid gap-4">
      {blocker.state === "blocked" && (
        <Alert>
          <AlertTitle>{t("views.leaveTitle")}</AlertTitle>
          <AlertDescription>{t("views.leaveBody")}</AlertDescription>
          <div className="flex flex-wrap gap-2">
            <RheaButton variant="ghost" onClick={() => blocker.reset?.()}>
              {t("views.stay")}
            </RheaButton>
            <RheaButton variant="default" onClick={() => blocker.proceed?.()}>
              {t("views.leave")}
            </RheaButton>
          </div>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>{t("views.notSaved")}</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="form-view-name">
            {t("views.nameLabel")}
          </FieldLabel>
          <Input
            id="form-view-name"
            required
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="form-view-key">{t("views.keyLabel")}</FieldLabel>
          <Input
            id="form-view-key"
            value={draft.key || (isNew ? slugifyKey(draft.name) : "")}
            disabled={!isNew}
            onChange={(e) => update({ key: slugifyKey(e.target.value) })}
          />
          <FieldDescription>
            {isNew ? t("views.newKeyHint") : t("views.lockedKeyHint")}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="form-view-limit">
            {t("views.limitLabel")}
          </FieldLabel>
          <Input
            id="form-view-limit"
            type="number"
            value={String(draft.recordLimit)}
            onChange={(e) =>
              update({ recordLimit: Number(e.target.value) || 0 })
            }
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="form-view-position">
            {t("views.orderLabel")}
          </FieldLabel>
          <Input
            id="form-view-position"
            type="number"
            value={String(draft.position)}
            onChange={(e) => update({ position: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">
          {t("views.statesLegend")}
        </legend>
        <div className="flex flex-wrap gap-2">
          {form.workflow.states.map((state) => (
            /* Base UI names the span from the wrapping label. */
            <label key={state.key} className="flex items-center gap-2 text-sm">
              <RheaCheckbox
                checked={draft.includedStates.includes(state.key)}
                onCheckedChange={() => toggleState(state.key)}
              />
              <span>{state.label}</span>
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">
          {t("views.fieldsLegend")}
        </legend>
        <div>
          {/* No wrapping label: the control sits alone under the section legend. */}
          <RheaSelect
            items={[
              { value: NONE_VALUE, label: t("views.addFieldPlaceholder") },
              ...fields
                .filter((field) => !draft.outputFields.includes(field.key))
                .map((field) => ({ value: field.key, label: field.label })),
            ]}
            value={NONE_VALUE}
            onValueChange={(value) => {
              if (value && value !== NONE_VALUE) addOutputField(value);
            }}
          >
            <SelectTrigger aria-label={t("views.addFieldLabel")}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>
                {t("views.addFieldPlaceholder")}
              </SelectItem>
              {fields
                .filter((f) => !draft.outputFields.includes(f.key))
                .map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
            </SelectContent>
          </RheaSelect>
        </div>
        <ol className="grid gap-2">
          {draft.outputFields.map((key, index) => (
            <li
              key={key}
              className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2 text-sm"
            >
              <span>{fields.find((f) => f.key === key)?.label ?? key}</span>
              <div className="flex gap-1">
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                  aria-label={t("views.moveUp", {
                    label: fields.find((f) => f.key === key)?.label ?? key,
                  })}
                  disabled={index === 0}
                  onClick={() => moveOutputField(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                  aria-label={t("views.moveDown", {
                    label: fields.find((f) => f.key === key)?.label ?? key,
                  })}
                  disabled={index === draft.outputFields.length - 1}
                  onClick={() => moveOutputField(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                  aria-label={t("views.removeLabel", {
                    label: fields.find((f) => f.key === key)?.label ?? key,
                  })}
                  onClick={() =>
                    update({
                      outputFields: draft.outputFields.filter((k) => k !== key),
                    })
                  }
                >
                  ✕
                </button>
              </div>
            </li>
          ))}
          {draft.outputFields.length === 0 && (
            <li className="text-sm text-muted-foreground">
              {t("views.noneSelected")}
            </li>
          )}
        </ol>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">
          {t("views.filtersLegend")}
        </legend>
        {draft.fieldFilters.map((filter, index) => {
          const operators = operatorsForType(fieldType(filter.field), t);
          return (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <RheaSelect
                items={[
                  { value: NONE_VALUE, label: t("views.fieldPlaceholder") },
                  ...fields.map((field) => ({
                    value: field.key,
                    label: field.label,
                  })),
                ]}
                value={filter.field || NONE_VALUE}
                onValueChange={(value) => {
                  const nextField = !value || value === NONE_VALUE ? "" : value;
                  const validOps = operatorsForType(
                    fieldType(nextField),
                    t,
                  ).map((o) => o.value);
                  const filters = [...draft.fieldFilters];
                  filters[index] = {
                    ...filter,
                    field: nextField,
                    operator: validOps.includes(filter.operator)
                      ? filter.operator
                      : (validOps[0] as typeof filter.operator),
                  };
                  update({ fieldFilters: filters });
                }}
              >
                <SelectTrigger aria-label={t("views.filterFieldLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>
                    {t("views.fieldPlaceholder")}
                  </SelectItem>
                  {fields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
              <RheaSelect
                items={operators}
                value={filter.operator}
                onValueChange={(value) => {
                  const filters = [...draft.fieldFilters];
                  filters[index] = {
                    ...filter,
                    operator: value ?? filter.operator,
                  };
                  update({ fieldFilters: filters });
                }}
              >
                <SelectTrigger aria-label={t("views.operatorLabel")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {operators.map((op) => (
                    <SelectItem key={op.value} value={op.value}>
                      {op.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
              {filter.operator !== "empty" &&
                filter.operator !== "not_empty" && (
                  <Input
                    className="min-w-40 flex-1"
                    value={filter.value}
                    onChange={(e) => {
                      const filters = [...draft.fieldFilters];
                      filters[index] = { ...filter, value: e.target.value };
                      update({ fieldFilters: filters });
                    }}
                  />
                )}
              <RheaButton
                variant="ghost"
                size="sm"
                onClick={() =>
                  update({
                    fieldFilters: draft.fieldFilters.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              >
                {t("views.removeItem")}
              </RheaButton>
            </div>
          );
        })}
        <RheaButton
          variant="ghost"
          size="sm"
          onClick={() => {
            const first = fields[0];
            if (!first) return;
            update({
              fieldFilters: [
                ...draft.fieldFilters,
                {
                  field: first.key,
                  operator: operatorsForType(first.type, t)[0]!.value as never,
                  value: "",
                },
              ],
            });
          }}
        >
          {t("views.addFilter")}
        </RheaButton>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">{t("views.sortLegend")}</legend>
        {draft.sort.map((rule, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <RheaSelect
              items={[
                { value: NONE_VALUE, label: t("views.fieldPlaceholder") },
                ...fields.map((field) => ({
                  value: field.key,
                  label: field.label,
                })),
              ]}
              value={rule.field || NONE_VALUE}
              onValueChange={(value) => {
                const sort = [...draft.sort];
                sort[index] = {
                  ...rule,
                  field: !value || value === NONE_VALUE ? "" : value,
                };
                update({ sort });
              }}
            >
              <SelectTrigger aria-label={t("views.sortFieldLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>
                  {t("views.fieldPlaceholder")}
                </SelectItem>
                {fields.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
            <RheaSelect
              items={[
                { value: "asc", label: t("views.ascending") },
                { value: "desc", label: t("views.descending") },
              ]}
              value={rule.direction}
              onValueChange={(value) => {
                const sort = [...draft.sort];
                sort[index] = {
                  ...rule,
                  direction: value ?? "asc",
                };
                update({ sort });
              }}
            >
              <SelectTrigger aria-label={t("views.sortDirectionLabel")}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">{t("views.ascending")}</SelectItem>
                <SelectItem value="desc">{t("views.descending")}</SelectItem>
              </SelectContent>
            </RheaSelect>
            <RheaButton
              variant="ghost"
              size="sm"
              onClick={() =>
                update({ sort: draft.sort.filter((_, i) => i !== index) })
              }
            >
              {t("views.removeItem")}
            </RheaButton>
          </div>
        ))}
        <RheaButton
          variant="ghost"
          size="sm"
          onClick={() => {
            const first = fields[0];
            if (!first) return;
            update({
              sort: [...draft.sort, { field: first.key, direction: "asc" }],
            });
          }}
        >
          {t("views.addSort")}
        </RheaButton>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">{t("views.timeLegend")}</legend>
        {/* Base UI names the span from the wrapping label. */}
        <label className="flex items-center gap-2 text-sm">
          <RheaCheckbox
            checked={draft.timeFilter.enabled}
            onCheckedChange={(checked) =>
              update({
                timeFilter: {
                  ...draft.timeFilter,
                  enabled: checked === true,
                },
              })
            }
          />
          <span>{t("views.timeEnabled")}</span>
        </label>
        {draft.timeFilter.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="form-view-start-field">
                {t("views.startField")}
              </FieldLabel>
              <RheaSelect
                items={[
                  { value: NONE_VALUE, label: t("views.noneOption") },
                  ...timeFields.map((field) => ({
                    value: field.key,
                    label: field.label,
                  })),
                ]}
                value={draft.timeFilter.startField ?? NONE_VALUE}
                onValueChange={(value) =>
                  update({
                    timeFilter: {
                      ...draft.timeFilter,
                      startField: !value || value === NONE_VALUE ? "" : value,
                    },
                  })
                }
              >
                <SelectTrigger id="form-view-start-field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>
                    {t("views.noneOption")}
                  </SelectItem>
                  {timeFields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="form-view-end-field">
                {t("views.endField")}
              </FieldLabel>
              <RheaSelect
                items={[
                  { value: NONE_VALUE, label: t("views.noneOption") },
                  ...timeFields.map((field) => ({
                    value: field.key,
                    label: field.label,
                  })),
                ]}
                value={draft.timeFilter.endField ?? NONE_VALUE}
                onValueChange={(value) =>
                  update({
                    timeFilter: {
                      ...draft.timeFilter,
                      endField: !value || value === NONE_VALUE ? "" : value,
                    },
                  })
                }
              >
                <SelectTrigger id="form-view-end-field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>
                    {t("views.noneOption")}
                  </SelectItem>
                  {timeFields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            {/* Base UI names the span from the wrapping label. */}
            <label className="flex items-center gap-2 text-sm">
              <RheaCheckbox
                checked={Boolean(draft.timeFilter.startBeforeNow)}
                onCheckedChange={(checked) =>
                  update({
                    timeFilter: {
                      ...draft.timeFilter,
                      startBeforeNow: checked === true,
                    },
                  })
                }
              />
              <span>{t("views.startBeforeNow")}</span>
            </label>
            {/* Base UI names the span from the wrapping label. */}
            <label className="flex items-center gap-2 text-sm">
              <RheaCheckbox
                checked={Boolean(draft.timeFilter.endAfterNow)}
                onCheckedChange={(checked) =>
                  update({
                    timeFilter: {
                      ...draft.timeFilter,
                      endAfterNow: checked === true,
                    },
                  })
                }
              />
              <span>{t("views.endAfterNow")}</span>
            </label>
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <RheaButton variant="ghost" onClick={onDone}>
          {t("common:actions.back")}
        </RheaButton>
        <RheaButton
          variant="secondary"
          disabled={runPreview.isPending || nameMissing}
          aria-busy={runPreview.isPending || undefined}
          onClick={() => runPreview.mutate()}
        >
          {runPreview.isPending && <Spinner aria-hidden="true" />}
          {t("views.previewButton")}
        </RheaButton>
        <RheaButton
          variant="default"
          disabled={save.isPending || nameMissing}
          aria-busy={save.isPending || undefined}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Spinner aria-hidden="true" />}
          {t("views.saveButton")}
        </RheaButton>
      </div>

      {preview && (
        <section className="grid gap-2 rounded-xl border border-border p-4">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            {t("views.previewTitle")}{" "}
            <Badge {...formToneBadgeProps("neutral")}>
              {t("views.previewCount", {
                count: preview.records?.length ?? 0,
              })}
            </Badge>
          </h3>
          {(preview.records?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              {t("views.previewEmpty")}
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    {(preview.fields ?? []).map((f) => (
                      <th
                        key={f.key}
                        scope="col"
                        className="px-3 py-2 font-medium"
                      >
                        {f.label || f.key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(preview.records ?? []).map((record) => (
                    <tr
                      key={record.id}
                      className="border-b border-border last:border-0"
                    >
                      {(preview.fields ?? []).map((f) => (
                        <td key={f.key} className="px-3 py-2">
                          {record.values[f.key] ?? ""}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
