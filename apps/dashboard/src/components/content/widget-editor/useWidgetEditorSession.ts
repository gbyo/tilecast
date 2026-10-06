/**
 * The one owner of a Widget authoring session (docs/widget-authoring.md).
 *
 * It holds the saved baseline and the working draft, derives whether
 * anything changed, validates, saves, protects unsaved work from
 * navigation, and routes after a save or on close. Nothing else in the
 * editor keeps its own copy of these, and no Widget type can replace them.
 * Preview state (frame, zoom, time) lives in the preview pane and never
 * touches the draft.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import type { Asset, WidgetDefinition } from "@/api/types";
import { toast } from "@/components/ui/toast";
import { contentKeys } from "@/data/content";
import { apiErrorMessage } from "@/i18n";
import { withParam } from "@/navigation/returnPaths";
import { useNavigationWarning } from "@/settings/useNavigationWarning";
import type { WidgetAuthoringSection } from "@tilecast/widget-sdk";
import type { WidgetAuthoring } from "./widgetAuthoring";
import {
  initialDraft,
  sameDraft,
  widgetSaveInput,
  type WidgetConfiguration,
  type WidgetDraft,
} from "./widgetEditorModel";
import { validateWidgetDraft } from "./widgetEditorValidation";
import { enqueueWidgetSnapshot } from "./snapshotQueue";

export type WidgetSaveState = "saved" | "unsaved" | "saving" | "error";

/** Where the editor should move focus to show a problem. */
export type WidgetFocusRequest = {
  readonly target: "field" | "details";
  readonly path?: string;
  readonly section?: WidgetAuthoringSection;
  readonly nonce: number;
};

export type WidgetEditorSessionOptions = {
  definition: WidgetDefinition;
  authoring: Exclude<WidgetAuthoring, { kind: "unsupported" }>;
  /** The saved Widget; absent while creating a new one. */
  asset?: Asset;
  csrf: string;
  readOnly: boolean;
  /** A validated in-app path the editor returns to. */
  returnTo: string | null;
  /** This Widget was created in the current trip from returnTo. */
  createdHere: boolean;
};

function isShortcutTargetInDialog(target: EventTarget | null) {
  return (
    target instanceof Element &&
    Boolean(target.closest('[role="dialog"],[role="alertdialog"]'))
  );
}

export function useWidgetEditorSession({
  definition,
  authoring,
  asset,
  csrf,
  readOnly,
  returnTo,
  createdHere,
}: WidgetEditorSessionOptions) {
  const { t } = useTranslation(["content", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const newName = t("widgets.editor.newName", { name: definition.name });
  const [start] = useState(() =>
    initialDraft(definition, authoring, asset, newName),
  );
  const [baseline, setBaseline] = useState<WidgetDraft>(start);
  const [draft, setDraft] = useState<WidgetDraft>(start);
  const isNew = !asset;
  // Edits since the Widget opened or was last saved.
  const changed = !sameDraft(baseline, draft);
  // A new Widget needs saving even before it is edited.
  const dirty = isNew || changed;
  const validation = useMemo(
    () => validateWidgetDraft(definition, draft, t),
    [definition, draft, t],
  );
  // Problems are shown after someone tries to save, not while they type.
  const [revealed, setRevealed] = useState(false);
  const [focusRequest, setFocusRequest] = useState<WidgetFocusRequest | null>(
    null,
  );
  const [detailsOpen, setDetailsOpen] = useState(false);
  // Counts wholesale replacements of the draft (Discard), so list rows in
  // the inspector start over instead of inheriting the old rows' identity.
  const [draftEpoch, setDraftEpoch] = useState(0);

  // One pass for the editor's own departures (after create, delete), which
  // must not ask to discard what was just saved or deliberately removed.
  const bypass = useRef(false);
  const leave = useCallback(
    (to: string, options?: { replace?: boolean }) => {
      bypass.current = true;
      void Promise.resolve(navigate(to, options)).finally(() => {
        bypass.current = false;
      });
    },
    [navigate],
  );
  const displayName = draft.name.trim() || newName;
  const navigationDialog = useNavigationWarning({
    dirty: changed && !readOnly,
    title: t("widgets.editor.discard.title"),
    body: t("widgets.editor.discard.body", { name: displayName }),
    cancel: t("widgets.editor.discard.keepEditing"),
    shouldBlock: () => !bypass.current,
  });

  const updateConfiguration = useCallback(
    (update: SetStateAction<WidgetConfiguration>) =>
      setDraft((current) => ({
        ...current,
        configuration:
          typeof update === "function" ? update(current.configuration) : update,
      })),
    [],
  );
  const updateField = useCallback(
    (key: string, value: unknown) =>
      updateConfiguration((current) => ({ ...current, [key]: value })),
    [updateConfiguration],
  );
  const updateDetails = useCallback(
    (details: { name: string; description: string }) =>
      setDraft((current) => ({ ...current, ...details })),
    [],
  );

  const save = useMutation({
    mutationFn: (sent: WidgetDraft) => {
      const input = widgetSaveInput(definition, sent);
      return asset
        ? api.updateWidget(asset.id, input, csrf)
        : api.createWidget(input, csrf);
    },
    onSuccess: (saved, sent) => {
      queryClient.setQueryData(contentKeys.asset(saved.id), saved);
      void queryClient.invalidateQueries({ queryKey: contentKeys.assets });
      // The Server's normalized Widget is the new baseline. Edits made
      // while the request was in flight stay in the draft as changes.
      const next = initialDraft(definition, authoring, saved, newName);
      setBaseline(next);
      setDraft((current) => (sameDraft(current, sent) ? next : current));
      setRevealed(false);
      toast.add({
        title: isNew
          ? t("widgets.editor.toast.created")
          : t("widgets.editor.toast.saved"),
        type: "success",
      });
      // The thumbnail follows the save and never decides it.
      if (authoring.kind === "component")
        enqueueWidgetSnapshot({
          asset: saved,
          onFailed: () =>
            toast.add({
              title: t("widgets.editor.toast.thumbnailFailed"),
              description: t("widgets.editor.toast.thumbnailFailedHint"),
              type: "warning",
            }),
        });
      if (isNew) {
        // Keep editing the Widget that now exists. A trip that started
        // elsewhere keeps its return path and reports the new Widget on
        // the way back (see closeTarget).
        const query = new URLSearchParams();
        if (returnTo) {
          query.set("returnTo", returnTo);
          query.set("created", "1");
        }
        leave(
          `/widgets/${saved.id}${query.size ? `?${query.toString()}` : ""}`,
          { replace: true },
        );
      }
    },
  });

  const canSave =
    !readOnly && dirty && !save.isPending && !(revealed && !validation.valid);

  const requestSave = useCallback(() => {
    if (readOnly || save.isPending || !dirty) return;
    if (!validation.valid) {
      setRevealed(true);
      const first = validation.issues[0];
      if (validation.name || validation.description) {
        setDetailsOpen(true);
        setFocusRequest({ target: "details", nonce: Date.now() });
      } else if (first) {
        setFocusRequest({
          target: "field",
          path: first.path,
          section: first.section,
          nonce: Date.now(),
        });
      }
      return;
    }
    save.mutate(draft);
  }, [readOnly, save, dirty, validation, draft]);

  // Ctrl/Command+S saves from anywhere in the editor except an open
  // dialog, which owns its own keys. The browser's own Save Page never runs.
  const saveFromShortcut = useEffectEvent(requestSave);
  useEffect(() => {
    if (readOnly) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "s" ||
        !(event.metaKey || event.ctrlKey) ||
        event.altKey ||
        event.shiftKey ||
        event.isComposing
      )
        return;
      if (isShortcutTargetInDialog(event.target)) return;
      event.preventDefault();
      saveFromShortcut();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [readOnly]);

  const discard = useCallback(() => {
    setDraft(baseline);
    setDraftEpoch((current) => current + 1);
    setRevealed(false);
    save.reset();
  }, [baseline, save]);

  const id = asset?.id;
  const closeTarget = returnTo
    ? createdHere && id
      ? withParam(returnTo, "newWidget", id)
      : returnTo
    : "/widgets";
  // Close is ordinary navigation: the navigation warning confirms it when
  // there are unsaved changes, exactly like any other departure.
  const close = useCallback(() => {
    void navigate(closeTarget);
  }, [navigate, closeTarget]);

  const saveState: WidgetSaveState = save.isPending
    ? "saving"
    : save.isError && dirty
      ? "error"
      : dirty
        ? "unsaved"
        : "saved";

  return {
    definition,
    authoring,
    asset,
    isNew,
    readOnly,
    baseline,
    draft,
    draftEpoch,
    displayName,
    changed,
    dirty,
    validation,
    revealed,
    focusRequest,
    detailsOpen,
    setDetailsOpen,
    saveState,
    saveError: save.error ? apiErrorMessage(save.error) : null,
    canSave,
    returnTo,
    closeTarget,
    updateConfiguration,
    updateField,
    updateDetails,
    save: requestSave,
    discard,
    close,
    leave,
    navigationDialog,
  };
}

export type WidgetEditorSession = ReturnType<typeof useWidgetEditorSession>;
