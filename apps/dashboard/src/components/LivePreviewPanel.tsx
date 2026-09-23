import { useMutation, useQuery } from "@tanstack/react-query";
import {
  AlertTriangle,
  Clock3,
  ImageOff,
  Monitor,
  RefreshCw,
  ShieldAlert,
  ShieldCheck,
  Video,
  WifiOff,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { api } from "../api/client";
import { previewApi } from "../api/previews";
import { useAuth } from "../auth/AuthProvider";
import { LiveStreamDialog } from "./LiveStreamDialog";
import { Button } from "./ui";
import {
  livePreviewState,
  previewAge,
  previewUnavailableMessage,
} from "./livePreviewState";
import "./LivePreviewPanel.css";

const LEASE_RENEWAL_MILLIS = 30_000;
const METADATA_REFRESH_MILLIS = 5_000;

type LivePreviewDisplayState =
  | ReturnType<typeof livePreviewState>
  | "image-error";

export function LivePreviewPanel({ screenId }: { screenId: string }) {
  const auth = useAuth();
  const [renewalError, setRenewalError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [watchingLive, setWatchingLive] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const screen = useQuery({
    queryKey: ["screens", screenId],
    queryFn: () => api.screen(screenId),
    refetchInterval: 15_000,
  });
  const preview = useQuery({
    queryKey: ["screen-preview", screenId],
    queryFn: () => previewApi.metadata(screenId),
    refetchInterval: METADATA_REFRESH_MILLIS,
    retry: false,
  });
  const csrfToken = auth.status?.csrfToken;

  useEffect(() => {
    if (!csrfToken) return;
    let active = true;
    const renew = async (forceCapture: boolean) => {
      try {
        await previewApi.renew(screenId, csrfToken, forceCapture);
        if (active) setRenewalError(null);
      } catch (error) {
        if (active)
          setRenewalError(
            error instanceof Error ? error.message : "Preview session failed.",
          );
      }
    };
    void renew(true);
    const interval = window.setInterval(
      () => void renew(false),
      LEASE_RENEWAL_MILLIS,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [csrfToken, screenId]);

  const manualRefresh = useMutation({
    mutationFn: async () => {
      if (!csrfToken) throw new Error("Your Studio session has expired.");
      await previewApi.renew(screenId, csrfToken, true);
    },
    onSuccess: async () => {
      setRenewalError(null);
      await preview.refetch();
    },
  });

  const state = livePreviewState(screen.data, preview.data);
  const imageUrl = useMemo(() => {
    if (!preview.data?.imageAvailable) return null;
    return previewApi.imageUrl(screenId, preview.data.updatedAt);
  }, [preview.data?.imageAvailable, preview.data?.updatedAt, screenId]);

  useEffect(() => {
    setImageLoadFailed(false);
  }, [imageUrl]);

  const displayState: LivePreviewDisplayState =
    imageLoadFailed && imageUrl ? "image-error" : state;
  const frameState =
    displayState === "image-error" ? "capture-error" : displayState;
  const capturedAt = preview.data?.capturedAt
    ? new Date(preview.data.capturedAt)
    : null;
  const captureAge = preview.data?.capturedAt
    ? previewAge(preview.data.capturedAt, now)
    : null;

  useEffect(() => {
    if (!preview.data?.capturedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [preview.data?.capturedAt]);

  return (
    <aside className="live-preview-panel" aria-label="Live preview">
      <header className="live-preview-panel__header">
        <div>
          <span className="live-preview-panel__eyebrow">On demand</span>
          <h2>Live preview</h2>
        </div>
        <div className="live-preview-panel__actions">
          <Button
            compact
            variant="quiet"
            onClick={() => manualRefresh.mutate()}
            loading={manualRefresh.isPending}
          >
            <RefreshCw size={15} aria-hidden="true" />
            Refresh
          </Button>
          <Button
            compact
            onClick={() => setWatchingLive(true)}
            disabled={screen.data?.status !== "online" || !csrfToken}
          >
            <Video size={15} aria-hidden="true" />
            Watch live
          </Button>
        </div>
      </header>

      <div className={`live-preview-frame live-preview-frame--${frameState}`}>
        {!imageLoadFailed &&
        (state === "live" || state === "stale") &&
        imageUrl ? (
          <img
            src={imageUrl}
            alt={`Current Tilecast output for ${screen.data?.name ?? "screen"}`}
            onError={() => setImageLoadFailed(true)}
          />
        ) : (
          <PreviewState
            state={displayState}
            failureStatus={preview.data?.captureFailureStatus}
          />
        )}
        {imageUrl && !imageLoadFailed && captureAge && (
          <span
            className={`live-preview-frame__banner live-preview-frame__banner--${captureAge.tone}`}
            title={
              capturedAt ? `Captured ${capturedAt.toLocaleString()}` : undefined
            }
          >
            {captureAge.label}
          </span>
        )}
      </div>

      <div className="live-preview-panel__status" aria-live="polite">
        <strong>{stateLabel(displayState)}</strong>
        <span>{stateDescription(displayState, renewalError)}</span>
      </div>

      <dl className="live-preview-panel__meta">
        <div>
          <dt>Last capture</dt>
          <dd>{capturedAt ? capturedAt.toLocaleString() : "Not captured"}</dd>
        </div>
        <div>
          <dt>Player</dt>
          <dd>
            {preview.data?.playerVersion ||
              screen.data?.playerVersion ||
              "Unknown"}
          </dd>
        </div>
        <div>
          <dt>Image</dt>
          <dd>
            {preview.data?.width && preview.data?.height
              ? `${preview.data.width}×${preview.data.height} · ${formatBytes(preview.data.fileSize ?? 0)}`
              : "No image"}
          </dd>
        </div>
      </dl>
      <div className="live-preview-panel__privacy">
        <ShieldCheck size={15} aria-hidden="true" />
        <span>Protected screens are not captured.</span>
      </div>
      {csrfToken && (
        <LiveStreamDialog
          open={watchingLive}
          screenId={screenId}
          screenName={screen.data?.name ?? "Screen"}
          csrfToken={csrfToken}
          onClose={() => setWatchingLive(false)}
        />
      )}
    </aside>
  );
}

function PreviewState({
  state,
  failureStatus,
}: {
  state: LivePreviewDisplayState;
  failureStatus?: string;
}) {
  const content = {
    loading: [Clock3, "Requesting a fresh capture…"],
    offline: [WifiOff, "The player is offline."],
    stale: [Clock3, "The latest preview is stale."],
    unavailable: [ShieldAlert, previewUnavailableMessage(failureStatus)],
    "capture-error": [
      AlertTriangle,
      "The player could not capture its window.",
    ],
    "image-error": [ImageOff, "The preview image could not be loaded."],
    live: [Monitor, "Live preview is ready."],
  } as const;
  const [Icon, message] = content[state] ?? [ImageOff, "Preview unavailable."];
  return (
    <div className="live-preview-frame__empty">
      <Icon size={28} aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function stateLabel(state: LivePreviewDisplayState) {
  return {
    loading: "Loading",
    live: "Live",
    offline: "Offline",
    stale: "Stale",
    unavailable: "Unavailable",
    "capture-error": "Capture error",
    "image-error": "Image unavailable",
  }[state];
}

function stateDescription(
  state: LivePreviewDisplayState,
  renewalError: string | null,
) {
  if (renewalError) return renewalError;
  return {
    loading: "Waiting for the paired player to respond.",
    live: "Refreshes about every 20 seconds while this page is open.",
    offline: "The session will resume when the player reconnects.",
    stale: "The player has not delivered a recent capture.",
    unavailable: "The current player screen cannot be previewed.",
    "capture-error": "Use Refresh to request another capture.",
    "image-error": "Use Refresh to request another preview image.",
  }[state];
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
