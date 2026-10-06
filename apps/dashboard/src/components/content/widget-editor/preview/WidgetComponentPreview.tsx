import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { WidgetMountState } from "@tilecast/widget-sdk/mount";
import type { ContentDefinitionField } from "@/api/types";
import type { StudioWidgetComponent } from "@/content/studioWidgets";
import type { PreviewTime } from "@/content/previewTime";
import {
  WidgetPreviewHost,
  type PreviewFrame,
} from "@/content/WidgetPreviewHost";
import { useComponentPreview } from "./useComponentPreview";
import type { PreviewStatus } from "./previewStatus";

/**
 * The draft rendered by the real Widget component, the same element the
 * Player mounts. There is no Studio-only renderer behind it.
 */
export function WidgetComponentPreview({
  component,
  fields,
  configuration,
  managedDataSourceId,
  previewTime,
  frame,
  scale,
  onStatus,
}: {
  component: StudioWidgetComponent;
  fields: readonly ContentDefinitionField[];
  configuration: Record<string, unknown>;
  managedDataSourceId?: string;
  previewTime: PreviewTime;
  frame: PreviewFrame;
  scale: number;
  onStatus: (status: PreviewStatus) => void;
}) {
  const { t } = useTranslation("content");
  const preview = useComponentPreview({
    component,
    fields,
    configuration,
    managedDataSourceId,
    previewTime,
  });
  const [mount, setMount] = useState<WidgetMountState>({ state: "pending" });

  const status: PreviewStatus = !preview.ready
    ? { kind: "loading" }
    : preview.sourcesFailed
      ? { kind: "error", message: t("widgets.editor.preview.sourceFailed") }
      : preview.compileProblem
        ? {
            kind: "error",
            message: t("widgets.editor.preview.configurationProblem"),
            detail: preview.compileProblem,
          }
        : preview.sourcesLoading
          ? { kind: "waiting" }
          : mount.state === "error"
            ? {
                kind: "error",
                message: t("widgets.editor.preview.renderFailed"),
                detail: mount.code,
              }
            : mount.state === "empty"
              ? {
                  kind: "empty",
                  message:
                    mount.reason === "no_source"
                      ? t("widgets.editor.preview.emptyNoSource")
                      : t("widgets.editor.preview.empty"),
                }
              : mount.state === "pending"
                ? { kind: "loading" }
                : { kind: "ready" };
  const statusKey = JSON.stringify(status);
  useEffect(() => {
    onStatus(JSON.parse(statusKey) as PreviewStatus);
  }, [statusKey, onStatus]);

  if (!preview.ready || !preview.componentRef) return null;
  return (
    <WidgetPreviewHost
      component={preview.componentRef}
      resources={preview.resources}
      context={preview.context}
      frame={frame}
      scale={scale}
      label={t("widgets.editor.preview.frameLabel")}
      onState={setMount}
    />
  );
}
