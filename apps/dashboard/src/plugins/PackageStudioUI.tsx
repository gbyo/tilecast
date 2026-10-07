import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { callStudioBridge } from "../api/domains/fleet";

/**
 * The bridge call one sandboxed Studio UI frame sends over its port: a
 * correlation id and the base64 guest input. Anything else is ignored.
 * The 24 KiB ceiling covers the 16 KiB call window encoded.
 */
export type StudioBridgeCall = {
  id: string;
  input: string;
};

const bridgeSource = "tilecast-studio-ui";
const helloKind = "studio-hello";
const handshakeKind = "studio-handshake";
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

/** The frame page's announcement before it holds the port. */
export function isStudioHello(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const hello = data as Record<string, unknown>;
  return hello.source === bridgeSource && hello.kind === helloKind;
}

/**
 * The sandboxed Studio UI host: the package entry page in an
 * opaque-origin allow-scripts iframe, plus the bridge relay. The frame
 * holds no credentials, so the parent carries the dashboard session and
 * CSRF token for every guest call.
 *
 * Calls cross a MessageChannel bound to the original frame document,
 * never the shared window bus. The page announces its document with a
 * hello; the parent answers once with the frame's port. A reload or
 * navigation destroys the document's port, and the parent never sends
 * the channel to a newly loaded document: the connection dies with the
 * document it was bound to, and the host reports the interface
 * unavailable. Transport failures answer the frame with status -1 and
 * a bridge_failed error the package page renders.
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
    const channel = new MessageChannel();
    let handshake = false;
    let loadCount = 0;
    let alive = true;

    const die = () => {
      if (!alive) return;
      alive = false;
      // The handshake stays spent: a hello from the replacement
      // document must not mint a fresh channel for it.
      handshake = true;
      channel.port1.onmessage = null;
      channel.port1.close();
      setFailed(true);
    };

    channel.port1.onmessage = (event: MessageEvent) => {
      if (!alive) return;
      const call = parseStudioBridgeCall(event.data);
      if (!call) return;
      const port = channel.port1;
      void (async () => {
        try {
          const answer = await callStudioBridge(
            packageId,
            call.input,
            csrfToken,
          );
          port.postMessage({
            source: bridgeSource,
            id: call.id,
            status: answer.status,
            output: answer.output,
          });
        } catch {
          port.postMessage({
            source: bridgeSource,
            id: call.id,
            status: -1,
            output: "",
            error: "bridge_failed",
          });
        }
      })();
    };

    const onMessage = (event: MessageEvent) => {
      if (!alive || handshake) return;
      const frame = frameRef.current;
      if (!frame || event.source === null) return;
      if (event.source !== frame.contentWindow) return;
      // The served entry runs opaque, so a legitimate hello carries the
      // origin "null"; a navigated document reports its own origin.
      if (event.origin !== "null") return;
      if (!isStudioHello(event.data)) return;
      handshake = true;
      // The platform only delivers to an opaque target with "*": the
      // hello checks above already authenticated this single-shot
      // transfer, and every later message travels the port instead.
      event.source.postMessage(
        { source: bridgeSource, kind: handshakeKind },
        "*",
        [channel.port2],
      );
    };
    const onLoad = () => {
      // The initial navigation fires exactly one load. A second load
      // means the original document went away, so the connection dies
      // with it instead of binding a stranger.
      loadCount += 1;
      if (loadCount > 1) die();
    };
    const frame = frameRef.current;
    frame?.addEventListener("load", onLoad);
    window.addEventListener("message", onMessage);
    return () => {
      alive = false;
      channel.port1.onmessage = null;
      channel.port1.close();
      frame?.removeEventListener("load", onLoad);
      window.removeEventListener("message", onMessage);
    };
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
