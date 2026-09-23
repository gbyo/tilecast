import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wifi, WifiOff } from "lucide-react";
import { api } from "../api/client";
import type { PresentationNetworkReadiness, Screen } from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "./ui/alert";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { Skeleton } from "./ui/skeleton";
import { toast } from "./ui/toast";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";

function statusLabel(status: PresentationNetworkReadiness["status"]) {
  switch (status) {
    case "ready":
      return "Presentation Network ready";
    case "connected":
      return "Connected for AirPlay";
    case "unassigned":
      return "No Presentation Network assigned";
    case "wifi_adapter_unavailable":
      return "Wi-Fi adapter unavailable";
    case "network_manager_unavailable":
      return "NetworkManager unavailable";
    case "helper_missing":
      return "Network helper unavailable";
    case "helper_unhealthy":
      return "Network helper unhealthy";
    case "configuration_pending":
      return "Configuration pending";
    case "reporting_pending":
      return "Waiting for player status";
    case "failed":
      return "Last connection failed";
    case "unsupported":
      return "Presentation Network unsupported";
    default:
      return "Presentation Network not applicable";
  }
}

export function ScreenPresentationNetworkPanel({
  screen,
  canManage,
  csrfToken,
}: {
  screen: Screen;
  canManage: boolean;
  csrfToken: string;
}) {
  const client = useQueryClient();
  const linux = screen.platform.trim().toLowerCase() === "linux";
  const readiness = useQuery({
    queryKey: ["screens", screen.id, "presentation-network"],
    queryFn: () => api.screenPresentationNetwork(screen.id),
    enabled: linux,
    refetchInterval: linux ? 10_000 : false,
  });
  const networks = useQuery({
    queryKey: ["presentation-networks"],
    queryFn: api.presentationNetworks,
    enabled: linux && canManage,
  });
  const [selected, setSelected] = useState("");

  useEffect(() => {
    setSelected(readiness.data?.presentationNetworkId ?? "");
  }, [readiness.data?.presentationNetworkId]);

  const assignment = useMutation({
    mutationFn: () =>
      selected
        ? api.assignScreenPresentationNetwork(screen.id, selected, csrfToken)
        : api.unassignScreenPresentationNetwork(screen.id, csrfToken),
    onSuccess: async () => {
      toast.add({
        title: selected
          ? "Presentation Network assignment saved."
          : "Presentation Network unassigned.",
        type: "success",
      });
      await client.invalidateQueries({
        queryKey: ["screens", screen.id, "presentation-network"],
      });
      await client.invalidateQueries({ queryKey: ["presentation-networks"] });
      await client.invalidateQueries({ queryKey: ["screens"] });
    },
  });
  const test = useMutation({
    mutationFn: () => {
      const networkId = readiness.data?.presentationNetworkId;
      if (!networkId) throw new Error("Assign a Presentation Network first.");
      return api.testPresentationNetwork(networkId, screen.id, csrfToken);
    },
    onSuccess: (result) => {
      toast.add({
        title: `Connection test requested. The player will report within ${result.timeoutSeconds} seconds.`,
        type: "success",
      });
      void client.invalidateQueries({
        queryKey: ["screens", screen.id, "commands"],
      });
    },
  });

  const assignedNetwork = useMemo(
    () =>
      networks.data?.items.find(
        (network) => network.id === readiness.data?.presentationNetworkId,
      ),
    [networks.data, readiness.data?.presentationNetworkId],
  );

  if (!linux) return null;

  const data = readiness.data;
  const disabled = !canManage || assignment.isPending;
  return (
    <section
      className="min-w-0 space-y-4 rounded-xl border border-border border-l-4 border-l-primary bg-muted/20 p-4"
      aria-labelledby="presentation-network-readiness-heading"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border pb-3">
        <div className="min-w-0 space-y-1">
          <h4
            id="presentation-network-readiness-heading"
            className="text-sm font-semibold"
          >
            Presentation Network
          </h4>
          <p className="text-sm text-muted-foreground">
            Temporary Wi-Fi is used only by this Linux player when it is the
            AirPlay gateway. Group followers remain on Ethernet.
          </p>
        </div>
        <Badge
          variant={
            data?.status === "failed" || data?.status === "unsupported"
              ? "destructive"
              : data?.status === "ready" || data?.status === "connected"
                ? "outline"
                : "secondary"
          }
        >
          {statusLabel(data?.status ?? "reporting_pending")}
        </Badge>
      </div>
      {readiness.isLoading ? (
        <div
          className="space-y-2"
          aria-label="Loading Presentation Network status"
        >
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : readiness.error ? (
        <Alert variant="destructive">
          <WifiOff aria-hidden="true" />
          <AlertTitle>Could not load Presentation Network status</AlertTitle>
          <AlertDescription>{readiness.error.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">
                Assigned network
              </dt>
              <dd className="mt-1 break-words text-sm">
                {data?.presentationNetworkName ?? "None"}
                {assignedNetwork && !assignedNetwork.credentialSet
                  ? " · credential missing"
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Player status</dt>
              <dd className="mt-1 break-words text-sm">
                {data?.detail ?? "Waiting for player status."}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Wi-Fi adapter</dt>
              <dd className="mt-1 text-sm">
                {data?.wifiAdapterPresent == null
                  ? "Not reported"
                  : data.wifiAdapterPresent
                    ? "Available"
                    : "Unavailable"}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">Ethernet IPv4</dt>
              <dd className="mt-1 break-words text-sm">
                {data?.wiredIpv4
                  ? `${data.wiredIpv4}${data.wiredInterfaceAvailable === false ? " · interface unavailable" : ""}`
                  : data?.wiredInterfaceAvailable === false
                    ? "Unavailable"
                    : "Not reported"}
              </dd>
            </div>
          </dl>
          {data?.limitation && (
            <Alert>
              <AlertDescription>
                Capability limitation: {data.limitation}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
      {canManage && (
        <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="grid min-w-0 gap-1.5 text-sm font-medium">
            <span>Assigned Presentation Network</span>
            <span className="text-xs font-normal text-muted-foreground">
              Assignment is durable; the player joins Wi-Fi only for an AirPlay
              gateway session.
            </span>
            <Select
              items={[
                { value: "__unassigned__", label: "No Presentation Network" },
                ...(networks.data?.items ?? []).map((network) => ({
                  value: network.id,
                  label: `${network.name} · ${network.ssid}`,
                })),
              ]}
              value={selected || "__unassigned__"}
              onValueChange={(value) =>
                setSelected(value === "__unassigned__" ? "" : (value ?? ""))
              }
            >
              <SelectTrigger
                className="w-full"
                aria-label="Assigned Presentation Network"
                disabled={networks.isLoading || assignment.isPending}
              >
                <SelectValue placeholder="No Presentation Network" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassigned__">
                  No Presentation Network
                </SelectItem>
                {(networks.data?.items ?? []).map((network) => (
                  <SelectItem key={network.id} value={network.id}>
                    {network.name} · {network.ssid}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>
          <div className="flex flex-wrap gap-2 sm:justify-end">
            <Button
              variant="default"
              disabled={
                disabled || selected === (data?.presentationNetworkId ?? "")
              }
              onClick={() => {
                assignment.mutate();
              }}
            >
              {assignment.isPending ? "Saving…" : "Save assignment"}
            </Button>
            {data?.presentationNetworkId && (
              <Button
                variant="outline"
                size="sm"
                disabled={test.isPending || data.status === "connected"}
                onClick={() => {
                  test.mutate();
                }}
              >
                {test.isPending ? "Testing…" : "Test connection"}
              </Button>
            )}
          </div>
        </div>
      )}
      {(assignment.error || test.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {(assignment.error ?? test.error)?.message}
          </AlertDescription>
        </Alert>
      )}
      {!canManage && (
        <p className="text-sm text-muted-foreground">
          An Owner or Administrator can change this assignment.
        </p>
      )}
      {data?.status === "unassigned" && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <WifiOff size={14} aria-hidden="true" /> AirPlay remains Ethernet-only
          until a network is assigned.
        </p>
      )}
      {(data?.status === "ready" || data?.status === "connected") && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Wifi size={14} aria-hidden="true" /> Ethernet remains the default
          Tilecast route.
        </p>
      )}
    </section>
  );
}
