/**
 * What the overflow menu offers and the operations behind it: details,
 * Used by, Duplicate, Diagnostics, Discard, and Delete.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import type { StudioAction } from "@/components/studio/ActionMenu";
import { toast } from "@/components/ui/toast";
import { contentKeys } from "@/data/content";
import { apiErrorMessage } from "@/i18n";
import type { WidgetEditorSession } from "../useWidgetEditorSession";
import type { WidgetDiagnosticsKind } from "../widgetDiagnostics";

export function useWidgetHeaderActions({
  session,
  csrf,
  canManage,
  compact,
  usageLabel,
  diagnostics,
  open,
}: {
  session: WidgetEditorSession;
  csrf: string;
  canManage: boolean;
  compact: boolean;
  usageLabel: string;
  diagnostics: WidgetDiagnosticsKind | null;
  open: {
    details: () => void;
    usage: () => void;
    diagnostics: () => void;
    delete: () => void;
  };
}) {
  const { t } = useTranslation("content");
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const asset = session.asset;

  const duplicate = useMutation({
    mutationFn: () => api.duplicateWidget(asset!.id, csrf),
    onSuccess: (copy) => {
      toast.add({ title: t("widgets.duplicateSuccess"), type: "success" });
      void queryClient.invalidateQueries({ queryKey: contentKeys.assets });
      void navigate(`/widgets/${copy.id}`);
    },
    onError: (error) =>
      toast.add({
        title: t("widgets.duplicateFailed"),
        description: apiErrorMessage(error),
        type: "error",
      }),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteAsset(asset!.id, csrf),
    onSuccess: () => {
      toast.add({ title: t("widgets.editor.delete.done"), type: "success" });
      void queryClient.invalidateQueries({ queryKey: contentKeys.assets });
      // Deleting deliberately discards the draft; there is nothing to keep.
      session.leave(session.returnTo ?? "/widgets");
    },
    onError: (error) =>
      toast.add({
        title: t("widgets.editor.delete.failed"),
        description: apiErrorMessage(error),
        type: "error",
      }),
  });

  const primary: StudioAction[] = [
    {
      id: "details",
      label: session.readOnly
        ? t("widgets.editor.actions.viewDetails")
        : t("widgets.editor.actions.editDetails"),
      icon: "details",
      onSelect: open.details,
    },
    ...(compact && asset
      ? [{ id: "usage", label: usageLabel, onSelect: open.usage }]
      : []),
    ...(asset && canManage
      ? [
          {
            id: "duplicate",
            label: t("widgets.editor.actions.duplicate"),
            icon: "duplicate",
            disabled: duplicate.isPending,
            onSelect: () => duplicate.mutate(),
          },
        ]
      : []),
    ...(diagnostics
      ? [
          {
            id: "diagnostics",
            label: t("widgets.editor.actions.diagnostics"),
            onSelect: open.diagnostics,
          },
        ]
      : []),
  ];
  const draftActions: StudioAction[] =
    session.changed && !session.readOnly
      ? [
          {
            id: "discard",
            label: t("widgets.editor.actions.discard"),
            icon: "restore",
            onSelect: session.discard,
          },
        ]
      : [];
  const destructive: StudioAction[] =
    asset && canManage
      ? [
          {
            id: "delete",
            label: t("widgets.editor.actions.delete"),
            icon: "delete",
            role: "destructive",
            onSelect: open.delete,
          },
        ]
      : [];

  return {
    sections: [
      { actions: primary },
      { actions: draftActions },
      { actions: destructive },
    ],
    remove,
  };
}
