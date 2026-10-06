/**
 * The two preview stages. Each asks its hook what to show and how it is
 * doing, and hands both to the shared stage; the pane never mirrors a
 * child's status back into its own state.
 */
import { useTranslation } from "react-i18next";
import type { ContentDefinitionField } from "@/api/types";
import type { StudioWidgetComponent } from "@/content/studioWidgets";
import type { PreviewTime } from "@/content/previewTime";
import { WidgetPreviewHost } from "@/content/WidgetPreviewHost";
import { PreviewStage } from "../PreviewStage";
import type { PreviewView } from "../usePreviewView";
import { useComponentPreview } from "./useComponentPreview";
import { useWebIntegrationPreview } from "./useWebIntegrationPreview";
import { WebIntegrationPreview } from "./WebIntegrationPreview";

/**
 * The draft rendered by the real Widget component, the same element the
 * Player mounts. There is no Studio-only renderer behind it.
 */
export function ComponentPreviewStage({
  view,
  component,
  fields,
  configuration,
  managedDataSourceId,
  previewTime,
}: {
  view: PreviewView;
  component: StudioWidgetComponent;
  fields: readonly ContentDefinitionField[];
  configuration: Record<string, unknown>;
  managedDataSourceId?: string;
  previewTime: PreviewTime;
}) {
  const { t } = useTranslation("content");
  const preview = useComponentPreview({
    component,
    fields,
    configuration,
    managedDataSourceId,
    previewTime,
  });
  return (
    <PreviewStage stageRef={view.stageRef} status={preview.status}>
      {preview.host && (
        <WidgetPreviewHost
          {...preview.host}
          frame={view.frame}
          scale={view.scale}
          label={t("widgets.editor.preview.frameLabel")}
        />
      )}
    </PreviewStage>
  );
}

export function WebPreviewStage({
  view,
  provider,
  configuration,
  csrf,
  canCompile,
  savedThumbnailUrl,
  urlField,
}: {
  view: PreviewView;
  provider: string;
  configuration: Record<string, unknown>;
  csrf: string;
  canCompile: boolean;
  savedThumbnailUrl?: string;
  urlField: string;
}) {
  const preview = useWebIntegrationPreview({
    provider,
    configuration,
    csrf,
    canCompile,
    savedThumbnailUrl,
    urlField,
  });
  return (
    <PreviewStage stageRef={view.stageRef} status={preview.status}>
      <WebIntegrationPreview
        surface={preview.surface}
        frame={view.frame}
        scale={view.scale}
      />
    </PreviewStage>
  );
}
