import { Radio, Video, WifiOff } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { api } from "../api/client";
import { ApiError } from "../api/errors";
import type { WireLiveStreamSession } from "../api/domains/screens";
import { endLiveStreamSession } from "../api/liveStreams";
import { presentationPath } from "../native-presentation/openNativePresentation";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const LEASE_RENEWAL_MILLIS = 3_000;
const FRAME_STALE_MILLIS = 5_000;
const MAX_TRANSPORT_RETRIES = 4;
const MAX_SESSION_RECOVERIES = 4;
const RETRY_BASE_MILLIS = 750;
const RETRY_MAX_MILLIS = 4_000;

type LiveStreamViewerError = "start" | "renew" | "connection" | "replaced";

function retryDelay(attempt: number) {
  return Math.min(RETRY_BASE_MILLIS * 2 ** attempt, RETRY_MAX_MILLIS);
}

/** The native presentation route of a screen's live stream. */
export function liveStreamPresentationPath(screenId: string) {
  return presentationPath("live-stream", screenId);
}

/**
 * A screen's live stream: it starts an ephemeral session while enabled,
 * renews its lease, shows the frames, and ends the session when it is
 * disabled or unmounts. The browser dialog and the native presentation both
 * render it.
 */
export function LiveStreamViewer({
  enabled = true,
  screenId,
  screenName,
  csrfToken,
}: {
  enabled?: boolean;
  screenId: string;
  screenName: string;
  csrfToken: string;
}) {
  const { t } = useTranslation(["alerts", "common"]);
  const [session, setSession] = useState<WireLiveStreamSession | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<LiveStreamViewerError | null>(null);
  const [streamAttempt, setStreamAttempt] = useState(0);
  const sessionRef = useRef<WireLiveStreamSession | null>(null);
  const transportRetryTimer = useRef<number | null>(null);
  const transportRetryCount = useRef(0);
  const lastTransportReconnect = useRef(0);

  const retryTransport = useCallback((immediate = false) => {
    if (!sessionRef.current) return;
    if (transportRetryTimer.current !== null) {
      window.clearTimeout(transportRetryTimer.current);
      transportRetryTimer.current = null;
    }
    const attempt = transportRetryCount.current;
    if (!immediate && attempt >= MAX_TRANSPORT_RETRIES) {
      setPlaying(false);
      setError("connection");
      return;
    }
    const delay = immediate ? 0 : retryDelay(attempt);
    if (!immediate) transportRetryCount.current = attempt + 1;
    setPlaying(false);
    setError(null);
    transportRetryTimer.current = window.setTimeout(() => {
      transportRetryTimer.current = null;
      lastTransportReconnect.current = Date.now();
      setStreamAttempt((value) => value + 1);
    }, delay);
  }, []);

  useEffect(() => {
    if (!enabled) return;
    let active = true;
    let renewalTimer: number | null = null;
    let recoveryTimer: number | null = null;
    let renewalInFlight = false;
    let sessionRecoveryCount = 0;
    let startedAt = 0;
    let stalled = false;
    let lastFrameSequence = 0;

    const clearRenewal = () => {
      if (renewalTimer !== null) {
        window.clearTimeout(renewalTimer);
        renewalTimer = null;
      }
    };

    const clearRecovery = () => {
      if (recoveryTimer !== null) {
        window.clearTimeout(recoveryTimer);
        recoveryTimer = null;
      }
    };

    const scheduleRenewal = (renew: () => void) => {
      clearRenewal();
      if (active && sessionRef.current) {
        renewalTimer = window.setTimeout(renew, LEASE_RENEWAL_MILLIS);
      }
    };

    const installSession = (
      next: WireLiveStreamSession,
      renew: () => void,
    ) => {
      sessionRef.current = next;
      startedAt = Date.now();
      stalled = false;
      lastFrameSequence = next.frameSequence ?? 0;
      sessionRecoveryCount = 0;
      transportRetryCount.current = 0;
      setSession(next);
      setPlaying(false);
      setError(null);
      scheduleRenewal(renew);
    };

    const scheduleSessionRecovery = (start: (recovering: boolean) => void) => {
      clearRenewal();
      if (!active || recoveryTimer !== null) return;
      sessionRef.current = null;
      setSession(null);
      setPlaying(false);
      setError(null);
      if (sessionRecoveryCount >= MAX_SESSION_RECOVERIES) {
        setError("start");
        return;
      }
      const attempt = sessionRecoveryCount;
      sessionRecoveryCount += 1;
      recoveryTimer = window.setTimeout(() => {
        recoveryTimer = null;
        if (active) start(true);
      }, retryDelay(attempt));
    };

    let startSession: (recovering: boolean) => void;
    let renewSession: () => void;

    renewSession = () => {
      const current = sessionRef.current;
      if (!active || !current || renewalInFlight) return;
      renewalInFlight = true;
      void api
        .renewLiveStream(screenId, current.id, csrfToken)
        .then((renewed) => {
          if (!active || sessionRef.current?.id !== current.id) return;
          sessionRef.current = renewed;
          setSession(renewed);

          const sequence = renewed.frameSequence ?? 0;
          const lastFrameMillis = renewed.lastFrameAt
            ? Date.parse(renewed.lastFrameAt)
            : startedAt;
          const frameAge = Number.isFinite(lastFrameMillis)
            ? Date.now() - lastFrameMillis
            : Number.POSITIVE_INFINITY;
          if (frameAge >= FRAME_STALE_MILLIS) {
            stalled = true;
            if (
              Date.now() - lastTransportReconnect.current >=
              LEASE_RENEWAL_MILLIS
            ) {
              retryTransport(false);
            }
          } else if (sequence > lastFrameSequence) {
            lastFrameSequence = sequence;
            transportRetryCount.current = 0;
            if (stalled) {
              stalled = false;
              retryTransport(true);
            }
            setError(null);
          }
        })
        .catch((reason: unknown) => {
          if (!active || sessionRef.current?.id !== current.id) return;
          if (reason instanceof ApiError && reason.code === "live_stream_replaced") {
            clearRenewal();
            clearRecovery();
            sessionRef.current = null;
            setSession(null);
            setPlaying(false);
            setError("replaced");
            return;
          }
          if (reason instanceof ApiError && reason.code === "live_stream_not_found") {
            scheduleSessionRecovery(startSession);
            return;
          }
          setPlaying(false);
          setError("renew");
        })
        .finally(() => {
          renewalInFlight = false;
          if (active && sessionRef.current?.id === current.id) {
            scheduleRenewal(renewSession);
          }
        });
    };

    startSession = (recovering: boolean) => {
      void api
        .startLiveStream(screenId, csrfToken)
        .then((next) => {
          if (!active) {
            void endLiveStreamSession(screenId, next.id, csrfToken).catch(
              () => undefined,
            );
            return;
          }
          installSession(next, renewSession);
          if (recovering) {
            setStreamAttempt((value) => value + 1);
          }
        })
        .catch(() => {
          if (!active) return;
          if (recovering) {
            scheduleSessionRecovery(startSession);
          } else {
            setError("start");
          }
        });
    };

    sessionRef.current = null;
    setSession(null);
    setPlaying(false);
    setError(null);
    setStreamAttempt(0);
    startSession(false);

    return () => {
      active = false;
      clearRenewal();
      clearRecovery();
      if (transportRetryTimer.current !== null) {
        window.clearTimeout(transportRetryTimer.current);
        transportRetryTimer.current = null;
      }
      const current = sessionRef.current;
      sessionRef.current = null;
      if (current) {
        void endLiveStreamSession(screenId, current.id, csrfToken).catch(
          () => undefined,
        );
      }
    };
  }, [csrfToken, enabled, retryTransport, screenId]);

  const errorMessage =
    error === "start"
      ? t("liveStream.startError")
      : error === "renew"
        ? t("liveStream.leaseRenewError")
        : error === "replaced"
          ? t("liveStream.replaced")
          : error === "connection"
            ? t("liveStream.connectionEnded")
            : null;

  return (
    <>
      <div className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-lg border border-border bg-[#080b0f]">
        {session ? (
          <img
            key={`${session.id}:${streamAttempt}`}
            className="block size-full object-contain"
            src={`${api.screenLiveStreamUrl(screenId, session.id)}${streamAttempt ? `?retry=${streamAttempt}` : ""}`}
            alt={t("liveStream.imageAlt", { name: screenName })}
            onLoad={() => {
              if (transportRetryTimer.current !== null) {
                window.clearTimeout(transportRetryTimer.current);
                transportRetryTimer.current = null;
              }
              transportRetryCount.current = 0;
              setPlaying(true);
              setError(null);
            }}
            onError={() => retryTransport(false)}
          />
        ) : null}
        {!playing && (
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-slate-100"
            aria-live="polite"
          >
            {errorMessage ? (
              <>
                <WifiOff className="size-7" aria-hidden="true" />
                <strong>{t("liveStream.unavailable")}</strong>
                <span className="text-sm text-slate-300">{errorMessage}</span>
                {session && error !== "replaced" ? (
                  <Button
                    className="mt-2"
                    variant="outline"
                    onClick={() => {
                      transportRetryCount.current = 0;
                      retryTransport(true);
                    }}
                  >
                    {t("liveStream.retry")}
                  </Button>
                ) : null}
              </>
            ) : (
              <>
                <Video className="size-7" aria-hidden="true" />
                <strong>{t("liveStream.connecting")}</strong>
                <span className="text-sm text-slate-300">
                  {t("liveStream.waitingFrame")}
                </span>
              </>
            )}
          </div>
        )}
        {playing && (
          <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-black/80 px-2 py-1 text-xs font-bold uppercase tracking-wide text-white">
            <Radio className="size-3.5 text-red-400" aria-hidden="true" />
            {t("liveStream.liveBadge")}
          </span>
        )}
      </div>
      <div className="mt-3.5 grid gap-1 text-sm text-muted-foreground">
        <p className="m-0">
          <Trans
            i18nKey="liveStream.targetLine"
            ns="alerts"
            values={{
              target: session
                ? t("liveStream.targetValue", {
                    fps: Math.round(1_000 / session.frameIntervalMillis),
                    width: session.maxWidth,
                    height: session.maxHeight,
                  })
                : t("liveStream.targetValue", {
                    fps: 8,
                    width: 640,
                    height: 360,
                  }),
            }}
            components={{ strong: <strong /> }}
          />
        </p>
        <p className="m-0">{t("liveStream.privacyNote")}</p>
      </div>
    </>
  );
}

export function LiveStreamDialog({
  open,
  screenId,
  screenName,
  csrfToken,
  onClose,
}: {
  open: boolean;
  screenId: string;
  screenName: string;
  csrfToken: string;
  onClose: () => void;
}) {
  const { t } = useTranslation(["alerts", "common"]);
  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="w-[min(920px,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>
            {t("liveStream.title", { name: screenName })}
          </DialogTitle>
          <DialogDescription>{t("liveStream.description")}</DialogDescription>
        </DialogHeader>
        <LiveStreamViewer
          enabled={open}
          screenId={screenId}
          screenName={screenName}
          csrfToken={csrfToken}
        />
        <DialogFooter>
          <Button onClick={onClose}>{t("liveStream.stopWatching")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
