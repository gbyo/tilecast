/**
 * The Widget editor (docs/widget-authoring.md): the live preview as the
 * main workspace with the inspector beside it. Every Widget type, new or
 * saved, component or web integration, edits here.
 *
 * Wide screens get a resizable split; compact ones stack the preview above
 * the inspector, each scrolling on its own. Only one arrangement is
 * mounted, so no control exists twice.
 */
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
  Alert,
  AlertAction,
  AlertDescription,
  AlertTitle,
} from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useCompactLayout } from "@/hooks/use-compact-layout";
import { useDesktopLayout } from "@/hooks/use-desktop-layout";
import { useAutomaticFieldMapping } from "./fields/useAutomaticFieldMapping";
import type { WidgetEditorSession } from "./useWidgetEditorSession";
import { WidgetDetailsDialog } from "./WidgetDetailsDialog";
import { WidgetEditorHeader } from "./WidgetEditorHeader";
import { WidgetInspector } from "./WidgetInspector";
import { WidgetPreviewPane } from "./WidgetPreviewPane";

const INSPECTOR_SIZE_KEY = "tilecast.widgetEditor.inspectorSize";
const DEFAULT_INSPECTOR_SIZE = 32;

// The split is a viewing preference of this browser, never Widget data.
function readInspectorSize() {
  try {
    const saved = Number(window.localStorage.getItem(INSPECTOR_SIZE_KEY));
    return saved >= 24 && saved <= 50 ? saved : DEFAULT_INSPECTOR_SIZE;
  } catch {
    return DEFAULT_INSPECTOR_SIZE;
  }
}

function writeInspectorSize(size: number) {
  try {
    window.localStorage.setItem(INSPECTOR_SIZE_KEY, String(Math.round(size)));
  } catch {
    // The split still works for this visit without browser storage.
  }
}

export function WidgetEditorWorkspace({
  session,
  csrf,
  canManage,
}: {
  session: WidgetEditorSession;
  csrf: string;
  canManage: boolean;
}) {
  const { t } = useTranslation(["content", "common"]);
  const desktop = useDesktopLayout();
  const compact = useCompactLayout();
  // Read once: React keeps only the first value, so only the first render
  // should touch browser storage.
  const [inspectorSize] = useState(readInspectorSize);
  useAutomaticFieldMapping({
    fields: session.definition.configurationSchema.fields,
    configuration: session.draft.configuration,
    readOnly: session.readOnly,
    updateConfiguration: session.updateConfiguration,
  });

  const preview = (
    <WidgetPreviewPane session={session} csrf={csrf} compact={compact} />
  );
  const inspector = <WidgetInspector session={session} csrf={csrf} />;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <h1 className="sr-only">
        {t("widgets.editor.heading", {
          name: session.displayName,
          type: session.definition.name,
        })}
      </h1>
      <WidgetEditorHeader
        session={session}
        csrf={csrf}
        canManage={canManage}
        compact={compact}
      />
      {session.saveState === "error" && session.saveError && (
        <Alert
          variant="destructive"
          className="shrink-0 rounded-none border-x-0 border-t-0"
        >
          <AlertTitle>{t("widgets.editor.status.failed")}</AlertTitle>
          <AlertDescription>{session.saveError}</AlertDescription>
          <AlertAction>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={session.save}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertAction>
        </Alert>
      )}
      {desktop ? (
        <ResizablePanelGroup
          orientation="horizontal"
          className="min-h-0 flex-1"
          onLayoutChanged={(layout) => {
            const size = layout["widget-inspector"];
            if (size) writeInspectorSize(size);
          }}
        >
          <ResizablePanel
            id="widget-preview"
            minSize="40%"
            aria-label={t("widgets.editor.preview.region")}
          >
            {preview}
          </ResizablePanel>
          <ResizableHandle withHandle aria-label={t("widgets.editor.resize")} />
          <ResizablePanel
            id="widget-inspector"
            defaultSize={`${inspectorSize}%`}
            minSize="24%"
            maxSize="50%"
          >
            <section
              aria-label={t("widgets.editor.inspector")}
              className="h-full min-h-0 border-s border-border"
            >
              {inspector}
            </section>
          </ResizablePanel>
        </ResizablePanelGroup>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="h-[38dvh] min-h-52 shrink-0 border-b border-border">
            {preview}
          </div>
          <section
            aria-label={t("widgets.editor.inspector")}
            className="min-h-0 flex-1"
          >
            {inspector}
          </section>
        </div>
      )}
      <WidgetDetailsDialog session={session} />
      {session.navigationDialog}
    </div>
  );
}
