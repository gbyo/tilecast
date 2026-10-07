import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { callStudioBridge } from "../api/domains/fleet";

/**
 * The bridge call one sandboxed Studio UI frame posts to its parent:
 * a correlation id and the base64 guest input. Anything else is
 * ignored. The 24 KiB ceiling covers the 16 KiB call window encoded.
 */
export type StudioBridgeCall = {
  id: string;
  input: string;
};

const bridgeSource = "tilecast-studio-ui";
const maxBridgeInputChars = 24 * 1024;

export function parseStudioBridgeCall(data: unknown): StudioBridgeCall | null {
  if (typeof data !== "object" || data === null) return null;
  const call = data as Record<string, unknown>;
  if (call.source !== bridgeSource) return null;
  if (typeof call.id !== "string" || call.id === "" || call.id.length > 128) {
    return null;
  }
  if (
    typeof call.input !== "string" ||
    call.input.length > maxBridgeInputChars
  ) {
    return null;
  }
  return { id: call.id, input: call.input };
}

/**
 * The sandboxed Studio UI host: the package entry page in an
 * opaque-origin allow-scripts iframe, plus the bridge relay. The frame
 * holds no credentials, so the parent carries the dashboard session and
 * CSRF token for every guest call. Messages are accepted only from the
 * hosted frame's own window; the reply origin stays "*" because an
 * opaque origin cannot be named. Transport failures answer the frame
 * with status -1 and a bridge_failed error the package page renders.
 */
export function PackageStudioUI({
  packageId,
  csrfToken,
}: {
  packageId: string;
  csrfToken: string;
}) {
  const { t } = useTranslation("plugins");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (!frame || event.source !== frame.contentWindow) return;
      const call = parseStudioBridgeCall(event.data);
      if (!call) return;
      const target = frame.contentWindow;
      void (async () => {
        try {
          const answer = await callStudioBridge(
            packageId,
            call.input,
            csrfToken,
          );
          target?.postMessage(
            {
              source: bridgeSource,
              id: call.id,
              status: answer.status,
              output: answer.output,
            },
            "*",
          );
        } catch {
          target?.postMessage(
            {
              source: bridgeSource,
              id: call.id,
              status: -1,
              output: "",
              error: "bridge_failed",
            },
            "*",
          );
        }
      })();
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [packageId, csrfToken]);

  return (
    <section aria-label={t("packages.studioTitle")} className="grid gap-3">
      <h3 className="text-sm font-semibold">{t("packages.studioTitle")}</h3>
      {failed ? (
        <p className="text-sm text-muted-foreground">
          {t("packages.studioUnavailable")}
        </p>
      ) : (
        <iframe
          ref={frameRef}
          src={`/api/v1/packages/${encodeURIComponent(packageId)}/studio/frame`}
          sandbox="allow-scripts"
          title={t("packages.studioTitle")}
          onError={() => setFailed(true)}
          className="h-96 w-full rounded-xl border"
        />
      )}
    </section>
  );
}
