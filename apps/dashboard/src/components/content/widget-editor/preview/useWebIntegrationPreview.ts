/**
 * A web integration previews through the Server's presentation compiler,
 * which turns its configuration into the address a sandboxed frame loads.
 * Most integrations retain the last compiled page while editing. Canva
 * clears it so a previous design cannot appear to validate a new link.
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
  urlField = "url",
}: {
  provider: string;
  configuration: Record<string, unknown>;
  csrf: string;
  /** Compiling a preview needs permission to edit Widgets. */
  canCompile: boolean;
  savedThumbnailUrl?: string;
  /** The configuration key that holds the address (webIntegration.urlField). */
  urlField?: string;
}) {
  const { t } = useTranslation("content");
  // Without an address there is nothing to compile; asking the Server would
  // only produce an internal error the author cannot act on.
  const address = configuration[urlField];
  const hasAddress = typeof address === "string" && address.trim() !== "";
  const previewConfiguration = useMemo(
    () => webPreviewConfiguration(provider, configuration),
    [provider, configuration],
  );
  const currentKey = stableSerialize(previewConfiguration);
  const settledKey = useDebounced(currentKey, COMPILE_DELAY_MS);
  const isCanva = provider === "canva";
  const isCurrent = currentKey === settledKey;
  const compiled = useQuery({
    queryKey: ["compiled-widget-preview", provider, settledKey],
    queryFn: () =>
      api.compileWidgetPreview(provider, JSON.parse(settledKey) as never, csrf),
    enabled: canCompile && hasAddress && (!isCanva || isCurrent),
    retry: false,
  });
  const lastGood = useLastGood(compiled.data ?? null);
  // A previous Canva design must not appear to validate the newly pasted URL.
  const presentation = isCanva
    ? isCurrent && hasAddress
      ? (compiled.data ?? null)
      : null
    : lastGood;

  const [blockedKey, setBlockedKey] = useState<string | null>(null);
  useEffect(() => {
    if (!isCanva) return;
    const onViolation = (event: SecurityPolicyViolationEvent) => {
      if (
        event.disposition !== "enforce" ||
        !["frame-src", "child-src", "default-src"].includes(
          event.effectiveDirective,
        )
      )
        return;
      // Cross-origin CSP reports can omit the path and query. Compare origins
      // without publishing the design's access parameters in diagnostics.
      try {
        if (new URL(event.blockedURI).origin === "https://www.canva.com")
          setBlockedKey(currentKey);
      } catch {
        /* A non-URL report cannot identify this preview. */
      }
    };
    document.addEventListener("securitypolicyviolation", onViolation);
    return () =>
      document.removeEventListener("securitypolicyviolation", onViolation);
  }, [isCanva, currentKey]);
  const restricted = isCanva && canCompile && blockedKey === currentKey;

  let status = webPreviewStatus(
    {
      canCompile,
      hasAddress,
      hasSavedThumbnail: Boolean(savedThumbnailUrl),
      isPending: compiled.isPending || (isCanva && !isCurrent),
      errorDetail:
        compiled.isError && (!isCanva || isCurrent)
          ? apiErrorMessage(compiled.error)
          : undefined,
      hasPresentation: presentation !== null,
    },
    t,
  );
  if (isCanva && status.kind === "ready" && canCompile) {
    status = {
      kind: "unverified",
      message: t("widgets.editor.preview.canvaUnverified"),
    };
  }
  if (restricted && status.kind === "unverified") {
    status = {
      kind: "unavailable",
      message: t("widgets.editor.preview.canvaRestricted"),
    };
  }
  const surface: WebPreviewSurface | null = restricted
    ? null
    : !canCompile
      ? savedThumbnailUrl
        ? { kind: "thumbnail", url: savedThumbnailUrl }
        : null
      : presentation
        ? { kind: "presentation", presentation }
        : null;
  return {
    status,
    surface,
    externalUrl: isCanva ? canvaExternalURL(address) : null,
  };
}

/** Only provider links can become an authoring action, including invalid design paths. */
function canvaExternalURL(value: unknown): string | null {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.trim());
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.port ||
      !["canva.com", "www.canva.com", "canva.link"].includes(url.hostname)
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}
