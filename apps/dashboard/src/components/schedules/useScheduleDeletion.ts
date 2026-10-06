import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import type { Schedule } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { scheduleMutations } from "../../data/schedules";
import { apiErrorMessage } from "../../i18n";
import { useConfirm } from "../ConfirmDialog";
import { toast } from "../ui/toast";

/**
 * Confirm, then delete a Schedule by id. The confirmation names the schedule;
 * the mutation invalidates every Schedule query; a rejection is surfaced as a
 * toast and leaves the list as it was. Render `dialog` beside the library.
 */
export function useScheduleDeletion() {
  const { t } = useTranslation(["schedules", "common"]);
  const client = useQueryClient();
  const auth = useAuth();
  const { confirm, dialog } = useConfirm();
  const remove = useMutation(
    scheduleMutations.removeById(client, auth.status?.csrfToken ?? ""),
  );

  const requestDelete = (schedule: Schedule) =>
    void confirm({
      title: t("editor.deleteTitle", { name: schedule.name }),
      action: t("common:actions.delete"),
      destructive: true,
    }).then((ok) => {
      if (!ok) return;
      remove.mutate(schedule.id, {
        onSuccess: () =>
          toast.add({ title: t("notifications.deleted"), type: "success" }),
        onError: (error) =>
          toast.add({
            title: t("page.deleteFailed"),
            description: apiErrorMessage(error),
            type: "error",
          }),
      });
    });

  return { requestDelete, deleting: remove.isPending, dialog };
}
