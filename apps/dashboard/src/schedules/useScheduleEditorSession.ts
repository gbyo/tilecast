/**
 * The one owner of a Schedule editing session.
 *
 * It holds the saved baseline and the working draft, derives whether anything
 * changed, validates, saves, protects unsaved work from navigation, and routes
 * after a create. No control keeps its own copy of any of these. Transient
 * interface state (which picker is open, which section is expanded) stays in
 * the components and never touches the draft.
 *
 * Saving is always explicit. A schedule change can alter what screens play,
 * so nothing here saves on its own.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
  useCallback,
  useMemo,
  useRef,
  useState,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import type { Schedule } from "../api/types";
import { toast } from "../components/ui/toast";
import { api } from "../api/client";
import { rememberSavedSchedule } from "../data/schedules";
import { useSaveShortcut } from "../hooks/use-save-shortcut";
import { apiErrorMessage } from "../i18n";
import { useNavigationWarning } from "../settings/useNavigationWarning";
import {
  draftFromSchedule,
  draftToInput,
  firstProblem,
  sameDraft,
  scheduleProblems,
  type ScheduleDraft,
  type ScheduleField,
} from "./scheduleEditorModel";
import { useSchedulePreflight } from "./useSchedulePreflight";

export type ScheduleSaveState = "saved" | "unsaved" | "saving" | "error";

/** Where the editor should move focus to show a problem. */
export type ScheduleFocusRequest = {
  readonly field: ScheduleField;
  readonly nonce: number;
};

/**
 * Router state carried across the route change that follows a create, so an
 * edit made while the create was in flight is not lost to the new route.
 */
export type ScheduleCarriedDraft = { scheduleDraft: ScheduleDraft };

export type ScheduleEditorSessionOptions = {
  /** The saved schedule; absent while creating a new one. */
  schedule?: Schedule;
  /** The draft to start from: a new schedule's defaults, or an unsaved edit carried over a create. */
  initial: ScheduleDraft;
  csrf: string;
  readOnly: boolean;
};

export function useScheduleEditorSession({
  schedule,
  initial,
  csrf,
  readOnly,
}: ScheduleEditorSessionOptions) {
  const { t } = useTranslation(["schedules", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const isNew = !schedule;
  const scheduleId = schedule?.id;

  // A saved schedule's baseline is what the server returned; a new schedule's
  // baseline is its defaults, so applying them never counts as an edit. A
  // carried draft starts from its own baseline and so stays unsaved.
  const [baseline, setBaseline] = useState<ScheduleDraft>(() =>
    schedule ? draftFromSchedule(schedule) : initial,
  );
  const [draft, setDraft] = useState<ScheduleDraft>(initial);
  const draftRef = useRef(draft);
  draftRef.current = draft;

  const changed = !sameDraft(baseline, draft);
  // A new schedule needs saving even before it is edited.
  const dirty = isNew || changed;
  const problems = useMemo(() => scheduleProblems(draft), [draft]);
  const hasProblems = Object.keys(problems).length > 0;
  // Problems appear after someone tries to save, not while they type.
  const [revealed, setRevealed] = useState(false);
  const [focusRequest, setFocusRequest] = useState<ScheduleFocusRequest | null>(
    null,
  );

  // One pass for the editor's own departures (after a create or a delete),
  // which must not ask to discard what was just saved or deliberately removed.
  const bypass = useRef(false);
  const leave = useCallback(
    (to: string, options?: { replace?: boolean; state?: unknown }) => {
      bypass.current = true;
      void Promise.resolve(navigate(to, options)).finally(() => {
        bypass.current = false;
      });
    },
    [navigate],
  );
  const displayName = draft.name.trim() || t("editor.newName");
  const navigationDialog = useNavigationWarning({
    dirty: changed && !readOnly,
    title: t("editor.discard.title"),
    body: t("editor.discard.body", { name: displayName }),
    cancel: t("editor.discard.keepEditing"),
    shouldBlock: () => !bypass.current,
  });

  const edit = useCallback(
    (update: SetStateAction<ScheduleDraft>) => {
      if (!readOnly) setDraft(update);
    },
    [readOnly],
  );
  const update = useCallback(
    (change: Partial<ScheduleDraft>) =>
      edit((current) => ({ ...current, ...change })),
    [edit],
  );

  const preflight = useSchedulePreflight(draft, scheduleId);

  // The mutation's variables are the draft that was sent, so edits made while
  // the request was in flight can be told apart from what was saved.
  const saveDraft = useMutation({
    mutationFn: (sent: ScheduleDraft) =>
      scheduleId
        ? api.updateSchedule(scheduleId, draftToInput(sent), csrf)
        : api.createSchedule(draftToInput(sent), csrf),
    onSuccess: (saved, sent) => {
      rememberSavedSchedule(queryClient, saved);
      // The server's normalized schedule is the new baseline. Edits made while
      // the request was in flight stay in the draft as changes.
      const next = draftFromSchedule(saved);
      const edited = !sameDraft(draftRef.current, sent);
      setBaseline(next);
      setDraft((current) => (sameDraft(current, sent) ? next : current));
      setRevealed(false);
      toast.add({
        title: isNew ? t("notifications.created") : t("notifications.updated"),
        type: "success",
      });
      if (isNew) {
        // Keep editing the schedule that now exists. A newer draft rides the
        // route change so it is not replaced by what was just saved.
        const carried: ScheduleCarriedDraft | undefined = edited
          ? { scheduleDraft: draftRef.current }
          : undefined;
        leave(`/schedules/${saved.id}`, { replace: true, state: carried });
      }
    },
  });
  const saving = saveDraft.isPending;

  const requestSave = useCallback(() => {
    if (readOnly || saving || !dirty) return;
    if (hasProblems) {
      setRevealed(true);
      const field = firstProblem(problems);
      if (field) setFocusRequest({ field, nonce: Date.now() });
      return;
    }
    saveDraft.mutate(draftRef.current);
  }, [readOnly, saving, dirty, hasProblems, problems, saveDraft]);

  useSaveShortcut(requestSave, readOnly);

  const discard = useCallback(() => {
    setDraft(baseline);
    setRevealed(false);
    saveDraft.reset();
  }, [baseline, saveDraft]);

  // A check that found the schedule cannot be saved (a screen that cannot run
  // display control) stops the save here; the server refuses it too.
  const preflightBlocking =
    preflight.status !== "incomplete" && preflight.blocking;
  const canSave =
    !readOnly &&
    dirty &&
    !saving &&
    !(revealed && hasProblems) &&
    !preflightBlocking;

  const saveState: ScheduleSaveState = saving
    ? "saving"
    : saveDraft.isError && dirty
      ? "error"
      : dirty
        ? "unsaved"
        : "saved";

  return {
    schedule,
    scheduleId,
    isNew,
    readOnly,
    baseline,
    draft,
    displayName,
    changed,
    dirty,
    problems,
    errors: revealed ? problems : {},
    revealed,
    focusRequest,
    saveState,
    saveError: saveDraft.error ? apiErrorMessage(saveDraft.error) : null,
    canSave,
    preflight,
    preflightBlocking,
    update,
    edit,
    save: requestSave,
    discard,
    leave,
    navigationDialog,
  };
}

export type ScheduleEditorSession = ReturnType<typeof useScheduleEditorSession>;
