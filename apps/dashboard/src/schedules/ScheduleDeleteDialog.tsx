import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import { buttonVariants } from "../components/ui/button";
import { toast } from "../components/ui/toast";
import { scheduleMutations } from "../data/schedules";
import { apiErrorMessage } from "../i18n";
import type { ScheduleEditorSession } from "./useScheduleEditorSession";

/** Names the schedule and what deleting it does, then deletes it. */
export function ScheduleDeleteDialog({
  session,
  csrf,
  open,
  onOpenChange,
}: {
  session: ScheduleEditorSession;
  csrf: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation("schedules");
  const queryClient = useQueryClient();
  const schedule = session.schedule;
  const remove = useMutation({
    ...scheduleMutations.remove(queryClient, csrf, session.scheduleId ?? ""),
    onSuccess: () => {
      toast.add({ title: t("notifications.deleted"), type: "success" });
      // Deleting deliberately discards the draft; there is nothing to keep.
      session.leave("/schedules");
    },
    onError: (error) => {
      onOpenChange(false);
      toast.add({
        title: t("editor.delete.failed"),
        description: apiErrorMessage(error),
        type: "error",
      });
    },
  });
  if (!schedule) return null;
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("editor.delete.title", { name: schedule.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("editor.delete.body")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("editor.delete.keep")}</AlertDialogCancel>
          <AlertDialogAction
            className={buttonVariants({ variant: "destructive" })}
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {t("editor.delete.confirm")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
