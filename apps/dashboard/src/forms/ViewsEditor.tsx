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
import {
  Button,
  Checkbox,
  EmptyState,
  Field,
  Input,
  Notice,
  Select,
  StatusBadge,
  TableContainer,
} from "../components/legacy-ui";
import {
  availableOutputFields,
  isTimeField,
  operatorsForType,
} from "./outputFields";
import { slugifyKey } from "./formKeys";

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
    <div className="form-views">
      <div className="form-views__toolbar">
        <Button variant="primary" onClick={onNew}>
          New view
        </Button>
      </div>
      {error && (
        <Notice variant="danger" title="View in use">
          {error}
        </Notice>
      )}
      {form.views.length === 0 ? (
        <EmptyState
          title="No saved views"
          message="Create a view to publish a named dataset for Widgets."
        />
      ) : (
        <TableContainer>
          <table className="data-table">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Dataset key</th>
                <th scope="col">States</th>
                <th scope="col" aria-label="Actions" />
              </tr>
            </thead>
            <tbody>
              {form.views.map((view) => (
                <tr key={view.id}>
                  <td>{view.name}</td>
                  <td>
                    <code>{view.key}</code>
                  </td>
                  <td>{view.includedStates.join(", ") || "—"}</td>
                  <td className="form-views__row-actions">
                    <Button
                      variant="quiet"
                      compact
                      onClick={() => onEdit(view)}
                    >
                      Edit
                    </Button>
                    <Button
                      variant="quiet"
                      compact
                      onClick={() => onDuplicate(view)}
                    >
                      Duplicate
                    </Button>
                    <Button
                      variant="quiet"
                      compact
                      disabled={remove.isPending}
                      onClick={() => remove.mutate(view.id)}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableContainer>
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
    <div className="form-view-form">
      {blocker.state === "blocked" && (
        <Notice
          variant="warning"
          title="Leave without saving?"
          action={
            <div className="form-builder__confirm-actions">
              <Button variant="quiet" onClick={() => blocker.reset?.()}>
                Stay
              </Button>
              <Button variant="primary" onClick={() => blocker.proceed?.()}>
                Leave
              </Button>
            </div>
          }
        >
          This view has unsaved changes.
        </Notice>
      )}
      {error && (
        <Notice variant="danger" title="View not saved">
          {error}
        </Notice>
      )}

      <div className="form-view-form__grid">
        <Field label="View name" required>
          <Input
            aria-label="View name"
            value={draft.name}
            onChange={(e) => update({ name: e.target.value })}
          />
        </Field>
        <Field
          label="Dataset key"
          description={
            isNew ? "Lowercase key; fixed once saved." : "Keys are immutable."
          }
        >
          <Input
            value={draft.key || (isNew ? slugifyKey(draft.name) : "")}
            disabled={!isNew}
            onChange={(e) => update({ key: slugifyKey(e.target.value) })}
          />
        </Field>
        <Field label="Record limit">
          <Input
            type="number"
            value={String(draft.recordLimit)}
            onChange={(e) =>
              update({ recordLimit: Number(e.target.value) || 0 })
            }
          />
        </Field>
        <Field label="Order">
          <Input
            type="number"
            value={String(draft.position)}
            onChange={(e) => update({ position: Number(e.target.value) || 0 })}
          />
        </Field>
      </div>

      <fieldset className="form-view-form__section">
        <legend>Included states</legend>
        <div className="form-view-form__checks">
          {form.workflow.states.map((state) => (
            <Checkbox
              key={state.key}
              label={state.label}
              checked={draft.includedStates.includes(state.key)}
              onChange={() => toggleState(state.key)}
            />
          ))}
        </div>
      </fieldset>

      <fieldset className="form-view-form__section">
        <legend>Output fields &amp; order</legend>
        <div className="form-view-form__add-field">
          {/* No wrapping label: the control sits alone under the section legend. */}
          <Select
            aria-label="Add an output field"
            value=""
            onChange={(e) => addOutputField(e.target.value)}
          >
            <option value="">Add a field…</option>
            {fields
              .filter((f) => !draft.outputFields.includes(f.key))
              .map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
          </Select>
        </div>
        <ol className="form-view-form__ordered">
          {draft.outputFields.map((key, index) => (
            <li key={key}>
              <span>{fields.find((f) => f.key === key)?.label ?? key}</span>
              <div>
                <button
                  type="button"
                  aria-label={`Move ${key} up`}
                  disabled={index === 0}
                  onClick={() => moveOutputField(index, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${key} down`}
                  disabled={index === draft.outputFields.length - 1}
                  onClick={() => moveOutputField(index, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${key}`}
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
            <li className="form-view-form__hint">
              All available fields (none selected).
            </li>
          )}
        </ol>
      </fieldset>

      <fieldset className="form-view-form__section">
        <legend>Field filters</legend>
        {draft.fieldFilters.map((filter, index) => {
          const operators = operatorsForType(fieldType(filter.field));
          return (
            <div key={index} className="form-view-form__filter-row">
              <Select
                aria-label="Filter field"
                value={filter.field}
                onChange={(e) => {
                  const nextField = e.target.value;
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
                <option value="">Field…</option>
                {fields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
              <Select
                aria-label="Filter operator"
                value={filter.operator}
                onChange={(e) => {
                  const filters = [...draft.fieldFilters];
                  filters[index] = {
                    ...filter,
                    operator: e.target.value as typeof filter.operator,
                  };
                  update({ fieldFilters: filters });
                }}
              >
                {operators.map((op) => (
                  <option key={op.value} value={op.value}>
                    {op.label}
                  </option>
                ))}
              </Select>
              {filter.operator !== "empty" &&
                filter.operator !== "not_empty" && (
                  <Input
                    aria-label="Filter value"
                    value={filter.value}
                    onChange={(e) => {
                      const filters = [...draft.fieldFilters];
                      filters[index] = { ...filter, value: e.target.value };
                      update({ fieldFilters: filters });
                    }}
                  />
                )}
              <Button
                variant="quiet"
                compact
                onClick={() =>
                  update({
                    fieldFilters: draft.fieldFilters.filter(
                      (_, i) => i !== index,
                    ),
                  })
                }
              >
                Remove
              </Button>
            </div>
          );
        })}
        <Button
          variant="quiet"
          compact
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
        </Button>
      </fieldset>

      <fieldset className="form-view-form__section">
        <legend>Sort</legend>
        {draft.sort.map((rule, index) => (
          <div key={index} className="form-view-form__filter-row">
            <Select
              aria-label="Sort field"
              value={rule.field}
              onChange={(e) => {
                const sort = [...draft.sort];
                sort[index] = { ...rule, field: e.target.value };
                update({ sort });
              }}
            >
              <option value="">Field…</option>
              {fields.map((f) => (
                <option key={f.key} value={f.key}>
                  {f.label}
                </option>
              ))}
            </Select>
            <Select
              aria-label="Sort direction"
              value={rule.direction}
              onChange={(e) => {
                const sort = [...draft.sort];
                sort[index] = {
                  ...rule,
                  direction: e.target.value as "asc" | "desc",
                };
                update({ sort });
              }}
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </Select>
            <Button
              variant="quiet"
              compact
              onClick={() =>
                update({ sort: draft.sort.filter((_, i) => i !== index) })
              }
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          variant="quiet"
          compact
          onClick={() => {
            const first = fields[0];
            if (!first) return;
            update({
              sort: [...draft.sort, { field: first.key, direction: "asc" }],
            });
          }}
        >
          Add sort rule
        </Button>
      </fieldset>

      <fieldset className="form-view-form__section">
        <legend>Time window</legend>
        <Checkbox
          label="Filter by a relative time window"
          checked={draft.timeFilter.enabled}
          onChange={(e) =>
            update({
              timeFilter: { ...draft.timeFilter, enabled: e.target.checked },
            })
          }
        />
        {draft.timeFilter.enabled && (
          <div className="form-view-form__grid">
            <Field label="Start field">
              <Select
                value={draft.timeFilter.startField ?? ""}
                onChange={(e) =>
                  update({
                    timeFilter: {
                      ...draft.timeFilter,
                      startField: e.target.value,
                    },
                  })
                }
              >
                <option value="">None</option>
                {timeFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="End field">
              <Select
                value={draft.timeFilter.endField ?? ""}
                onChange={(e) =>
                  update({
                    timeFilter: {
                      ...draft.timeFilter,
                      endField: e.target.value,
                    },
                  })
                }
              >
                <option value="">None</option>
                {timeFields.map((f) => (
                  <option key={f.key} value={f.key}>
                    {f.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Checkbox
              label="Start is before now"
              checked={Boolean(draft.timeFilter.startBeforeNow)}
              onChange={(e) =>
                update({
                  timeFilter: {
                    ...draft.timeFilter,
                    startBeforeNow: e.target.checked,
                  },
                })
              }
            />
            <Checkbox
              label="End is after now"
              checked={Boolean(draft.timeFilter.endAfterNow)}
              onChange={(e) =>
                update({
                  timeFilter: {
                    ...draft.timeFilter,
                    endAfterNow: e.target.checked,
                  },
                })
              }
            />
          </div>
        )}
      </fieldset>

      <div className="form-view-form__actions">
        <Button variant="quiet" onClick={onDone}>
          Back
        </Button>
        <Button
          variant="secondary"
          loading={runPreview.isPending}
          disabled={runPreview.isPending || nameMissing}
          onClick={() => runPreview.mutate()}
        >
          Preview
        </Button>
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={save.isPending || nameMissing}
          onClick={() => save.mutate()}
        >
          Save view
        </Button>
      </div>

      {preview && (
        <section className="form-view-form__preview" aria-label="Preview">
          <h3>
            Preview{" "}
            <StatusBadge
              label={`${preview.records?.length ?? 0} records`}
              tone="neutral"
            />
          </h3>
          {(preview.records?.length ?? 0) === 0 ? (
            <p>No records match this view.</p>
          ) : (
            <TableContainer>
              <table className="data-table">
                <thead>
                  <tr>
                    {(preview.fields ?? []).map((f) => (
                      <th key={f.key} scope="col">
                        {f.label || f.key}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(preview.records ?? []).map((record) => (
                    <tr key={record.id}>
                      {(preview.fields ?? []).map((f) => (
                        <td key={f.key}>{record.values[f.key] ?? ""}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </TableContainer>
          )}
        </section>
      )}
    </div>
  );
}
