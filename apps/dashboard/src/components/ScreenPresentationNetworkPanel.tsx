import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Wifi, WifiOff } from "lucide-react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
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

type ScreensT = TFunction<"screens", undefined>;

function statusLabel(
  status: PresentationNetworkReadiness["status"],
  t: ScreensT,
) {
  switch (status) {
    case "ready":
      return t("network.status.ready");
    case "connected":
      return t("network.status.connected");
    case "unassigned":
      return t("network.status.unassigned");
    case "wifi_adapter_unavailable":
      return t("network.status.wifiAdapter");
    case "network_manager_unavailable":
      return t("network.status.networkManager");
    case "helper_missing":
      return t("network.status.helperMissing");
    case "helper_unhealthy":
      return t("network.status.helperUnhealthy");
    case "configuration_pending":
      return t("network.status.configPending");
    case "reporting_pending":
      return t("network.status.reportingPending");
    case "failed":
      return t("network.status.failed");
    case "unsupported":
      return t("network.status.unsupported");
    default:
      return t("network.status.notApplicable");
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
  const { t } = useTranslation(["screens", "common"]);
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
          ? t("network.savedAssigned")
          : t("network.savedUnassigned"),
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
      if (!networkId) throw new Error(t("network.assignFirst"));
      return api.testPresentationNetwork(networkId, screen.id, csrfToken);
    },
    onSuccess: (result) => {
      toast.add({
        title: t("network.testRequested", { seconds: result.timeoutSeconds }),
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
            {t("network.title")}
          </h4>
          <p className="text-sm text-muted-foreground">{t("network.body")}</p>
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
          {statusLabel(data?.status ?? "reporting_pending", t)}
        </Badge>
      </div>
      {readiness.isLoading ? (
        <div className="space-y-2" aria-label={t("network.loading")}>
          <Skeleton className="h-8 w-full" />
          <Skeleton className="h-8 w-full" />
        </div>
      ) : readiness.error ? (
        <Alert variant="destructive">
          <WifiOff aria-hidden="true" />
          <AlertTitle>{t("network.loadError")}</AlertTitle>
          <AlertDescription>{readiness.error.message}</AlertDescription>
        </Alert>
      ) : (
        <>
          <dl className="grid gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("network.assigned")}
              </dt>
              <dd className="mt-1 break-words text-sm">
                {data?.presentationNetworkName ?? t("shared.none")}
                {assignedNetwork && !assignedNetwork.credentialSet
                  ? t("network.credentialMissing")
                  : ""}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("network.playerStatus")}
              </dt>
              <dd className="mt-1 break-words text-sm">
                {data?.detail ?? t("network.waitingStatus")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("network.wifi")}
              </dt>
              <dd className="mt-1 text-sm">
                {data?.wifiAdapterPresent == null
                  ? t("shared.notReported")
                  : data.wifiAdapterPresent
                    ? t("detail.available")
                    : t("network.unavailable")}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {t("network.ethernet")}
              </dt>
              <dd className="mt-1 break-words text-sm">
                {data?.wiredIpv4
                  ? `${data.wiredIpv4}${data.wiredInterfaceAvailable === false ? t("network.ifaceUnavailable") : ""}`
                  : data?.wiredInterfaceAvailable === false
                    ? t("network.unavailable")
                    : t("shared.notReported")}
              </dd>
            </div>
          </dl>
          {data?.limitation && (
            <Alert>
              <AlertDescription>
                {t("network.limitation", { detail: data.limitation })}
              </AlertDescription>
            </Alert>
          )}
        </>
      )}
      {canManage && (
        <div className="grid gap-3 border-t border-border pt-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
          <label className="grid min-w-0 gap-1.5 text-sm font-medium">
            <span>{t("network.assignLabel")}</span>
            <span className="text-xs font-normal text-muted-foreground">
              {t("network.assignHint")}
            </span>
            <Select
              items={[
                { value: "__unassigned__", label: t("network.noNetwork") },
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
                aria-label={t("network.assignLabel")}
                disabled={networks.isLoading || assignment.isPending}
              >
                <SelectValue placeholder={t("network.noNetwork")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__unassigned__">
                  {t("network.noNetwork")}
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
              {assignment.isPending
                ? t("common:actions.saving")
                : t("network.save")}
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
                {test.isPending ? t("network.testing") : t("network.test")}
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
          {t("network.viewerNote")}
        </p>
      )}
      {data?.status === "unassigned" && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <WifiOff size={14} aria-hidden="true" /> {t("network.ethernetOnly")}
        </p>
      )}
      {(data?.status === "ready" || data?.status === "connected") && (
        <p className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Wifi size={14} aria-hidden="true" /> {t("network.ethernetDefault")}
        </p>
      )}
    </section>
  );
}
