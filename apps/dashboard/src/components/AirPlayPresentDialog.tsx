import { useMutation, useQuery } from "@tanstack/react-query";
import { Airplay, Radio, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, ApiError } from "../api/client";
import type { AirplaySession, ReliabilityStatus } from "../api/types";
import { airplayCapabilityBlockDetail } from "./airplayCapability";
import { Alert, AlertDescription } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

function countdown(expiresAt: string, now: number) {
  const remaining = Math.max(0, Date.parse(expiresAt) - now);
  const totalMinutes = Math.floor(remaining / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  const seconds = Math.floor((remaining % 60_000) / 1_000);
  return hours > 0
    ? `${hours}h ${String(minutes).padStart(2, "0")}m`
    : `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

function sessionStatus(session: AirplaySession) {
  if (session.status === "ended" || session.status === "expired")
    return session.status === "expired" ? "AirPlay expired" : "AirPlay stopped";
  if (session.status === "stopping") return "Stopping AirPlay";
  if (session.status === "failed" || session.failedCount > 0)
    return "AirPlay could not prepare every display";
  if (session.status === "active" || session.connectedCount > 0)
    return `Presenting · ${session.connectedCount}/${session.screenCount} displays receiving`;
  if (session.status === "waiting")
    return `Waiting · ${session.readyCount}/${session.screenCount} displays ready`;
  return `Preparing · ${session.readyCount}/${session.screenCount} displays ready`;
}

function presentationNetworkProgress(
  session: AirplaySession,
): string | undefined {
  if (!session.presentationNetworkId) return undefined;
  const gateway = session.screens.find(
    (screen) => screen.role === "gateway" || screen.role === "single",
  );
  const networkName = session.presentationNetworkName ?? "Presentation Network";
  const state = gateway?.presentationNetworkState;
  if (state === "joining") return `Joining ${networkName} Wi-Fi…`;
  if (state === "connected" && session.status !== "active")
    return `Connected to ${networkName}. Preparing AirPlay…`;
  if (state === "failed") {
    switch (gateway?.failureCode) {
      case "authentication_failed":
        return "Presentation Network authentication failed.";
      case "ssid_not_found":
        return `${networkName} was not found near the gateway.`;
      case "dhcp_timeout":
        return "The gateway joined Wi-Fi but did not receive an address.";
      case "ethernet_default_route_lost":
        return "Ethernet stopped being the default route; Wi-Fi was disconnected.";
      default:
        return "The gateway could not prepare the Presentation Network.";
    }
  }
  if (session.status === "preparing" || session.status === "waiting")
    return `Preparing ${networkName} for AirPlay…`;
  return undefined;
}

function airplayCreateError(error: unknown): string {
  if (
    error instanceof ApiError &&
    error.code === "airplay_presentation_network_gateway_unavailable"
  )
    return "No eligible Wi-Fi gateway is available for this AirPlay target.";
  return error instanceof Error
    ? error.message
    : "AirPlay could not be started.";
}

export function AirPlayPresentDialog({
  open,
  targetType,
  targetId,
  destinationName,
  displayCount,
  csrfToken,
  capability,
  capabilities,
  capabilityLoading = false,
  capabilityError,
  audioDisplayName,
  onClose,
}: {
  open: boolean;
  targetType: "screen" | "group";
  targetId: string;
  destinationName: string;
  displayCount: number;
  csrfToken: string;
  capability?: ReliabilityStatus;
  capabilities?: ReliabilityStatus[];
  capabilityLoading?: boolean;
  capabilityError?: string;
  audioDisplayName?: string;
  onClose: () => void;
}) {
  const [durationMinutes, setDurationMinutes] = useState<0 | 15 | 30 | 60>(30);
  const [transport, setTransport] = useState<"auto" | "unicast" | "multicast">(
    "auto",
  );
  const [audioMode, setAudioMode] = useState<"gateway_only" | "none">(
    "gateway_only",
  );
  const [session, setSession] = useState<AirplaySession | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const targetKey = `${targetType}:${targetId}`;
  const previousTargetKey = useRef(targetKey);

  useEffect(() => {
    if (!open) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [open]);

  const create = useMutation({
    mutationFn: () =>
      api.createAirplaySession(
        { targetType, targetId, durationMinutes, transport, audioMode },
        csrfToken,
      ),
    onSuccess: (value) => {
      setSession(value);
      setSessionId(value.id);
    },
  });
  const allCapabilities = useMemo(
    () => capabilities ?? (capability ? [capability] : []),
    [capabilities, capability],
  );
  const reportedSessionId = useMemo(() => {
    const ids = new Set(
      allCapabilities
        .map((item) => item.externalPresentationSessionId)
        .filter((value): value is string => Boolean(value)),
    );
    return ids.size === 1 ? [...ids][0] : null;
  }, [allCapabilities]);
  useEffect(() => {
    if (open && !sessionId && reportedSessionId) {
      // Rehydrate a session created by another Studio tab, or before this
      // dialog was reopened. The server response remains the source of truth;
      // the reliability row supplies only the durable session ID.
      setSessionId(reportedSessionId);
    }
  }, [open, reportedSessionId, sessionId]);
  const current = useQuery({
    queryKey: ["airplay-session", sessionId],
    queryFn: () => {
      if (!sessionId) throw new Error("AirPlay session is not available");
      return api.airplaySession(sessionId);
    },
    enabled: Boolean(open && sessionId),
    refetchInterval: (query) => {
      const value = query.state.data;
      return value && ["ended", "expired", "failed"].includes(value.status)
        ? false
        : 2_000;
    },
  });
  const stop = useMutation({
    mutationFn: () => {
      if (!sessionId) throw new Error("AirPlay session is not available");
      return api.stopAirplaySession(sessionId, csrfToken);
    },
    onSuccess: (value) => {
      setSession(value);
      setSessionId(value.id);
    },
  });
  useEffect(() => {
    const targetChanged = previousTargetKey.current !== targetKey;
    previousTargetKey.current = targetKey;
    if (!open || targetChanged) {
      setSession(null);
      setSessionId(null);
    }
  }, [open, targetKey]);
  const live = current.data ?? session;
  const capabilitiesComplete =
    displayCount > 0 && allCapabilities.length === displayCount;
  const groupReady =
    targetType !== "group" && displayCount === 1
      ? true
      : allCapabilities.every((item) => item.airplayGroupSupported === true);
  const capabilityText = useMemo(() => {
    if (displayCount === 0) return "Add at least one display to this target.";
    // A failed capability read is not the same as a display that has not
    // reported yet. Reporting both as "waiting" leaves the dialog stuck with
    // no way to tell a broken request from a player that never probed.
    if (capabilityError)
      return `Tilecast could not read display capabilities: ${capabilityError}`;
    if (!capabilitiesComplete) {
      if (capabilityLoading) return "Reading display capabilities…";
      const remaining = Math.max(1, displayCount - allCapabilities.length);
      return `Waiting for ${remaining} display${remaining === 1 ? "" : "s"} to report AirPlay capabilities.`;
    }
    const blocked = allCapabilities.filter((item) =>
      targetType === "group"
        ? item.airplayGroupSupported === false
        : item.airplaySupported === false,
    );
    if (blocked.length > 0) {
      // Naming the dependency is the whole point: "not AirPlay-ready" leaves an
      // operator guessing between UxPlay, GStreamer, the H.264 decoder, and
      // Avahi. Prefer the player's own sentence, which also carries the version
      // it found, and fall back to the component flags it reported.
      const detail = airplayCapabilityBlockDetail(blocked);
      return blocked.length === 1
        ? `This display is not AirPlay-ready. ${detail}`
        : `${blocked.length} displays are not AirPlay-ready. ${detail}`;
    }
    if (targetType === "group" && groupReady === false) {
      return "One or more displays has not verified the GStreamer RTP receiver path.";
    }
    if (
      targetType !== "group" &&
      allCapabilities.some((item) => item.airplaySupported !== true)
    )
      // The reported capability is the source of truth, so this points at the
      // probe rather than at a version number. Every player release since
      // AirPlay shipped has carried fixes that changed what "new enough" means,
      // and naming one version sends operators to check the wrong thing.
      return "This display has not reported AirPlay capabilities yet. Run Test AirPlay support from Health & recovery; if the probe never reports, update Tilecast Player.";
    const hardware1080 = allCapabilities.every(
      (item) =>
        item.airplayHardwareDecode && item.airplayMaxProfile === "1080p30",
    );
    const h264Ready = allCapabilities.every(
      (item) =>
        item.airplayMaxProfile === "1080p30" ||
        item.airplayMaxProfile === "720p30",
    );
    if (hardware1080)
      return `All ${allCapabilities.length} displays hardware-ready · common profile 1080p30 H.264`;
    if (h264Ready)
      return `Common profile 720p30 H.264 · at least one display is software-only`;
    return "Capability profile is still being reported.";
  }, [
    allCapabilities,
    capabilitiesComplete,
    capabilityError,
    capabilityLoading,
    displayCount,
    groupReady,
    targetType,
  ]);
  const anyUnsupported = allCapabilities.some((item) =>
    targetType === "group"
      ? item.airplayGroupSupported === false
      : item.airplaySupported === false,
  );
  const profileReady = allCapabilities.every(
    (item) =>
      item.airplayMaxProfile === "1080p30" ||
      item.airplayMaxProfile === "720p30",
  );
  const canEnable =
    capabilitiesComplete &&
    !anyUnsupported &&
    (targetType === "group"
      ? allCapabilities.every((item) => item.airplayGroupSupported === true)
      : allCapabilities.every((item) => item.airplaySupported === true)) &&
    profileReady &&
    groupReady;

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose();
      }}
    >
      <DialogContent className="max-h-[min(90vh,54rem)] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Present with AirPlay · {destinationName}</DialogTitle>
          <DialogDescription>
            Start and monitor a temporary external AirPlay session.
          </DialogDescription>
        </DialogHeader>
        {!live && sessionId ? (
          <>
            <Alert>
              <Radio size={17} aria-hidden="true" />
              <AlertDescription>
                {current.error
                  ? "Tilecast could not load the active AirPlay session. Refresh and try again."
                  : "Loading the active AirPlay session…"}
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
            </DialogFooter>
          </>
        ) : !live ? (
          <>
            <div className="flex items-center gap-3">
              <Airplay
                className="size-7 shrink-0 text-primary"
                aria-hidden="true"
              />
              <div className="grid min-w-0 gap-1">
                <strong className="text-sm">{destinationName}</strong>
                <span className="text-sm text-muted-foreground">
                  {displayCount} display{displayCount === 1 ? "" : "s"} ·
                  temporary external presentation
                </span>
              </div>
            </div>
            <Alert>
              <ShieldCheck size={17} aria-hidden="true" />
              <AlertDescription>{capabilityText}</AlertDescription>
            </Alert>
            {capability?.externalPresentationState &&
              capability.externalPresentationState !== "none" && (
                <Alert variant="destructive">
                  <AlertDescription>
                    An AirPlay presentation is already reported on this screen.
                    Stop it before starting another.
                  </AlertDescription>
                </Alert>
              )}
            <div className="grid gap-4">
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Duration</span>
                <Select
                  items={[
                    { value: "15", label: "15 minutes" },
                    { value: "30", label: "30 minutes" },
                    { value: "60", label: "1 hour" },
                    {
                      value: "0",
                      label: "Until stopped (24-hour safety deadline)",
                    },
                  ]}
                  value={String(durationMinutes)}
                  onValueChange={(value) => {
                    if (value) {
                      setDurationMinutes(Number(value) as 0 | 15 | 30 | 60);
                    }
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Duration">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="15">15 minutes</SelectItem>
                    <SelectItem value="30">30 minutes</SelectItem>
                    <SelectItem value="60">1 hour</SelectItem>
                    <SelectItem value="0">
                      Until stopped (24-hour safety deadline)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Video transport</span>
                <span className="text-xs font-normal text-muted-foreground">
                  Auto uses unicast for 1–4 displays and multicast only when
                  validated.
                </span>
                <Select
                  items={[
                    { value: "auto", label: "Auto" },
                    { value: "unicast", label: "Unicast fan-out" },
                    {
                      value: "multicast",
                      label: "Multicast (falls back to unicast)",
                    },
                  ]}
                  value={transport}
                  onValueChange={(value) => {
                    if (
                      value === "auto" ||
                      value === "unicast" ||
                      value === "multicast"
                    ) {
                      setTransport(value);
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label="Video transport"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="auto">Auto</SelectItem>
                    <SelectItem value="unicast">Unicast fan-out</SelectItem>
                    <SelectItem value="multicast">
                      Multicast (falls back to unicast)
                    </SelectItem>
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>Audio display</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {audioDisplayName
                    ? `Primary audio: ${audioDisplayName}`
                    : "Primary audio uses the selected or automatically chosen gateway."}
                </span>
                <Select
                  items={[
                    {
                      value: "gateway_only",
                      label: "Gateway / primary display only",
                    },
                    { value: "none", label: "No AirPlay audio" },
                  ]}
                  value={audioMode}
                  onValueChange={(value) => {
                    if (value === "gateway_only" || value === "none") {
                      setAudioMode(value);
                    }
                  }}
                >
                  <SelectTrigger className="w-full" aria-label="Audio display">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="gateway_only">
                      Gateway / primary display only
                    </SelectItem>
                    <SelectItem value="none">No AirPlay audio</SelectItem>
                  </SelectContent>
                </Select>
              </label>
            </div>
            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {airplayCreateError(create.error)}
                </AlertDescription>
              </Alert>
            )}
            <DialogFooter className="border-t border-border pt-4">
              <Button variant="outline" onClick={onClose}>
                Cancel
              </Button>
              <Button
                variant="default"
                disabled={!canEnable || Boolean(sessionId)}
                onClick={() => create.mutate()}
              >
                {create.isPending ? "Enabling…" : "Enable AirPlay"}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Radio size={18} aria-hidden="true" />
              <strong className="text-sm">
                {presentationNetworkProgress(live) ?? sessionStatus(live)}
              </strong>
            </div>
            <div className="grid gap-1 rounded-xl border border-slate-700 bg-slate-950 p-5 text-center text-slate-100">
              <span className="text-xs uppercase tracking-widest text-slate-400">
                AirPlay receiver
              </span>
              <strong>{live.receiverName}</strong>
              <small className="text-xs uppercase tracking-widest text-slate-400">
                PIN
              </small>
              <code className="my-1 text-5xl font-extrabold tracking-[0.18em] sm:text-6xl">
                {live.pin ?? "----"}
              </code>
              <p className="mx-auto mt-2 max-w-[390px] text-sm text-slate-300">
                On iPhone, iPad, or Mac, open Screen Mirroring / AirPlay and
                choose this receiver.
              </p>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">Profile</dt>
                <dd className="mt-1 text-sm font-medium">
                  {live.videoProfile} H.264
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Transport</dt>
                <dd className="mt-1 text-sm font-medium">{live.transport}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Audio</dt>
                <dd className="mt-1 text-sm font-medium">
                  {live.audioMode === "none"
                    ? "None"
                    : `${audioDisplayName ?? "Gateway / primary display"} only`}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">Expires in</dt>
                <dd className="mt-1 text-sm font-medium">
                  {countdown(live.expiresAt, now)}
                </dd>
              </div>
            </dl>
            <div className="grid max-h-40 gap-1.5 overflow-y-auto">
              {live.screens.map((screen) => (
                <Badge
                  key={screen.screenId}
                  variant={
                    screen.state === "failed" || screen.state === "degraded"
                      ? "destructive"
                      : screen.state === "connected"
                        ? "outline"
                        : "secondary"
                  }
                  className="h-auto w-full justify-start whitespace-normal px-2.5 py-1.5 text-left"
                >
                  {screen.screenName}: {screen.state.replaceAll("_", " ")}
                  {screen.presentationNetworkState
                    ? ` · Wi-Fi ${screen.presentationNetworkState.replaceAll("_", " ")}`
                    : ""}
                </Badge>
              ))}
            </div>
            {stop.error && (
              <Alert variant="destructive">
                <AlertDescription>{stop.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter className="border-t border-border pt-4">
              <Button variant="outline" onClick={onClose}>
                Close
              </Button>
              <Button
                variant="destructive"
                disabled={["stopping", "ended", "expired", "failed"].includes(
                  live.status,
                )}
                onClick={() => stop.mutate()}
              >
                {stop.isPending ? "Stopping…" : "Stop AirPlay"}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
