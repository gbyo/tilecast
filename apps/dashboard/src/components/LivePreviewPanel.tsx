import { screenQueries } from "../data/screens";

import { formatBytes } from "../lib/formatBytes";
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
import { useScreenPreviewSession } from "./useScreenPreviewSession";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { api } from "../api/client";
import { useAuth } from "../auth/AuthProvider";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import { useOpenNativePresentation } from "../native-presentation/openNativePresentation";
import {
  LiveStreamDialog,
  liveStreamPresentationPath,
} from "./LiveStreamDialog";
import { Button } from "./ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./ui/card";
import {
  livePreviewState,
  previewAge,
  previewUnavailableMessage,
} from "./livePreviewState";

const METADATA_REFRESH_MILLIS = 5_000;
type LivePreviewDisplayState =
  ReturnType<typeof livePreviewState> | "image-error";

const captureAgeToneClasses = {
  fresh: "bg-emerald-500/15 text-emerald-800 dark:text-emerald-300",
  aging: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
  old: "bg-destructive/10 text-destructive",
} as const;

export function LivePreviewPanel({
  screenId,
  onOpenHistory,
}: {
  screenId: string;
  onOpenHistory?: () => void;
}) {
  const auth = useAuth();
  const { t } = useTranslation(["screens", "common", "alerts"]);
  const formatLocale = useFormatLocale();
  const openNativePresentation = useOpenNativePresentation();
  const [manualRefreshError, setManualRefreshError] = useState<string | null>(
    null,
  );
  const [now, setNow] = useState(Date.now);
  const [watchingLive, setWatchingLive] = useState(false);
  const [imageLoadFailed, setImageLoadFailed] = useState(false);
  const screen = useQuery({
    ...screenQueries.detail(screenId),
    refetchInterval: 15_000,
  });
  const preview = useQuery({
    ...screenQueries.preview(screenId),
    refetchInterval: METADATA_REFRESH_MILLIS,
    retry: false,
  });
  const csrfToken = auth.status?.csrfToken;
  const screenName = screen.data?.name ?? t("livePreview.unnamedScreen");

  // A native host presents the stream in its own sheet; otherwise, and
  // always in a browser, Studio's dialog shows it.
  const watchLive = async () => {
    const presented = await openNativePresentation({
      path: liveStreamPresentationPath(screenId),
      title: t("alerts:liveStream.title", { name: screenName }),
      size: "full",
    });
    if (!presented) setWatchingLive(true);
  };

  const previewEnabled =
    Boolean(csrfToken) &&
    screen.data?.status !== "offline" &&
    screen.data?.status !== "disabled" &&
    screen.data?.status !== "revoked";
  const protectedPreview =
    preview.data?.captureFailureStatus?.startsWith("sensitive_") ?? false;
  const { error: renewalError } = useScreenPreviewSession({
    screenId,
    csrfToken,
    enabled: previewEnabled,
    capturedAt: preview.data?.capturedAt,
    protectedPreview,
  });

  const manualRefresh = useMutation({
    mutationFn: async () => {
      if (!csrfToken) throw new Error(t("livePreview.sessionFailed"));
      await api.renewScreenPreview(screenId, true, csrfToken);
    },
    onSuccess: async () => {
      setManualRefreshError(null);
      await preview.refetch();
    },
    onError: (error) => {
      setManualRefreshError(
        error instanceof Error
          ? apiErrorMessage(error)
          : t("livePreview.sessionFailed"),
      );
    },
  });

  const state = livePreviewState(screen.data, preview.data);
  const imageUrl = useMemo(() => {
    if (!preview.data?.imageAvailable) return null;
    return api.screenPreviewImageUrl(
      screenId,
      preview.data.capturedAt ?? preview.data.updatedAt,
    );
  }, [
    preview.data?.capturedAt,
    preview.data?.imageAvailable,
    preview.data?.updatedAt,
    screenId,
  ]);

  useEffect(() => {
    setImageLoadFailed(false);
  }, [preview.data?.capturedAt]);

  const displayState: LivePreviewDisplayState =
    imageLoadFailed && imageUrl && (state === "live" || state === "stale")
      ? "image-error"
      : state;
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
    <Card
      role="complementary"
      aria-label={t("livePreview.title")}
      className="min-w-0"
    >
      <CardHeader>
        <CardTitle>{t("livePreview.title")}</CardTitle>
        <CardDescription>{t("livePreview.onDemand")}</CardDescription>
        <CardAction className="col-span-full row-start-auto mt-2 flex flex-wrap justify-start gap-2 sm:col-start-2 sm:row-span-2 sm:row-start-1 sm:mt-0 sm:justify-self-end">
          {onOpenHistory && (
            <Button size="sm" variant="ghost" onClick={onOpenHistory}>
              <Clock3 aria-hidden="true" />
              {t("preview.snapshotsTitle")}
            </Button>
          )}
          <Button
            size="sm"
            variant="outline"
            onClick={() => manualRefresh.mutate()}
            disabled={manualRefresh.isPending || !csrfToken}
          >
            <RefreshCw aria-hidden="true" />
            {manualRefresh.isPending
              ? t("common:actions.refreshing")
              : t("common:actions.refresh")}
          </Button>
          <Button
            size="sm"
            onClick={() => void watchLive()}
            disabled={screen.data?.status !== "online" || !csrfToken}
          >
            <Video aria-hidden="true" />
            {t("livePreview.watchLive")}
          </Button>
        </CardAction>
      </CardHeader>

      <CardContent className="min-w-0">
        <div className="relative grid aspect-video overflow-hidden rounded-xl border border-border bg-[#080b0f]">
          {!imageLoadFailed &&
          (state === "live" || state === "stale") &&
          imageUrl ? (
            <img
              className="size-full bg-black object-contain"
              src={imageUrl}
              alt={t("livePreview.imageAlt", {
                name: screen.data?.name ?? t("livePreview.unknownScreen"),
              })}
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
            {t(stateLabelKeys[displayState])}
          </strong>
          <span className="text-sm text-muted-foreground">
            {stateDescription(
              displayState,
              manualRefreshError ?? (renewalError ? apiErrorMessage(renewalError) : null),
              t,
            )}
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
                ? `${preview.data.width}×${preview.data.height} · ${formatBytes(
                    preview.data.fileSize,
                    formatLocale,
                  )}`
                : t("livePreview.noImage")}
            </dd>
          </div>
        </dl>
      </CardContent>

      <CardFooter className="border-t text-xs text-muted-foreground">
        <ShieldCheck
          className="size-4 text-emerald-700 dark:text-emerald-400"
          aria-hidden="true"
        />
        <span className="ms-2">{t("livePreview.protectedNote")}</span>
      </CardFooter>
      {csrfToken && (
        <LiveStreamDialog
          open={watchingLive}
          screenId={screenId}
          screenName={screenName}
          csrfToken={csrfToken}
          onClose={() => setWatchingLive(false)}
        />
      )}
    </Card>
  );
}

const stateLabelKeys = {
  loading: "livePreview.states.loading.label",
  live: "livePreview.states.live.label",
  offline: "livePreview.states.offline.label",
  stale: "livePreview.states.stale.label",
  unavailable: "livePreview.states.unavailable.label",
  "capture-error": "livePreview.states.captureError.label",
  "image-error": "livePreview.states.imageError.label",
} as const;

const stateDescriptionKeys = {
  loading: "livePreview.states.loading.description",
  live: "livePreview.states.live.description",
  offline: "livePreview.states.offline.description",
  stale: "livePreview.states.stale.description",
  unavailable: "livePreview.states.unavailable.description",
  "capture-error": "livePreview.states.captureError.description",
  "image-error": "livePreview.states.imageError.description",
} as const;

function PreviewState({
  state,
  failureStatus,
}: {
  state: LivePreviewDisplayState;
  failureStatus?: string;
}) {
  const { t } = useTranslation("screens");
  const content = {
    loading: [Clock3, "livePreview.overlay.loading"],
    offline: [WifiOff, "livePreview.overlay.offline"],
    stale: [Clock3, "livePreview.overlay.stale"],
    unavailable: [ShieldAlert, null],
    "capture-error": [AlertTriangle, "livePreview.overlay.captureError"],
    "image-error": [ImageOff, "livePreview.overlay.imageError"],
    live: [Monitor, "livePreview.overlay.live"],
  } as const;
  const [Icon, messageKey] = content[state] ?? [
    ImageOff,
    "livePreview.overlay.unknown",
  ];
  const stateClasses =
    state === "capture-error" || state === "image-error"
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
  state: LivePreviewDisplayState,
  renewalError: string | null,
  t: TFunction<["screens", "common"]>,
) {
  if (renewalError) return renewalError;
  return t(stateDescriptionKeys[state]);
}
