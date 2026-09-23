import { Radio, Video, WifiOff } from "lucide-react";
import { useEffect, useState } from "react";
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
                    : "The live stream lease could not be renewed.",
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
              : "The live stream could not be started.",
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
  }, [csrfToken, open, screenId]);

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="w-[min(920px,calc(100vw-2rem))] max-w-none">
        <DialogHeader>
          <DialogTitle>Live stream · {screenName}</DialogTitle>
          <DialogDescription>
            Ephemeral player output, relayed only while this window is open.
          </DialogDescription>
        </DialogHeader>
        <div className="relative grid aspect-video w-full place-items-center overflow-hidden rounded-lg border border-border bg-[#080b0f]">
          {session ? (
            <img
              className="block size-full object-contain"
              src={liveStreamApi.mjpegUrl(screenId, session.id)}
              alt={`Live Tilecast output from ${screenName}`}
              onLoad={() => setPlaying(true)}
              onError={() =>
                setError("The live stream connection ended unexpectedly.")
              }
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
                  <strong>Stream unavailable</strong>
                  <span className="text-sm text-slate-300">{error}</span>
                </>
              ) : (
                <>
                  <Video className="size-7" aria-hidden="true" />
                  <strong>Connecting to player…</strong>
                  <span className="text-sm text-slate-300">
                    Waiting for the first frame.
                  </span>
                </>
              )}
            </div>
          )}
          {playing && (
            <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-md border border-white/20 bg-black/80 px-2 py-1 text-xs font-bold uppercase tracking-wide text-white">
              <Radio className="size-3.5 text-red-400" aria-hidden="true" />
              Live
            </span>
          )}
        </div>
        <div className="mt-3.5 grid gap-1 text-sm text-muted-foreground">
          <p className="m-0">
            Targeting{" "}
            <strong>
              {session
                ? `${Math.round(1_000 / session.frameIntervalMillis)} FPS · ${session.maxWidth}×${session.maxHeight}`
                : "8 FPS · 640×360"}
            </strong>
            . Actual refresh depends on the player and network.
          </p>
          <p className="m-0">
            This stream is relayed only while this window is open. Frames are
            never saved to snapshots, live preview, Activity, or backups.
          </p>
        </div>
        <DialogFooter>
          <Button onClick={onClose}>Stop watching</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
