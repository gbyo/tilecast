import { useEffect, useMemo, useRef, useState } from "react";
import { useBlocker } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
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
    setDraft({ ...copy, key: "", name: `${view.name} (copy)` });
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
          err instanceof Error ? err.message : "Could not delete the view.",
        );
      }
    },
  });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap gap-2">
        <RheaButton variant="default" onClick={onNew}>
          New view
        </RheaButton>
      </div>
      {error && (
        <Alert variant="destructive">
          <AlertTitle>View in use</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      {form.views.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyTitle>No saved views</EmptyTitle>
            <EmptyDescription>
              Create a view to publish a named dataset for Widgets.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border">
          <Table className="w-full text-sm">
            <TableHeader>
              <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
                <TableHead scope="col" className="px-3 py-2 font-medium">
                  Name
                </TableHead>
                <TableHead scope="col" className="px-3 py-2 font-medium">
                  Dataset key
                </TableHead>
                <TableHead scope="col" className="px-3 py-2 font-medium">
                  States
                </TableHead>
                <TableHead scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {form.views.map((view) => (
                <TableRow
                  key={view.id}
                  className="border-b border-border last:border-0"
                >
                  <TableCell className="px-3 py-2">{view.name}</TableCell>
                  <TableCell className="px-3 py-2">
                    <code className="text-xs">{view.key}</code>
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    {view.includedStates.join(", ") || "—"}
                  </TableCell>
                  <TableCell className="px-3 py-2">
                    <div className="flex flex-wrap justify-end gap-1">
                      <RheaButton
                        variant="ghost"
                        size="sm"
                        onClick={() => onEdit(view)}
                      >
                        Edit
                      </RheaButton>
                      <RheaButton
                        variant="ghost"
                        size="sm"
                        onClick={() => onDuplicate(view)}
                      >
                        Duplicate
                      </RheaButton>
                      <RheaButton
                        variant="ghost"
                        size="sm"
                        disabled={remove.isPending}
                        onClick={() => remove.mutate(view.id)}
                      >
                        Delete
                      </RheaButton>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
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
  const queryClient = useQueryClient();
  const fields = useMemo(() => availableOutputFields(form), [form]);
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
      setError(err instanceof Error ? err.message : "Could not save the view."),
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
      setError(
        err instanceof Error ? err.message : "Could not preview the view.",
      ),
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
          <AlertTitle>Leave without saving?</AlertTitle>
          <AlertDescription>This view has unsaved changes.</AlertDescription>
          <div className="flex flex-wrap gap-2">
            <RheaButton variant="ghost" onClick={() => blocker.reset?.()}>
              Stay
            </RheaButton>
            <RheaButton variant="default" onClick={() => blocker.proceed?.()}>
              Leave
            </RheaButton>
          </div>
        </Alert>
      )}
      {error && (
        <Alert variant="destructive">
          <AlertTitle>View not saved</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <Field>
          <FieldLabel htmlFor="form-view-name">View name</FieldLabel>
          <Input
            id="form-view-name"
            required
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </Field>
        <Field>
          <FieldLabel htmlFor="form-view-key">Dataset key</FieldLabel>
          <Input
            id="form-view-key"
            value={draft.key || (isNew ? slugifyKey(draft.name) : "")}
            disabled={!isNew}
            onChange={(e) => update({ key: slugifyKey(e.target.value) })}
          />
          <FieldDescription>
            {isNew ? "Lowercase key; fixed once saved." : "Keys are immutable."}
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="form-view-limit">Record limit</FieldLabel>
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
          <FieldLabel htmlFor="form-view-position">Order</FieldLabel>
          <Input
            id="form-view-position"
            type="number"
            value={String(draft.position)}
            onChange={(e) => update({ position: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">Included states</legend>
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
          Output fields &amp; order
        </legend>
        <div>
          {/* No wrapping label: the control sits alone under the section legend. */}
          <RheaSelect
            items={[
              { value: NONE_VALUE, label: "Add a field…" },
              ...fields
                .filter((field) => !draft.outputFields.includes(field.key))
                .map((field) => ({ value: field.key, label: field.label })),
            ]}
            value={NONE_VALUE}
            onValueChange={(value) => {
              if (value && value !== NONE_VALUE) addOutputField(value);
            }}
          >
            <SelectTrigger aria-label="Add an output field">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE_VALUE}>Add a field…</SelectItem>
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
                  aria-label={`Move ${fields.find((f) => f.key === key)?.label ?? key} up`}
                  disabled={index === 0}
                  onClick={() => moveOutputField(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                  aria-label={`Move ${fields.find((f) => f.key === key)?.label ?? key} down`}
                  disabled={index === draft.outputFields.length - 1}
                  onClick={() => moveOutputField(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="inline-flex h-7 w-7 items-center justify-center rounded-lg border border-border text-sm hover:bg-muted disabled:opacity-50"
                  aria-label={`Remove ${fields.find((f) => f.key === key)?.label ?? key}`}
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
              All available fields (none selected).
            </li>
          )}
        </ol>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">Field filters</legend>
        {draft.fieldFilters.map((filter, index) => {
          const operators = operatorsForType(fieldType(filter.field));
          return (
            <div key={index} className="flex flex-wrap items-center gap-2">
              <RheaSelect
                items={[
                  { value: NONE_VALUE, label: "Field…" },
                  ...fields.map((field) => ({
                    value: field.key,
                    label: field.label,
                  })),
                ]}
                value={filter.field || NONE_VALUE}
                onValueChange={(value) => {
                  const nextField = !value || value === NONE_VALUE ? "" : value;
                  const validOps = operatorsForType(fieldType(nextField)).map(
                    (o) => o.value,
                  );
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
                <SelectTrigger aria-label="Filter field">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE_VALUE}>Field…</SelectItem>
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
                <SelectTrigger aria-label="Filter operator">
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
                Remove
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
                  operator: operatorsForType(first.type)[0]!.value as never,
                  value: "",
                },
              ],
            });
          }}
        >
          Add filter
        </RheaButton>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">Sort</legend>
        {draft.sort.map((rule, index) => (
          <div key={index} className="flex flex-wrap items-center gap-2">
            <RheaSelect
              items={[
                { value: NONE_VALUE, label: "Field…" },
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
              <SelectTrigger aria-label="Sort field">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NONE_VALUE}>Field…</SelectItem>
                {fields.map((f) => (
                  <SelectItem key={f.key} value={f.key}>
                    {f.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </RheaSelect>
            <RheaSelect
              items={[
                { value: "asc", label: "Ascending" },
                { value: "desc", label: "Descending" },
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
              <SelectTrigger aria-label="Sort direction">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="asc">Ascending</SelectItem>
                <SelectItem value="desc">Descending</SelectItem>
              </SelectContent>
            </RheaSelect>
            <RheaButton
              variant="ghost"
              size="sm"
              onClick={() =>
                update({ sort: draft.sort.filter((_, i) => i !== index) })
              }
            >
              Remove
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
          Add sort rule
        </RheaButton>
      </fieldset>

      <fieldset className="grid gap-3 rounded-xl border border-border p-4">
        <legend className="text-sm font-medium">Time window</legend>
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
          <span>Filter by a relative time window</span>
        </label>
        {draft.timeFilter.enabled && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="form-view-start-field">
                Start field
              </FieldLabel>
              <RheaSelect
                items={[
                  { value: NONE_VALUE, label: "None" },
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
                  <SelectItem value={NONE_VALUE}>None</SelectItem>
                  {timeFields.map((f) => (
                    <SelectItem key={f.key} value={f.key}>
                      {f.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="form-view-end-field">End field</FieldLabel>
              <RheaSelect
                items={[
                  { value: NONE_VALUE, label: "None" },
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
                  <SelectItem value={NONE_VALUE}>None</SelectItem>
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
              <span>Start is before now</span>
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
              <span>End is after now</span>
            </label>
          </div>
        )}
      </fieldset>

      <div className="flex flex-wrap gap-2">
        <RheaButton variant="ghost" onClick={onDone}>
          Back
        </RheaButton>
        <RheaButton
          variant="secondary"
          disabled={runPreview.isPending || nameMissing}
          aria-busy={runPreview.isPending || undefined}
          onClick={() => runPreview.mutate()}
        >
          {runPreview.isPending && <Spinner aria-hidden="true" />}
          Preview
        </RheaButton>
        <RheaButton
          variant="default"
          disabled={save.isPending || nameMissing}
          aria-busy={save.isPending || undefined}
          onClick={() => save.mutate()}
        >
          {save.isPending && <Spinner aria-hidden="true" />}
          Save view
        </RheaButton>
      </div>

      {preview && (
        <section className="grid gap-2 rounded-xl border border-border p-4">
          <h3 className="flex flex-wrap items-center gap-2 text-base font-semibold">
            Preview{" "}
            <Badge {...formToneBadgeProps("neutral")}>
              {`${preview.records?.length ?? 0} records`}
            </Badge>
          </h3>
          {(preview.records?.length ?? 0) === 0 ? (
            <p className="text-sm text-muted-foreground">
              No records match this view.
            </p>
          ) : (
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="w-full text-sm">
                <TableHeader>
                  <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
                    {(preview.fields ?? []).map((f) => (
                      <TableHead
                        key={f.key}
                        scope="col"
                        className="px-3 py-2 font-medium"
                      >
                        {f.label || f.key}
                      </TableHead>
                    ))}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(preview.records ?? []).map((record) => (
                    <TableRow
                      key={record.id}
                      className="border-b border-border last:border-0"
                    >
                      {(preview.fields ?? []).map((f) => (
                        <TableCell key={f.key} className="px-3 py-2">
                          {record.values[f.key] ?? ""}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
