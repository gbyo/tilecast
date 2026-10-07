import {
  canManageScreens,
  screenKeys,
  screenQueries,
  SCREEN_STATUS_REFRESH_MS,
} from "../data/screens";

import { formatBytes } from "../lib/formatBytes";
import { settingsQueries } from "../data/settings";
import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Airplay,
  CircleAlert,
  Link2,
  Monitor,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldOff,
  Search,
  TriangleAlert,
  Wifi,
  WifiOff,
  X,
  Plus,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useForm } from "react-hook-form";
import {
  Link,
  Outlet,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api } from "../api/client";
import { apiErrorMessage, useFormatLocale } from "../i18n";
import { useDesktopLayout } from "../hooks/use-desktop-layout";
import type {
  Location,
  MapCoordinates,
  PlayerCommandType,
  ReliabilityStatus,
  Screen,
  ScreenStatus,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import type { ApprovalForm } from "../pairing/pairingFlow";
import {
  LocationPicker,
  makeApprovalSchema,
} from "../pairing/PairingDetailsForm";
import { PairScreenDialog } from "../pairing/PairScreenDialog";
import {
  AddBrowserPlayer,
  BrowserRecoveryPanel,
} from "../screens/browser/BrowserPlayerControls";
import { BrowserCommandPanel } from "../screens/browser/BrowserCommandPanel";
import { BrowserPlayerDiagnostics } from "../screens/browser/BrowserPlayerDiagnostics";
import { screenRunsBrowserPlayer } from "../screens/commandApplicability";
import { PendingPairings } from "../pairing/PendingPairings";
import { useNativePairScreen } from "../pairing/useNativePairScreen";
import { AirPlayPresentDialog } from "../components/AirPlayPresentDialog";
import { ScreenDetailPanel } from "../screens/detail/ScreenDetailPanel";
import { ScreenPlaybackCard } from "../screens/detail/ScreenPlaybackCard";
import { ScreenScheduleCard } from "../screens/detail/ScreenScheduleCard";
import { PlaybackExplanationPanel } from "../screens/detail/PlaybackExplanationPanel";
import { ScreenPlaybackDiagnostics } from "../screens/detail/ScreenPlaybackDiagnostics";
import { DashboardSearch } from "../components/DashboardListToolbar";
import { useCompactLayout } from "../hooks/use-compact-layout";
import {
  fleetFilterKeys,
  screenNeedsAttention,
  tallyFleet,
  type FleetFilterKey,
  type FleetFilterValues,
} from "../screens/fleet/fleetModel";
import {
  fleetPreferenceKeys,
  useFleetPreference,
} from "../screens/fleet/fleetPreferences";
import {
  FleetFilters,
  type FleetFilterSources,
} from "../screens/fleet/FleetFilters";
import { FleetSummary } from "../screens/fleet/FleetSummary";
import {
  FleetGroupSort,
  FleetViewOptionsMenu,
  FleetViewToggle,
  type FleetView,
} from "../screens/fleet/FleetViewControls";
import { PageHeader } from "../components/PageHeader";
import { ScreenPresentationNetworkPanel } from "../components/ScreenPresentationNetworkPanel";
import { QuickPresentDialog } from "../components/QuickPresentDialog";
import { FireTvAccessibilityAdbPanel } from "../components/FireTvAccessibilityAdbPanel";
import { PlayerPolicyEditor } from "../settings/PlayerPolicyEditor";
import { formatLocationAddress } from "../settings/LocationsPanel";
import { isAndroidScreen } from "../playerPlatform";

import {
  livePreviewState,
  previewAge,
  previewRailState,
} from "../components/livePreviewState";
import { PreviewFreshnessRail } from "../components/PreviewFreshnessRail";
import { screenRowActionGroups } from "../components/screenActions";
import {
  ActionMenuButton,
  type StudioActionGroup,
} from "../components/studio/ActionMenu";
import { ScreenFleetMap } from "../components/ScreenFleetMap";
import { ScreenFleetTable } from "../components/ScreenFleetTable";
import { ScreenPositionPicker } from "../components/ScreenPositionPicker";
import {
  ScreenActivityPanel,
  ScreenActivitySummary,
} from "../components/ScreenActivityPanel";
import { LivePreviewPanel } from "../components/LivePreviewPanel";
import { SnapshotHistoryPanel } from "../components/SnapshotHistoryPanel";
import { AspectRatio } from "../components/ui/aspect-ratio";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { toast } from "../components/ui/toast";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { ButtonGroup } from "../components/ui/button-group";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/ui/card";
import { Checkbox } from "../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleChevron,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/studio/StudioCollapsible";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "../components/ui/alert-dialog";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import { Field, FieldError, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import { Textarea } from "../components/ui/textarea";
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Skeleton } from "../components/ui/skeleton";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";

const GRID_PREVIEW_LEASE_RENEWAL_MILLIS = 30_000;
const GRID_PREVIEW_METADATA_REFRESH_MILLIS = 10_000;
const GRID_PREVIEW_AGE_REFRESH_MILLIS = 10_000;

export type ScreensT = TFunction<"screens", undefined>;

export type ScreenManageSection =
  "playback" | "device" | "health" | "maintenance";

const screenManageSections: readonly ScreenManageSection[] = [
  "playback",
  "device",
  "health",
  "maintenance",
];

export function normalizeScreenManageSection(
  requestedTab: string,
  requestedSection: string | null,
): ScreenManageSection {
  if (requestedTab === "reliability") return "health";
  if (requestedTab === "commands") return "maintenance";
  if (requestedTab === "device" && !requestedSection) return "device";
  return screenManageSections.includes(requestedSection as ScreenManageSection)
    ? (requestedSection as ScreenManageSection)
    : "device";
}

export type ScreenDetailTab = "overview" | "activity" | "settings";
type ScreenTabDestination = {
  tab: ScreenDetailTab;
};
type ScreenCommandAction =
  | {
      kind: "confirm";
      title: string;
      description: string;
      confirmLabel: string;
      destructive?: boolean;
      commandType: PlayerCommandType;
      payload: Record<string, unknown>;
    }
  | {
      kind: "input";
      title: string;
      description: string;
      confirmLabel: string;
      input: {
        label: string;
        type: "text" | "number";
        min?: number;
        max?: number;
        placeholder?: string;
      };
      commandType: PlayerCommandType;
      createPayload: (value: string | number) => Record<string, unknown>;
    };

const screenDetailTabs: readonly ScreenDetailTab[] = [
  "overview",
  "activity",
  "settings",
];

type ScreenDetailTabLabelKey =
  "detail.tabOverview" | "detail.tabActivity" | "detail.tabSettings";

const screenDetailTabLabels: Record<ScreenDetailTab, ScreenDetailTabLabelKey> =
  {
    overview: "detail.tabOverview",
    activity: "detail.tabActivity",
    settings: "detail.tabSettings",
  };

/**
 * Primary Screen-detail navigation. The same three-tab strip is used at every
 * breakpoint so operators do not have to relearn the resource on mobile.
 */
export function ScreenDetailTabs({ policyDirty }: { policyDirty: boolean }) {
  const { t } = useTranslation(["screens", "common"]);
  const options = screenDetailTabs.map((value) => ({
    value,
    label: t(screenDetailTabLabels[value]),
  }));
  return (
    <TabsList
      aria-label={t("detail.tabsLabel")}
      variant="line"
      className="grid min-h-10 w-full grid-cols-3 rounded-none border-b border-border p-0 sm:flex sm:justify-start sm:gap-4"
    >
      {options.map((option) => (
        <TabsTrigger
          key={option.value}
          value={option.value}
          className="min-w-0 px-2 sm:flex-none"
        >
          <span className="truncate">{option.label}</span>
          {option.value === "settings" && policyDirty && (
            <Badge variant="secondary">{t("detail.unsavedBadge")}</Badge>
          )}
        </TabsTrigger>
      ))}
    </TabsList>
  );
}

export function normalizeScreenDetailTab(
  requestedTab: string | null,
  requestedSection: string | null = null,
): ScreenDetailTab {
  if (
    !requestedTab ||
    requestedTab === "snapshots" ||
    requestedTab === "content"
  )
    return "overview";
  if (requestedTab === "manage")
    return requestedSection === "settings" ? "settings" : "overview";
  if (requestedTab === "player-settings") return "settings";
  if (
    requestedTab === "device" ||
    requestedTab === "reliability" ||
    requestedTab === "commands"
  )
    return "overview";
  return screenDetailTabs.includes(requestedTab as ScreenDetailTab)
    ? (requestedTab as ScreenDetailTab)
    : "overview";
}
export const formatReportedStatus = (
  value: unknown,
  t: ScreensT,
  fallback?: string,
) =>
  typeof value === "string" && value.trim()
    ? value.replaceAll("_", " ")
    : (fallback ?? t("shared.notReported"));
const formatReportedCount = (value: unknown, fallback = 0) =>
  typeof value === "number" && Number.isFinite(value) ? value : fallback;
/**
 * Whether this screen reports Linux systemd autostart at all. Android players
 * and Linux players older than autostart support both report nothing, and the
 * Linux-specific controls stay hidden for them.
 */
export const reportsAutostart = (status?: ReliabilityStatus) =>
  typeof status?.autostartState === "string" && status.autostartState !== "";

/**
 * One-line autostart summary. Keeps "installed" and "verified at boot"
 * separate on purpose: an enabled unit is a promise about the next boot, while
 * a cold-boot launch is evidence that the promise held.
 */
export const autostartSummary = (
  status: ReliabilityStatus | undefined,
  t: ScreensT,
): string => {
  const target = status?.autostartTarget ? ` · ${status.autostartTarget}` : "";
  switch (status?.autostartState) {
    case "installed":
      return status?.bootLaunchVerified
        ? t("detail.autostart.installedVerified", { target })
        : t("detail.autostart.installedUnverified", { target });
    case "not_installed":
      return t("detail.autostart.notInstalled");
    case "needs_attention":
      return `${t("detail.autostart.needsAttention")}${status?.autostartError ? ` · ${status.autostartError}` : ""}`;
    case "unsupported":
      return `${t("detail.autostart.unsupported")}${status?.autostartError ? ` · ${status.autostartError}` : ""}`;
    case "unknown":
      // The probe itself failed. Distinct from a device that reports nothing:
      // there is a device, it tried, and it carries the reason.
      return `${t("detail.autostart.unknown")}${status?.autostartError ? ` · ${status.autostartError}` : ""}`;
    default:
      return t("shared.notReported");
  }
};

/**
 * What still stands between this screen and an unattended boot. The player
 * owns its own service; it cannot create the graphical session that service
 * renders into, so those gaps are named rather than implied.
 */
export const autostartWarning = (
  status: ReliabilityStatus | undefined,
  t: ScreensT,
) => {
  if (!reportsAutostart(status)) return undefined;
  if (status?.autostartState === "not_installed")
    return t("detail.autostart.warnNotInstalled");
  if (status?.autostartState === "needs_attention")
    return t("detail.autostart.warnNeedsAttention");
  if (status?.autostartState === "unknown")
    return status.autostartError
      ? t("detail.autostart.warnUnknownWithError", {
          error: status.autostartError,
        })
      : t("detail.autostart.warnUnknown");
  if (
    status?.autostartState === "installed" &&
    status.autostartTarget === "default.target" &&
    status.autostartLingerEnabled === false
  )
    return t("detail.autostart.warnNoLinger");
  return undefined;
};

export const reliabilityCapabilityWarning = (
  status: ReliabilityStatus | undefined,
  t: ScreensT,
) => {
  if (
    status?.configuredMode === "managed_kiosk" &&
    status.effectiveMode !== "managed_kiosk"
  )
    return t("detail.warnManagedKiosk");
  if (status?.accessibilityServiceState === "policy_enabled_service_disabled")
    return t("detail.warnAccessibility");
  if (status?.sleepCapability === "black_screen_only")
    return t("detail.warnSleepFallback");
  return undefined;
};
export const zeroTouchReadiness = (
  status: ReliabilityStatus | undefined,
  t: ScreensT,
): string => {
  if (!status || !status.commissioningState) return t("detail.readiness.setup");
  if (status.bootRecoveryResult === "unsupported")
    return t("detail.readiness.unsupported");
  if (status.commissioningState !== "complete")
    return t("detail.readiness.setup");
  if (
    status.accessibilityServiceState === "enabled" &&
    status.bootLaunchVerified &&
    status.immersiveModeActive &&
    status.keepScreenOn &&
    status.updateReadiness === "ready" &&
    !status.safeMode
  )
    return t("detail.readiness.ready");
  return t("detail.readiness.partial");
};
export function resolveScreenDetail(
  detail: Screen | null | undefined,
  listed: Screen | undefined,
): Screen | undefined {
  if (!detail) return listed;
  if (!listed) return detail;
  return { ...detail, status: listed.status };
}

const statusContent: Record<
  ScreenStatus,
  {
    labelKey:
      | "status.online"
      | "status.recent"
      | "status.stale"
      | "status.offline"
      | "status.disabled"
      | "status.revoked"
      | "status.awaiting_player";
    Icon: typeof Wifi;
  }
> = {
  online: { labelKey: "status.online", Icon: Wifi },
  recent: { labelKey: "status.recent", Icon: Wifi },
  stale: { labelKey: "status.stale", Icon: CircleAlert },
  offline: { labelKey: "status.offline", Icon: WifiOff },
  disabled: { labelKey: "status.disabled", Icon: ShieldOff },
  revoked: { labelKey: "status.revoked", Icon: ShieldOff },
  awaiting_player: { labelKey: "status.awaiting_player", Icon: WifiOff },
};

export function ScreensWorkspacePage() {
  const { t } = useTranslation("screens");
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const manageable = canManageScreens(auth.status?.user);
  const screens = useQuery({
    ...screenQueries.list(),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  const archive =
    location.pathname === "/screens/archive" ||
    location.pathname.startsWith("/screens/archive/");
  const activeTab = archive ? "archive" : "fleet";
  const openPairScreen = useNativePairScreen();
  const [statusFilter, setStatusFilter] = useFleetPreference<string>(
    fleetPreferenceKeys.status,
    "",
  );
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const takeoverCount = useActiveTakeoverCount(manageable && !archive);
  const takeoverActions: StudioActionGroup[] =
    manageable && !archive
      ? [
          {
            actions: [
              {
                id: "takeover",
                label:
                  takeoverCount > 0
                    ? `${t("takeover.title")} · ${t("takeover.activeBadge", { count: takeoverCount })}`
                    : t("takeover.title"),
                onSelect: () => setTakeoverOpen(true),
              },
            ],
          },
        ]
      : [];

  return (
    <div className="w-full min-w-0 space-y-4">
      {/* The Studio top bar names the page, as on Overview. The h1 stays for
          document structure and assistive technology. */}
      <h1 className="sr-only">{t("page.title")}</h1>
      <FleetSummary
        screens={screens.data?.items ?? []}
        loading={screens.isLoading}
        statusFilter={statusFilter}
        onStatusFilter={setStatusFilter}
        showStatus={!archive}
        actions={
          <>
            {manageable && (
              <Link
                className={buttonVariants({ variant: "default", size: "sm" })}
                to="/screens/pair"
                onClick={(event) =>
                  void openPairScreen(event, ["pair-screen"], "/screens/pair")
                }
              >
                <Plus aria-hidden="true" /> {t("page.pairScreen")}
              </Link>
            )}
            {manageable && !archive && <AddBrowserPlayer />}
            <ActionMenuButton
              label={t("page.moreActions")}
              actions={takeoverActions}
              size="icon-sm"
            />
          </>
        }
      />
      {manageable && !archive && (
        <TakeoverDialogs
          screens={screens.data?.items ?? []}
          open={takeoverOpen}
          onOpenChange={setTakeoverOpen}
        />
      )}
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          void navigate(value === "archive" ? "/screens/archive" : "/screens")
        }
        className="min-w-0 gap-3"
      >
        <TabsList variant="line" aria-label={t("page.viewsAriaLabel")}>
          <TabsTrigger value="fleet">{t("page.fleetTab")}</TabsTrigger>
          <TabsTrigger value="archive">{t("page.archiveTab")}</TabsTrigger>
        </TabsList>
        <TabsContent value={activeTab} className="min-w-0 outline-none">
          <Outlet />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export function ScreensPage() {
  const auth = useAuth();
  const manageable = canManageScreens(auth.status?.user);
  const screens = useQuery({
    ...screenQueries.list(),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  const pending = useQuery({
    ...screenQueries.pendingPairings(),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
    enabled: manageable,
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
  });
  return (
    <div className="w-full min-w-0 space-y-5">
      <ActiveTakeoverBanners canManage={manageable} />
      {screens.isError && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(screens.error)}</AlertDescription>
        </Alert>
      )}
      <PendingPairings
        requests={pending.data?.items ?? []}
        canManage={manageable}
      />
      <ScreenListContent
        screens={screens.data?.items ?? []}
        loading={screens.isLoading}
        canManage={manageable}
        locations={locations.data?.items ?? []}
        locationsError={locations.isError}
        csrfToken={auth.status?.csrfToken ?? ""}
        onRefresh={async () => {
          await Promise.all([screens.refetch(), locations.refetch()]);
        }}
      />
    </div>
  );
}

const useTakeovers = (enabled = true) =>
  useQuery({
    queryKey: ["takeovers"],
    queryFn: api.takeovers,
    refetchInterval: 10_000,
    enabled,
  });

function useActiveTakeoverCount(enabled: boolean) {
  const takeovers = useTakeovers(enabled);
  return (takeovers.data?.items ?? []).filter(
    (item) => item.status === "active",
  ).length;
}

/* A takeover is rare, high-impact, and irreversible from the player's
   point of view, so it stays a quiet header action until one is actually running.
   While a takeover is active the banner below becomes the loudest thing on the
   page, which is the only time the danger treatment is truthful. */
function ActiveTakeoverBanners({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const takeovers = useTakeovers();
  const [canceling, setCanceling] = useState<{
    id: string;
    name: string;
  } | null>(null);
  const [cancelReason, setCancelReason] = useState("");
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.cancelTakeover(id, reason, auth.status?.csrfToken ?? ""),
    onSuccess: async () => {
      setCanceling(null);
      setCancelReason("");
      toast.add({ title: "Takeover ended.", type: "success" });
      await queryClient.invalidateQueries({ queryKey: ["takeovers"] });
    },
  });
  const active = (takeovers.data?.items ?? []).filter(
    (item) => item.status === "active",
  );
  if (active.length === 0) return null;
  return (
    <>
      <div className="space-y-2">
        {active.map((item) => (
          <Alert
            key={item.id}
            variant="destructive"
            className="flex flex-wrap items-start gap-x-3 gap-y-2"
          >
            <ShieldAlert
              className="mt-0.5 size-4 shrink-0"
              aria-hidden="true"
            />
            <div className="min-w-0 flex-1 space-y-1">
              <AlertTitle>
                {t("takeover.activeBanner", { name: item.name })}
              </AlertTitle>
              <AlertDescription>
                {t("takeover.bannerBody", {
                  playlist: item.playlistName,
                  expires: new Date(item.expiresAt).toLocaleString(
                    formatLocale,
                  ),
                })}
              </AlertDescription>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
                <li>
                  {t("takeover.stats.playing", { count: item.activeCount })}
                </li>
                <li>
                  {t("takeover.stats.preparing", {
                    count: item.preparingCount,
                  })}
                </li>
                <li>
                  {t("takeover.stats.failed", { count: item.failedCount })}
                </li>
                <li>
                  {t("takeover.stats.targeted", { count: item.affectedCount })}
                </li>
              </ul>
            </div>
            {canManage && (
              <Button
                variant="destructive"
                size="sm"
                type="button"
                onClick={() => {
                  setCancelReason("");
                  setCanceling({ id: item.id, name: item.name });
                }}
              >
                {t("takeover.end")}
              </Button>
            )}
          </Alert>
        ))}
      </div>
      <Dialog
        open={canceling !== null}
        onOpenChange={(open) => {
          if (!open) setCanceling(null);
        }}
      >
        <DialogContent>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (canceling) {
                cancel.mutate({
                  id: canceling.id,
                  reason: cancelReason.trim(),
                });
              }
            }}
          >
            <DialogHeader>
              <DialogTitle>
                {t("takeover.endTitle", { name: canceling?.name ?? "" })}
              </DialogTitle>
              <DialogDescription>{t("takeover.endBody")}</DialogDescription>
            </DialogHeader>
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-cancel-reason"
                className="text-sm font-medium"
              >
                {t("takeover.reasonLabel")}
              </FieldLabel>
              <Input
                id="takeover-cancel-reason"
                value={cancelReason}
                maxLength={500}
                onChange={(event) => setCancelReason(event.target.value)}
              />
            </Field>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setCanceling(null)}
              >
                {t("takeover.keepActive")}
              </Button>
              <Button
                variant="destructive"
                type="submit"
                disabled={!canceling || cancel.isPending}
              >
                {cancel.isPending ? t("takeover.ending") : t("takeover.end")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function FleetHoldButton({
  holdMs = 3000,
  onHoldComplete,
  children,
  holdingLabel,
  hint,
  disabled,
}: {
  holdMs?: number;
  onHoldComplete: () => void;
  children: ReactNode;
  holdingLabel?: ReactNode;
  hint?: ReactNode;
  disabled?: boolean;
}) {
  const [progress, setProgress] = useState(0);
  const [holding, setHolding] = useState(false);
  const frame = useRef<number | null>(null);
  const hintId = useId();

  const stop = useCallback(() => {
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setHolding(false);
    setProgress(0);
  }, []);
  useEffect(() => stop, [stop]);

  const start = useCallback(() => {
    if (disabled || frame.current !== null) return;
    const started = performance.now();
    setHolding(true);
    const tick = () => {
      const ratio = Math.min(1, (performance.now() - started) / holdMs);
      setProgress(ratio);
      if (ratio < 1) {
        frame.current = requestAnimationFrame(tick);
        return;
      }
      frame.current = null;
      setHolding(false);
      setProgress(0);
      onHoldComplete();
    };
    frame.current = requestAnimationFrame(tick);
  }, [disabled, holdMs, onHoldComplete]);

  return (
    <div className="grid justify-items-start gap-1.5">
      <Button
        variant="destructive"
        type="button"
        disabled={disabled}
        aria-describedby={hint ? hintId : undefined}
        className="relative isolate overflow-hidden"
        onPointerDown={(event) => {
          if (event.button === 0) start();
        }}
        onPointerUp={stop}
        onPointerCancel={stop}
        onPointerLeave={stop}
        onBlur={stop}
        onKeyDown={(event) => {
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          start();
        }}
        onKeyUp={(event) => {
          if (event.key === " " || event.key === "Enter") stop();
        }}
      >
        <span
          aria-hidden="true"
          className="pointer-events-none absolute inset-y-0 left-0 -z-10 bg-destructive/20"
          style={{ width: `${progress * 100}%` }}
        />
        {holding && holdingLabel ? holdingLabel : children}
      </Button>
      {hint && (
        <span id={hintId} className="text-xs text-muted-foreground">
          {hint}
        </span>
      )}
    </div>
  );
}

const takeoverExpiryOptions = [
  { value: "15", labelKey: "takeover.expiry.minutes15" },
  { value: "60", labelKey: "takeover.expiry.hour1" },
  { value: "240", labelKey: "takeover.expiry.hours4" },
  { value: "1440", labelKey: "takeover.expiry.hours24" },
] as const;

/* Takeover is reached from the page's overflow menu, so its dialogs are
   controlled by the page instead of owning a trigger button. */
function TakeoverDialogs({
  screens,
  open,
  onOpenChange: setOpen,
}: {
  screens: Screen[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [activationPassword, setActivationPassword] = useState("");
  const [name, setName] = useState("");
  const [playlistId, setPlaylistId] = useState("");
  const [screenIds, setScreenIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(60);
  const playlists = useQuery({
    queryKey: ["playlists", "takeover"],
    queryFn: () => api.playlists(),
    enabled: open,
  });
  const groups = useQuery({
    queryKey: ["screen-groups", "takeover"],
    queryFn: () => api.screenGroups(),
    enabled: open,
  });
  const runtimeSettings = useQuery({
    ...settingsQueries.organization(),
    enabled: open,
  });
  const activate = useMutation({
    mutationFn: (password: string) =>
      api.activateTakeover(
        {
          name,
          description: "",
          playlistId,
          screenIds,
          groupIds,
          expiresAt: new Date(Date.now() + minutes * 60_000).toISOString(),
          password,
        },
        auth.status?.csrfToken ?? "",
      ),
    onSuccess: async () => {
      toast.add({ title: "Takeover started.", type: "success" });
      setOpen(false);
      setPasswordOpen(false);
      setConfirmationOpen(false);
      setActivationPassword("");
      setName("");
      setPlaylistId("");
      setScreenIds([]);
      setGroupIds([]);
      await queryClient.invalidateQueries({ queryKey: ["takeovers"] });
    },
  });
  const offlineSelected = screens.filter(
    (item) => screenIds.includes(item.id) && item.status !== "online",
  ).length;
  /* Taking over the whole fleet at once is the one shape of this action with no
     screen left showing normal content, so it is the one that has to be held
     rather than clicked. Ticking every box by hand counts the same as using the
     All screens toggle. */
  const everyScreenSelected =
    screens.length > 0 && screens.every((item) => screenIds.includes(item.id));
  const ready = Boolean(
    name && playlistId && (screenIds.length > 0 || groupIds.length > 0),
  );
  const requiresPassword = Boolean(
    runtimeSettings.data?.values["takeover.reauthentication_required"],
  );
  const continueActivation = () => {
    if (requiresPassword) {
      setActivationPassword("");
      setPasswordOpen(true);
    } else {
      activate.mutate("");
    }
  };
  const beginActivation = (heldForAllScreens: boolean) => {
    // A completed three-second hold already confirms a fleet-wide takeover.
    if (heldForAllScreens) continueActivation();
    else setConfirmationOpen(true);
  };
  return (
    <>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(90dvh,54rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("takeover.title")}</DialogTitle>
            <DialogDescription>{t("takeover.dialogBody")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-name"
                className="text-sm font-medium"
              >
                {t("takeover.nameLabel")}
              </FieldLabel>
              <Input
                id="takeover-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={180}
              />
            </Field>
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-playlist"
                className="text-sm font-medium"
              >
                {t("takeover.playlistLabel")}
              </FieldLabel>
              <Select
                items={(playlists.data?.items ?? []).map((playlist) => ({
                  value: playlist.id,
                  label: playlist.name,
                }))}
                value={playlistId || null}
                onValueChange={(value) => setPlaylistId(value ?? "")}
              >
                <SelectTrigger id="takeover-playlist" className="w-full">
                  <SelectValue
                    placeholder={t("takeover.playlistPlaceholder")}
                  />
                </SelectTrigger>
                <SelectContent>
                  {playlists.data?.items?.map((playlist) => (
                    <SelectItem key={playlist.id} value={playlist.id}>
                      {playlist.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-duration"
                className="text-sm font-medium"
              >
                {t("takeover.expiresLabel")}
              </FieldLabel>
              <Select
                items={takeoverExpiryOptions.map((option) => ({
                  value: option.value,
                  label: t(option.labelKey),
                }))}
                value={String(minutes)}
                onValueChange={(value) => {
                  if (value) setMinutes(Number(value));
                }}
              >
                <SelectTrigger id="takeover-duration" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {takeoverExpiryOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {t(option.labelKey)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Field>
            <fieldset className="grid gap-3 border-t border-border pt-4">
              <legend className="text-sm font-semibold">
                {t("takeover.targetScreens")}
              </legend>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  aria-pressed={everyScreenSelected}
                  disabled={screens.length === 0}
                  onClick={() =>
                    setScreenIds(
                      everyScreenSelected ? [] : screens.map((item) => item.id),
                    )
                  }
                >
                  {t("takeover.allScreens")}
                </Button>
                <span className="text-sm text-muted-foreground">
                  {t("takeover.fleetCount", { count: screens.length })}
                </span>
              </div>
              <div className="grid gap-2 sm:grid-cols-2">
                {screens.map((item) => (
                  <label
                    className="flex min-w-0 items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                    key={item.id}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={screenIds.includes(item.id)}
                      onCheckedChange={(checked) =>
                        setScreenIds((ids) =>
                          checked
                            ? [...ids, item.id]
                            : ids.filter((id) => id !== item.id),
                        )
                      }
                    />
                    <span className="grid min-w-0 gap-0.5">
                      {item.name}
                      <small className="text-xs text-muted-foreground">
                        {statusLabel(item.status, t)}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="grid gap-3 border-t border-border pt-4">
              <legend className="text-sm font-semibold">
                {t("takeover.targetGroups")}
              </legend>
              <div className="grid gap-2 sm:grid-cols-2">
                {groups.data?.items?.map((group) => (
                  <label
                    className="flex min-w-0 items-start gap-2 rounded-lg border border-border px-3 py-2 text-sm"
                    key={group.id}
                  >
                    <Checkbox
                      className="mt-0.5"
                      checked={groupIds.includes(group.id)}
                      onCheckedChange={(checked) =>
                        setGroupIds((ids) =>
                          checked
                            ? [...ids, group.id]
                            : ids.filter((id) => id !== group.id),
                        )
                      }
                    />
                    <span className="grid min-w-0 gap-0.5">
                      {group.name}
                      <small className="text-xs text-muted-foreground">
                        {t("takeover.groupMemberCount", {
                          count: group.membershipCount,
                        })}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
          {activate.error && !passwordOpen && (
            <Alert variant="destructive">
              <CircleAlert aria-hidden="true" />
              <AlertTitle>{t("takeover.activateError")}</AlertTitle>
              <AlertDescription>
                {apiErrorMessage(activate.error)}
              </AlertDescription>
            </Alert>
          )}
          <DialogFooter className="border-t border-border pt-4 sm:justify-between">
            <p className="text-sm text-muted-foreground sm:mr-auto">
              {everyScreenSelected ? (
                <strong>
                  {t("takeover.summaryAll", { count: screens.length })}
                </strong>
              ) : (
                t("takeover.summarySelected", { count: screenIds.length })
              )}{" "}
              {t("takeover.summaryGroups", { count: groupIds.length })}
              {offlineSelected > 0
                ? ` ${t("takeover.summaryOffline", { count: offlineSelected })}`
                : ""}
              .
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                type="button"
                onClick={() => setOpen(false)}
              >
                {t("common:actions.cancel")}
              </Button>
              {everyScreenSelected ? (
                <FleetHoldButton
                  holdMs={3000}
                  disabled={!ready || activate.isPending}
                  holdingLabel={t("takeover.keepHolding")}
                  hint={t("takeover.holdHint")}
                  onHoldComplete={() => beginActivation(true)}
                >
                  {activate.isPending
                    ? t("takeover.activating")
                    : t("takeover.holdToActivate")}
                </FleetHoldButton>
              ) : (
                <Button
                  variant="destructive"
                  type="button"
                  disabled={!ready || activate.isPending}
                  onClick={() => beginActivation(false)}
                >
                  {activate.isPending
                    ? t("takeover.activating")
                    : t("takeover.activate")}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("takeover.confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("takeover.confirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("takeover.reviewTargets")}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmationOpen(false);
                continueActivation();
              }}
            >
              {t("takeover.activate")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog open={passwordOpen} onOpenChange={setPasswordOpen}>
        <DialogContent>
          <form
            className="space-y-5"
            onSubmit={(event) => {
              event.preventDefault();
              if (!activationPassword) return;
              activate.mutate(activationPassword);
            }}
          >
            <DialogHeader>
              <DialogTitle>{t("takeover.passwordTitle")}</DialogTitle>
              <DialogDescription>
                {t("takeover.passwordBody")}
              </DialogDescription>
            </DialogHeader>
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-current-password"
                className="text-sm font-medium"
              >
                {t("takeover.currentPassword")}
              </FieldLabel>
              <Input
                id="takeover-current-password"
                type="password"
                autoComplete="current-password"
                autoFocus
                value={activationPassword}
                onChange={(event) => setActivationPassword(event.target.value)}
              />
            </Field>
            {activate.error && (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{t("takeover.activateError")}</AlertTitle>
                <AlertDescription>
                  {apiErrorMessage(activate.error)}
                </AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setPasswordOpen(false)}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button
                type="submit"
                disabled={!activationPassword || activate.isPending}
              >
                {activate.isPending
                  ? t("takeover.activating")
                  : t("takeover.confirmAction")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function ArchiveScreenDialog({
  screen,
  csrfToken,
  open,
  onOpenChange,
  onArchived,
}: {
  screen: Screen;
  csrfToken: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onArchived?: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const queryClient = useQueryClient();
  const archive = useMutation({
    mutationFn: () =>
      api.revokeScreen(screen.id, t("detail.archiveReason"), csrfToken),
    onSuccess: async () => {
      toast.add({
        title: t("detail.archiveSuccess", { name: screen.name }),
        type: "success",
      });
      onOpenChange(false);
      onArchived?.();
      await queryClient.invalidateQueries({ queryKey: screenKeys.all });
    },
  });

  return (
    <AlertDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!archive.isPending) onOpenChange(nextOpen);
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {t("detail.archiveConfirmTitle", { name: screen.name })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("detail.archiveConfirmBody")}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {archive.error && (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertDescription>
              {apiErrorMessage(archive.error)}
            </AlertDescription>
          </Alert>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={archive.isPending}>
            {t("common:actions.cancel")}
          </AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={archive.isPending}
            onClick={(event) => {
              event.preventDefault();
              archive.mutate();
            }}
          >
            {t("detail.archiveAction")}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export function ScreenListContent({
  screens,
  loading,
  canManage,
  locations: locationItems = [],
  locationsError = false,
  csrfToken = "",
  onRefresh,
}: {
  screens: Screen[];
  loading: boolean;
  canManage: boolean;
  locations?: Location[];
  locationsError?: boolean;
  csrfToken?: string;
  onRefresh?: () => Promise<unknown>;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const openPairScreen = useNativePairScreen();
  const [search, setSearch] = useFleetPreference<string>(
    fleetPreferenceKeys.search,
    "",
  );
  const [status, setStatus] = useFleetPreference<string>(
    fleetPreferenceKeys.status,
    "",
  );
  const [location, setLocation] = useFleetPreference<string>(
    fleetPreferenceKeys.location,
    "",
  );
  const [platform, setPlatform] = useFleetPreference<string>(
    fleetPreferenceKeys.platform,
    "",
  );
  const [playing, setPlaying] = useFleetPreference<string>(
    fleetPreferenceKeys.playing,
    "",
  );
  const [syncGroup, setSyncGroup] = useFleetPreference<string>(
    fleetPreferenceKeys.syncGroup,
    "",
  );
  const [orientation, setOrientation] = useFleetPreference<string>(
    fleetPreferenceKeys.orientation,
    "",
  );
  const [update, setUpdate] = useFleetPreference<string>(
    fleetPreferenceKeys.update,
    "",
  );
  const [groupBy, setGroupBy] = useFleetPreference<string>(
    fleetPreferenceKeys.groupBy,
    "location",
  );
  const [sort, setSort] = useFleetPreference<string>(
    fleetPreferenceKeys.sort,
    "name-asc",
  );
  const [view, setView] = useFleetPreference<FleetView>(
    fleetPreferenceKeys.view,
    "table",
  );
  const compact = useCompactLayout();
  const desktop = useDesktopLayout();
  const effectiveView = view === "map" ? "map" : desktop ? view : "grid";
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        JSON.parse(
          storageGet("session", "tilecast.screens.collapsed") ?? "[]",
        ) as string[],
      ),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [archiveTarget, setArchiveTarget] = useState<Screen | null>(null);
  const [bulkLocation, setBulkLocation] = useState("");
  const filtered = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return screens.filter((screen) => {
      const attention = needsAttention(screen);
      const statusMatch =
        !status ||
        (status === "attention" && attention) ||
        (status === "updating" && Boolean(screen.updateState)) ||
        (status === "syncing" && screen.updateState === "syncing") ||
        screen.status === status;
      const playingMatch =
        !playing ||
        (playing === "nothing" && !screen.nowPlayingName) ||
        screen.nowPlayingType === playing;
      const syncMatch =
        !syncGroup ||
        (syncGroup === "any" && Boolean(screen.syncGroupId)) ||
        (syncGroup === "none" && !screen.syncGroupId) ||
        screen.syncGroupId === syncGroup;
      const orientationValue =
        screen.screenHeight > screen.screenWidth ? "portrait" : "landscape";
      const updateMatch =
        !update ||
        (update === "current" && !screen.updateState && !screen.updateError) ||
        (update === "attention" && Boolean(screen.updateError)) ||
        screen.updateState === update;
      const haystack = [
        screen.name,
        screen.location,
        formatLocationAddress(screen.locationDetails),
        screen.roomName,
        screen.roomNumber,
        screen.platform,
        screen.deviceModel,
        screen.nowPlayingName,
      ]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return (
        (!needle || haystack.includes(needle)) &&
        statusMatch &&
        (!location || screen.locationId === location) &&
        (!platform || screen.platform === platform) &&
        playingMatch &&
        syncMatch &&
        (!orientation || orientation === orientationValue) &&
        updateMatch
      );
    });
  }, [
    location,
    orientation,
    platform,
    playing,
    screens,
    search,
    status,
    syncGroup,
    update,
  ]);
  const visibleGroups = useMemo(
    () => buildScreenGroups(filtered, groupBy, sort, t, formatLocale),
    [filtered, formatLocale, groupBy, sort, t],
  );
  const filterValues: FleetFilterValues = {
    status,
    location,
    platform,
    playing,
    syncGroup,
    orientation,
    update,
  };
  const filterSetters: Record<FleetFilterKey, (value: string) => void> = {
    status: setStatus,
    location: setLocation,
    platform: setPlatform,
    playing: setPlaying,
    syncGroup: setSyncGroup,
    orientation: setOrientation,
    update: setUpdate,
  };
  const filterSources = useMemo<FleetFilterSources>(
    () => ({
      locations: locationItems,
      platforms: [...new Set(screens.map((item) => item.platform))]
        .filter(Boolean)
        .sort()
        .map((value) => ({ value, label: platformLabel(value, t) })),
      displayGroups: [
        ...new Map(
          screens
            .filter((item) => item.syncGroupId)
            .map(
              (item) =>
                [
                  item.syncGroupId ?? "",
                  item.syncGroupName ?? t("list.syncOptions.fallback"),
                ] as const,
            ),
        ).entries(),
      ].map(([id, name]) => ({ id, name })),
    }),
    [locationItems, screens, t],
  );
  // Every active facet is shown and removable here, so the Filters count is
  // never the only sign that the fleet is narrowed.
  const facetLabels: Record<FleetFilterKey, string> = {
    status: t("list.statusFilter"),
    location: t("list.locationFilter"),
    platform: t("list.platformFilter"),
    playing: t("list.playingFilter"),
    syncGroup: t("list.groupFilter"),
    orientation: t("list.orientationFilter"),
    update: t("list.updateFilter"),
  };
  const facetValueLabel = (key: FleetFilterKey, value: string) => {
    switch (key) {
      case "status":
        return statusLabel(value, t);
      case "location":
        return locationItems.find((item) => item.id === value)?.name ?? value;
      case "platform":
        return platformLabel(value, t);
      case "playing":
        return value === "presentation"
          ? t("list.playingOptions.presentation")
          : value === "playlist"
            ? t("list.playingOptions.playlist")
            : t("shared.nothingAssigned");
      case "syncGroup":
        return syncGroupFilterLabel(value, screens, t);
      case "orientation":
        return value === "portrait"
          ? t("list.orientationOptions.portrait")
          : t("list.orientationOptions.landscape");
      case "update":
        return updateLabel(value, t);
    }
  };
  const activeFacets = fleetFilterKeys
    .filter((key) => filterValues[key] !== "")
    .map((key) => ({
      key,
      facet: facetLabels[key],
      value: facetValueLabel(key, filterValues[key]),
      remove: () => filterSetters[key](""),
    }));
  const anyFilterActive = Boolean(search) || activeFacets.length > 0;
  const resetFacets = () => {
    for (const key of fleetFilterKeys) filterSetters[key]("");
  };
  const clearFilters = () => {
    setSearch("");
    resetFacets();
  };
  const setGroupCollapsed = (key: string, isCollapsed: boolean) => {
    const next = new Set(collapsed);
    if (isCollapsed) next.add(key);
    else next.delete(key);
    setCollapsed(next);
    storageSet(
      "session",
      "tilecast.screens.collapsed",
      JSON.stringify([...next]),
    );
  };
  const restartSelected = async () => {
    const ids = [...selected];
    try {
      await toast.promise(
        Promise.all(
          ids.map((id) =>
            api.createScreenCommand(
              id,
              "restart_player_process",
              {},
              csrfToken,
            ),
          ),
        ),
        {
          loading: `Requesting restart for ${ids.length} screens…`,
          success: `Restart requested for ${ids.length} screens.`,
          error: "The restart request could not be sent.",
        },
      );
    } catch {
      return;
    }
    setSelected(new Set());
  };
  const changeSelectedLocation = async () => {
    const chosen = bulkLocation || undefined;
    await Promise.all(
      screens
        .filter((screen) => selected.has(screen.id))
        .map((screen) =>
          api.updateScreen(
            screen.id,
            {
              name: screen.name,
              description: screen.description,
              locationId: chosen,
              roomName: screen.roomName ?? "",
              roomNumber: screen.roomNumber ?? "",
            },
            csrfToken,
          ),
        ),
    );
    setSelected(new Set());
    await onRefresh?.();
  };
  if (loading)
    return (
      <div className="space-y-2" aria-label={t("list.loading")}>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-14 w-full" />
        ))}
      </div>
    );
  if (screens.length === 0)
    return (
      <Empty className="min-h-56 border-y border-dashed px-5 py-8">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Monitor aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle role="heading" aria-level={2}>
            {t("list.emptyTitle")}
          </EmptyTitle>
          <EmptyDescription>{t("list.emptyBody")}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {canManage ? (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              to="/screens/pair"
              onClick={(event) =>
                void openPairScreen(event, ["pair-screen"], "/screens/pair")
              }
            >
              {t("page.pairScreen")}
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("list.emptyManageNote")}
            </p>
          )}
        </EmptyContent>
      </Empty>
    );
  return (
    <section className="min-w-0 space-y-3" aria-label={t("list.sectionLabel")}>
      <div className="space-y-2">
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label={t("list.filterGroup")}
        >
          <DashboardSearch
            value={search}
            onValueChange={setSearch}
            label={t("list.searchLabel")}
            placeholder={t("list.searchPlaceholder")}
            clearLabel={t("list.clearSearch")}
            className={
              compact ? "max-w-none basis-full" : "max-w-none basis-40"
            }
          />
          <FleetFilters
            values={filterValues}
            onChange={(key, value) => filterSetters[key](value)}
            onReset={resetFacets}
            sources={filterSources}
          />
          <div className="ml-auto flex items-center gap-2">
            {effectiveView !== "map" &&
              (compact ? (
                <FleetViewOptionsMenu
                  groupBy={groupBy}
                  onGroupByChange={setGroupBy}
                  sort={sort}
                  onSortChange={setSort}
                />
              ) : (
                <FleetGroupSort
                  groupBy={groupBy}
                  onGroupByChange={setGroupBy}
                  sort={sort}
                  onSortChange={setSort}
                />
              ))}
            <FleetViewToggle view={effectiveView} onViewChange={setView} />
          </div>
        </div>
        {anyFilterActive && (
          <div
            className="flex flex-wrap items-center gap-1.5"
            role="group"
            aria-label={t("list.activeFilters")}
          >
            <span className="mr-1 text-xs text-muted-foreground" role="status">
              {t("list.resultCount", {
                filtered: filtered.length,
                total: screens.length,
              })}
            </span>
            {activeFacets.map((filter) => (
              <Badge key={filter.key} variant="secondary" className="gap-1.5">
                <span>
                  {filter.facet}: {filter.value}
                </span>
                <Button
                  type="button"
                  aria-label={t("list.removeFilter", {
                    facet: filter.facet,
                    value: filter.value,
                  })}
                  onClick={filter.remove}
                  variant="ghost"
                  size="icon-xs"
                  className="rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <X className="size-3" aria-hidden="true" />
                </Button>
              </Badge>
            ))}
            <Button variant="ghost" size="xs" onClick={clearFilters}>
              {t("list.clearAll")}
            </Button>
          </div>
        )}
      </div>
      {effectiveView === "grid" && (
        <p className="text-xs text-muted-foreground">{t("list.gridHint")}</p>
      )}
      {selected.size > 0 && canManage && (
        <div className="flex flex-wrap items-center gap-2 border-l-2 border-primary bg-muted/50 px-3 py-2">
          <strong className="mr-2 text-sm">
            {t("list.selectedCount", { count: selected.size })}
          </strong>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void restartSelected()}
          >
            <RefreshCw aria-hidden="true" /> {t("list.restart")}
          </Button>
          <ButtonGroup>
            <FleetFilterSelect
              label={t("list.moveToLocation")}
              value={bulkLocation}
              onChange={setBulkLocation}
              options={[
                { value: "", label: t("shared.unassigned") },
                ...locationItems.map((item) => ({
                  value: item.id,
                  label: item.name,
                })),
              ]}
            />
            <Button
              variant="secondary"
              onClick={() => void changeSelectedLocation()}
            >
              {t("list.moveAction")}
            </Button>
          </ButtonGroup>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
          >
            {t("list.clearSelection")}
          </Button>
        </div>
      )}
      {locationsError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{t("list.locationsError")}</AlertTitle>
          <AlertDescription>{t("list.locationsErrorBody")}</AlertDescription>
        </Alert>
      )}
      {filtered.length === 0 ? (
        <Empty className="min-h-48 border-y border-dashed px-4 py-7">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>{t("list.noMatchTitle")}</EmptyTitle>
            <EmptyDescription>{t("list.noMatchBody")}</EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              {t("list.clearFilters")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : effectiveView === "map" ? (
        <ScreenFleetMap screens={filtered} />
      ) : visibleGroups.every((group) => collapsed.has(group.key)) ? (
        <Empty className="min-h-40 border-y border-dashed py-6">
          <EmptyHeader>
            <EmptyTitle>{t("list.allCollapsed")}</EmptyTitle>
          </EmptyHeader>
          <EmptyContent>
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                setCollapsed(new Set());
                storageSet("session", "tilecast.screens.collapsed", "[]");
              }}
            >
              {t("list.expandAll")}
            </Button>
          </EmptyContent>
        </Empty>
      ) : (
        <div className="space-y-4">
          {visibleGroups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const groupSelected = group.screens.every((screen) =>
              selected.has(screen.id),
            );
            return (
              <Collapsible
                key={group.key}
                open={!isCollapsed}
                onOpenChange={(open) => setGroupCollapsed(group.key, !open)}
                render={<section className="min-w-0 space-y-2" />}
              >
                {groupBy !== "none" && (
                  <header className="flex items-center gap-2 border-b border-border py-1.5">
                    <CollapsibleTrigger
                      render={
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={
                            isCollapsed
                              ? t("list.expandGroup", { label: group.label })
                              : t("list.collapseGroup", { label: group.label })
                          }
                        />
                      }
                    >
                      <CollapsibleChevron orientation="right" size={16} />
                    </CollapsibleTrigger>
                    {canManage && (
                      <Checkbox
                        aria-label={t("list.selectGroup", {
                          label: group.label,
                        })}
                        checked={groupSelected}
                        onCheckedChange={(checked) => {
                          const next = new Set(selected);
                          for (const screen of group.screens) {
                            if (checked === true) next.add(screen.id);
                            else next.delete(screen.id);
                          }
                          setSelected(next);
                        }}
                      />
                    )}
                    <div className="min-w-0 flex-1">
                      <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
                        <strong className="truncate text-sm">
                          {group.label}
                        </strong>
                        {group.description && (
                          <span className="truncate text-xs text-muted-foreground">
                            {group.description}
                          </span>
                        )}
                      </div>
                      <GroupHealth screens={group.screens} />
                    </div>
                  </header>
                )}
                <CollapsibleContent className="min-w-0">
                  {effectiveView === "table" && (
                    <div className="min-w-0">
                      <ScreenFleetTable
                        screens={group.screens}
                        canManage={canManage}
                        selectedIds={selected}
                        csrfToken={csrfToken}
                        showLocation={groupBy !== "location"}
                        onSelectionChange={(id, checked) => {
                          const next = new Set(selected);
                          if (checked) next.add(id);
                          else next.delete(id);
                          setSelected(next);
                        }}
                        onArchive={setArchiveTarget}
                      />
                    </div>
                  )}
                  {effectiveView === "grid" && (
                    <div className="grid grid-cols-[repeat(auto-fill,minmax(17.5rem,1fr))] gap-4 pt-3">
                      {group.screens.map((screen) => (
                        <ScreenGridCard
                          key={screen.id}
                          screen={screen}
                          csrfToken={csrfToken}
                          selected={selected.has(screen.id)}
                          canManage={canManage}
                          showLocation={groupBy !== "location"}
                          onSelect={(checked) => {
                            const next = new Set(selected);
                            if (checked) next.add(screen.id);
                            else next.delete(screen.id);
                            setSelected(next);
                          }}
                          onArchive={() => setArchiveTarget(screen)}
                        />
                      ))}
                    </div>
                  )}
                </CollapsibleContent>
              </Collapsible>
            );
          })}
        </div>
      )}
      {archiveTarget && (
        <ArchiveScreenDialog
          screen={archiveTarget}
          csrfToken={csrfToken}
          open
          onOpenChange={(open) => {
            if (!open) setArchiveTarget(null);
          }}
        />
      )}
    </section>
  );
}

function storageGet(kind: "local" | "session", key: string) {
  try {
    const storage =
      kind === "local" ? window.localStorage : window.sessionStorage;
    return storage?.getItem(key) ?? null;
  } catch {
    return null;
  }
}

function storageSet(kind: "local" | "session", key: string, value: string) {
  try {
    const storage =
      kind === "local" ? window.localStorage : window.sessionStorage;
    storage?.setItem(key, value);
  } catch {
    // Preferences are an enhancement; private browsing may reject storage.
  }
}

const noFleetFilter = "__tilecast_all__";

function FleetFilterSelect({
  label,
  value,
  onChange,
  options,
  className,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: readonly { value: string; label: string }[];
  className?: string;
}) {
  const selectedValue = value || noFleetFilter;
  const items = options.map((option) => ({
    value: option.value || noFleetFilter,
    label: option.label,
  }));

  return (
    <Select
      items={items}
      value={selectedValue}
      onValueChange={(next) =>
        onChange(!next || next === noFleetFilter ? "" : next)
      }
    >
      <SelectTrigger
        aria-label={label}
        className={className ?? "w-40 max-sm:flex-1"}
      >
        <SelectValue placeholder={label} />
      </SelectTrigger>
      <SelectContent>
        {items.map((option) => (
          <SelectItem key={option.value} value={option.value}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

/* Plain metadata, with the one thing that needs action in semantic color
   and an icon, so it never rests on color alone. */
function GroupHealth({ screens }: { screens: Screen[] }) {
  const { t } = useTranslation("screens");
  const tally = tallyFleet(screens);
  const syncGroups = new Set(
    screens.map((item) => item.syncGroupName).filter(Boolean),
  );
  return (
    <p className="flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
      <span>{t("list.screenCount", { count: tally.total })}</span>
      <span aria-hidden="true">·</span>
      <span>{t("list.summaryOnline", { count: tally.online })}</span>
      {tally.attention > 0 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1 font-medium text-destructive">
            <CircleAlert className="size-3" aria-hidden="true" />
            {t("list.healthAttention", { count: tally.attention })}
          </span>
        </>
      )}
      {syncGroups.size === 1 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1">
            <Link2 className="size-3" aria-hidden="true" />
            {[...syncGroups][0]}
          </span>
        </>
      )}
    </p>
  );
}

function syncGroupFilterLabel(value: string, screens: Screen[], t: ScreensT) {
  if (value === "any") return t("list.syncOptions.any");
  if (value === "none") return t("list.syncOptions.none");
  return (
    screens.find((item) => item.syncGroupId === value)?.syncGroupName ??
    t("list.syncOptions.selected")
  );
}

function updateLabel(value: string, t: ScreensT) {
  if (value === "current") return t("list.updateOptions.current");
  if (value === "attention") return t("status.attention");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function platformLabel(value: string, t: ScreensT) {
  const normalized = value.toLowerCase();
  if (normalized === "browser") return t("platform.browser");
  if (normalized === "linux") return t("platform.linux");
  if (normalized.includes("fire")) return t("platform.fireTv");
  if (normalized.includes("google")) return t("platform.googleTv");
  if (normalized.includes("android")) return t("platform.androidTv");
  return value || t("platform.unknown");
}

function statusLabel(value: string, t: ScreensT) {
  if (value === "attention") return t("status.attention");
  if (value === "updating") return t("status.updating");
  if (value === "syncing") return t("status.syncing");
  const entry = statusContent[value as ScreenStatus];
  return entry ? t(entry.labelKey) : value;
}

const needsAttention = screenNeedsAttention;

function roomLabel(screen: Screen, t: ScreensT) {
  if (screen.roomName && screen.roomNumber)
    return t("room.combined", {
      name: screen.roomName,
      number: screen.roomNumber,
    });
  if (screen.roomName) return screen.roomName;
  if (screen.roomNumber) return t("room.number", { number: screen.roomNumber });
  return "";
}

type ScreenGroupView = {
  key: string;
  label: string;
  description?: string;
  screens: Screen[];
};

function buildScreenGroups(
  screens: Screen[],
  groupBy: string,
  sort: string,
  t: ScreensT,
  locale: string,
): ScreenGroupView[] {
  const sorted = [...screens].sort((left, right) => {
    const descending = sort.endsWith("-desc") ? -1 : 1;
    const field = sort.replace(/-(asc|desc)$/, "");
    if (field === "contact")
      return (
        (new Date(left.lastContactAt ?? 0).getTime() -
          new Date(right.lastContactAt ?? 0).getTime()) *
        descending
      );
    if (field === "added")
      return (
        (new Date(left.pairedAt).getTime() -
          new Date(right.pairedAt).getTime()) *
        descending
      );
    const a =
      field === "location"
        ? left.location
        : field === "status"
          ? left.status
          : field === "platform"
            ? platformLabel(left.platform, t)
            : left.name;
    const b =
      field === "location"
        ? right.location
        : field === "status"
          ? right.status
          : field === "platform"
            ? platformLabel(right.platform, t)
            : right.name;
    return a.localeCompare(b, locale, { sensitivity: "base" }) * descending;
  });
  if (groupBy === "none")
    return [{ key: "all", label: t("list.allLabel"), screens: sorted }];
  const map = new Map<string, ScreenGroupView>();
  for (const screen of sorted) {
    const key =
      groupBy === "status"
        ? `status:${screen.status}`
        : groupBy === "sync"
          ? `sync:${screen.syncGroupId ?? "none"}`
          : `location:${screen.locationId ?? "unassigned"}`;
    const label =
      groupBy === "status"
        ? statusLabel(screen.status, t)
        : groupBy === "sync"
          ? (screen.syncGroupName ?? t("list.syncOptions.none"))
          : screen.location || t("shared.unassigned");
    const description =
      groupBy === "location"
        ? formatLocationAddress(screen.locationDetails)
        : undefined;
    const existing = map.get(key);
    if (existing) existing.screens.push(screen);
    else map.set(key, { key, label, description, screens: [screen] });
  }
  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, locale, { sensitivity: "base" }),
  );
}

export function ScreenGridCard({
  screen,
  csrfToken,
  selected,
  canManage,
  showLocation,
  onSelect,
  onArchive,
}: {
  screen: Screen;
  csrfToken: string;
  selected: boolean;
  canManage: boolean;
  showLocation: boolean;
  onSelect: (checked: boolean) => void;
  onArchive?: () => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const navigate = useNavigate();
  const detailHref = `/screens/${screen.id}`;
  const ref = useRef<HTMLElement>(null);
  const [visible, setVisible] = useState(false);
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      ([entry]) => setVisible(entry?.isIntersecting ?? false),
      { rootMargin: "180px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);
  const canRequestPreview =
    visible &&
    Boolean(csrfToken) &&
    screen.status !== "offline" &&
    screen.status !== "disabled" &&
    screen.status !== "revoked";
  useEffect(() => {
    if (!canRequestPreview) return;
    let active = true;
    const renew = async (forceCapture: boolean) => {
      try {
        await api.renewScreenPreview(screen.id, forceCapture, csrfToken);
      } catch {
        // The metadata query below keeps the card's honest unavailable state.
        // A transient lease failure is retried at the next renewal.
      }
    };
    void renew(true);
    const interval = window.setInterval(
      () => active && void renew(false),
      GRID_PREVIEW_LEASE_RENEWAL_MILLIS,
    );
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [canRequestPreview, csrfToken, screen.id]);
  const preview = useQuery({
    ...screenQueries.previewCard(screen.id),
    enabled: visible,
    refetchInterval: visible ? GRID_PREVIEW_METADATA_REFRESH_MILLIS : false,
  });
  const image =
    preview.data?.imageAvailable && preview.data.updatedAt
      ? api.screenPreviewImageUrl(screen.id, preview.data.updatedAt)
      : undefined;
  const age = preview.data?.capturedAt
    ? previewAge(preview.data.capturedAt, now, t)
    : null;
  useEffect(() => {
    if (!visible || !preview.data?.capturedAt) return;
    const interval = window.setInterval(
      () => setNow(Date.now()),
      GRID_PREVIEW_AGE_REFRESH_MILLIS,
    );
    return () => window.clearInterval(interval);
  }, [preview.data?.capturedAt, visible]);
  const previewState = livePreviewState(screen, preview.data, now);
  const railState = previewRailState(
    previewState,
    preview.data?.capturedAt,
    now,
  );
  const captureFailed = previewState === "capture-error";
  const portrait = screen.screenHeight > screen.screenWidth;
  return (
    <article
      ref={ref}
      className={`group min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20 ${needsAttention(screen) ? "border-amber-500/60 bg-amber-500/5" : "border-border"}`}
    >
      <div className="relative flow-root">
        <Link
          to={detailHref}
          aria-label={t("grid.openScreen", { name: screen.name })}
          className="block outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset"
        >
          <AspectRatio
            ratio={(screen.screenWidth || 16) / (screen.screenHeight || 9)}
            className={`grid max-h-52 w-full place-items-center overflow-hidden bg-slate-950 ${portrait ? "mx-auto my-3 w-[min(45%,8rem)] rounded-xl" : ""}`}
          >
            {preview.isLoading && visible ? (
              <Skeleton
                className="absolute inset-0 min-h-32"
                aria-label={t("grid.loadingPreview")}
              />
            ) : image ? (
              <>
                <img
                  className="h-full w-full object-contain"
                  src={image}
                  alt={t("grid.previewAlt", { name: screen.name })}
                />
                {age && (
                  <Badge
                    variant="secondary"
                    className="pointer-events-none absolute right-2 bottom-2 border-white/10 bg-black/60 text-white"
                    aria-label={t("grid.snapshotCaptured", { age: age.label })}
                    title={t("grid.snapshotTitle", {
                      date: new Date(
                        preview.data?.capturedAt ?? "",
                      ).toLocaleString(formatLocale),
                    })}
                  >
                    {age.label}
                  </Badge>
                )}
                {captureFailed && (
                  <Badge
                    variant="secondary"
                    className="pointer-events-none absolute bottom-2 left-2 gap-1 border-white/10 bg-black/60 text-white"
                  >
                    <TriangleAlert aria-hidden="true" />
                    {t("livePreview.states.captureError.label")}
                  </Badge>
                )}
              </>
            ) : (
              <span className="grid min-h-32 place-items-center gap-1 text-center text-xs text-slate-300">
                <Monitor className="size-6" aria-hidden="true" />
                {captureFailed
                  ? t("livePreview.states.captureError.label")
                  : screen.status === "offline"
                    ? t("grid.offline")
                    : t("grid.unavailable")}
              </span>
            )}
          </AspectRatio>
        </Link>
        <PreviewFreshnessRail state={railState} screenId={screen.id} />
      </div>
      <div className="grid gap-3 p-3">
        <header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
          {canManage && (
            <Checkbox
              aria-label={t("grid.selectScreen", { name: screen.name })}
              checked={selected}
              onCheckedChange={(checked) => onSelect(checked === true)}
            />
          )}
          <span className="grid min-w-0 gap-0.5">
            <Link
              to={detailHref}
              className="truncate text-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring"
            >
              {screen.name}
            </Link>
            <small className="truncate text-xs text-muted-foreground">
              {[showLocation ? screen.location : "", roomLabel(screen, t)]
                .filter(Boolean)
                .join(" · ") || t("shared.unassigned")}
            </small>
          </span>
          <div className="shrink-0">
            <ActionMenuButton
              label={t("grid.rowActions", { name: screen.name })}
              actions={screenRowActionGroups({
                screen,
                t,
                navigate,
                csrfToken,
                canManage,
                onArchive,
              })}
              variant="ghost"
              size="icon-sm"
            />
          </div>
        </header>
        <div className="flex flex-wrap items-center gap-2">
          <StatusLabel status={screen.status} />
          <span className="text-xs text-muted-foreground">
            {formatContact(screen.lastContactAt, t, formatLocale)}
          </span>
        </div>
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs">
          <dt className="text-muted-foreground">{t("grid.nowPlaying")}</dt>
          <dd className="truncate font-medium">
            {screen.nowPlayingName || t("shared.nothingAssigned")}
          </dd>
        </dl>
        {screen.syncGroupName && (
          <Badge variant="outline" className="max-w-full justify-start gap-1.5">
            <Link2 aria-hidden="true" />
            <span className="truncate">{screen.syncGroupName}</span>
          </Badge>
        )}
      </div>
    </article>
  );
}

export function ScreensPairRoute() {
  return (
    <>
      <ScreensPage />
      <PairScreenDialog />
    </>
  );
}

export function ScreenDetailPage() {
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [mapPositionOverride, setMapPositionOverride] = useState<
    MapCoordinates | undefined
  >();
  const initializedScreenId = useRef<string | null>(null);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [pendingDestination, setPendingDestination] =
    useState<ScreenTabDestination | null>(null);
  const [airplayOpen, setAirplayOpen] = useState(false);
  const [quickPresentOpen, setQuickPresentOpen] = useState(
    () => searchParams.get("present") === "1",
  );
  const [screenCommandAction, setScreenCommandAction] =
    useState<ScreenCommandAction | null>(null);
  const [screenCommandInput, setScreenCommandInput] = useState("");
  const [screenCommandError, setScreenCommandError] = useState("");
  useEffect(() => {
    if (searchParams.get("edit") === "details") setEditingDetails(true);
  }, [searchParams]);
  const query = useQuery({
    ...screenQueries.detail(id),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  useEffect(() => {
    if (
      searchParams.get("tab") !== "content" &&
      searchParams.get("focus") !== "content"
    )
      return;
    const frame = window.requestAnimationFrame(() => {
      document.getElementById("screen-content")?.scrollIntoView?.({
        block: "start",
        behavior: "smooth",
      });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [query.data?.id, searchParams]);
  const screens = useQuery({
    ...screenQueries.list(),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  const detailsForm = useForm<ApprovalForm>({
    resolver: zodResolver(useMemo(() => makeApprovalSchema(t), [t])),
    defaultValues: {
      name: "",
      locationId: undefined,
      roomName: "",
      roomNumber: "",
      description: "",
    },
  });
  const locations = useQuery({
    queryKey: ["locations"],
    queryFn: api.locations,
  });
  useEffect(() => {
    if (!query.data) return;
    // Polling must not overwrite an open edit, but the first data for a screen
    // still has to seed the form when "?edit=details" opened it before the
    // query resolved. Otherwise a save would send a null position.
    if (editingDetails && initializedScreenId.current === query.data.id) return;
    initializedScreenId.current = query.data.id;
    detailsForm.reset({
      name: query.data.name,
      locationId: query.data.locationId,
      roomName: query.data.roomName ?? "",
      roomNumber: query.data.roomNumber ?? "",
      description: query.data.description,
    });
    setMapPositionOverride(query.data.mapPositionOverride);
  }, [detailsForm, editingDetails, query.data]);
  const updateDetails = useMutation({
    mutationFn: (values: ApprovalForm) =>
      api.updateScreen(
        id,
        { ...values, mapPositionOverride: mapPositionOverride ?? null },
        auth.status?.csrfToken ?? "",
      ),
    onSuccess: async (updated) => {
      toast.add({ title: "Screen details saved.", type: "success" });
      queryClient.setQueryData(screenQueries.detail(id).queryKey, updated);
      setEditingDetails(false);
      await queryClient.invalidateQueries({ queryKey: screenKeys.all });
    },
  });
  const assignment = useQuery({
    ...screenQueries.assignment(id),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  // The playback plan is the authority for expected playback. Previous data
  // stays visible across the ten-second refresh so the card never flashes.
  const plan = useQuery({
    ...screenQueries.playbackPlan(id),
    placeholderData: (previous) => previous,
  });
  // Truthful "Next": ask the same authority what it selects at the upcoming
  // boundary instead of claiming the boundary itself is a content change.
  // Specified-instant queries carry their own key and do not poll.
  const nextBoundary = plan.data?.current?.nextEvaluationAt;
  const futurePlan = useQuery({
    ...screenQueries.playbackPlan(id, nextBoundary),
    enabled: Boolean(nextBoundary),
  });
  const futurePlanState: "loading" | "error" | "ready" = !nextBoundary
    ? "ready"
    : futurePlan.isPending
      ? "loading"
      : futurePlan.isError
        ? "error"
        : "ready";
  const stateMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setScreenEnabled(id, enabled, auth.status?.csrfToken ?? ""),
    onSuccess: async (_result, enabled) => {
      toast.add({
        title: enabled ? "Screen enabled." : "Screen disabled.",
        type: "success",
      });
      await queryClient.invalidateQueries({ queryKey: screenKeys.all });
    },
  });
  const commands = useQuery({
    ...screenQueries.commands(id),
    refetchInterval: 5_000,
    enabled: true,
  });
  const reliability = useQuery({
    ...screenQueries.reliability(id),
    refetchInterval: SCREEN_STATUS_REFRESH_MS,
  });
  const playerHistory = useQuery({
    ...screenQueries.playerHistory(id),
  });
  const screenPolicy = useQuery({
    queryKey: ["screen", id, "policy"],
    queryFn: () => api.screenPolicy(id),
  });
  const command = useMutation({
    mutationFn: ({
      type,
      payload,
    }: {
      type: PlayerCommandType;
      payload: Record<string, unknown>;
    }) =>
      api.createScreenCommand(id, type, payload, auth.status?.csrfToken ?? ""),
    onSuccess: (_result, action) => {
      toast.add({
        title: `Player command queued: ${action.type.replaceAll("_", " ")}.`,
        type: "success",
      });
      void queryClient.invalidateQueries({
        queryKey: screenKeys.commands(id),
      });
      void queryClient.invalidateQueries({
        queryKey: screenKeys.reliability(id),
      });
    },
  });
  const requestScreenCommand = (action: ScreenCommandAction) => {
    setScreenCommandInput("");
    setScreenCommandError("");
    setScreenCommandAction(action);
  };
  const confirmScreenCommand = () => {
    if (!screenCommandAction) return;
    let payload: Record<string, unknown>;
    if (screenCommandAction.kind === "input") {
      const value = screenCommandInput.trim();
      if (!value) {
        setScreenCommandError(t("detail.commandInputRequired"));
        return;
      }
      if (screenCommandAction.input.type === "number") {
        const numberValue = Number(value);
        if (
          !Number.isInteger(numberValue) ||
          (screenCommandAction.input.min != null &&
            numberValue < screenCommandAction.input.min) ||
          (screenCommandAction.input.max != null &&
            numberValue > screenCommandAction.input.max)
        ) {
          setScreenCommandError(
            t("detail.commandRangeError", {
              min: screenCommandAction.input.min ?? "−∞",
              max: screenCommandAction.input.max ?? "∞",
            }),
          );
          return;
        }
        payload = screenCommandAction.createPayload(numberValue);
      } else {
        payload = screenCommandAction.createPayload(value);
      }
    } else {
      payload = screenCommandAction.payload;
    }
    command.mutate({ type: screenCommandAction.commandType, payload });
    setScreenCommandAction(null);
  };
  const listedScreen = screens.data?.items?.find((screen) => screen.id === id);
  const screen = resolveScreenDetail(query.data, listedScreen);
  if (query.isLoading && !screen)
    return (
      <div className="space-y-2">
        <Skeleton className="h-4 w-56" />
        <p className="text-sm text-muted-foreground">{t("detail.loading")}</p>
      </div>
    );
  if (!screen)
    return (
      <Alert variant="destructive">
        <AlertDescription>{t("detail.loadError")}</AlertDescription>
      </Alert>
    );
  // Which controls make sense for this Player is one question, answered once.
  const isBrowserPlayer = screenRunsBrowserPlayer(screen);
  const displayCapabilities =
    reliability.data?.displayControlCapabilities ?? {};
  const hasDisplayControl = Object.keys(displayCapabilities).length > 0;
  const requestedTab = searchParams.get("tab") ?? "overview";
  const requestedSection = searchParams.get("section");
  const requestedPanel = searchParams.get("panel");
  const tab = normalizeScreenDetailTab(requestedTab, requestedSection);
  const manageSection = normalizeScreenManageSection(
    requestedTab,
    requestedSection,
  );
  const legacyDiagnosticsOpen =
    requestedTab === "device" ||
    requestedTab === "reliability" ||
    requestedTab === "commands" ||
    (requestedTab === "manage" && requestedSection !== "settings");
  const diagnosticsOpen =
    requestedPanel === "diagnostics" || legacyDiagnosticsOpen;
  const snapshotsOpen =
    requestedPanel === "snapshots" || requestedTab === "snapshots";
  const explanationOpen = requestedPanel === "explanation";

  const commitDestination = (destination: ScreenTabDestination) => {
    const next = new URLSearchParams(searchParams);
    if (destination.tab === "overview") next.delete("tab");
    else next.set("tab", destination.tab);
    next.delete("panel");
    next.delete("section");
    next.delete("focus");
    setSearchParams(next);
    setPendingDestination(null);
    setPolicyDirty(false);
  };
  const selectTab = (nextTab: string) => {
    if (!screenDetailTabs.includes(nextTab as ScreenDetailTab)) return;
    const destination: ScreenTabDestination = {
      tab: nextTab as ScreenDetailTab,
    };
    if (destination.tab === tab) return;
    if (policyDirty && tab === "settings" && destination.tab !== "settings") {
      setPendingDestination(destination);
      return;
    }
    commitDestination(destination);
  };
  const setDetailPanel = (
    panel: "diagnostics" | "snapshots" | "explanation",
    open: boolean,
    section: ScreenManageSection = manageSection,
  ) => {
    const next = new URLSearchParams(searchParams);
    if (open) {
      if (
        requestedTab === "device" ||
        requestedTab === "reliability" ||
        requestedTab === "commands" ||
        requestedTab === "manage" ||
        requestedTab === "snapshots" ||
        requestedTab === "content"
      ) {
        next.delete("tab");
      }
      next.delete("focus");
      next.set("panel", panel);
      if (panel === "diagnostics") next.set("section", section);
      else next.delete("section");
    } else {
      next.delete("panel");
      if (panel === "diagnostics") next.delete("section");
      if (
        requestedTab === "device" ||
        requestedTab === "reliability" ||
        requestedTab === "commands" ||
        requestedTab === "manage" ||
        requestedTab === "snapshots" ||
        requestedTab === "content"
      ) {
        next.delete("tab");
      }
    }
    next.delete("focus");
    setSearchParams(next, {
      replace:
        !open ||
        requestedPanel === panel ||
        legacyDiagnosticsOpen ||
        requestedTab === "snapshots",
    });
  };
  const openDiagnostics = (section: ScreenManageSection = "device") =>
    setDetailPanel("diagnostics", true, section);
  const viewContent = () => {
    const next = new URLSearchParams(searchParams);
    next.delete("tab");
    next.delete("panel");
    next.delete("section");
    next.set("focus", "content");
    setSearchParams(next);
    window.requestAnimationFrame(() => {
      document.getElementById("screen-content")?.scrollIntoView?.({
        block: "start",
        behavior: "smooth",
      });
    });
  };
  const setDiagnosticsSection = (section: string) => {
    if (!screenManageSections.includes(section as ScreenManageSection)) return;
    openDiagnostics(section as ScreenManageSection);
  };
  return (
    <div className="w-full min-w-0 space-y-5">
      <PageHeader
        title={
          <span className="flex flex-wrap items-center gap-2">
            {screen.name}
            <StatusLabel status={screen.status} />
          </span>
        }
        description={[
          platformLabel(screen.platform, t),
          [screen.deviceManufacturer, screen.deviceModel]
            .filter(Boolean)
            .join(" "),
          screen.playerVersion
            ? t("detail.playerVersion", {
                version: screen.playerVersion,
              })
            : t("detail.playerVersionMissing"),
          [screen.location, roomLabel(screen, t)].filter(Boolean).join(" · ") ||
            t("detail.noLocation"),
        ]
          .filter(Boolean)
          .join(" · ")}
        actions={
          <>
            {canManageScreens(auth.status?.user) && (
              <Button size="sm" onClick={() => setQuickPresentOpen(true)}>
                <Play aria-hidden="true" /> {t("detail.present")}
              </Button>
            )}
            {canManageScreens(auth.status?.user) && (
              <Button
                variant="outline"
                size="sm"
                onClick={() =>
                  command.mutate({
                    type: "restart_player_process",
                    payload: {},
                  })
                }
              >
                <RefreshCw aria-hidden="true" /> {t("list.restart")}
              </Button>
            )}
            <ActionMenuButton
              label={t("detail.moreActions")}
              actions={[
                {
                  actions: [
                    ...(canManageScreens(auth.status?.user)
                      ? [
                          {
                            id: "edit-details",
                            label: t("grid.editDetails"),
                            icon: "details",
                            onSelect: () => setEditingDetails(true),
                          },
                        ]
                      : []),
                    ...(canManageScreens(auth.status?.user) &&
                    screen.platform.toLowerCase() === "linux"
                      ? [
                          {
                            id: "airplay",
                            label: t("detail.airplay"),
                            icon: "airplay",
                            onSelect: () => setAirplayOpen(true),
                          },
                        ]
                      : []),
                    {
                      id: "view-content",
                      label: t("detail.viewContent"),
                      icon: "screens",
                      onSelect: viewContent,
                    },
                  ],
                },
                {
                  actions: canManageScreens(auth.status?.user)
                    ? [
                        {
                          id: "archive",
                          label: t("detail.archiveMenuAction"),
                          icon: "archive",
                          role: "destructive",
                          onSelect: () => setConfirmArchive(true),
                        },
                      ]
                    : [],
                },
              ]}
              variant="outline"
              size="icon-sm"
            />
          </>
        }
      />
      <AirPlayPresentDialog
        open={airplayOpen}
        targetType="screen"
        targetId={screen.id}
        destinationName={screen.name}
        displayCount={1}
        csrfToken={auth.status?.csrfToken ?? ""}
        capability={reliability.data}
        capabilityLoading={reliability.isPending}
        capabilityError={reliability.error?.message}
        audioDisplayName={screen.name}
        onClose={() => setAirplayOpen(false)}
      />
      <QuickPresentDialog
        open={quickPresentOpen}
        targetType="screen"
        targetId={screen.id}
        destinationName={screen.name}
        csrfToken={auth.status?.csrfToken ?? ""}
        onClose={() => setQuickPresentOpen(false)}
      />
      <Dialog open={editingDetails} onOpenChange={setEditingDetails}>
        <DialogContent className="max-w-2xl">
          <form
            className="space-y-5"
            onSubmit={(event) =>
              void detailsForm.handleSubmit((values) =>
                updateDetails.mutateAsync(values),
              )(event)
            }
          >
            <DialogHeader>
              <DialogTitle>{t("detail.editTitle")}</DialogTitle>
              <DialogDescription>{t("detail.editBody")}</DialogDescription>
            </DialogHeader>
            {updateDetails.error && (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>{t("detail.saveError")}</AlertTitle>
                <AlertDescription>
                  {apiErrorMessage(updateDetails.error)}
                </AlertDescription>
              </Alert>
            )}
            <Field className="gap-2">
              <FieldLabel
                htmlFor="editScreenName"
                className="text-sm font-medium"
              >
                {t("approval.nameLabel")}
              </FieldLabel>
              <Input
                id="editScreenName"
                autoFocus
                aria-invalid={Boolean(detailsForm.formState.errors.name)}
                {...detailsForm.register("name")}
              />
              {detailsForm.formState.errors.name?.message && (
                <FieldError>
                  {detailsForm.formState.errors.name.message}
                </FieldError>
              )}
            </Field>
            <LocationPicker
              locations={locations.data?.items ?? []}
              value={detailsForm.watch("locationId")}
              onChange={(locationId) =>
                detailsForm.setValue("locationId", locationId, {
                  shouldDirty: true,
                })
              }
            />
            <ScreenPositionPicker
              value={mapPositionOverride}
              locationPosition={(() => {
                const selected = (locations.data?.items ?? []).find(
                  (location) => location.id === detailsForm.watch("locationId"),
                );
                return typeof selected?.latitude === "number" &&
                  typeof selected.longitude === "number"
                  ? {
                      latitude: selected.latitude,
                      longitude: selected.longitude,
                    }
                  : undefined;
              })()}
              onChange={setMapPositionOverride}
            />
            <div className="grid gap-4 sm:grid-cols-2">
              <Field className="gap-2">
                <FieldLabel
                  htmlFor="editScreenRoomName"
                  className="text-sm font-medium"
                >
                  {t("approval.roomName")}
                </FieldLabel>
                <Input
                  id="editScreenRoomName"
                  {...detailsForm.register("roomName")}
                />
              </Field>
              <Field className="gap-2">
                <FieldLabel
                  htmlFor="editScreenRoomNumber"
                  className="text-sm font-medium"
                >
                  {t("approval.roomNumber")}
                </FieldLabel>
                <Input
                  id="editScreenRoomNumber"
                  {...detailsForm.register("roomNumber")}
                />
              </Field>
            </div>
            <Field className="gap-2">
              <FieldLabel
                htmlFor="editScreenDescription"
                className="text-sm font-medium"
              >
                {t("approval.description")}
              </FieldLabel>
              <Textarea
                id="editScreenDescription"
                {...detailsForm.register("description")}
              />
              {detailsForm.formState.errors.description?.message && (
                <FieldError>
                  {detailsForm.formState.errors.description.message}
                </FieldError>
              )}
            </Field>
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setEditingDetails(false)}
              >
                {t("common:actions.cancel")}
              </Button>
              <Button type="submit" disabled={updateDetails.isPending}>
                {updateDetails.isPending
                  ? t("common:actions.saving")
                  : t("detail.saveDetails")}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
      <Tabs
        value={tab}
        onValueChange={selectTab}
        className="w-full min-w-0 gap-4"
      >
        <ScreenDetailTabs policyDirty={policyDirty} />

        {tab === "overview" && (
          <TabsContent
            value="overview"
            className="min-w-0 space-y-4 outline-none"
          >
            <section
              className="space-y-4"
              aria-labelledby="screen-overview-title"
            >
              <header className="sr-only">
                <h2 id="screen-overview-title">{t("detail.tabOverview")}</h2>
                <p>{t("detail.overviewBody")}</p>
              </header>
              {reliability.data?.externalPresentationState &&
                reliability.data.externalPresentationState !== "none" && (
                  <Alert>
                    <Airplay aria-hidden="true" />
                    <AlertTitle>{t("detail.externalTitle")}</AlertTitle>
                    <AlertDescription>
                      {reliability.data.airplayConnected
                        ? t("detail.externalMirroring")
                        : t("detail.externalWaiting")}{" "}
                      {t("detail.externalNote")}
                    </AlertDescription>
                  </Alert>
                )}

              <div className="grid min-w-0 gap-4 xl:grid-cols-[minmax(0,1.45fr)_minmax(18rem,0.75fr)]">
                {screen.platform === "browser" ? (
                  <Card size="sm">
                    <CardHeader>
                      <CardTitle>{t("browser.monitorTitle")}</CardTitle>
                    </CardHeader>
                    <CardContent className="text-sm text-muted-foreground">
                      {t("browser.captureUnsupported")}
                    </CardContent>
                  </Card>
                ) : (
                  <LivePreviewPanel
                    screenId={id}
                    onOpenHistory={() => setDetailPanel("snapshots", true)}
                  />
                )}
                <Card size="sm" className="min-w-0">
                  <CardHeader>
                    <CardTitle>{t("detail.factConnectionTitle")}</CardTitle>
                    <CardDescription>
                      {t("detail.overviewBody")}
                    </CardDescription>
                    <CardAction>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDiagnostics("device")}
                      >
                        {t("detail.diagnosticsTitle")}
                      </Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2 xl:grid-cols-1">
                      <OverviewFact
                        label={t("detail.factConnection")}
                        value={<StatusLabel status={screen.status} />}
                      />
                      <OverviewFact
                        label={t("detail.factLocation")}
                        value={
                          [screen.location, roomLabel(screen, t)]
                            .filter(Boolean)
                            .join(" · ") || t("shared.notSet")
                        }
                      />
                      <OverviewFact
                        label={t("detail.factLastContact")}
                        value={formatContact(
                          screen.lastContactAt,
                          t,
                          formatLocale,
                        )}
                      />
                      <OverviewFact
                        label={t("detail.factPlayerUpdate")}
                        value={
                          screen.updateError
                            ? t("shared.updateFailed")
                            : (screen.updateState?.replaceAll("_", " ") ??
                              t("detail.noDeployment"))
                        }
                      />
                      <OverviewFact
                        label={t("detail.factReliability")}
                        value={
                          reliability.data?.effectiveMode?.replaceAll(
                            "_",
                            " ",
                          ) ?? t("shared.notReported")
                        }
                      />
                      <OverviewFact
                        label={t("detail.factPlayerSettings")}
                        value={
                          <Link
                            to="?tab=settings"
                            className="underline underline-offset-4"
                          >
                            {t("detail.policyOverrides", {
                              count: Object.keys(
                                screenPolicy.data?.values ?? {},
                              ).length,
                            })}
                          </Link>
                        }
                      />
                    </dl>
                  </CardContent>
                </Card>
              </div>

              {isBrowserPlayer && (
                <BrowserPlayerDiagnostics
                  screenId={id}
                  screenStatus={screen.status}
                  playbackState={assignment.data?.playbackState}
                  lastPlaybackError={assignment.data?.lastPlaybackError}
                  reliability={reliability.data}
                />
              )}
              {screen.platform === "browser" &&
                canManageScreens(auth.status?.user) && (
                  <BrowserRecoveryPanel
                    screenId={id}
                    csrfToken={auth.status?.csrfToken ?? ""}
                  />
                )}
              <ScreenPlaybackCard
                screenId={id}
                screenName={screen.name}
                screenStatus={screen.status}
                lastContactAt={screen.lastContactAt}
                assignment={assignment.data}
                assignmentLoading={assignment.isPending}
                assignmentError={assignment.error}
                plan={plan.data}
                planLoading={plan.isPending}
                planError={plan.error}
                canManage={canManageScreens(auth.status?.user)}
                csrfToken={auth.status?.csrfToken ?? ""}
                onExplain={() => setDetailPanel("explanation", true)}
                onOpenDiagnostics={() => openDiagnostics("playback")}
              />

              <ScreenScheduleCard
                screenId={id}
                assignment={assignment.data}
                plan={plan.data}
                futurePlan={futurePlan.data}
                futureState={futurePlanState}
                loading={assignment.isPending}
              />

              <div className="grid min-w-0 gap-4 lg:grid-cols-2">
                <Card size="sm" className="min-w-0">
                  <CardHeader>
                    <CardTitle>{t("detail.healthTitle")}</CardTitle>
                    <CardDescription>{t("detail.healthBody")}</CardDescription>
                    <CardAction>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => openDiagnostics("health")}
                      >
                        {t("detail.sectionHealth")}
                      </Button>
                    </CardAction>
                  </CardHeader>
                  <CardContent>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-sm font-medium">
                        {t("detail.zeroTouch")}
                      </span>
                      <Badge variant="outline">
                        {zeroTouchReadiness(reliability.data, t)}
                      </Badge>
                    </div>
                    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                      <OverviewFact
                        label={t("detail.factReliability")}
                        value={
                          reliability.data?.effectiveMode?.replaceAll(
                            "_",
                            " ",
                          ) ?? t("shared.notReported")
                        }
                      />
                      <OverviewFact
                        label={t("detail.factPlayerUpdate")}
                        value={
                          screen.updateError
                            ? t("shared.updateFailed")
                            : (screen.updateState?.replaceAll("_", " ") ??
                              t("detail.noDeployment"))
                        }
                      />
                    </dl>
                    {reliabilityCapabilityWarning(reliability.data, t) && (
                      <Alert>
                        <AlertDescription>
                          {reliabilityCapabilityWarning(reliability.data, t)}
                        </AlertDescription>
                      </Alert>
                    )}
                  </CardContent>
                </Card>
                <ScreenActivitySummary
                  screenId={id}
                  onOpen={() => selectTab("activity")}
                />
              </div>
            </section>
          </TabsContent>
        )}

        {tab === "activity" && (
          <TabsContent value="activity" className="min-w-0 outline-none">
            <ScreenActivityPanel screenId={id} />
          </TabsContent>
        )}

        <ScreenDetailPanel
          open={diagnosticsOpen}
          onOpenChange={(open) => setDetailPanel("diagnostics", open)}
          title={t("detail.diagnosticsTitle")}
          description={t("detail.diagnosticsBody")}
        >
          <Tabs
            value={manageSection}
            onValueChange={setDiagnosticsSection}
            className="min-w-0 gap-4"
          >
            <TabsList
              aria-label={t("detail.deviceNav")}
              variant="line"
              className="sticky top-0 z-10 grid w-full grid-cols-4 rounded-none border-b border-border bg-popover p-0"
            >
              <TabsTrigger value="playback">
                {t("detail.sectionPlayback")}
              </TabsTrigger>
              <TabsTrigger value="device">
                {t("detail.sectionDevice")}
              </TabsTrigger>
              <TabsTrigger value="health">
                {t("detail.sectionHealth")}
              </TabsTrigger>
              <TabsTrigger value="maintenance">
                {t("detail.sectionMaintenance")}
              </TabsTrigger>
            </TabsList>

            {manageSection === "playback" && (
              <section
                className="space-y-3"
                aria-labelledby="playback-diagnostics-heading"
              >
                <h3
                  id="playback-diagnostics-heading"
                  className="text-sm font-semibold"
                >
                  {t("diagnostics.playbackTitle")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("diagnostics.playbackBody")}
                </p>
                <ScreenPlaybackDiagnostics
                  assignment={assignment.data}
                  plan={plan.data}
                  loading={assignment.isPending || plan.isPending}
                />
              </section>
            )}

            {manageSection === "health" && isBrowserPlayer && (
              <section
                className="space-y-3"
                aria-labelledby="browser-health-heading"
              >
                <h3
                  id="browser-health-heading"
                  className="text-sm font-semibold"
                >
                  {t("detail.healthTitle")}
                </h3>
                <BrowserPlayerDiagnostics
                  screenId={id}
                  screenStatus={screen.status}
                  playbackState={assignment.data?.playbackState}
                  lastPlaybackError={assignment.data?.lastPlaybackError}
                  reliability={reliability.data}
                />
              </section>
            )}

            {manageSection === "health" && !isBrowserPlayer && (
              <section
                className="space-y-3"
                aria-labelledby="reliability-heading"
              >
                <h3 id="reliability-heading" className="text-sm font-semibold">
                  {t("detail.healthTitle")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("detail.healthBody")}
                </p>
                <section className="min-w-0 space-y-3 rounded-xl border border-border border-l-4 border-l-primary bg-muted/20">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
                    <div className="min-w-0 space-y-1">
                      <h4 className="text-sm font-semibold">
                        {t("detail.zeroTouch")}
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        {t("detail.zeroTouchBody")}
                      </p>
                    </div>
                    <Badge variant="outline">
                      {zeroTouchReadiness(reliability.data, t)}
                    </Badge>
                  </div>
                  <dl className="grid gap-3 px-4 pb-4 sm:grid-cols-2 [&_dd]:mt-1 [&_dd]:break-words [&_dd]:text-sm [&_dt]:text-xs [&_dt]:text-muted-foreground">
                    <div>
                      <dt>{t("detail.factCommissioning")}</dt>
                      <dd>
                        {formatReportedStatus(
                          reliability.data?.commissioningState,
                          t,
                          t("detail.notStarted"),
                        )}
                        {typeof reliability.data?.commissioningStep ===
                          "string" && reliability.data.commissioningStep.trim()
                          ? ` · ${formatReportedStatus(reliability.data.commissioningStep, t, "")}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("detail.factAccessibilityReturn")}</dt>
                      <dd>
                        {formatReportedStatus(
                          reliability.data?.accessibilityServiceState,
                          t,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("detail.factLaunchAfterBoot")}</dt>
                      <dd>
                        {reliability.data?.bootLaunchVerified
                          ? t("detail.bootVerified")
                          : reportsAutostart(reliability.data)
                            ? // Linux has no boot-attempt counter; the autostart row
                              // below carries the detail.
                              t("detail.bootUnverified")
                            : t("detail.bootAttempts", {
                                count: formatReportedCount(
                                  reliability.data?.bootAttemptCount,
                                ),
                              })}
                      </dd>
                    </div>
                    {reportsAutostart(reliability.data) && (
                      <div>
                        <dt>{t("detail.factAutostart")}</dt>
                        <dd>{autostartSummary(reliability.data, t)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>{t("detail.factCachedFallback")}</dt>
                      <dd>
                        {reliability.data?.cachedFallbackAvailable
                          ? t("detail.available")
                          : t("detail.notConfirmed")}
                      </dd>
                    </div>
                    {isAndroidScreen(screen.platform) && (
                      <div>
                        <dt>{t("detail.factInstallPermission")}</dt>
                        <dd>
                          {formatReportedStatus(
                            screen.installPermissionStatus,
                            t,
                          )}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>{t("detail.factFreeStorage")}</dt>
                      <dd>
                        {screen.availableStorageBytes == null
                          ? t("shared.notReported")
                          : formatBytes(
                              screen.availableStorageBytes,
                              formatLocale,
                            )}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("detail.factLastHealthy")}</dt>
                      <dd>
                        {reliability.data?.lastHealthyPlaybackAt
                          ? new Date(
                              reliability.data.lastHealthyPlaybackAt,
                            ).toLocaleString(formatLocale)
                          : t("shared.notReported")}
                      </dd>
                    </div>
                    <div>
                      <dt>{t("detail.factUpdateReadiness")}</dt>
                      <dd>
                        {formatReportedStatus(
                          reliability.data?.updateReadiness,
                          t,
                        )}
                      </dd>
                    </div>
                    {screen.platform.toLowerCase() === "linux" && (
                      <>
                        <div>
                          <dt>{t("detail.factDisplayControl")}</dt>
                          <dd>
                            {reliability.data?.displayControlProvider
                              ? t("detail.providerCapabilities", {
                                  provider:
                                    reliability.data.displayControlProvider,
                                  count: Object.keys(
                                    reliability.data
                                      .displayControlCapabilities ?? {},
                                  ).length,
                                })
                              : t("shared.notReported")}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("detail.factDisplayState")}</dt>
                          <dd>
                            {formatReportedStatus(
                              reliability.data?.displayPowerState,
                              t,
                            )}
                            {reliability.data
                              ?.displayControlLastCommandResult ===
                              "display_command_sent" &&
                            reliability.data?.displayPowerStateConfirmed ===
                              false
                              ? t("detail.displayNotConfirmed")
                              : ""}
                            {reliability.data?.displayControlPolicyState ===
                            "powered_off_by_policy"
                              ? t("detail.displayPolicyOff")
                              : ""}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("detail.factLastDisplayCommand")}</dt>
                          <dd>
                            {reliability.data?.displayControlLastCommandState
                              ? `${formatReportedStatus(reliability.data.displayControlLastCommandState, t)}${reliability.data.displayControlLastCommandResult ? ` · ${reliability.data.displayControlLastCommandResult}` : ""}`
                              : t("shared.notReported")}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("detail.factAirplayPresent")}</dt>
                          <dd>
                            {reliability.data?.airplaySupported
                              ? t("detail.airplayReady", {
                                  profile:
                                    reliability.data.airplayMaxProfile ??
                                    t("detail.profilePending"),
                                })
                              : t("detail.airplayNotReady")}
                          </dd>
                        </div>
                        <div>
                          <dt>{t("detail.factAirplayDecoder")}</dt>
                          <dd>
                            {reliability.data?.airplayDecoder ??
                              t("shared.notReported")}
                            {reliability.data?.airplayHardwareDecode
                              ? t("detail.decoderHardware")
                              : t("detail.decoderSoftware")}
                          </dd>
                        </div>
                      </>
                    )}
                  </dl>
                </section>
                {screen.platform.toLowerCase() === "linux" && (
                  <ScreenPresentationNetworkPanel
                    screen={screen}
                    canManage={canManageScreens(auth.status?.user)}
                    csrfToken={auth.status?.csrfToken ?? ""}
                  />
                )}
                <dl className="grid gap-3 rounded-xl border border-border p-4 sm:grid-cols-2 [&_dd]:mt-1 [&_dd]:break-words [&_dd]:text-sm [&_dt]:text-xs [&_dt]:text-muted-foreground">
                  <div>
                    <dt>{t("detail.factReliabilityMode")}</dt>
                    <dd>
                      {t("detail.reliabilityModeValue", {
                        configured: formatReportedStatus(
                          reliability.data?.configuredMode,
                          t,
                        ),
                        effective: formatReportedStatus(
                          reliability.data?.effectiveMode,
                          t,
                        ),
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("detail.factForeground")}</dt>
                    <dd>
                      {formatReportedStatus(
                        reliability.data?.foregroundState,
                        t,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("detail.factBootRecovery")}</dt>
                    <dd>
                      {formatReportedStatus(
                        reliability.data?.bootRecoveryResult,
                        t,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("detail.factImmersive")}</dt>
                    <dd>
                      {reliability.data?.immersiveModeActive
                        ? t("detail.immersive")
                        : t("detail.notImmersive")}{" "}
                      ·{" "}
                      {reliability.data?.keepScreenOn
                        ? t("detail.keptAwake")
                        : t("detail.wakeReleased")}
                    </dd>
                  </div>
                  {isAndroidScreen(screen.platform) && (
                    <>
                      <div>
                        <dt>{t("detail.factManagedKiosk")}</dt>
                        <dd>
                          {t("detail.lockTaskValue", {
                            mode: formatReportedStatus(
                              reliability.data?.managedKioskCapability,
                              t,
                            ),
                            state: formatReportedStatus(
                              reliability.data?.lockTaskState,
                              t,
                              t("detail.lockStateUnknown"),
                            ),
                          })}
                        </dd>
                      </div>
                      <div>
                        <dt>{t("detail.factAccessibilityControl")}</dt>
                        <dd>
                          {formatReportedStatus(
                            reliability.data?.accessibilityServiceState,
                            t,
                          )}
                        </dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>{t("detail.factActiveHours")}</dt>
                    <dd>
                      {formatReportedStatus(
                        reliability.data?.activeHoursState,
                        t,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("detail.factSleepSupport")}</dt>
                    <dd>
                      {formatReportedStatus(
                        reliability.data?.sleepCapability,
                        t,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("detail.factRecovery")}</dt>
                    <dd>
                      {t("detail.recoveryValue", {
                        level: formatReportedCount(
                          reliability.data?.recoveryLevel,
                        ),
                        count: formatReportedCount(
                          reliability.data?.recoveryCount,
                        ),
                        state: reliability.data?.safeMode
                          ? t("detail.safeActive")
                          : t("detail.safeInactive"),
                      })}
                    </dd>
                  </div>
                  <div>
                    <dt>{t("detail.factMaintenance")}</dt>
                    <dd>
                      {reliability.data?.maintenanceSessionExpiresAt
                        ? t("detail.maintenanceUntil", {
                            date: new Date(
                              reliability.data.maintenanceSessionExpiresAt,
                            ).toLocaleString(formatLocale),
                          })
                        : t("detail.maintenanceInactive")}
                    </dd>
                  </div>
                </dl>
                {reliabilityCapabilityWarning(reliability.data, t) && (
                  <Alert>
                    <AlertDescription>
                      {reliabilityCapabilityWarning(reliability.data, t)}
                    </AlertDescription>
                  </Alert>
                )}
                {autostartWarning(reliability.data, t) && (
                  <Alert>
                    <AlertDescription>
                      {autostartWarning(reliability.data, t)}
                    </AlertDescription>
                  </Alert>
                )}
                {canManageScreens(auth.status?.user) && (
                  <>
                    <section
                      className="overflow-hidden rounded-xl border border-border"
                      aria-labelledby="reliability-controls-title"
                    >
                      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-muted/40 px-4 py-3">
                        <div className="space-y-0.5">
                          <h4
                            id="reliability-controls-title"
                            className="text-sm font-medium"
                          >
                            {t("detail.controlsTitle")}
                          </h4>
                          <p className="text-sm text-muted-foreground">
                            {t("detail.controlsBody")}
                          </p>
                        </div>
                        {command.isPending && (
                          <Badge>{t("detail.sending")}</Badge>
                        )}
                      </header>
                      <div className="grid gap-3 p-4 md:grid-cols-2">
                        {isAndroidScreen(screen.platform) && (
                          <div className="space-y-3 rounded-xl border border-border p-4">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                {t("detail.powerTitle")}
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                {t("detail.powerBody")}
                              </p>
                            </div>
                            <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1 [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-2 [&_button]:text-center">
                              <Button
                                variant="outline"
                                disabled={command.isPending}
                                onClick={() =>
                                  command.mutate({
                                    type: "power_assist_sleep",
                                    payload: {},
                                  })
                                }
                              >
                                {t("detail.testSleep")}
                              </Button>
                              <Button
                                variant="outline"
                                disabled={command.isPending}
                                onClick={() =>
                                  command.mutate({
                                    type: "power_assist_wake",
                                    payload: {},
                                  })
                                }
                              >
                                {t("detail.testWake")}
                              </Button>
                            </div>
                          </div>
                        )}
                        <div className="space-y-3 rounded-xl border border-border p-4">
                          <div className="space-y-0.5">
                            <h5 className="text-sm font-medium">
                              {t("detail.recoveryTitle")}
                            </h5>
                            <p className="text-sm text-muted-foreground">
                              {t("detail.recoveryBody")}
                            </p>
                          </div>
                          <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1 [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-2 [&_button]:text-center">
                            <Button
                              variant="outline"
                              disabled={command.isPending}
                              onClick={() =>
                                command.mutate({
                                  type: "retry_player_recovery",
                                  payload: {},
                                })
                              }
                            >
                              {t("detail.retryRecovery")}
                            </Button>
                            <Button
                              variant="outline"
                              disabled={
                                command.isPending || !reliability.data?.safeMode
                              }
                              onClick={() =>
                                command.mutate({
                                  type: "exit_safe_mode",
                                  payload: {},
                                })
                              }
                            >
                              {t("detail.exitSafe")}
                            </Button>
                          </div>
                        </div>
                        {reportsAutostart(reliability.data) && (
                          <div className="space-y-3 rounded-xl border border-border p-4">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                {t("detail.autostartTitle")}
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                {t("detail.autostartBody")}
                              </p>
                            </div>
                            <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1 [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-2 [&_button]:text-center">
                              <Button
                                variant="outline"
                                disabled={command.isPending}
                                onClick={() =>
                                  command.mutate({
                                    type: "install_autostart",
                                    payload: {},
                                  })
                                }
                              >
                                {t("detail.setupAutostart")}
                              </Button>
                              <Button
                                variant="outline"
                                disabled={command.isPending}
                                onClick={() =>
                                  requestScreenCommand({
                                    kind: "confirm",
                                    title: t("detail.removeAutostartTitle"),
                                    description: t(
                                      "detail.removeAutostartBody",
                                    ),
                                    confirmLabel: t(
                                      "detail.removeAutostartAction",
                                    ),
                                    destructive: true,
                                    commandType: "remove_autostart",
                                    payload: {},
                                  })
                                }
                              >
                                {t("detail.removeAutostart")}
                              </Button>
                            </div>
                          </div>
                        )}
                        {screen.platform.toLowerCase() === "linux" && (
                          <div className="space-y-3 rounded-xl border border-border p-4 md:col-span-2">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                {t("detail.displayTitle")}
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                {t("detail.displayBody")}
                              </p>
                            </div>
                            <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1 lg:grid-cols-4 [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-2 [&_button]:text-center">
                              {displayCapabilities.power && (
                                <>
                                  <Button
                                    variant="outline"
                                    disabled={command.isPending}
                                    onClick={() =>
                                      command.mutate({
                                        type: "display_power_on",
                                        payload: {},
                                      })
                                    }
                                  >
                                    {t("detail.powerOn")}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    disabled={command.isPending}
                                    onClick={() =>
                                      command.mutate({
                                        type: "display_power_off",
                                        payload: {},
                                      })
                                    }
                                  >
                                    {t("detail.powerOff")}
                                  </Button>
                                </>
                              )}
                              {displayCapabilities.input && (
                                <Button
                                  variant="outline"
                                  disabled={command.isPending}
                                  onClick={() =>
                                    requestScreenCommand({
                                      kind: "input",
                                      title: t("detail.inputTitle"),
                                      description: t("detail.inputBody"),
                                      confirmLabel: t("detail.inputConfirm"),
                                      input: {
                                        label: t("detail.inputLabel"),
                                        type: "text",
                                        // i18n-ignore: example CEC address format, not prose
                                        placeholder: "1.0.0.0",
                                      },
                                      commandType: "display_set_input",
                                      createPayload: (input) => ({ input }),
                                    })
                                  }
                                >
                                  {t("detail.inputTitle")}
                                </Button>
                              )}
                              {displayCapabilities.volume && (
                                <Button
                                  variant="outline"
                                  disabled={command.isPending}
                                  onClick={() =>
                                    requestScreenCommand({
                                      kind: "input",
                                      title: t("detail.volumeTitle"),
                                      description: t("detail.volumeBody"),
                                      confirmLabel: t("detail.volumeConfirm"),
                                      input: {
                                        label: t("detail.volumeLabel"),
                                        type: "number",
                                        min: 0,
                                        max: 100,
                                      },
                                      commandType: "display_set_volume",
                                      createPayload: (volume) => ({ volume }),
                                    })
                                  }
                                >
                                  {t("detail.volumeTitle")}
                                </Button>
                              )}
                              {displayCapabilities.mute && (
                                <>
                                  <Button
                                    variant="outline"
                                    disabled={command.isPending}
                                    onClick={() =>
                                      command.mutate({
                                        type: "display_mute",
                                        payload: {},
                                      })
                                    }
                                  >
                                    {t("detail.mute")}
                                  </Button>
                                  <Button
                                    variant="outline"
                                    disabled={command.isPending}
                                    onClick={() =>
                                      command.mutate({
                                        type: "display_unmute",
                                        payload: {},
                                      })
                                    }
                                  >
                                    {t("detail.unmute")}
                                  </Button>
                                </>
                              )}
                              {displayCapabilities.brightness && (
                                <Button
                                  variant="outline"
                                  disabled={command.isPending}
                                  onClick={() =>
                                    requestScreenCommand({
                                      kind: "input",
                                      title: t("detail.brightnessTitle"),
                                      description: t("detail.brightnessBody"),
                                      confirmLabel: t(
                                        "detail.brightnessConfirm",
                                      ),
                                      input: {
                                        label: t("detail.brightnessLabel"),
                                        type: "number",
                                        min: 0,
                                        max: 100,
                                      },
                                      commandType: "display_set_brightness",
                                      createPayload: (brightness) => ({
                                        brightness,
                                      }),
                                    })
                                  }
                                >
                                  {t("detail.brightnessTitle")}
                                </Button>
                              )}
                              <Button
                                variant="outline"
                                disabled={command.isPending}
                                onClick={() =>
                                  command.mutate({
                                    type: "display_probe",
                                    payload: {},
                                  })
                                }
                              >
                                {t("detail.probe")}
                              </Button>
                              {!hasDisplayControl && (
                                <span className="text-sm text-muted-foreground">
                                  {t("detail.noCapability")}
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                        {screen.platform.toLowerCase() === "linux" && (
                          <div className="space-y-3 rounded-xl border border-border p-4">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                {t("detail.airplayDiagTitle")}
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                {t("detail.airplayDiagBody")}
                              </p>
                            </div>
                            <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1 [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-2 [&_button]:text-center">
                              <Button
                                variant="outline"
                                disabled={command.isPending}
                                onClick={() =>
                                  command.mutate({
                                    type: "test_airplay_support",
                                    payload: {},
                                  })
                                }
                              >
                                {t("detail.testAirplay")}
                              </Button>
                            </div>
                          </div>
                        )}
                        <div className="space-y-3 rounded-xl border border-border p-4 md:col-span-2">
                          <div className="space-y-0.5">
                            <h5 className="text-sm font-medium">
                              {t("detail.playbackActionsTitle")}
                            </h5>
                            <p className="text-sm text-muted-foreground">
                              {t("detail.playbackActionsBody")}
                            </p>
                          </div>
                          <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1 lg:grid-cols-4 [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-2 [&_button]:text-center">
                            {(
                              [
                                ["retry_current_item", "detail.cmdRetry"],
                                ["skip_current_item", "detail.cmdSkip"],
                                ["recreate_renderer", "detail.cmdRenderer"],
                                [
                                  "recreate_playback_session",
                                  "detail.cmdSession",
                                ],
                                ["restart_activity", "detail.cmdActivity"],
                                ["restart_player_process", "detail.cmdRestart"],
                                ["resynchronize_player", "detail.cmdResync"],
                                ["run_player_self_test", "detail.cmdSelfTest"],
                              ] as const
                            ).map(([type, labelKey]) => (
                              <Button
                                variant="outline"
                                key={type}
                                disabled={command.isPending}
                                onClick={() =>
                                  command.mutate({ type, payload: {} })
                                }
                              >
                                {t(labelKey)}
                              </Button>
                            ))}
                          </div>
                        </div>
                      </div>
                    </section>
                  </>
                )}
                <FireTvAccessibilityAdbPanel screenId={id} />
              </section>
            )}

            {manageSection === "maintenance" &&
              isBrowserPlayer &&
              canManageScreens(auth.status?.user) && (
                <div className="space-y-4">
                  <BrowserCommandPanel
                    pending={command.isPending}
                    onCommand={(type, payload) =>
                      command.mutate({ type, payload })
                    }
                  />
                  {command.isSuccess && (
                    <p className="text-sm text-muted-foreground">
                      {t("detail.commandQueued")}
                    </p>
                  )}
                  <section className="space-y-3">
                    <h3 className="text-sm font-semibold">
                      {t("detail.recentOps")}
                    </h3>
                    <div className="grid gap-2">
                      {commands.data?.items?.map((c) => (
                        <div
                          key={c.id}
                          className="space-y-0.5 rounded-lg border border-border px-3 py-2"
                        >
                          <p className="text-sm font-medium">
                            {c.type?.replaceAll("_", " ") ??
                              t("detail.unknownCommand")}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {c.state} ·{" "}
                            {new Date(c.createdAt).toLocaleString(formatLocale)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {c.resultCode?.replaceAll("_", " ") ??
                              t("detail.noResult")}
                          </p>
                        </div>
                      ))}
                    </div>
                  </section>
                </div>
              )}
            {manageSection === "maintenance" &&
              !isBrowserPlayer &&
              canManageScreens(auth.status?.user) && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    {t("detail.sectionMaintenance")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t("detail.maintBody")}
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        command.mutate({ type: "sync_now", payload: {} })
                      }
                    >
                      {t("detail.syncNow")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        command.mutate({ type: "reload_playback", payload: {} })
                      }
                    >
                      {t("detail.reload")}
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        command.mutate({
                          type: "identify_screen",
                          payload: { durationSeconds: 30 },
                        })
                      }
                    >
                      {t("detail.identify")}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        requestScreenCommand({
                          kind: "confirm",
                          title: t("detail.clearCacheTitle"),
                          description: t("detail.clearCacheBody"),
                          confirmLabel: t("detail.clearCacheAction"),
                          destructive: true,
                          commandType: "clear_media_cache",
                          payload: {},
                        })
                      }
                    >
                      {t("detail.clearCacheAction")}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        requestScreenCommand({
                          kind: "confirm",
                          title: t("detail.clearSiteTitle"),
                          description: t("detail.clearSiteBody"),
                          confirmLabel: t("detail.clearSiteAction"),
                          destructive: true,
                          commandType: "clear_website_data",
                          payload: {},
                        })
                      }
                    >
                      {t("detail.clearSiteAction")}
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() => {
                        const disabling = !assignment.data?.playbackDisabled;
                        if (!disabling) {
                          command.mutate({
                            type: "enable_playback",
                            payload: {},
                          });
                        } else {
                          requestScreenCommand({
                            kind: "confirm",
                            title: t("detail.disableTitle"),
                            description: t("detail.disableBody"),
                            confirmLabel: t("detail.disableAction"),
                            destructive: true,
                            commandType: "disable_playback",
                            payload: {},
                          });
                        }
                      }}
                    >
                      {assignment.data?.playbackDisabled
                        ? t("detail.enablePlayback")
                        : t("detail.disableAction")}
                    </Button>
                  </div>
                  {command.isSuccess && (
                    <p className="text-sm text-muted-foreground">
                      {t("detail.commandQueued")}
                    </p>
                  )}
                  <div className="grid gap-2">
                    {commands.data?.items?.map((c) => (
                      <div
                        key={c.id}
                        className="space-y-0.5 rounded-lg border border-border px-3 py-2"
                      >
                        <p className="text-sm font-medium">
                          {c.type?.replaceAll("_", " ") ??
                            t("detail.unknownCommand")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {c.state} ·{" "}
                          {new Date(c.createdAt).toLocaleString(formatLocale)}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {c.resultCode?.replaceAll("_", " ") ??
                            t("detail.noResult")}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            {manageSection === "maintenance" &&
              !canManageScreens(auth.status?.user) && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">
                    {t("detail.recentOps")}
                  </h3>
                  {commands.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-56" />
                      <p className="text-sm text-muted-foreground">
                        {t("detail.loadingOps")}
                      </p>
                    </div>
                  ) : (commands.data?.items?.length ?? 0) === 0 ? (
                    <p>{t("detail.noOps")}</p>
                  ) : (
                    <div className="grid gap-2">
                      {commands.data?.items?.map((c) => (
                        <div
                          key={c.id}
                          className="space-y-0.5 rounded-lg border border-border px-3 py-2"
                        >
                          <p className="text-sm font-medium">
                            {c.type?.replaceAll("_", " ") ??
                              t("detail.unknownCommand")}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {c.state} ·{" "}
                            {new Date(c.createdAt).toLocaleString(formatLocale)}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {c.resultCode?.replaceAll("_", " ") ??
                              t("detail.noResult")}
                          </p>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
            {manageSection === "device" && (
              <>
                <section className="grid gap-x-8 gap-y-6 border-y border-border py-4 md:grid-cols-2">
                  <section
                    className="space-y-3"
                    aria-labelledby="device-facts-title"
                  >
                    <h3
                      id="device-facts-title"
                      className="text-sm font-semibold"
                    >
                      {t("detail.sectionDevice")}
                    </h3>
                    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                      <OverviewFact
                        label={t("detail.factHardware")}
                        value={
                          `${screen.deviceManufacturer ?? ""} ${screen.deviceModel ?? ""}`.trim() ||
                          t("shared.notReported")
                        }
                      />
                      <OverviewFact
                        label={t("detail.factPlatform")}
                        value={
                          screen.platform === "linux"
                            ? t("platform.linux")
                            : `${formatReportedStatus(screen.platform, t)} ${screen.androidVersion ?? ""}`.trim()
                        }
                      />
                      <OverviewFact
                        label={t("detail.factPlayerVersion")}
                        value={
                          screen.playerVersionCode
                            ? t("detail.versionWithCode", {
                                version:
                                  screen.playerVersion ??
                                  t("shared.notReported"),
                                code: screen.playerVersionCode,
                              })
                            : (screen.playerVersion ?? t("shared.notReported"))
                        }
                      />
                      {isAndroidScreen(screen.platform) && (
                        <>
                          <OverviewFact
                            label={t("detail.factAndroidSdk")}
                            value={screen.androidSdk ?? t("shared.notReported")}
                          />
                          <OverviewFact
                            label={t("detail.factInstallerSource")}
                            value={
                              screen.installerSource ?? t("shared.notReported")
                            }
                          />
                          <OverviewFact
                            label={t("detail.factInstallPermission")}
                            value={
                              screen.installPermissionStatus?.replaceAll(
                                "_",
                                " ",
                              ) ?? t("shared.unknown")
                            }
                          />
                        </>
                      )}
                      <OverviewFact
                        label={t("detail.factPlayerUpdate")}
                        value={`${screen.updateState?.replaceAll("_", " ") ?? t("detail.noDeployment")}${screen.updateExpectedBytes ? ` · ${Math.round(((screen.updateDownloadedBytes ?? 0) / screen.updateExpectedBytes) * 100)}%` : ""}${screen.updateError ? ` · ${screen.updateError}` : ""}`}
                      />
                      <OverviewFact
                        label={t("detail.factResolution")}
                        value={t("detail.resolutionValue", {
                          width: screen.screenWidth ?? t("shared.notReported"),
                          height:
                            screen.screenHeight ?? t("shared.notReported"),
                        })}
                      />
                      <OverviewFact
                        label={t("detail.factLocale")}
                        value={screen.locale || t("shared.notReported")}
                      />
                      <OverviewFact
                        label={t("detail.factTimezone")}
                        value={screen.timezone || t("shared.notReported")}
                      />
                    </dl>
                  </section>
                  <section
                    className="space-y-3"
                    aria-labelledby="connection-facts-title"
                  >
                    <h3
                      id="connection-facts-title"
                      className="text-sm font-semibold"
                    >
                      {t("detail.factConnectionTitle")}
                    </h3>
                    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                      <OverviewFact
                        label={t("detail.factStatus")}
                        value={<StatusLabel status={screen.status} />}
                      />
                      <OverviewFact
                        label={t("detail.factLastContact")}
                        value={formatContact(
                          screen.lastContactAt,
                          t,
                          formatLocale,
                        )}
                      />
                      <OverviewFact
                        label={t("detail.factNetworkAddress")}
                        value={screen.lastKnownIp || t("shared.notReported")}
                      />
                      <OverviewFact
                        label={t("detail.factCredential")}
                        value={
                          screen.hasActiveCredential
                            ? t("detail.credentialActive")
                            : t("detail.credentialRevoked")
                        }
                      />
                    </dl>
                  </section>
                </section>
                <Card size="sm">
                  <CardHeader>
                    <CardTitle>{t("detail.hwTitle")}</CardTitle>
                    <CardDescription>{t("detail.hwBody")}</CardDescription>
                  </CardHeader>
                  <CardContent>
                    {playerHistory.data?.items.length ? (
                      <ItemGroup className="gap-0 divide-y divide-border">
                        {playerHistory.data.items.map((hardware) => (
                          <Item
                            key={hardware.id}
                            size="xs"
                            render={<div role="listitem" />}
                            className="rounded-none px-0"
                          >
                            <ItemContent className="min-w-0">
                              <ItemTitle>
                                {hardware.manufacturer} {hardware.model}
                              </ItemTitle>
                              <ItemDescription>
                                {hardware.platform} · {hardware.playerVersion} ·{" "}
                                {hardware.screenWidth}×{hardware.screenHeight} ·{" "}
                                {t("detail.hwPaired", {
                                  date: new Date(
                                    hardware.pairedAt,
                                  ).toLocaleDateString(formatLocale),
                                })}
                                {hardware.retiredAt
                                  ? t("detail.hwRetired", {
                                      date: new Date(
                                        hardware.retiredAt,
                                      ).toLocaleDateString(formatLocale),
                                    })
                                  : t("detail.hwCurrent")}
                                {hardware.retirementReason
                                  ? ` · ${hardware.retirementReason}`
                                  : ""}
                              </ItemDescription>
                            </ItemContent>
                          </Item>
                        ))}
                      </ItemGroup>
                    ) : playerHistory.isLoading ? (
                      <Skeleton className="h-12 w-full" />
                    ) : (
                      <p className="text-sm text-muted-foreground">
                        {t("detail.hwEmpty")}
                      </p>
                    )}
                  </CardContent>
                </Card>

                {canManageScreens(auth.status?.user) && (
                  <section
                    className="space-y-4 border-t border-border pt-4"
                    aria-labelledby="player-access-title"
                  >
                    <header>
                      <h3
                        id="player-access-title"
                        className="text-sm font-semibold"
                      >
                        {t("detail.accessTitle")}
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {t("detail.accessBody")}
                      </p>
                    </header>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          {screen.enabled
                            ? t("detail.enabledTitle")
                            : t("detail.disabledTitle")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {screen.enabled
                            ? t("detail.enabledBody")
                            : t("detail.disabledBody")}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => stateMutation.mutate(!screen.enabled)}
                        disabled={stateMutation.isPending}
                      >
                        {stateMutation.isPending
                          ? t("common:actions.saving")
                          : screen.enabled
                            ? t("detail.disableButton")
                            : t("detail.enableButton")}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                      <div>
                        <p className="text-sm font-medium">
                          {t("detail.archiveTitle")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t("detail.archiveBody")}
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        onClick={() => setConfirmArchive(true)}
                      >
                        {t("detail.archiveAction")}
                      </Button>
                    </div>
                  </section>
                )}
              </>
            )}
          </Tabs>
        </ScreenDetailPanel>

        {tab === "settings" && (
          <TabsContent
            value="settings"
            className="min-w-0 space-y-4 outline-none"
          >
            <Card size="sm">
              <CardHeader>
                <CardTitle>{t("detail.editTitle")}</CardTitle>
                <CardDescription>{t("detail.editBody")}</CardDescription>
                {canManageScreens(auth.status?.user) && (
                  <CardAction>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setEditingDetails(true)}
                    >
                      {t("grid.editDetails")}
                    </Button>
                  </CardAction>
                )}
              </CardHeader>
              <CardContent>
                <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2 lg:grid-cols-3">
                  <OverviewFact
                    label={t("approval.nameLabel")}
                    value={screen.name}
                  />
                  <OverviewFact
                    label={t("detail.factLocation")}
                    value={
                      [screen.location, roomLabel(screen, t)]
                        .filter(Boolean)
                        .join(" · ") || t("shared.notSet")
                    }
                  />
                  <OverviewFact
                    label={t("approval.description")}
                    value={screen.description || t("shared.notSet")}
                  />
                </dl>
              </CardContent>
            </Card>
            <PlayerPolicyEditor
              target="screen"
              id={id}
              onDirtyChange={setPolicyDirty}
            />
          </TabsContent>
        )}
      </Tabs>
      <ScreenDetailPanel
        open={snapshotsOpen}
        onOpenChange={(open) => setDetailPanel("snapshots", open)}
        title={t("preview.snapshotsTitle")}
        description={t("preview.snapshotsBody")}
      >
        <SnapshotHistoryPanel screenId={id} />
      </ScreenDetailPanel>
      <ScreenDetailPanel
        open={explanationOpen}
        onOpenChange={(open) => setDetailPanel("explanation", open)}
        title={t("playback.explanationTitle")}
        description={t("playback.explanationBody")}
      >
        <PlaybackExplanationPanel screenId={id} assignment={assignment.data} />
      </ScreenDetailPanel>
      <Dialog
        open={pendingDestination !== null}
        onOpenChange={(open) => {
          if (!open) setPendingDestination(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("detail.discardTitle")}</DialogTitle>
            <DialogDescription>{t("detail.discardBody")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDestination(null)}
            >
              {t("detail.keepEditing")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDestination) commitDestination(pendingDestination);
              }}
            >
              {t("detail.discardAction")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <ArchiveScreenDialog
        screen={screen}
        csrfToken={auth.status?.csrfToken ?? ""}
        open={confirmArchive}
        onOpenChange={setConfirmArchive}
        onArchived={() => void navigate("/screens")}
      />
      <AlertDialog
        open={screenCommandAction?.kind === "confirm"}
        onOpenChange={(open) => {
          if (!open && screenCommandAction?.kind === "confirm") {
            setScreenCommandAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {screenCommandAction?.kind === "confirm"
                ? screenCommandAction.title
                : t("detail.confirmFallback")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {screenCommandAction?.kind === "confirm"
                ? screenCommandAction.description
                : t("detail.reviewFallback")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={command.isPending}>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant={
                screenCommandAction?.kind === "confirm" &&
                screenCommandAction.destructive
                  ? "destructive"
                  : "default"
              }
              disabled={command.isPending}
              onClick={confirmScreenCommand}
            >
              {screenCommandAction?.kind === "confirm"
                ? screenCommandAction.confirmLabel
                : t("detail.continueAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <Dialog
        open={screenCommandAction?.kind === "input"}
        onOpenChange={(open) => {
          if (!open && screenCommandAction?.kind === "input") {
            setScreenCommandAction(null);
            setScreenCommandError("");
          }
        }}
      >
        <DialogContent>
          {screenCommandAction?.kind === "input" && (
            <form
              className="space-y-5"
              onSubmit={(event) => {
                event.preventDefault();
                confirmScreenCommand();
              }}
            >
              <DialogHeader>
                <DialogTitle>{screenCommandAction.title}</DialogTitle>
                <DialogDescription>
                  {screenCommandAction.description}
                </DialogDescription>
              </DialogHeader>
              <Field className="gap-2">
                <FieldLabel
                  htmlFor="screen-command-input"
                  className="text-sm font-medium"
                >
                  {screenCommandAction.input.label}
                </FieldLabel>
                <Input
                  id="screen-command-input"
                  autoFocus
                  aria-label={screenCommandAction.input.label}
                  type={screenCommandAction.input.type}
                  min={screenCommandAction.input.min}
                  max={screenCommandAction.input.max}
                  placeholder={screenCommandAction.input.placeholder}
                  value={screenCommandInput}
                  onChange={(event) => {
                    setScreenCommandInput(event.target.value);
                    setScreenCommandError("");
                  }}
                />
              </Field>
              {screenCommandError && (
                <p className="text-sm text-destructive" role="alert">
                  {screenCommandError}
                </p>
              )}
              <DialogFooter>
                <Button
                  variant="outline"
                  type="button"
                  onClick={() => setScreenCommandAction(null)}
                >
                  {t("common:actions.cancel")}
                </Button>
                <Button type="submit" disabled={command.isPending}>
                  {screenCommandAction.confirmLabel}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}

export function StatusLabel({ status }: { status: ScreenStatus }) {
  const { t } = useTranslation("screens");
  const entry = statusContent[status];
  const Icon = entry?.Icon ?? CircleAlert;
  const variant =
    status === "offline" || status === "stale"
      ? "destructive"
      : status === "recent"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant} className="gap-1.5">
      <Icon aria-hidden="true" />
      {entry ? t(entry.labelKey) : t("status.unknown")}
    </Badge>
  );
}

function OverviewFact({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div className="min-w-0 space-y-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words text-sm font-medium">{value}</dd>
    </div>
  );
}

function formatContact(value: string | undefined, t: ScreensT, locale: string) {
  if (!value) return t("contact.never");
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return t("contact.justNow");
  if (seconds < 3600)
    return t("contact.minutesAgo", { count: Math.floor(seconds / 60) });
  if (seconds < 86400)
    return t("contact.hoursAgo", { count: Math.floor(seconds / 3600) });
  return new Date(value).toLocaleDateString(locale);
}
