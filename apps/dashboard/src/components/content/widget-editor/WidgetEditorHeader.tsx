/**
 * The editor's controls in the shared Studio header: Back, the impact of a
 * save (Used by), save state, Save, and the Widget's other actions. The
 * header's last breadcrumb shows the draft name and opens its details.
 */
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { ActionMenuButton } from "@/components/studio/ActionMenu";
import {
  EditorHeaderPortal,
  useEditorHeaderRename,
  useEditorHeaderTitle,
} from "@/components/studio/EditorHeaderSlots";
import { Separator } from "@/components/ui/separator";
import { DeleteWidgetDialog } from "./header/DeleteWidgetDialog";
import { useWidgetHeaderActions } from "./header/useWidgetHeaderActions";
import { WidgetHeaderNavigation } from "./header/WidgetHeaderNavigation";
import {
  WidgetHeaderStatus,
  WidgetUsageButton,
} from "./header/WidgetHeaderStatus";
import type { WidgetEditorSession } from "./useWidgetEditorSession";
import { WidgetDiagnosticsPanel } from "./WidgetDiagnosticsPanel";
import { widgetDiagnosticsKind } from "./widgetDiagnostics";
import { WidgetUsagePanel } from "./WidgetUsagePanel";
import { widgetUsageCount } from "./widgetUsage";

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
  const { t } = useTranslation("content");
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
  const actions = useWidgetHeaderActions({
    session,
    csrf,
    canManage,
    compact,
    usageLabel,
    diagnostics,
    open: {
      details: () => setDetailsOpen(true),
      usage: () => setUsageOpen(true),
      diagnostics: () => setDiagnosticsOpen(true),
      delete: () => setDeleteOpen(true),
    },
  });

  return (
    <>
      <EditorHeaderPortal
        left={<WidgetHeaderNavigation session={session} />}
        right={
          <div className="flex shrink-0 items-center gap-2">
            {asset && !compact && (
              <WidgetUsageButton
                label={usageLabel}
                onOpen={() => setUsageOpen(true)}
              />
            )}
            {!compact && <Separator orientation="vertical" className="h-4" />}
            <WidgetHeaderStatus session={session} compact={compact} />
            <ActionMenuButton
              label={t("widgets.editor.actions.label")}
              variant="ghost"
              size="icon-sm"
              actions={actions.sections}
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
        <DeleteWidgetDialog
          asset={asset}
          usage={usage}
          pending={actions.remove.isPending}
          open={deleteOpen}
          onOpenChange={setDeleteOpen}
          onConfirm={() => actions.remove.mutate()}
        />
      )}
    </>
  );
}
