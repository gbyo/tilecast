/**
 * The editor's main workspace: the live preview and the controls for how
 * it is viewed. Everything here (frame, zoom, fullscreen, preview time) is
 * a way of looking at the Widget and never changes the draft.
 */
import { useQueries } from "@tanstack/react-query";
import { useRef } from "react";
import { cn } from "cn";
import { api } from "@/api/client";
import { dataSourceKeysIn } from "@/content/dataSourceBindings";
import { recommendedFrameOf } from "@/content/widgetGeometry";
import { offersRecommendedFrame } from "./previewFrames";
import {
  ComponentPreviewStage,
  WebPreviewStage,
} from "./preview/PreviewStages";
import { PreviewToolbar } from "./PreviewToolbar";
import { useFullscreen } from "./useFullscreen";
import { usePreviewView } from "./usePreviewView";
import type { WidgetEditorSession } from "./useWidgetEditorSession";
import { previewsTime } from "./widgetAuthoring";

/** Data Sources with date selection make any Widget time-dependent. */
function useDateSelectedSources(session: WidgetEditorSession) {
  const ids = dataSourceKeysIn(
    session.definition.configurationSchema.fields,
    session.draft.configuration,
  );
  return useQueries({
    queries: ids.map((id) => ({
      queryKey: ["definition-form-data-source", id],
      queryFn: () => api.getDataSource(id),
    })),
    combine: (results) =>
      results.some((result) => result.data?.dateSelection?.enabled === true),
  });
}

export function WidgetPreviewPane({
  session,
  csrf,
  compact,
}: {
  session: WidgetEditorSession;
  csrf: string;
  compact: boolean;
}) {
  const recommended = recommendedFrameOf(session.definition);
  const view = usePreviewView(recommended);
  const paneRef = useRef<HTMLDivElement>(null);
  const fullscreen = useFullscreen(paneRef);
  const dateSelected = useDateSelectedSources(session);
  const authoring = session.authoring;
  const configuration = session.draft.configuration;

  return (
    <div
      ref={paneRef}
      className={cn(
        "flex min-h-0 min-w-0 flex-col bg-background",
        fullscreen.active ? "fixed inset-0 z-50 h-dvh" : "h-full",
      )}
    >
      <PreviewToolbar
        view={view}
        recommended={offersRecommendedFrame(recommended) ? recommended : null}
        showTime={previewsTime(session.definition) || dateSelected}
        compact={compact}
        fullscreen={fullscreen}
      />
      {authoring.kind === "component" ? (
        <ComponentPreviewStage
          view={view}
          component={authoring.component}
          fields={session.definition.configurationSchema.fields}
          configuration={configuration}
          managedDataSourceId={session.asset?.widget?.managedDataSourceId}
          previewTime={view.previewTime}
        />
      ) : (
        <WebPreviewStage
          view={view}
          provider={session.definition.id}
          configuration={configuration}
          csrf={csrf}
          canCompile={!session.readOnly}
          savedThumbnailUrl={session.asset?.thumbnailUrl}
          urlField={authoring.urlField}
        />
      )}
    </div>
  );
}
