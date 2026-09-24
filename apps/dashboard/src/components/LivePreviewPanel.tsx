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
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api/client";
import { previewApi } from "../api/previews";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";
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
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
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
            error instanceof Error
              ? error.message
              : t("livePreview.sessionFailed"),
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
  }, [csrfToken, screenId, t]);

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
    ? previewAge(preview.data.capturedAt, now, t)
    : null;

  useEffect(() => {
    if (!preview.data?.capturedAt) return;
    const interval = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(interval);
  }, [preview.data?.capturedAt]);

  return (
    <aside
      className="live-preview-panel grid gap-4 rounded-xl border border-border bg-card p-4"
      aria-label={t("livePreview.title")}
    >
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("livePreview.onDemand")}
          </span>
          <h2 className="mt-0.5 text-base font-semibold">
            {t("livePreview.title")}
          </h2>
        </div>
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => manualRefresh.mutate()}
            disabled={manualRefresh.isPending}
          >
            <RefreshCw aria-hidden="true" />
            {manualRefresh.isPending
              ? t("common:actions.refreshing")
              : t("common:actions.refresh")}
          </Button>
          <Button
            size="sm"
            onClick={() => setWatchingLive(true)}
            disabled={screen.data?.status !== "online" || !csrfToken}
          >
            <Video aria-hidden="true" />
            {t("livePreview.watchLive")}
          </Button>
        </div>
      </header>

      <div className="relative grid aspect-video overflow-hidden rounded-xl border border-border bg-[#080b0f]">
        {(state === "live" || state === "stale") && imageUrl ? (
          <img
            className="size-full bg-black object-contain"
            src={imageUrl}
            alt={t("livePreview.imageAlt", {
              name: screen.data?.name ?? t("livePreview.unknownScreen"),
            })}
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
              capturedAt
                ? t("livePreview.capturedTitle", {
                    date: capturedAt.toLocaleString(formatLocale),
                  })
                : undefined
            }
          >
            {captureAge.label}
          </span>
        )}
      </div>

      <div className="grid gap-1" aria-live="polite">
        <strong className="text-sm font-medium">
          {t(stateLabelKeys[state])}
        </strong>
        <span className="text-sm text-muted-foreground">
          {stateDescription(state, renewalError, t)}
        </span>
      </div>

      <dl className="grid gap-3 border-y border-border py-3 text-xs sm:grid-cols-3">
        <div className="grid gap-1">
          <dt>{t("livePreview.lastCapture")}</dt>
          <dd className="m-0 break-words text-muted-foreground">
            {capturedAt
              ? capturedAt.toLocaleString(formatLocale)
              : t("livePreview.notCaptured")}
          </dd>
        </div>
        <div className="grid gap-1">
          <dt>{t("livePreview.player")}</dt>
          <dd className="m-0 break-words text-muted-foreground">
            {preview.data?.playerVersion ||
              screen.data?.playerVersion ||
              t("shared.unknown")}
          </dd>
        </div>
        <div className="grid gap-1">
          <dt>{t("livePreview.image")}</dt>
          <dd className="m-0 break-words text-muted-foreground">
            {preview.data?.width && preview.data?.height
              ? `${preview.data.width}×${preview.data.height} · ${formatBytes(preview.data.fileSize ?? 0)}`
              : t("livePreview.noImage")}
          </dd>
        </div>
      </dl>
      <div className="flex items-center gap-2 border-t border-border pt-3 text-xs text-muted-foreground">
        <ShieldCheck
          className="size-4 text-emerald-700 dark:text-emerald-400"
          aria-hidden="true"
        />
        <span>{t("livePreview.protectedNote")}</span>
      </div>
      {csrfToken && (
        <LiveStreamDialog
          open={watchingLive}
          screenId={screenId}
          screenName={screen.data?.name ?? t("livePreview.unnamedScreen")}
          csrfToken={csrfToken}
          onClose={() => setWatchingLive(false)}
        />
      )}
    </aside>
  );
}

const stateLabelKeys = {
  loading: "livePreview.states.loading.label",
  live: "livePreview.states.live.label",
  offline: "livePreview.states.offline.label",
  stale: "livePreview.states.stale.label",
  unavailable: "livePreview.states.unavailable.label",
  "capture-error": "livePreview.states.captureError.label",
} as const;

const stateDescriptionKeys = {
  loading: "livePreview.states.loading.description",
  live: "livePreview.states.live.description",
  offline: "livePreview.states.offline.description",
  stale: "livePreview.states.stale.description",
  unavailable: "livePreview.states.unavailable.description",
  "capture-error": "livePreview.states.captureError.description",
} as const;

function PreviewState({
  state,
  failureStatus,
}: {
  state: ReturnType<typeof livePreviewState>;
  failureStatus?: string;
}) {
  const { t } = useTranslation("screens");
  const content = {
    loading: [Clock3, "livePreview.overlay.loading"],
    offline: [WifiOff, "livePreview.overlay.offline"],
    stale: [Clock3, "livePreview.overlay.stale"],
    unavailable: [ShieldAlert, null],
    "capture-error": [AlertTriangle, "livePreview.overlay.captureError"],
    live: [Monitor, "livePreview.overlay.live"],
  } as const;
  const [Icon, messageKey] = content[state] ?? [
    ImageOff,
    "livePreview.overlay.unknown",
  ];
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
      <span>
        {messageKey
          ? t(messageKey)
          : previewUnavailableMessage(failureStatus, t)}
      </span>
    </div>
  );
}

function stateDescription(
  state: ReturnType<typeof livePreviewState>,
  renewalError: string | null,
  t: TFunction<["screens", "common"]>,
) {
  if (renewalError) return renewalError;
  return t(stateDescriptionKeys[state]);
}

function formatBytes(bytes: number) {
  if (!bytes) return "0 KB";
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}
