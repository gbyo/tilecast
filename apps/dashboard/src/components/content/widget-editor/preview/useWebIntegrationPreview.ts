/**
 * A web integration previews through the Server's presentation compiler,
 * which turns its configuration into the address a sandboxed frame loads.
 * The last page that compiled stays in view while a new address is typed
 * or turns out to be invalid; the problem is reported separately.
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/api/client";
import type { WidgetPresentation } from "@/api/types";
import { apiErrorMessage } from "@/i18n";
import { stableSerialize } from "../widgetEditorModel";
import { webPreviewStatus } from "./previewStatus";
import { useLastGood } from "./useLastGood";
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

export type WebPreviewSurface =
  | { readonly kind: "presentation"; readonly presentation: WidgetPresentation }
  | { readonly kind: "thumbnail"; readonly url: string };

export function useWebIntegrationPreview({
  provider,
  configuration,
  csrf,
  canCompile,
  savedThumbnailUrl,
}: {
  provider: string;
  configuration: Record<string, unknown>;
  csrf: string;
  /** Compiling a preview needs permission to edit Widgets. */
  canCompile: boolean;
  savedThumbnailUrl?: string;
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
  const presentation = useLastGood(compiled.data ?? null);

  const status = webPreviewStatus(
    {
      canCompile,
      hasSavedThumbnail: Boolean(savedThumbnailUrl),
      isPending: compiled.isPending,
      errorDetail: compiled.isError
        ? apiErrorMessage(compiled.error)
        : undefined,
      hasPresentation: presentation !== null,
    },
    t,
  );
  const surface: WebPreviewSurface | null = !canCompile
    ? savedThumbnailUrl
      ? { kind: "thumbnail", url: savedThumbnailUrl }
      : null
    : presentation
      ? { kind: "presentation", presentation }
      : null;
  return { status, surface };
}
