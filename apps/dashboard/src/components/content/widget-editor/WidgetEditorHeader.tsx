/**
 * The editor's controls in the shared Studio header: Back, the impact of a
 * save (Used by), save state, Save, and the Widget's other actions. The
 * header's last breadcrumb shows the draft name and opens its details.
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Users } from "lucide-react";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router";
import { api } from "@/api/client";
import {
  ActionMenuButton,
  type StudioAction,
} from "@/components/studio/ActionMenu";
import {
  EditorHeaderPortal,
  useEditorHeaderRename,
  useEditorHeaderTitle,
} from "@/components/studio/EditorHeaderSlots";
import { EditorSaveStatus } from "@/components/studio/EditorSaveStatus";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button, buttonVariants } from "@/components/ui/button";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { toast } from "@/components/ui/toast";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { contentKeys } from "@/data/content";
import { apiErrorMessage } from "@/i18n";
import type { WidgetEditorSession } from "./useWidgetEditorSession";
import { WidgetDiagnosticsPanel } from "./WidgetDiagnosticsPanel";
import { widgetDiagnosticsKind } from "./widgetDiagnostics";
import { WidgetUsagePanel } from "./WidgetUsagePanel";
import { widgetUsageCount } from "./widgetUsage";

type Origin = "layout" | "playlist" | "media" | "dataSources" | "screen";

function originOf(returnTo: string | null): Origin | null {
  if (!returnTo) return null;
  if (returnTo.startsWith("/layouts/")) return "layout";
  if (returnTo.startsWith("/playlists/")) return "playlist";
  if (returnTo.startsWith("/assets")) return "media";
  if (returnTo.startsWith("/data-sources")) return "dataSources";
  if (returnTo.startsWith("/screens")) return "screen";
  return null;
}

function shortcutLabel() {
  if (typeof navigator === "undefined") return "Ctrl S";
  return /Mac|iPhone|iPad|iPod/i.test(navigator.platform) ? "⌘ S" : "Ctrl S";
}

export function WidgetEditorHeader({
  session,
  csrf,
  canManage,
  compact,
}: {
  session: WidgetEditorSession;
  csrf: string;
  canManage: boolean;
  compact: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [usageOpen, setUsageOpen] = useState(false);
  const [diagnosticsOpen, setDiagnosticsOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const asset = session.asset;
  const usage = widgetUsageCount(asset);
  const diagnostics = widgetDiagnosticsKind(session.definition, asset);
  const setDetailsOpen = session.setDetailsOpen;

  useEditorHeaderTitle(session.displayName);
  useEditorHeaderRename(
    useCallback(() => setDetailsOpen(true), [setDetailsOpen]),
  );

  const usageLabel =
    usage > 0
      ? t("widgets.editor.usage.button", { count: usage })
      : t("widgets.editor.usage.unused");
  const origin = originOf(session.returnTo);
  const backLabel = origin
    ? t(`widgets.editor.back.${origin}`)
    : session.returnTo
      ? t("widgets.editor.back.previous")
      : t("widgets.editor.back.widgets");

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
      onSelect: () => setDetailsOpen(true),
    },
    ...(compact && asset
      ? [
          {
            id: "usage",
            label: usageLabel,
            onSelect: () => setUsageOpen(true),
          },
        ]
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
            onSelect: () => setDiagnosticsOpen(true),
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
            onSelect: () => setDeleteOpen(true),
          },
        ]
      : [];

  const saveLabel = compact
    ? t("widgets.editor.saveShort")
    : session.isNew
      ? t("widgets.editor.saveNew")
      : t("widgets.editor.save");

  return (
    <>
      <EditorHeaderPortal
        left={
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label={backLabel}
                  onClick={session.close}
                />
              }
            >
              <ArrowLeft aria-hidden="true" />
            </TooltipTrigger>
            <TooltipContent>{backLabel}</TooltipContent>
          </Tooltip>
        }
        right={
          <div className="flex shrink-0 items-center gap-2">
            {asset && !compact && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                aria-haspopup="dialog"
                onClick={() => setUsageOpen(true)}
              >
                <Users aria-hidden="true" />
                {usageLabel}
              </Button>
            )}
            {!compact && <Separator orientation="vertical" className="h-4" />}
            {session.readOnly ? (
              <EditorSaveStatus
                state="readOnly"
                compact={compact}
                labels={{
                  saved: t("widgets.editor.status.saved"),
                  readOnly: t("widgets.editor.status.viewOnly"),
                }}
              />
            ) : (
              <>
                <EditorSaveStatus
                  state={session.saveState}
                  compact={compact}
                  onRetry={session.save}
                  labels={{
                    saved: t("widgets.editor.status.saved"),
                    unsaved: session.isNew
                      ? t("widgets.editor.status.notSaved")
                      : t("widgets.editor.status.unsaved"),
                    saving: t("widgets.editor.status.saving"),
                    error: t("widgets.editor.status.failed"),
                  }}
                />
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        type="button"
                        size="sm"
                        disabled={!session.canSave}
                        aria-busy={session.saveState === "saving" || undefined}
                        aria-keyshortcuts="Control+S Meta+S"
                        onClick={session.save}
                      />
                    }
                  >
                    {session.saveState === "saving" && (
                      <Spinner aria-hidden="true" />
                    )}
                    {saveLabel}
                  </TooltipTrigger>
                  <TooltipContent>
                    {saveLabel} <Kbd>{shortcutLabel()}</Kbd>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            <ActionMenuButton
              label={t("widgets.editor.actions.label")}
              variant="ghost"
              size="icon-sm"
              actions={[
                { actions: primary },
                { actions: draftActions },
                { actions: destructive },
              ]}
            />
          </div>
        }
      />
      {asset && (
        <WidgetUsagePanel
          asset={asset}
          open={usageOpen}
          onOpenChange={setUsageOpen}
        />
      )}
      {asset && diagnostics && (
        <WidgetDiagnosticsPanel
          kind={diagnostics}
          asset={asset}
          open={diagnosticsOpen}
          onOpenChange={setDiagnosticsOpen}
        />
      )}
      {asset && (
        <AlertDialog open={deleteOpen} onOpenChange={setDeleteOpen}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>
                {t("widgets.editor.delete.title", { name: asset.name })}
              </AlertDialogTitle>
              <AlertDialogDescription>
                {usage > 0
                  ? t("widgets.editor.delete.inUse", { count: usage })
                  : t("widgets.editor.delete.body")}
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>
                {t("widgets.editor.delete.keep")}
              </AlertDialogCancel>
              {usage === 0 && (
                <AlertDialogAction
                  className={buttonVariants({ variant: "destructive" })}
                  disabled={remove.isPending}
                  onClick={() => remove.mutate()}
                >
                  {t("widgets.editor.delete.confirm")}
                </AlertDialogAction>
              )}
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      )}
    </>
  );
}
