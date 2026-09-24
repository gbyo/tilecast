import { useMutation, useQuery } from "@tanstack/react-query";
import { Airplay, Radio, ShieldCheck } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api, ApiError } from "../api/client";
import type { AirplaySession, ReliabilityStatus } from "../api/types";
import { airplayCapabilityBlockDetail } from "./airplayCapability";
import { Alert, AlertDescription } from "./ui/alert";
import { toast } from "./ui/toast";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Field, FieldDescription, FieldLabel } from "./ui/field";
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

function sessionStatus(session: AirplaySession, t: TFunction<"alerts">) {
  if (session.status === "ended" || session.status === "expired")
    return session.status === "expired"
      ? t("airplay.status.expired")
      : t("airplay.status.stopped");
  if (session.status === "stopping") return t("airplay.status.stopping");
  if (session.status === "failed" || session.failedCount > 0)
    return t("airplay.status.unprepared");
  if (session.status === "active" || session.connectedCount > 0)
    return t("airplay.status.presenting", {
      connected: session.connectedCount,
      total: session.screenCount,
    });
  if (session.status === "waiting")
    return t("airplay.status.waiting", {
      ready: session.readyCount,
      total: session.screenCount,
    });
  return t("airplay.status.preparing", {
    ready: session.readyCount,
    total: session.screenCount,
  });
}

function presentationNetworkProgress(
  session: AirplaySession,
  t: TFunction<"alerts">,
): string | undefined {
  if (!session.presentationNetworkId) return undefined;
  const gateway = session.screens.find(
    (screen) => screen.role === "gateway" || screen.role === "single",
  );
  const networkName =
    session.presentationNetworkName ?? t("airplay.network.fallbackName");
  const state = gateway?.presentationNetworkState;
  if (state === "joining")
    return t("airplay.network.joining", { name: networkName });
  if (state === "connected" && session.status !== "active")
    return t("airplay.network.connected", { name: networkName });
  if (state === "failed") {
    switch (gateway?.failureCode) {
      case "authentication_failed":
        return t("airplay.network.authFailed");
      case "ssid_not_found":
        return t("airplay.network.ssidNotFound", { name: networkName });
      case "dhcp_timeout":
        return t("airplay.network.dhcpTimeout");
      case "ethernet_default_route_lost":
        return t("airplay.network.routeLost");
      default:
        return t("airplay.network.genericFailure");
    }
  }
  if (session.status === "preparing" || session.status === "waiting")
    return t("airplay.network.preparing", { name: networkName });
  return undefined;
}

function airplayCreateError(error: unknown, t: TFunction<"alerts">): string {
  if (
    error instanceof ApiError &&
    error.code === "airplay_presentation_network_gateway_unavailable"
  )
    return t("airplay.createError.gatewayUnavailable");
  return error instanceof Error
    ? error.message
    : t("airplay.createError.generic");
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
  const { t } = useTranslation(["alerts", "common"]);
  const [session, setSession] = useState<AirplaySession | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

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
      toast.add({ title: "AirPlay session started.", type: "success" });
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
      if (!sessionId) throw new Error(t("airplay.sessionUnavailable"));
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
      if (!sessionId) throw new Error(t("airplay.sessionUnavailable"));
      return api.stopAirplaySession(sessionId, csrfToken);
    },
    onSuccess: (value) => {
      toast.add({ title: "AirPlay session ended.", type: "success" });
      setSession(value);
      setSessionId(value.id);
    },
  });
  useEffect(() => {
    if (!open) {
      setSession(null);
      setSessionId(null);
    }
  }, [open, targetId]);
  const live = current.data ?? session;
  const capabilitiesComplete =
    displayCount > 0 && allCapabilities.length === displayCount;
  const groupReady =
    targetType !== "group" && displayCount === 1
      ? true
      : allCapabilities.every((item) => item.airplayGroupSupported === true);
  const capabilityText = useMemo(() => {
    if (displayCount === 0) return t("airplay.capability.noDisplays");
    // A failed capability read is not the same as a display that has not
    // reported yet. Reporting both as "waiting" leaves the dialog stuck with
    // no way to tell a broken request from a player that never probed.
    if (capabilityError)
      return t("airplay.capability.readError", { error: capabilityError });
    if (!capabilitiesComplete) {
      if (capabilityLoading) return t("airplay.capability.reading");
      const remaining = Math.max(1, displayCount - allCapabilities.length);
      return t("airplay.capability.waitingReports", { count: remaining });
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
      const detail = airplayCapabilityBlockDetail(blocked, t);
      return t("airplay.capability.notReady", {
        count: blocked.length,
        detail,
      });
    }
    if (targetType === "group" && groupReady === false) {
      return t("airplay.capability.groupProbe");
    }
    if (
      targetType !== "group" &&
      allCapabilities.some((item) => item.airplaySupported !== true)
    )
      // The reported capability is the source of truth, so this points at the
      // probe rather than at a version number. Every player release since
      // AirPlay shipped has carried fixes that changed what "new enough" means,
      // and naming one version sends operators to check the wrong thing.
      return t("airplay.capability.noReport");
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
      return t("airplay.capability.hardwareReady", {
        count: allCapabilities.length,
      });
    if (h264Ready) return t("airplay.capability.softwareOnly");
    return t("airplay.capability.stillReporting");
  }, [
    allCapabilities,
    capabilitiesComplete,
    capabilityError,
    capabilityLoading,
    displayCount,
    groupReady,
    t,
    targetType,
  ]);
  const anyUnsupported = allCapabilities.some((item) =>
    targetType === "group"
      ? item.airplayGroupSupported === false
      : item.airplaySupported === false,
  );
  const durationOptions = [
    { value: "15", label: t("airplay.durations.fifteenMinutes") },
    { value: "30", label: t("airplay.durations.thirtyMinutes") },
    { value: "60", label: t("airplay.durations.oneHour") },
    { value: "0", label: t("airplay.durations.untilStopped") },
  ];
  const transportOptions = [
    { value: "auto", label: t("airplay.transportOptions.auto") },
    { value: "unicast", label: t("airplay.transportOptions.unicast") },
    { value: "multicast", label: t("airplay.transportOptions.multicast") },
  ];
  const audioOptions = [
    {
      value: "gateway_only",
      label: t("airplay.audioOptions.gatewayOnly"),
    },
    { value: "none", label: t("airplay.audioOptions.none") },
  ];
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
          <DialogTitle>
            {t("airplay.title", { name: destinationName })}
          </DialogTitle>
          <DialogDescription>{t("airplay.description")}</DialogDescription>
        </DialogHeader>
        {!live && sessionId ? (
          <>
            <Alert>
              <Radio size={17} aria-hidden="true" />
              <AlertDescription>
                {current.error
                  ? t("airplay.loadingError")
                  : t("airplay.loadingSession")}
              </AlertDescription>
            </Alert>
            <DialogFooter>
              <Button variant="outline" onClick={onClose}>
                {t("common:actions.close")}
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
                  {t("airplay.targetSummary", { count: displayCount })}
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
                    {t("airplay.alreadyReported")}
                  </AlertDescription>
                </Alert>
              )}
            <div className="grid gap-4">
              <label className="grid gap-1.5 text-sm font-medium">
                <span>{t("airplay.durationLabel")}</span>
                <Select
                  items={durationOptions}
                  value={String(durationMinutes)}
                  onValueChange={(value) => {
                    if (value) {
                      setDurationMinutes(Number(value) as 0 | 15 | 30 | 60);
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("airplay.durationLabel")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {durationOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>{t("airplay.transportLabel")}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {t("airplay.transportHint")}
                </span>
                <Select
                  items={transportOptions}
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
                    aria-label={t("airplay.transportLabel")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {transportOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </label>
              <label className="grid gap-1.5 text-sm font-medium">
                <span>{t("airplay.audioLabel")}</span>
                <span className="text-xs font-normal text-muted-foreground">
                  {audioDisplayName
                    ? t("airplay.audioHintWithName", {
                        name: audioDisplayName,
                      })
                    : t("airplay.audioHintDefault")}
                </span>
                <Select
                  items={audioOptions}
                  value={audioMode}
                  onValueChange={(value) => {
                    if (value === "gateway_only" || value === "none") {
                      setAudioMode(value);
                    }
                  }}
                >
                  <SelectTrigger
                    className="w-full"
                    aria-label={t("airplay.audioLabel")}
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {audioOptions.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>
            {create.error && (
              <Alert variant="destructive">
                <AlertDescription>
                  {airplayCreateError(create.error, t)}
                </AlertDescription>
              </Alert>
            )}
            <DialogFooter className="border-t border-border pt-4">
              <Button variant="outline" onClick={onClose}>
                {t("common:actions.cancel")}
              </Button>
              <Button
                variant="default"
                disabled={!canEnable || Boolean(sessionId)}
                onClick={() => create.mutate()}
              >
                {create.isPending ? t("airplay.enabling") : t("airplay.enable")}
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <Radio size={18} aria-hidden="true" />
              <strong className="text-sm">
                {presentationNetworkProgress(live, t) ?? sessionStatus(live, t)}
              </strong>
            </div>
            <div className="grid gap-1 rounded-xl border border-slate-700 bg-slate-950 p-5 text-center text-slate-100">
              <span className="text-xs uppercase tracking-widest text-slate-400">
                {t("airplay.receiverLabel")}
              </span>
              <strong>{live.receiverName}</strong>
              <small className="text-xs uppercase tracking-widest text-slate-400">
                {t("airplay.pinLabel")}
              </small>
              <code className="my-1 text-5xl font-extrabold tracking-[0.18em] sm:text-6xl">
                {live.pin ?? "----"}
              </code>
              <p className="mx-auto mt-2 max-w-[390px] text-sm text-slate-300">
                {t("airplay.instructions")}
              </p>
            </div>
            <dl className="grid gap-3 sm:grid-cols-2">
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("airplay.profileLabel")}
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {t("airplay.profileValue", { profile: live.videoProfile })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("airplay.transportTitle")}
                </dt>
                <dd className="mt-1 text-sm font-medium">{live.transport}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("airplay.audioTitle")}
                </dt>
                <dd className="mt-1 text-sm font-medium">
                  {live.audioMode === "none"
                    ? t("airplay.audioNone")
                    : t("airplay.audioGatewayOnly", {
                        name:
                          audioDisplayName ??
                          t("airplay.audioOptions.gatewayOnly"),
                      })}
                </dd>
              </div>
              <div>
                <dt className="text-xs text-muted-foreground">
                  {t("airplay.expiresLabel")}
                </dt>
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
                  {t("airplay.screenState", {
                    name: screen.screenName,
                    state: screen.state.replaceAll("_", " "),
                    wifi: screen.presentationNetworkState
                      ? t("airplay.screenWifi", {
                          state: screen.presentationNetworkState.replaceAll(
                            "_",
                            " ",
                          ),
                        })
                      : "",
                  })}
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
                {t("common:actions.close")}
              </Button>
              <Button
                variant="destructive"
                disabled={["stopping", "ended", "expired", "failed"].includes(
                  live.status,
                )}
                onClick={() => stop.mutate()}
              >
                {stop.isPending ? t("airplay.stopping") : t("airplay.stop")}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}
