import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { useBlocker } from "react-router";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  ArrowDown,
  ArrowDownToLine,
  ArrowUp,
  ArrowUpToLine,
  MoreHorizontal,
  Trash2,
} from "lucide-react";
import type {
  FormDataSource,
  FormField,
  FormFieldControl,
  FormSchema,
} from "../api/types";
import { api, ApiError } from "../api/client";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button } from "../components/ui/button";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
  ContextMenuTrigger,
} from "../components/ui/context-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import { Field, FieldLabel } from "../components/ui/field";
import { toast } from "../components/ui/toast";
import { Input } from "../components/ui/input";
import { Item, ItemActions, ItemGroup } from "../components/ui/item";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "../components/ui/resizable";
import { Separator } from "../components/ui/separator";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "../components/ui/sheet";
import { Spinner } from "../components/ui/spinner";
import { Textarea } from "../components/ui/textarea";
import { useTranslation } from "react-i18next";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
import { FormFieldEditor, type FieldLock } from "./FormFieldEditor";
import { FormFieldPalette } from "./FormFieldPalette";
import { FormRenderer } from "./FormRenderer";
import {
  controlMeta,
  newField,
  publishedOutputKeys,
  schemasEquivalent,
} from "./formSchema";
import { RESERVED_FIELD_KEYS } from "./formKeys";

type SaveState = "saved" | "dirty" | "saving" | "error";

function cloneSchema(schema: FormSchema): FormSchema {
  return JSON.parse(JSON.stringify(schema)) as FormSchema;
}

export function FormBuilder({
  form,
  csrf,
  readOnly = false,
}: {
  form: FormDataSource;
  csrf: string;
  readOnly?: boolean;
}) {
  const { t } = useTranslation(["forms", "common"]);
  const queryClient = useQueryClient();
  const [draft, setDraft] = useState<FormSchema>(() =>
    cloneSchema(form.draftSchema),
  );
  const [baseline, setBaseline] = useState<string>(() =>
    JSON.stringify(form.draftSchema),
  );
  const [selected, setSelected] = useState(0);
  const [saveError, setSaveError] = useState("");
  const [showPublish, setShowPublish] = useState(false);
  const [publishError, setPublishError] = useState("");
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const desktop = useDesktopLayout();

  const dirty = JSON.stringify(draft) !== baseline;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const publishedKeys = useMemo(() => publishedOutputKeys(form), [form]);

  // Publishing is only meaningful when the current draft differs from the published revision.
  // A draft that matches the published schema is never publishable, even if it differs from the
  // last saved draft (e.g. the user edited and then reverted back to the published content).
  const publishedSchema = form.publishedRevision?.schema;
  const hasPublishableChanges =
    !publishedSchema || !schemasEquivalent(draft, publishedSchema);

  // Block in-app navigation while there are unsaved schema changes so edits are not lost. Any
  // change to the path, query string, or hash counts as leaving the current view.
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty &&
      (currentLocation.pathname !== nextLocation.pathname ||
        currentLocation.search !== nextLocation.search ||
        currentLocation.hash !== nextLocation.hash),
  );

  // Warn on browser refresh/close while there are unsaved schema changes.
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

  const saveDraft = useMutation({
    mutationFn: () => api.updateFormDraft(form.id, draft, csrf),
    onMutate: () => setSaveError(""),
    onSuccess: (updated) => {
      toast.add({ title: "Form draft saved.", type: "success" });
      setBaseline(JSON.stringify(updated.draftSchema));
      setDraft(cloneSchema(updated.draftSchema));
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["data-source", form.id],
      });
    },
    onError: (error) =>
      setSaveError(
        error instanceof Error ? error.message : t("builder.draftFallback"),
      ),
  });

  const publish = useMutation({
    mutationFn: async () => {
      // Snapshot the schema being sent so baseline tracking reflects what was actually persisted,
      // not any edits the user makes while the request is in flight.
      const schema = draft;
      const snapshot = JSON.stringify(schema);
      if (dirtyRef.current) {
        await api.updateFormDraft(form.id, schema, csrf);
        // The draft is now saved server-side; mark it saved even if publishing then fails.
        setBaseline(snapshot);
      }
      await api.publishForm(form.id, csrf);
      return { snapshot };
    },
    onMutate: () => setPublishError(""),
    onSuccess: ({ snapshot }) => {
      toast.add({ title: "Form published.", type: "success" });
      setBaseline(snapshot);
      setShowPublish(false);
      void queryClient.invalidateQueries({
        queryKey: ["form-data-source", form.id],
      });
      void queryClient.invalidateQueries({
        queryKey: ["data-source", form.id],
      });
    },
    onError: (error) => {
      if (error instanceof ApiError && error.status === 409) {
        setPublishError(t("builder.publishConflict"));
      } else {
        setPublishError(
          error instanceof Error ? error.message : t("builder.publishFallback"),
        );
      }
    },
  });

  const saveState: SaveState = saveDraft.isPending
    ? "saving"
    : saveError
      ? "error"
      : dirty
        ? "dirty"
        : "saved";

  const keys = draft.fields.map((field) => field.key);
  // Rows are keyed by field key so focus follows a field when it moves. Keys are
  // editable and may briefly collide, so repeats get an occurrence suffix.
  const rowKeys = keys.map(
    (key, index) =>
      `${key}#${keys.slice(0, index).filter((other) => other === key).length}`,
  );
  const selectedField = draft.fields[selected];

  type FieldAction = {
    key: string;
    label: string;
    icon: ReactNode;
    shortcut?: string;
    disabled: boolean;
    danger?: boolean;
    run: () => void;
  };

  const fieldActions = (index: number, field: FormField): FieldAction[] => {
    const last = draft.fields.length - 1;
    return [
      {
        key: "up",
        label: t("builder.actions.moveUp"),
        icon: <ArrowUp size={14} aria-hidden="true" />,
        shortcut: "Alt+↑",
        disabled: index === 0,
        run: () => move(index, -1),
      },
      {
        key: "down",
        label: t("builder.actions.moveDown"),
        icon: <ArrowDown size={14} aria-hidden="true" />,
        shortcut: "Alt+↓",
        disabled: index === last,
        run: () => move(index, 1),
      },
      {
        key: "top",
        label: t("builder.actions.moveTop"),
        icon: <ArrowUpToLine size={14} aria-hidden="true" />,
        shortcut: "Alt+Home",
        disabled: index === 0,
        run: () => moveToEdge(index, "top"),
      },
      {
        key: "bottom",
        label: t("builder.actions.moveBottom"),
        icon: <ArrowDownToLine size={14} aria-hidden="true" />,
        shortcut: "Alt+End",
        disabled: index === last,
        run: () => moveToEdge(index, "bottom"),
      },
      {
        key: "delete",
        label: t("builder.actions.deleteField"),
        icon: <Trash2 size={14} aria-hidden="true" />,
        disabled: lockFor(field).deleteLocked,
        danger: true,
        run: () => removeField(index),
      },
    ];
  };

  // Alt+Arrow reorders without leaving the row; Alt+Home/End jumps to an edge.
  const onRowKeyDown = (event: KeyboardEvent, index: number) => {
    if (readOnly || !event.altKey) return;
    if (event.key === "ArrowUp") {
      event.preventDefault();
      move(index, -1);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      move(index, 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      moveToEdge(index, "top");
    } else if (event.key === "End") {
      event.preventDefault();
      moveToEdge(index, "bottom");
    }
  };

  const renderFieldRow = (field: FormField, index: number) => {
    const name = field.label || field.key;
    const rowLabel = t("builder.row.editField", { name });
    const menuLabel = t("builder.row.actionsFor", { name });
    const actions = readOnly ? [] : fieldActions(index, field);
    const selectButton = (
      <Button
        type="button"
        variant="ghost"
        className="h-auto min-w-0 flex-1 flex-col items-start gap-0.5 p-0 text-left font-normal whitespace-normal"
        onClick={() => selectField(index)}
        aria-current={index === selected}
        aria-label={rowLabel}
      >
        <span className="truncate text-sm font-medium">{name}</span>
        <span className="text-xs text-muted-foreground">
          {t(controlMeta(field.control).labelKey)}
        </span>
      </Button>
    );
    const rowActions = !readOnly ? (
      <ItemActions>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={menuLabel}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
              </Button>
            }
          />
          <DropdownMenuContent align="end" aria-label={menuLabel}>
            {actions.map((action) => (
              <Fragment key={action.key}>
                {action.danger && <DropdownMenuSeparator />}
                <DropdownMenuItem
                  variant={action.danger ? "destructive" : "default"}
                  disabled={action.disabled}
                  onClick={action.run}
                >
                  {action.icon}
                  {action.label}
                  {action.shortcut && (
                    <DropdownMenuShortcut>
                      {action.shortcut}
                    </DropdownMenuShortcut>
                  )}
                </DropdownMenuItem>
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </ItemActions>
    ) : null;
    if (readOnly)
      return (
        <Item
          key={rowKeys[index]}
          variant={index === selected ? "muted" : "outline"}
          size="sm"
        >
          {selectButton}
        </Item>
      );
    return (
      <ContextMenu key={rowKeys[index]}>
        <ContextMenuTrigger
          render={
            <Item
              variant={index === selected ? "muted" : "outline"}
              size="sm"
              onKeyDown={(event) => onRowKeyDown(event, index)}
            />
          }
        >
          {selectButton}
          {rowActions}
        </ContextMenuTrigger>
        <ContextMenuContent aria-label={menuLabel}>
          {actions.map((action) => (
            <Fragment key={action.key}>
              {action.danger && <ContextMenuSeparator />}
              <ContextMenuItem
                variant={action.danger ? "destructive" : "default"}
                disabled={action.disabled}
                onClick={action.run}
              >
                {action.icon}
                {action.label}
                {action.shortcut && (
                  <ContextMenuShortcut>{action.shortcut}</ContextMenuShortcut>
                )}
              </ContextMenuItem>
            </Fragment>
          ))}
        </ContextMenuContent>
      </ContextMenu>
    );
  };

  const mutateField = (index: number, next: FormField) => {
    setDraft((current) => {
      const fields = [...current.fields];
      fields[index] = next;
      return { ...current, fields };
    });
  };

  // Selection is updated outside the setDraft updater so the updater stays pure (React StrictMode
  // may invoke it more than once).
  const addField = (control: FormFieldControl) => {
    const field = newField(
      control,
      [...draft.fields.map((f) => f.key), ...RESERVED_FIELD_KEYS],
      t,
    );
    setDraft((current) => ({ ...current, fields: [...current.fields, field] }));
    setSelected(draft.fields.length);
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= draft.fields.length) return;
    setDraft((current) => {
      const fields = [...current.fields];
      const moving = fields[index];
      const displaced = fields[target];
      if (!moving || !displaced) return current;
      fields[index] = displaced;
      fields[target] = moving;
      return { ...current, fields };
    });
    setSelected(target);
  };

  const removeField = (index: number) => {
    setDraft((current) => ({
      ...current,
      fields: current.fields.filter((_, i) => i !== index),
    }));
    setSelected((prev) =>
      index < prev
        ? prev - 1
        : Math.max(0, Math.min(prev, draft.fields.length - 2)),
    );
  };

  const moveToEdge = (index: number, edge: "top" | "bottom") => {
    const target = edge === "top" ? 0 : draft.fields.length - 1;
    if (target === index || target < 0) return;
    setDraft((current) => {
      const fields = [...current.fields];
      const [moving] = fields.splice(index, 1);
      if (moving === undefined) return current;
      fields.splice(target, 0, moving);
      return { ...current, fields };
    });
    setSelected(target);
  };

  // Selecting a row always selects the field; on narrow screens it also opens
  // the inspector Sheet (the desktop pane is already visible there).
  const selectField = (index: number) => {
    setSelected(index);
    if (!desktop && !readOnly) setInspectorOpen(true);
  };

  const lockFor = (field: FormField): FieldLock => {
    const published = publishedKeys.has(field.key);
    return {
      keyLocked: published,
      controlLocked: published,
      deleteLocked: published,
    };
  };

  const fieldsPanel = (
    <section
      className="grid content-start gap-3"
      aria-label={t("builder.fieldsPanel")}
    >
      {draft.fields.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {t("builder.emptyFields")}
        </p>
      ) : (
        <ItemGroup>
          {draft.fields.map((field, index) => renderFieldRow(field, index))}
        </ItemGroup>
      )}
      {!readOnly && <FormFieldPalette onAdd={addField} />}
    </section>
  );

  const previewPanel = (
    <section
      className="grid content-start gap-3"
      aria-label={t("builder.previewPanel")}
    >
      {!readOnly && (
        <div className="grid gap-3">
          <Field>
            <FieldLabel htmlFor="form-builder-title">
              {t("builder.formTitle")}
            </FieldLabel>
            <Input
              id="form-builder-title"
              value={draft.title ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  title: event.target.value,
                }))
              }
            />
          </Field>
          <Field>
            <FieldLabel htmlFor="form-builder-description">
              {t("builder.formDescription")}
            </FieldLabel>
            <Textarea
              id="form-builder-description"
              rows={2}
              value={draft.description ?? ""}
              onChange={(event) =>
                setDraft((current) => ({
                  ...current,
                  description: event.target.value,
                }))
              }
            />
          </Field>
        </div>
      )}
      <FormRenderer schema={draft} readOnly />
    </section>
  );

  const inspectorPanel = !readOnly ? (
    <aside
      className="grid content-start gap-4"
      aria-label={t("builder.inspectorPanel")}
    >
      <div className="grid gap-1">
        <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
          {t("builder.inspectorEyebrow")}
        </p>
        <h3 className="text-base font-semibold">
          {t("builder.inspectorPanel")}
        </h3>
      </div>
      <Separator />
      {selectedField ? (
        <FormFieldEditor
          field={selectedField}
          allKeys={keys}
          lock={lockFor(selectedField)}
          readOnly={readOnly}
          onChange={(next) => mutateField(selected, next)}
        />
      ) : (
        <p className="text-sm text-muted-foreground">
          {t("builder.inspectorEmpty")}
        </p>
      )}
    </aside>
  ) : null;

  return (
    <div className="grid gap-4">
      {!readOnly && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border px-3 py-2">
          <span className="text-sm text-muted-foreground">
            {saveState === "saving"
              ? t("builder.status.saving")
              : saveState === "error"
                ? t("builder.status.saveFailed")
                : saveState === "dirty"
                  ? t("builder.status.unsaved")
                  : t("builder.status.saved")}
          </span>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="secondary"
              disabled={!dirty || saveDraft.isPending}
              aria-busy={saveDraft.isPending || undefined}
              onClick={() => saveDraft.mutate()}
            >
              {saveDraft.isPending && <Spinner aria-hidden="true" />}
              {t("builder.saveDraft")}
            </Button>
            <Button
              variant="default"
              disabled={
                publish.isPending ||
                saveDraft.isPending ||
                !hasPublishableChanges
              }
              onClick={() => setShowPublish(true)}
            >
              {t("builder.publish")}
            </Button>
          </div>
        </div>
      )}

      {blocker.state === "blocked" && (
        <Alert>
          <AlertTitle>{t("builder.leave.title")}</AlertTitle>
          <AlertDescription>{t("builder.leave.body")}</AlertDescription>
          <div className="flex flex-wrap gap-2">
            <Button variant="ghost" onClick={() => blocker.reset?.()}>
              {t("builder.leave.stay")}
            </Button>
            <Button variant="default" onClick={() => blocker.proceed?.()}>
              {t("builder.leave.leave")}
            </Button>
          </div>
        </Alert>
      )}

      {saveError && (
        <Alert variant="destructive">
          <AlertTitle>{t("builder.draftError")}</AlertTitle>
          <AlertDescription>{saveError}</AlertDescription>
        </Alert>
      )}

      {showPublish && (
        <Alert>
          <AlertTitle>{t("builder.publishTitle")}</AlertTitle>
          <AlertDescription>
            {t("builder.publishBody")}
            {publishError && (
              <span className="font-medium text-destructive">
                {" "}
                {publishError}
              </span>
            )}
          </AlertDescription>
          <div className="flex flex-wrap gap-2">
            <Button
              variant="ghost"
              onClick={() => setShowPublish(false)}
              disabled={publish.isPending}
            >
              {t("common:actions.cancel")}
            </Button>
            <Button
              variant="default"
              disabled={publish.isPending}
              aria-busy={publish.isPending || undefined}
              onClick={() => publish.mutate()}
            >
              {publish.isPending && <Spinner aria-hidden="true" />}
              {t("builder.publishConfirm")}
            </Button>
          </div>
        </Alert>
      )}

      {desktop ? (
        <ResizablePanelGroup
          orientation="horizontal"
          role="group"
          aria-label={t("builder.layout.group")}
        >
          <ResizablePanel
            id="form-fields"
            defaultSize="26%"
            minSize="18%"
            aria-label={t("builder.layout.fields")}
          >
            <div className="grid min-w-0 content-start gap-3 pr-4">
              {fieldsPanel}
            </div>
          </ResizablePanel>
          <ResizableHandle
            withHandle
            aria-label={t("builder.layout.resizeFieldsPreview")}
          />
          <ResizablePanel
            id="form-preview"
            defaultSize={readOnly ? "74%" : "44%"}
            minSize="30%"
            aria-label={t("builder.layout.preview")}
          >
            <div className="grid min-w-0 content-start gap-3 px-4">
              {previewPanel}
            </div>
          </ResizablePanel>
          {!readOnly && (
            <>
              <ResizableHandle
                withHandle
                aria-label={t("builder.layout.resizePreviewInspector")}
              />
              <ResizablePanel
                id="form-inspector"
                defaultSize="30%"
                minSize="20%"
                aria-label={t("builder.layout.inspector")}
              >
                <div className="grid min-w-0 content-start gap-3 pl-4">
                  {inspectorPanel}
                </div>
              </ResizablePanel>
            </>
          )}
        </ResizablePanelGroup>
      ) : (
        <div className="grid gap-4">
          {fieldsPanel}
          {previewPanel}
        </div>
      )}

      {!readOnly && selectedField && (
        <Sheet
          open={inspectorOpen && !desktop}
          onOpenChange={(open) => {
            if (!open) setInspectorOpen(false);
          }}
        >
          <SheetContent side="right" className="overflow-y-auto">
            <SheetHeader>
              <p className="text-xs font-medium tracking-wide text-muted-foreground uppercase">
                {t("builder.inspectorPanel")}
              </p>
              <SheetTitle>
                {selectedField.label || selectedField.key}
              </SheetTitle>
            </SheetHeader>
            <div className="px-4 pb-4">
              <FormFieldEditor
                field={selectedField}
                allKeys={keys}
                lock={lockFor(selectedField)}
                readOnly={readOnly}
                onChange={(next) => mutateField(selected, next)}
              />
            </div>
          </SheetContent>
        </Sheet>
      )}
    </div>
  );
}
