import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { WidgetPresentation } from "@/api/types";
import { DeclarativePresentationPreview } from "@/content/SourceEditors";
import type { PreviewFrame } from "@/content/WidgetPreviewHost";
import { apiErrorMessage } from "@/i18n";
import { stableSerialize } from "../widgetEditorModel";
import type { PreviewStatus } from "./previewStatus";
import { webPreviewConfiguration } from "./webPreviewConfiguration";

// Web previews need a Server round trip, so typing an address waits for a
// pause instead of compiling every keystroke.
const COMPILE_DELAY_MS = 500;

function useDebounced<T>(value: T, delay: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setSettled(value), delay);
    return () => window.clearTimeout(timer);
  }, [value, delay]);
  return settled;
}

/**
 * A web integration previews the page itself in the same sandboxed frame
 * Studio uses everywhere else. Screens show it through their isolated
 * player view; Studio never loosens that isolation to preview it.
 */
export function WebIntegrationPreview({
  provider,
  configuration,
  csrf,
  canCompile,
  savedThumbnailUrl,
  frame,
  scale,
  onStatus,
}: {
  provider: string;
  configuration: Record<string, unknown>;
  csrf: string;
  /** Compiling a preview needs permission to edit Widgets. */
  canCompile: boolean;
  savedThumbnailUrl?: string;
  frame: PreviewFrame;
  scale: number;
  onStatus: (status: PreviewStatus) => void;
}) {
  const { t } = useTranslation("content");
  const previewConfiguration = useMemo(
    () => webPreviewConfiguration(provider, configuration),
    [provider, configuration],
  );
  const settledKey = useDebounced(
    stableSerialize(previewConfiguration),
    COMPILE_DELAY_MS,
  );
  const compiled = useQuery({
    queryKey: ["compiled-widget-preview", provider, settledKey],
    queryFn: () =>
      api.compileWidgetPreview(provider, JSON.parse(settledKey) as never, csrf),
    enabled: canCompile,
    retry: false,
  });
  // The last page that compiled stays in view while a new address is
  // typed or turns out to be invalid.
  const lastGood = useRef<WidgetPresentation | null>(null);
  if (compiled.data) lastGood.current = compiled.data;
  const presentation = lastGood.current;

  const status: PreviewStatus = !canCompile
    ? savedThumbnailUrl
      ? { kind: "ready" }
      : {
          kind: "unavailable",
          message: t("widgets.editor.preview.webViewOnly"),
        }
    : compiled.isError
      ? {
          kind: "error",
          message: t("widgets.editor.preview.webInvalid"),
          detail: apiErrorMessage(compiled.error),
        }
      : compiled.isPending
        ? { kind: "loading" }
        : !presentation
          ? {
              kind: "unavailable",
              message: t("widgets.editor.preview.webUnavailable"),
            }
          : { kind: "ready" };
  const statusKey = JSON.stringify(status);
  useEffect(() => {
    onStatus(JSON.parse(statusKey) as PreviewStatus);
  }, [statusKey, onStatus]);

  const surface = (content: React.ReactNode) => (
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
        {content}
      </div>
    </div>
  );

  if (!canCompile)
    return savedThumbnailUrl
      ? surface(
          <img
            src={savedThumbnailUrl}
            alt=""
            className="size-full object-cover"
          />,
        )
      : null;
  if (!presentation) return null;
  return surface(
    <DeclarativePresentationPreview
      presentation={presentation}
      source={undefined}
    />,
  );
}
