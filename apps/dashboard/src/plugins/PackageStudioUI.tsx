import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { callStudioBridge } from "../api/domains/fleet";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";

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
const resizeKind = "studio-resize";
const maxBridgeInputChars = 24 * 1024;

/**
 * The frame's height in CSS pixels. It starts at a modest default, follows
 * the height the page reports over its port, and never leaves this range:
 * a page taller than the maximum scrolls inside the frame instead of
 * pushing the rest of Studio away.
 */
export const studioFrameHeight = { initial: 280, min: 200, max: 680 } as const;

/** The largest report treated as a measurement at all; beyond it is noise. */
const maxReportedHeight = 100_000;

export function clampStudioHeight(height: number) {
  return Math.min(
    studioFrameHeight.max,
    Math.max(studioFrameHeight.min, Math.round(height)),
  );
}

/**
 * A resize report: the frame page tells the parent how tall its content
 * wants to be. Only this exact shape counts, and only a finite positive
 * number within a sane bound; anything else is ignored rather than
 * clamped, so a malformed message cannot move the layout at all.
 */
export function parseStudioResize(data: unknown): number | null {
  if (typeof data !== "object" || data === null) return null;
  const message = data as Record<string, unknown>;
  const keys = Object.keys(message);
  if (keys.length !== 3) return null;
  if (message.source !== bridgeSource || message.kind !== resizeKind) {
    return null;
  }
  const height = message.height;
  if (typeof height !== "number" || !Number.isFinite(height)) return null;
  if (height <= 0 || height > maxReportedHeight) return null;
  return height;
}

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
  const [height, setHeight] = useState<number>(studioFrameHeight.initial);

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
      const resize = parseStudioResize(event.data);
      if (resize !== null) {
        setHeight(clampStudioHeight(resize));
        return;
      }
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
    <Card role="region" aria-labelledby="package-settings-title">
      <CardHeader>
        <CardTitle
          id="package-settings-title"
          role="heading"
          aria-level={2}
          className="text-lg"
        >
          {t("storeDetail.settings.title")}
        </CardTitle>
        <CardDescription>
          {t("storeDetail.settings.description")}
        </CardDescription>
      </CardHeader>
      <CardContent>
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
            style={{ height }}
            className="w-full rounded-lg bg-background ring-1 ring-foreground/10 transition-[height] duration-200 motion-reduce:transition-none"
          />
        )}
      </CardContent>
    </Card>
  );
}
