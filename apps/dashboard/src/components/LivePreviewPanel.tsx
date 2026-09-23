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
import { Button } from "./ui/button";
import {
  livePreviewState,
  previewAge,
  previewUnavailableMessage,
} from "./livePreviewState";

const LEASE_RENEWAL_MILLIS = 30_000;
const METADATA_REFRESH_MILLIS = 5_000;
const captureAgeToneClasses = {
  fresh: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  aging: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  old: "bg-destructive/10 text-destructive",
} as const;

export function LivePreviewPanel({ screenId }: { screenId: string }) {
  const auth = useAuth();
  const [renewalError, setRenewalError] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now);
  const [watchingLive, setWatchingLive] = useState(false);
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
    <aside
      className="live-preview-panel grid gap-4 rounded-xl border border-border bg-card p-4"
      aria-label="Live preview"
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            On demand
          </span>
          <h2 className="mt-0.5 text-base font-semibold">Live preview</h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => manualRefresh.mutate()}
            disabled={manualRefresh.isPending}
          >
            <RefreshCw aria-hidden="true" />
            {manualRefresh.isPending ? "Refreshing…" : "Refresh"}
          </Button>
          <Button
            size="sm"
            onClick={() => setWatchingLive(true)}
            disabled={screen.data?.status !== "online" || !csrfToken}
          >
            <Video aria-hidden="true" />
            Watch live
          </Button>
        </div>
      </header>

      <div className="relative grid aspect-video overflow-hidden rounded-xl border border-border bg-[#080b0f]">
        {(state === "live" || state === "stale") && imageUrl ? (
          <img
            className="size-full bg-black object-contain"
            src={imageUrl}
            alt={`Current Tilecast output for ${screen.data?.name ?? "screen"}`}
          />
        ) : (
          <PreviewState
            state={state}
            failureStatus={preview.data?.captureFailureStatus}
          />
        )}
        {imageUrl && captureAge && (
          <span
            className={`absolute right-2 bottom-2 rounded-md px-2 py-1 text-xs font-semibold ${captureAgeToneClasses[captureAge.tone]}`}
            title={
              capturedAt ? `Captured ${capturedAt.toLocaleString()}` : undefined
            }
          >
            {captureAge.label}
          </span>
        )}
      </div>

      <div className="grid gap-1" aria-live="polite">
        <strong className="text-sm font-medium">{stateLabel(state)}</strong>
        <span className="text-sm text-muted-foreground">
          {stateDescription(state, renewalError)}
        </span>
      </div>

      <dl className="grid gap-3 border-y border-border py-3 text-xs sm:grid-cols-3">
        <div className="grid gap-1">
          <dt>Last capture</dt>
          <dd className="m-0 break-words text-muted-foreground">
            {capturedAt ? capturedAt.toLocaleString() : "Not captured"}
          </dd>
        </div>
        <div className="grid gap-1">
          <dt>Player</dt>
          <dd className="m-0 break-words text-muted-foreground">
            {preview.data?.playerVersion ||
              screen.data?.playerVersion ||
              "Unknown"}
          </dd>
        </div>
        <div className="grid gap-1">
          <dt>Image</dt>
          <dd className="m-0 break-words text-muted-foreground">
            {preview.data?.width && preview.data?.height
              ? `${preview.data.width}×${preview.data.height} · ${formatBytes(preview.data.fileSize ?? 0)}`
              : "No image"}
          </dd>
        </div>
      </dl>
      <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <ShieldCheck
          className="size-4 text-emerald-700 dark:text-emerald-400"
          aria-hidden="true"
        />
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
  state: ReturnType<typeof livePreviewState>;
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
    live: [Monitor, "Live preview is ready."],
  } as const;
  const [Icon, message] = content[state] ?? [ImageOff, "Preview unavailable."];
  const stateClasses =
    state === "capture-error"
      ? "bg-destructive/10 text-destructive"
      : state === "offline" || state === "unavailable"
        ? "bg-muted"
        : "";
  return (
    <div
      className={`grid place-content-center justify-items-center gap-2 p-4 text-center text-muted-foreground ${stateClasses}`}
    >
      <Icon className="size-7" aria-hidden="true" />
      <span>{message}</span>
    </div>
  );
}

function stateLabel(state: ReturnType<typeof livePreviewState>) {
  return {
    loading: "Loading",
    live: "Live",
    offline: "Offline",
    stale: "Stale",
    unavailable: "Unavailable",
    "capture-error": "Capture error",
  }[state];
}

function stateDescription(
  state: ReturnType<typeof livePreviewState>,
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
  }[state];
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
