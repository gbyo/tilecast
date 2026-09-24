import { Radio, Video, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import { liveStreamApi, type LiveStreamSession } from "../api/liveStreams";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";

const LEASE_RENEWAL_MILLIS = 7_000;

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
  const [session, setSession] = useState<LiveStreamSession | null>(null);
  const [playing, setPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    let started: LiveStreamSession | null = null;
    let renewal: number | undefined;

    setSession(null);
    setPlaying(false);
    setError(null);
    void liveStreamApi
      .start(screenId, csrfToken)
      .then((next) => {
        if (!active) {
          void liveStreamApi
            .end(screenId, next.id, csrfToken, true)
            .catch(() => undefined);
          return;
        }
        started = next;
        setSession(next);
        renewal = window.setInterval(() => {
          void liveStreamApi
            .renew(screenId, next.id, csrfToken)
            .then((renewed) => {
              if (active) setSession(renewed);
            })
            .catch((reason) => {
              if (active) {
                setError(
                  reason instanceof Error
                    ? reason.message
                    : t("liveStream.leaseRenewError"),
                );
              }
            });
        }, LEASE_RENEWAL_MILLIS);
      })
      .catch((reason) => {
        if (active) {
          setError(
            reason instanceof Error
              ? reason.message
              : t("liveStream.startError"),
          );
        }
      });

    return () => {
      active = false;
      if (renewal !== undefined) window.clearInterval(renewal);
      if (started) {
        void liveStreamApi
          .end(screenId, started.id, csrfToken, true)
          .catch(() => undefined);
      }
    };
    // `t` is a dependency so a language change restarts this ephemeral
    // preview with labels in the new language.
  }, [csrfToken, open, screenId, t]);

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
        <div className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-lg border border-border bg-[#080b0f]">
          {session ? (
            <img
              className="block size-full object-contain"
              src={liveStreamApi.mjpegUrl(screenId, session.id)}
              alt={t("liveStream.imageAlt", { name: screenName })}
              onLoad={() => setPlaying(true)}
              onError={() => setError(t("liveStream.connectionEnded"))}
            />
          ) : null}
          {!playing && (
            <div
              className="absolute inset-0 flex flex-col items-center justify-center gap-2 px-4 text-center text-slate-100"
              aria-live="polite"
            >
              {error ? (
                <>
                  <WifiOff className="size-7" aria-hidden="true" />
                  <strong>{t("liveStream.unavailable")}</strong>
                  <span className="text-sm text-slate-300">{error}</span>
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
        <DialogFooter>
          <Button onClick={onClose}>{t("liveStream.stopWatching")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
