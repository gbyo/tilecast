import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type { ScreenGroup } from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { useConfirm } from "../../components/ConfirmDialog";
import { toast } from "../../components/ui/toast";
import { screenKeys } from "../../data/screens";

/**
 * Deleting a group asks first and says plainly that screens survive. Both the
 * index row menu and the detail header menu use it.
 */
export function useDeleteDisplayGroup(
  onDeleted?: (group: ScreenGroup) => void,
) {
  const { t } = useTranslation(["screens", "common"]);
  const csrf = useAuth().status?.csrfToken ?? "";
  const client = useQueryClient();
  const { confirm, dialog } = useConfirm();
  const remove = useMutation({
    mutationFn: (group: ScreenGroup) => api.deleteScreenGroup(group.id, csrf),
    onSuccess: async (_result, group) => {
      toast.add({ title: t("groups.deleted"), type: "success" });
      await client.invalidateQueries({ queryKey: ["screen-groups"] });
      await client.invalidateQueries({ queryKey: screenKeys.all });
      onDeleted?.(group);
    },
    onError: () =>
      toast.add({ title: t("groups.errors.delete"), type: "error" }),
  });

  const requestDelete = async (group: ScreenGroup) => {
    const ok = await confirm({
      title: t("groups.detail.deleteTitle", { name: group.name }),
      body: t("groups.detail.deleteBody"),
      action: t("common:actions.delete"),
      destructive: true,
    });
    if (ok) remove.mutate(group);
  };

  return { requestDelete, pending: remove.isPending, dialog };
}
