import { useTranslation } from "react-i18next";
import { DeclarativePresentationPreview } from "@/content/SourceEditors";
import type { PreviewFrame } from "@/content/WidgetPreviewHost";
import type { WebPreviewSurface } from "./useWebIntegrationPreview";

/**
 * A web integration previews the page itself in the same sandboxed frame
 * Studio uses everywhere else. Screens show it through their isolated
 * player view; Studio never loosens that isolation to preview it.
 */
export function WebIntegrationPreview({
  surface,
  frame,
  scale,
}: {
  surface: WebPreviewSurface | null;
  frame: PreviewFrame;
  scale: number;
}) {
  const { t } = useTranslation("content");
  if (!surface) return null;
  return (
    <div
      role="img"
      aria-label={t("widgets.editor.preview.frameLabel")}
      className="relative overflow-hidden bg-black"
      style={{ width: frame.width * scale, height: frame.height * scale }}
    >
      <div
        className="declarative-widget-preview"
        style={{
          width: frame.width,
          height: frame.height,
          transform: `scale(${scale})`,
          transformOrigin: "top left",
        }}
      >
        {surface.kind === "thumbnail" ? (
          <img src={surface.url} alt="" className="size-full object-cover" />
        ) : (
          <DeclarativePresentationPreview
            presentation={surface.presentation}
            source={undefined}
          />
        )}
      </div>
    </div>
  );
}
