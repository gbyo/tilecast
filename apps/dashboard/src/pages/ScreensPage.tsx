import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Airplay,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  Grid2X2,
  Link2,
  List,
  MoreHorizontal,
  Monitor,
  Pencil,
  Play,
  RefreshCw,
  ShieldAlert,
  ShieldOff,
  Search,
  SlidersHorizontal,
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
import { Trans, useTranslation } from "react-i18next";
import { z } from "zod";
import { api } from "../api/client";
import { useFormatLocale } from "../i18n";
import type {
  Location,
  PairingRequest,
  ReliabilityStatus,
  Screen,
  ScreenStatus,
  User,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { ScreenContentChain } from "../content/ScreenContentChain";
import { AirPlayPresentDialog } from "../components/AirPlayPresentDialog";
import { DashboardSearch } from "../components/DashboardListToolbar";
import { ScreenPresentationNetworkPanel } from "../components/ScreenPresentationNetworkPanel";
import { QuickPresentDialog } from "../components/QuickPresentDialog";
import { FormField } from "../components/FormField";
import { FireTvAccessibilityAdbPanel } from "../components/FireTvAccessibilityAdbPanel";
import { PlayerPolicyEditor } from "../settings/PlayerPolicyEditor";
import { formatLocationAddress } from "../settings/LocationsPanel";
import { isAndroidScreen } from "../playerPlatform";
import { previewApi } from "../api/previews";
import { previewAge } from "../components/livePreviewState";
import { ScreenFleetTable } from "../components/ScreenFleetTable";
import { ScreenActivityPanel } from "../components/ScreenActivityPanel";
import { AspectRatio } from "../components/ui/aspect-ratio";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "../components/ui/combobox";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { toast } from "../components/ui/toast";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/ui/collapsible";
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
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../components/ui/dropdown-menu";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/ui/empty";
import {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from "../components/ui/field";
import { Input } from "../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../components/ui/radio-group";
import { Textarea } from "../components/ui/textarea";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from "../components/ui/item";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "../components/ui/popover";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "../components/ui/toggle-group";
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

export const canManageScreens = (user?: User) =>
  user?.role === "owner" || user?.role === "administrator";

export type ScreenManageSection =
  "settings" | "health" | "maintenance" | "device";

const screenManageSections: readonly ScreenManageSection[] = [
  "settings",
  "health",
  "maintenance",
  "device",
];

export function normalizeScreenManageSection(
  requestedTab: string,
  requestedSection: string | null,
): ScreenManageSection {
  if (requestedTab === "player-settings" || requestedTab === "settings")
    return "settings";
  if (requestedTab === "reliability") return "health";
  if (requestedTab === "commands") return "maintenance";
  if (requestedTab === "device" && !requestedSection) return "device";
  return screenManageSections.includes(requestedSection as ScreenManageSection)
    ? (requestedSection as ScreenManageSection)
    : "settings";
}

export type ScreenDetailTab =
  "overview" | "content" | "activity" | "device" | "settings";
type ScreenTabDestination = {
  tab: ScreenDetailTab;
  section?: ScreenManageSection;
};
type ScreenCommandAction =
  | {
      kind: "confirm";
      title: string;
      description: string;
      confirmLabel: string;
      destructive?: boolean;
      commandType: string;
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
      commandType: string;
      createPayload: (value: string | number) => Record<string, unknown>;
    };

const screenDetailTabs: readonly ScreenDetailTab[] = [
  "overview",
  "content",
  "activity",
  "device",
  "settings",
];

// Legacy URLs remain valid while the resource view gets the new tab names.
const legacyManageTabs = ["player-settings", "reliability", "commands"];

export function normalizeScreenDetailTab(
  requestedTab: string | null,
  requestedSection: string | null = null,
): ScreenDetailTab {
  if (!requestedTab || requestedTab === "snapshots") return "overview";
  if (requestedTab === "manage") {
    return normalizeScreenManageSection(requestedTab, requestedSection) ===
      "settings"
      ? "settings"
      : "device";
  }
  if (legacyManageTabs.includes(requestedTab)) {
    return requestedTab === "player-settings" ? "settings" : "device";
  }
  return screenDetailTabs.includes(requestedTab as ScreenDetailTab)
    ? (requestedTab as ScreenDetailTab)
    : "overview";
}
const formatBytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
};
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
const makeCodeSchema = (t: ScreensT) =>
  z.object({
    code: z.string().trim().min(6, t("pair.codeRequired")).max(9),
  });
const makeApprovalSchema = (t: ScreensT) =>
  z.object({
    name: z.string().trim().min(2, t("approval.nameRequired")).max(120),
    locationId: z.string().optional(),
    roomName: z.string().max(120),
    roomNumber: z.string().max(80),
    description: z.string().max(1000),
  });
type CodeForm = z.infer<ReturnType<typeof makeCodeSchema>>;
type ApprovalForm = z.infer<ReturnType<typeof makeApprovalSchema>>;
export const pairingApprovalPayload = (
  request: PairingRequest,
  values: ApprovalForm,
  destination: PairingDestination = "automatic",
  replacementScreenId?: string,
) => ({
  ...values,
  replaceExistingCredential:
    destination === "credential_repair" ||
    (destination === "automatic" &&
      request.previouslyPaired &&
      request.hasActiveCredential),
  ...(destination === "replace_hardware"
    ? { replaceHardware: true, replacementScreenId }
    : {}),
});
type PairingDestination =
  "automatic" | "new_screen" | "credential_repair" | "replace_hardware";
export const pairingApprovalLabel = (
  request: PairingRequest,
  t: ScreensT,
  destination: PairingDestination = "automatic",
) =>
  destination === "replace_hardware"
    ? t("approval.actionReplace")
    : destination === "credential_repair" ||
        (destination === "automatic" &&
          request.previouslyPaired &&
          request.hasActiveCredential)
      ? t("approval.actionRepair")
      : t("approval.actionApprove");

function LocationPicker({
  locations,
  value,
  onChange,
}: {
  locations: Location[];
  value?: string;
  onChange: (value?: string) => void;
}) {
  const { t } = useTranslation("screens");
  const selected = locations.find((location) => location.id === value);
  const items = [
    { value: "__unassigned__", label: t("shared.unassigned") },
    ...locations.map((location) => {
      const address = formatLocationAddress(location);
      return {
        value: location.id,
        label: address ? `${location.name} — ${address}` : location.name,
      };
    }),
  ];
  return (
    <Field className="gap-2">
      <FieldLabel htmlFor="screen-location" className="text-sm font-medium">
        {t("picker.locationLabel")}
      </FieldLabel>
      <Select
        items={items}
        value={value ?? "__unassigned__"}
        onValueChange={(next) =>
          onChange(next === "__unassigned__" || !next ? undefined : next)
        }
      >
        <SelectTrigger id="screen-location" className="w-full">
          <SelectValue placeholder={t("shared.unassigned")} />
        </SelectTrigger>
        <SelectContent>
          {items.map((item) => (
            <SelectItem key={item.value} value={item.value}>
              {item.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {selected && formatLocationAddress(selected) && (
        <small className="text-xs text-muted-foreground">
          {formatLocationAddress(selected)}
        </small>
      )}
      <Link
        className="w-fit text-xs underline underline-offset-4"
        to="/settings/locations"
      >
        {t("picker.createLocation")}
      </Link>
    </Field>
  );
}

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
      | "status.revoked";
    Icon: typeof Wifi;
  }
> = {
  online: { labelKey: "status.online", Icon: Wifi },
  recent: { labelKey: "status.recent", Icon: Wifi },
  stale: { labelKey: "status.stale", Icon: CircleAlert },
  offline: { labelKey: "status.offline", Icon: WifiOff },
  disabled: { labelKey: "status.disabled", Icon: ShieldOff },
  revoked: { labelKey: "status.revoked", Icon: ShieldOff },
};

export function ScreensWorkspacePage() {
  const { t } = useTranslation("screens");
  const auth = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const manageable = canManageScreens(auth.status?.user);
  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    refetchInterval: 10_000,
  });
  const archive =
    location.pathname === "/screens/archive" ||
    location.pathname.startsWith("/screens/archive/");
  const activeTab = archive ? "archive" : "fleet";

  return (
    <div className="w-full min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("page.title")}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {archive
              ? t("archive.body")
              : screens.isLoading
                ? t("page.loadingInventory")
                : screenInventorySummary(screens.data?.items ?? [], t)}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {manageable && (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              to="/screens/pair"
            >
              <Plus aria-hidden="true" /> {t("page.pairScreen")}
            </Link>
          )}
          {manageable && !archive && (
            <TakeoverAction screens={screens.data?.items ?? []} />
          )}
        </div>
      </header>
      <Tabs
        value={activeTab}
        onValueChange={(value) =>
          void navigate(value === "archive" ? "/screens/archive" : "/screens")
        }
        className="min-w-0 gap-4"
      >
        <TabsList variant="line" aria-label="Screen views">
          <TabsTrigger value="fleet">Fleet</TabsTrigger>
          <TabsTrigger value="archive">Archive</TabsTrigger>
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
    queryKey: ["screens"],
    queryFn: api.screens,
    refetchInterval: 10_000,
  });
  const pending = useQuery({
    queryKey: ["screens", "pairing", "pending"],
    queryFn: api.pendingPairings,
    refetchInterval: 10_000,
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
          <AlertDescription>{screens.error.message}</AlertDescription>
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

const useTakeovers = () =>
  useQuery({
    queryKey: ["takeovers"],
    queryFn: api.takeovers,
    refetchInterval: 10_000,
  });

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

function TakeoverAction({ screens }: { screens: Screen[] }) {
  const { t } = useTranslation(["screens", "common"]);
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [confirmationOpen, setConfirmationOpen] = useState(false);
  const [passwordOpen, setPasswordOpen] = useState(false);
  const [activationPassword, setActivationPassword] = useState("");
  const [name, setName] = useState("");
  const [playlistId, setPlaylistId] = useState("");
  const [screenIds, setScreenIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [minutes, setMinutes] = useState(60);
  const takeovers = useTakeovers();
  const activeCount = (takeovers.data?.items ?? []).filter(
    (item) => item.status === "active",
  ).length;
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
    queryKey: ["settings", "takeover-defaults"],
    queryFn: api.settings,
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
      <Button
        variant="outline"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ShieldAlert size={16} aria-hidden="true" />
        {t("takeover.title")}
        {activeCount > 0 && (
          <Badge variant="secondary">
            {t("takeover.activeBadge", { count: activeCount })}
          </Badge>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(90vh,54rem)] max-w-3xl overflow-y-auto">
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
              <AlertDescription>{activate.error.message}</AlertDescription>
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
                <AlertDescription>{activate.error.message}</AlertDescription>
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
  const [search, setSearch] = useStoredState<string>(
    "tilecast.screens.search",
    "",
  );
  const [status, setStatus] = useStoredState<string>(
    "tilecast.screens.status",
    "",
  );
  const [location, setLocation] = useStoredState<string>(
    "tilecast.screens.location",
    "",
  );
  const [platform, setPlatform] = useStoredState<string>(
    "tilecast.screens.platform",
    "",
  );
  const [playing, setPlaying] = useStoredState<string>(
    "tilecast.screens.playing",
    "",
  );
  const [syncGroup, setSyncGroup] = useStoredState<string>(
    "tilecast.screens.syncGroup",
    "",
  );
  const [orientation, setOrientation] = useStoredState<string>(
    "tilecast.screens.orientation",
    "",
  );
  const [update, setUpdate] = useStoredState<string>(
    "tilecast.screens.update",
    "",
  );
  const [groupBy, setGroupBy] = useStoredState<string>(
    "tilecast.screens.groupBy",
    "location",
  );
  const [sort, setSort] = useStoredState<string>(
    "tilecast.screens.sort",
    "name-asc",
  );
  const [view, setView] = useStoredState<"table" | "grid">(
    "tilecast.screens.view",
    "table",
  );
  const [collapsed, setCollapsed] = useState<Set<string>>(
    () =>
      new Set(
        JSON.parse(
          storageGet("session", "tilecast.screens.collapsed") ?? "[]",
        ) as string[],
      ),
  );
  const [selected, setSelected] = useState<Set<string>>(new Set());
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
  // Only the filters put away inside "More filters" are chipped. Search, status,
  // location, platform, and now playing each show their own value in the toolbar
  // directly above, so chipping them restated the whole row back to the reader.
  const chippedFilters: { facet: string; value: string; remove: () => void }[] =
    [];
  if (syncGroup)
    chippedFilters.push({
      facet: t("list.groupFilter"),
      value: syncGroupFilterLabel(syncGroup, screens, t),
      remove: () => setSyncGroup(""),
    });
  if (orientation)
    chippedFilters.push({
      facet: t("list.orientationFilter"),
      value:
        orientation === "portrait"
          ? t("list.orientationOptions.portrait")
          : t("list.orientationOptions.landscape"),
      remove: () => setOrientation(""),
    });
  if (update)
    chippedFilters.push({
      facet: t("list.updateFilter"),
      value: updateLabel(update, t),
      remove: () => setUpdate(""),
    });
  const advancedFilterCount = chippedFilters.length;
  const anyFilterActive = Boolean(
    search ||
    status ||
    location ||
    platform ||
    playing ||
    syncGroup ||
    orientation ||
    update,
  );
  const clearFilters = () => {
    setSearch("");
    setStatus("");
    setLocation("");
    setPlatform("");
    setPlaying("");
    setSyncGroup("");
    setOrientation("");
    setUpdate("");
  };
  const toggleCollapsed = (key: string) => {
    const next = new Set(collapsed);
    if (next.has(key)) next.delete(key);
    else next.add(key);
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
    <section className="min-w-0 space-y-4" aria-label={t("list.sectionLabel")}>
      <ScreenSummary screens={screens} status={status} onStatus={setStatus} />
      <div className="space-y-3">
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
          />
          <FleetFilterSelect
            label={t("list.statusFilter")}
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: t("list.statusOptions.all") },
              { value: "online", label: t("status.online") },
              { value: "offline", label: t("status.offline") },
              { value: "attention", label: t("status.attention") },
              { value: "updating", label: t("status.updating") },
              { value: "syncing", label: t("status.syncing") },
            ]}
          />
          <FleetFilterSelect
            label={t("list.locationFilter")}
            value={location}
            onChange={setLocation}
            options={[
              { value: "", label: t("list.allLocations") },
              ...locationItems.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
          />
          <FleetFilterSelect
            label={t("list.platformFilter")}
            value={platform}
            onChange={setPlatform}
            options={[
              { value: "", label: t("list.allPlatforms") },
              ...[...new Set(screens.map((item) => item.platform))]
                .sort()
                .map((item) => ({
                  value: item,
                  label: platformLabel(item, t),
                })),
            ]}
          />
          <FleetFilterSelect
            label={t("list.playingFilter")}
            value={playing}
            onChange={setPlaying}
            options={[
              { value: "", label: t("list.playingOptions.any") },
              {
                value: "presentation",
                label: t("list.playingOptions.presentation"),
              },
              { value: "playlist", label: t("list.playingOptions.playlist") },
              { value: "nothing", label: t("shared.nothingAssigned") },
            ]}
          />
          <Popover>
            <PopoverTrigger
              render={<Button variant="outline" />}
              aria-label={
                advancedFilterCount > 0
                  ? t("list.moreFiltersActive", {
                      count: advancedFilterCount,
                    })
                  : t("list.moreFiltersLabel")
              }
            >
              <SlidersHorizontal aria-hidden="true" /> {t("list.moreFilters")}
              {advancedFilterCount > 0 && (
                <Badge variant="secondary">{advancedFilterCount}</Badge>
              )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 gap-3">
              <h3 className="text-sm font-medium">{t("list.moreFilters")}</h3>
              <FleetFilterSelect
                label={t("list.groupFilter")}
                value={syncGroup}
                onChange={setSyncGroup}
                className="w-full"
                options={[
                  { value: "", label: t("list.syncOptions.all") },
                  { value: "any", label: t("list.syncOptions.any") },
                  { value: "none", label: t("list.syncOptions.none") },
                  ...[
                    ...new Map(
                      screens
                        .filter((item) => item.syncGroupId)
                        .map(
                          (item) =>
                            [
                              item.syncGroupId ?? "",
                              item.syncGroupName ??
                                t("list.syncOptions.fallback"),
                            ] as const,
                        ),
                    ).entries(),
                  ].map(([id, name]) => ({ value: id, label: name })),
                ]}
              />
              <FleetFilterSelect
                label={t("list.orientationFilter")}
                value={orientation}
                onChange={setOrientation}
                className="w-full"
                options={[
                  { value: "", label: t("list.orientationOptions.any") },
                  {
                    value: "landscape",
                    label: t("list.orientationOptions.landscape"),
                  },
                  {
                    value: "portrait",
                    label: t("list.orientationOptions.portrait"),
                  },
                ]}
              />
              <FleetFilterSelect
                label={t("list.updateFilter")}
                value={update}
                onChange={setUpdate}
                className="w-full"
                options={[
                  { value: "", label: t("list.updateOptions.any") },
                  { value: "current", label: t("list.updateOptions.current") },
                  {
                    value: "downloading",
                    label: t("list.updateOptions.downloading"),
                  },
                  { value: "attention", label: t("status.attention") },
                ]}
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          {anyFilterActive ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">
                {t("list.resultCount", {
                  filtered: filtered.length,
                  total: screens.length,
                })}
              </span>
              {chippedFilters.map((filter) => (
                <Badge
                  key={filter.facet}
                  variant="secondary"
                  className="gap-1.5"
                >
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
                {t("list.clearFilters")}
              </Button>
            </div>
          ) : (
            <span />
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <FleetFilterSelect
              label={t("list.groupBy")}
              value={groupBy}
              onChange={setGroupBy}
              options={[
                { value: "location", label: t("list.groupOptions.location") },
                { value: "status", label: t("list.groupOptions.status") },
                { value: "sync", label: t("list.groupOptions.sync") },
                { value: "none", label: t("list.groupOptions.none") },
              ]}
            />
            <FleetFilterSelect
              label={t("list.sortLabel")}
              className="w-52 max-sm:flex-1"
              value={sort}
              onChange={setSort}
              options={[
                { value: "name-asc", label: t("list.sortOptions.nameAsc") },
                { value: "name-desc", label: t("list.sortOptions.nameDesc") },
                {
                  value: "location-asc",
                  label: t("list.sortOptions.locationAsc"),
                },
                { value: "status-asc", label: t("list.sortOptions.status") },
                {
                  value: "contact-desc",
                  label: t("list.sortOptions.contactDesc"),
                },
                {
                  value: "contact-asc",
                  label: t("list.sortOptions.contactAsc"),
                },
                { value: "added-desc", label: t("list.sortOptions.addedDesc") },
                {
                  value: "platform-asc",
                  label: t("list.sortOptions.platform"),
                },
              ]}
            />
            <ToggleGroup
              value={[view]}
              multiple={false}
              onValueChange={(values) => {
                const selectedView = values[0];
                if (selectedView === "table" || selectedView === "grid") {
                  setView(selectedView);
                }
              }}
              aria-label={t("list.viewLabel")}
              variant="outline"
              spacing={0}
            >
              <ToggleGroupItem value="table" aria-label={t("list.tableView")}>
                <List aria-hidden="true" />
              </ToggleGroupItem>
              <ToggleGroupItem value="grid" aria-label={t("list.gridView")}>
                <Grid2X2 aria-hidden="true" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      </div>
      {view === "grid" && (
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
            size="sm"
            onClick={() => void changeSelectedLocation()}
          >
            {t("list.moveAction")}
          </Button>
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
              <section className="min-w-0 space-y-2" key={group.key}>
                {groupBy !== "none" && (
                  <header className="flex flex-wrap items-center gap-2 border-b border-border py-2">
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-expanded={!isCollapsed}
                      aria-label={
                        isCollapsed
                          ? t("list.expandGroup", { label: group.label })
                          : t("list.collapseGroup", { label: group.label })
                      }
                      onClick={() => toggleCollapsed(group.key)}
                    >
                      {isCollapsed ? (
                        <ChevronRight size={16} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={16} aria-hidden="true" />
                      )}
                    </Button>
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
                    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
                      <strong className="truncate text-sm">
                        {group.label}
                      </strong>
                      <Badge variant="secondary">{group.screens.length}</Badge>
                      {group.description && (
                        <span className="text-xs text-muted-foreground">
                          {group.description}
                        </span>
                      )}
                    </div>
                    <GroupHealth screens={group.screens} />
                  </header>
                )}
                {!isCollapsed && view === "table" && (
                  <div className="min-w-0">
                    <ScreenFleetTable
                      screens={group.screens}
                      canManage={canManage}
                      selectedIds={selected}
                      csrfToken={csrfToken}
                      onSelectionChange={(id, checked) => {
                        const next = new Set(selected);
                        if (checked) next.add(id);
                        else next.delete(id);
                        setSelected(next);
                      }}
                    />
                  </div>
                )}
                {!isCollapsed && view === "grid" && (
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
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
    </section>
  );
}

function useStoredState<T extends string>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(
    () => (storageGet("local", key) as T | null) ?? fallback,
  );
  const update = (next: T) => {
    setValue(next);
    storageSet("local", key, next);
  };
  return [value, update] as const;
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

function ScreenSummary({
  screens,
  status,
  onStatus,
}: {
  screens: Screen[];
  status: string;
  onStatus: (value: string) => void;
}) {
  const { t } = useTranslation("screens");
  const online = screens.filter((item) => item.status === "online").length;
  const attention = screens.filter(needsAttention).length;
  const locations = new Set(
    screens.map((item) => item.locationId).filter(Boolean),
  ).size;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-y border-border py-2"
      role="group"
      aria-label={t("list.summaryGroup")}
    >
      <span className="mr-2 text-sm text-muted-foreground">
        {t("list.summaryLine", {
          screens: t("list.screenCount", { count: screens.length }),
          locations: t("list.locationCount", { count: locations }),
        })}
      </span>
      <Button
        variant={status === "online" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={status === "online"}
        onClick={() => onStatus(status === "online" ? "" : "online")}
      >
        <strong className="tabular-nums">{online}</strong> {t("status.online")}
      </Button>
      <Button
        variant={status === "attention" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={status === "attention"}
        onClick={() => onStatus(status === "attention" ? "" : "attention")}
      >
        <strong className="tabular-nums">{attention}</strong>{" "}
        {t("status.attention")}
      </Button>
    </div>
  );
}

function GroupHealth({ screens }: { screens: Screen[] }) {
  const { t } = useTranslation("screens");
  const online = screens.filter((item) => item.status === "online").length;
  const attention = screens.filter(needsAttention).length;
  const syncGroups = new Set(
    screens.map((item) => item.syncGroupName).filter(Boolean),
  );
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      <Badge variant={online === screens.length ? "outline" : "secondary"}>
        {t("list.healthFraction", { online, total: screens.length })}
      </Badge>
      {attention > 0 && (
        <Badge variant="destructive">
          <CircleAlert aria-hidden="true" />
          {t("list.healthAttention", { count: attention })}
        </Badge>
      )}
      {syncGroups.size === 1 && (
        <Badge variant="outline">
          <Link2 aria-hidden="true" />
          {[...syncGroups][0]}
        </Badge>
      )}
    </span>
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

function screenInventorySummary(screens: Screen[], t: ScreensT) {
  const locationCount = new Set(
    screens
      .map((screen) => screen.locationId || screen.location)
      .filter(Boolean),
  ).size;
  return t("page.inventorySummary", {
    count: screens.length,
    locationPart: t("page.locationPart", { count: locationCount }),
  });
}

function updateLabel(value: string, t: ScreensT) {
  if (value === "current") return t("list.updateOptions.current");
  if (value === "attention") return t("status.attention");
  return value.charAt(0).toUpperCase() + value.slice(1);
}

export function platformLabel(value: string, t: ScreensT) {
  const normalized = value.toLowerCase();
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

function needsAttention(screen: Screen) {
  return (
    ["stale", "offline", "disabled", "revoked"].includes(screen.status) ||
    Boolean(screen.updateError)
  );
}

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

function selectionSummary(
  assignment:
    | {
        selectionSource?: string;
        currentScheduleId?: string | null;
        relevantSchedules?: { id: string; name: string }[];
      }
    | undefined,
  t: ScreensT,
) {
  if (assignment?.selectionSource === "takeover") return t("takeover.title");
  if (assignment?.selectionSource === "quick_present")
    return t("detail.selectionQuickPresent");
  if (assignment?.selectionSource === "schedule") {
    if (!assignment.currentScheduleId) return t("detail.selectionScheduled");
    const name =
      assignment.relevantSchedules?.find(
        (schedule) => schedule.id === assignment.currentScheduleId,
      )?.name ?? t("detail.selectionScheduleFallback");
    return t("detail.selectionScheduledNamed", { name });
  }
  if (assignment?.selectionSource === "direct_fallback")
    return t("detail.selectionDirect");
  return t("detail.selectionNone");
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
}: {
  screen: Screen;
  csrfToken: string;
  selected: boolean;
  canManage: boolean;
  showLocation: boolean;
  onSelect: (checked: boolean) => void;
}) {
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
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
        await previewApi.renew(screen.id, csrfToken, forceCapture);
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
    queryKey: ["screen-preview-card", screen.id],
    queryFn: () => previewApi.metadata(screen.id),
    enabled: visible,
    refetchInterval: visible ? GRID_PREVIEW_METADATA_REFRESH_MILLIS : false,
  });
  const image =
    preview.data?.imageAvailable && preview.data.updatedAt
      ? previewApi.imageUrl(screen.id, preview.data.updatedAt)
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
  const portrait = screen.screenHeight > screen.screenWidth;
  return (
    <article
      ref={ref}
      className={`group min-w-0 overflow-hidden rounded-xl border bg-card transition-colors hover:border-foreground/20 ${needsAttention(screen) ? "border-amber-500/60 bg-amber-500/5" : "border-border"}`}
    >
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
            </>
          ) : (
            <span className="grid min-h-32 place-items-center gap-1 text-center text-xs text-slate-300">
              <Monitor className="size-6" aria-hidden="true" />
              {screen.status === "offline"
                ? t("grid.offline")
                : t("grid.unavailable")}
            </span>
          )}
        </AspectRatio>
      </Link>
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
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={t("grid.rowActions", { name: screen.name })}
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  render={<Link to={`/screens/${screen.id}`} />}
                >
                  <Monitor aria-hidden="true" /> {t("grid.openItem")}
                </DropdownMenuItem>
                {canManage && (
                  <>
                    <DropdownMenuItem
                      onClick={() =>
                        void api.createScreenCommand(
                          screen.id,
                          "restart_player_process",
                          {},
                          csrfToken,
                        )
                      }
                    >
                      <RefreshCw aria-hidden="true" /> {t("grid.restartPlayer")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      render={
                        <Link to={`/screens/${screen.id}?edit=details`} />
                      }
                    >
                      <Pencil aria-hidden="true" /> {t("grid.editDetails")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      render={<Link to={`/screens/${screen.id}?tab=content`} />}
                    >
                      {t("grid.assignContent")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      render={<Link to={`/screens/${screen.id}?present=1`} />}
                    >
                      <Play aria-hidden="true" /> {t("grid.showNow")}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      render={
                        <Link
                          to={
                            screen.syncGroupId
                              ? `/groups/${screen.syncGroupId}`
                              : "/groups"
                          }
                        />
                      }
                    >
                      {screen.syncGroupId
                        ? t("grid.openGroup")
                        : t("grid.addToGroup")}
                    </DropdownMenuItem>
                  </>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
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

function PendingPairings({
  requests,
  canManage,
}: {
  requests: PairingRequest[];
  canManage: boolean;
}) {
  const { t } = useTranslation("screens");
  const formatLocale = useFormatLocale();
  if (requests.length === 0) return null;
  return (
    <section className="space-y-2" aria-label={t("pending.section")}>
      <Alert>
        <RefreshCw aria-hidden="true" />
        <AlertTitle className="flex items-center gap-2">
          {t("pending.title")}{" "}
          <Badge variant="secondary">{requests.length}</Badge>
        </AlertTitle>
        <AlertDescription>
          {t("pending.body", { count: requests.length })}
        </AlertDescription>
      </Alert>
      <ItemGroup className="gap-1.5">
        {requests.map((request) => (
          <Item
            key={request.id}
            size="xs"
            variant="outline"
            render={<div role="listitem" />}
          >
            <ItemContent className="min-w-0">
              <ItemTitle>
                {request.metadata.manufacturer} {request.metadata.model}
              </ItemTitle>
              <ItemDescription>
                {platformLabel(request.metadata.platform, t)} ·{" "}
                {request.metadata.screenWidth}×{request.metadata.screenHeight} ·{" "}
                {t("pending.expires", {
                  time: new Date(request.expiresAt).toLocaleTimeString(
                    formatLocale,
                    {
                      hour: "numeric",
                      minute: "2-digit",
                    },
                  ),
                })}
              </ItemDescription>
            </ItemContent>
            {canManage && (
              <ItemActions>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={`/screens/pair/request/${request.id}`}
                >
                  {t("pending.review")}
                </Link>
              </ItemActions>
            )}
          </Item>
        ))}
      </ItemGroup>
    </section>
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

export function PairScreenDialog() {
  const { code, requestId } = useParams();
  const { t } = useTranslation(["screens", "common"]);
  const auth = useAuth();
  const navigate = useNavigate();
  const [request, setRequest] = useState<PairingRequest>();
  const [error, setError] = useState<string>();
  const form = useForm<CodeForm>({
    resolver: zodResolver(useMemo(() => makeCodeSchema(t), [t])),
    defaultValues: { code: code ?? "" },
  });
  const lookup = async (value: CodeForm) => {
    setError(undefined);
    try {
      setRequest(await api.resolvePairing(value.code));
    } catch (reason) {
      setError(
        reason instanceof Error ? reason.message : t("pair.resolveError"),
      );
    }
  };
  useEffect(() => {
    if (code && !request) void lookup({ code });
  }, [code]); // eslint-disable-line react-hooks/exhaustive-deps
  const pending = useQuery({
    queryKey: ["screens", "pairing", "pending"],
    queryFn: api.pendingPairings,
    enabled: Boolean(requestId),
  });
  useEffect(() => {
    if (requestId && pending.data)
      setRequest(pending.data.items.find((item) => item.id === requestId));
  }, [requestId, pending.data]);

  const close = () => void navigate("/screens");

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) close();
      }}
    >
      <DialogContent
        className={
          request
            ? "max-h-[min(90vh,56rem)] overflow-y-auto sm:max-w-3xl"
            : "sm:max-w-lg"
        }
      >
        {!canManageScreens(auth.status?.user) ? (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle>{t("pair.gateTitle")}</DialogTitle>
              <DialogDescription>{t("pair.gateBody")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button variant="outline" onClick={close}>
                {t("pair.backToScreens")}
              </Button>
            </DialogFooter>
          </>
        ) : request ? (
          <ApprovalPanel
            request={request}
            onDone={(screenId) =>
              void navigate(screenId ? `/screens/${screenId}` : "/screens")
            }
          />
        ) : (
          <>
            <DialogHeader className="pr-8">
              <DialogTitle>{t("pair.title")}</DialogTitle>
              <DialogDescription>{t("pair.body")}</DialogDescription>
            </DialogHeader>
            {error && (
              <Alert variant="destructive">
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}
            <form
              className="space-y-4"
              onSubmit={(event) => void form.handleSubmit(lookup)(event)}
            >
              <FormField
                id="pairingCode"
                label={t("pair.codeLabel")}
                autoComplete="off"
                autoFocus
                className="h-14 font-mono text-xl font-semibold tracking-[0.18em] uppercase"
                // i18n-ignore: example pairing-code format, not prose
                placeholder="ABC234"
                error={form.formState.errors.code?.message}
                {...form.register("code")}
              />
              <Alert>
                <AlertTitle>{t("pair.onTvTitle")}</AlertTitle>
                <AlertDescription>{t("pair.onTvBody")}</AlertDescription>
              </Alert>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={close}>
                  {t("common:actions.cancel")}
                </Button>
                <Button type="submit">{t("pair.findPlayer")}</Button>
              </DialogFooter>
            </form>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function ApprovalPanel({
  request,
  onDone,
}: {
  request: PairingRequest;
  onDone: (screenId?: string) => void;
}) {
  const { t } = useTranslation("screens");
  const { t: commonT } = useTranslation("common");
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const defaultDestination: PairingDestination =
    request.previouslyPaired && request.hasActiveCredential
      ? "credential_repair"
      : "new_screen";
  const [destination, setDestination] =
    useState<PairingDestination>(defaultDestination);
  const [replacementScreenId, setReplacementScreenId] = useState("");
  const [approvalError, setApprovalError] = useState("");
  const [approvalConfirmation, setApprovalConfirmation] = useState<{
    values: ApprovalForm;
    title: string;
    description: string;
  } | null>(null);
  const form = useForm<ApprovalForm>({
    resolver: zodResolver(useMemo(() => makeApprovalSchema(t), [t])),
    defaultValues: {
      name:
        request.existingScreenName ??
        `${request.metadata.manufacturer} ${request.metadata.model}`,
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
  const screens = useQuery({
    queryKey: ["screens", "pairing-replacement-options"],
    queryFn: api.screens,
    enabled: destination === "replace_hardware",
  });
  const approve = useMutation({
    mutationFn: (values: ApprovalForm) => {
      if (destination === "replace_hardware" && !replacementScreenId)
        throw new Error(t("approval.chooseScreenError"));
      if (destination === "replace_hardware") {
        const target = screens.data?.items.find(
          (screen) => screen.id === replacementScreenId,
        );
        if (!target) throw new Error(t("approval.screenNotFound"));
      }
      return api.approvePairing(
        request.id,
        pairingApprovalPayload(
          request,
          values,
          destination,
          replacementScreenId,
        ),
        auth.status?.csrfToken ?? "",
      );
    },
    onSuccess: async (screen) => {
      toast.add({ title: "Screen pairing approved.", type: "success" });
      await queryClient.invalidateQueries({ queryKey: ["screens"] });
      await queryClient.invalidateQueries({
        queryKey: ["screens", "pairing", "pending"],
      });
      onDone(screen.id);
    },
  });
  const reject = useMutation({
    mutationFn: () =>
      api.rejectPairing(
        request.id,
        "Rejected by administrator",
        auth.status?.csrfToken ?? "",
      ),
    onSuccess: () => {
      toast.add({ title: "Pairing request rejected.", type: "success" });
      onDone();
    },
  });
  const requestApproval = (values: ApprovalForm) => {
    setApprovalError("");
    if (destination === "credential_repair") {
      setApprovalConfirmation({
        values,
        title: t("approval.repairTitle", {
          name: request.existingScreenName ?? "",
        }),
        description: t("approval.repairBody"),
      });
      return;
    }
    if (destination === "replace_hardware") {
      const target = screens.data?.items.find(
        (screen) => screen.id === replacementScreenId,
      );
      if (!target) {
        setApprovalError(t("approval.chooseScreenError"));
        return;
      }
      setApprovalConfirmation({
        values,
        title: t("approval.replaceTitle", { name: target.name }),
        description: t("approval.replaceBody"),
      });
      return;
    }
    approve.mutate(values);
  };
  if (approvalConfirmation)
    return (
      <div className="space-y-5">
        <DialogHeader className="pr-8">
          <DialogTitle>{approvalConfirmation.title}</DialogTitle>
          <DialogDescription>
            {approvalConfirmation.description}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={approve.isPending}
            onClick={() => setApprovalConfirmation(null)}
          >
            {t("approval.goBack")}
          </Button>
          <Button
            type="button"
            disabled={approve.isPending}
            onClick={() => {
              approve.mutate(approvalConfirmation.values);
              setApprovalConfirmation(null);
            }}
          >
            {t("approval.confirmPairing")}
          </Button>
        </DialogFooter>
      </div>
    );

  const eligibleScreens = (screens.data?.items ?? []).filter(
    (screen) => screen.id !== request.existingScreenId,
  );
  const selectedReplacementScreen = eligibleScreens.find(
    (screen) => screen.id === replacementScreenId,
  );
  const metadata = request.metadata;
  return (
    <div className="space-y-5">
      <DialogHeader className="pr-8">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1.5">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {t("approval.step")}
            </p>
            <DialogTitle>{t("approval.title")}</DialogTitle>
            <DialogDescription>{t("approval.body")}</DialogDescription>
          </div>
          <Badge variant="outline" className="shrink-0">
            {t("approval.expires", {
              time: new Date(request.expiresAt).toLocaleTimeString(
                formatLocale,
                {
                  hour: "numeric",
                  minute: "2-digit",
                },
              ),
            })}
          </Badge>
        </div>
      </DialogHeader>
      <dl className="device-facts">
        <div>
          <dt>{t("approval.device")}</dt>
          <dd>
            {metadata.manufacturer} {metadata.model}
          </dd>
        </div>
        <div>
          <dt>{t("approval.platform")}</dt>
          <dd>{metadata.platform}</dd>
        </div>
        <div>
          <dt>{t("approval.android")}</dt>
          <dd>{metadata.androidVersion}</dd>
        </div>
        <div>
          <dt>{t("approval.player")}</dt>
          <dd>{metadata.playerVersion}</dd>
        </div>
        <div>
          <dt>{t("approval.resolution")}</dt>
          <dd>
            {metadata.screenWidth} × {metadata.screenHeight}
          </dd>
        </div>
        <div>
          <dt>{t("approval.locale")}</dt>
          <dd>
            {metadata.locale} · {metadata.timezone}
          </dd>
        </div>
        {metadata.approximateAddress && (
          <div>
            <dt>{t("approval.network")}</dt>
            <dd>{metadata.approximateAddress}</dd>
          </div>
        )}
      </dl>
      <FieldSet className="grid gap-3 rounded-xl border border-border p-4">
        <FieldLegend variant="label" className="mb-0">
          {t("approval.destination")}
        </FieldLegend>
        <RadioGroup
          aria-label={t("approval.destination")}
          value={destination}
          onValueChange={(value) => setDestination(value as PairingDestination)}
          className="grid gap-2"
        >
          <Field orientation="horizontal" className="items-start">
            <RadioGroupItem id="pairing-destination-new" value="new_screen" />
            <FieldContent>
              <FieldLabel
                htmlFor="pairing-destination-new"
                className="font-normal"
              >
                {t("approval.newScreen")}
              </FieldLabel>
              <FieldDescription>{t("approval.newScreenHint")}</FieldDescription>
            </FieldContent>
          </Field>
          {request.previouslyPaired && request.hasActiveCredential && (
            <Field orientation="horizontal" className="items-start">
              <RadioGroupItem
                id="pairing-destination-repair"
                value="credential_repair"
              />
              <FieldContent>
                <FieldLabel
                  htmlFor="pairing-destination-repair"
                  className="font-normal"
                >
                  {t("approval.repair")}
                </FieldLabel>
                <FieldDescription>
                  {t("approval.repairHint", {
                    name: request.existingScreenName ?? "",
                  })}
                </FieldDescription>
              </FieldContent>
            </Field>
          )}
          <Field orientation="horizontal" className="items-start">
            <RadioGroupItem
              id="pairing-destination-replace"
              value="replace_hardware"
            />
            <FieldContent>
              <FieldLabel
                htmlFor="pairing-destination-replace"
                className="font-normal"
              >
                {t("approval.replace")}
              </FieldLabel>
              <FieldDescription>{t("approval.replaceHint")}</FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>
        {destination === "replace_hardware" && (
          <Field>
            <FieldLabel htmlFor="pairing-existing-screen">
              {t("approval.existingScreen")}
            </FieldLabel>
            <Combobox
              items={eligibleScreens}
              value={selectedReplacementScreen ?? null}
              itemToStringLabel={(screen: Screen) =>
                screen.location
                  ? screen.name + " — " + screen.location
                  : screen.name
              }
              onValueChange={(value) => setReplacementScreenId(value?.id ?? "")}
            >
              <ComboboxInput
                id="pairing-existing-screen"
                aria-label={t("approval.existingScreen")}
                placeholder={t("approval.searchScreens")}
                showClear
                className="w-full"
              />
              <ComboboxContent>
                <ComboboxEmpty>
                  {screens.isLoading
                    ? commonT("status.loading")
                    : screens.isError
                      ? t("approval.screensLoadError")
                      : t("approval.noMatchingScreens")}
                </ComboboxEmpty>
                <ComboboxList>
                  {(screen: Screen) => (
                    <ComboboxItem key={screen.id} value={screen}>
                      {screen.name}
                      {screen.location ? ` — ${screen.location}` : ""}
                    </ComboboxItem>
                  )}
                </ComboboxList>
              </ComboboxContent>
            </Combobox>
            <FieldDescription>{t("approval.selectHint")}</FieldDescription>
          </Field>
        )}
      </FieldSet>
      {request.previouslyPaired && (
        <Alert role="status">
          <AlertTitle>
            {t("approval.pairedBefore", {
              name: request.existingScreenName ?? "",
            })}
          </AlertTitle>
          <AlertDescription>
            {destination === "replace_hardware"
              ? t("approval.pairedReplaceBody")
              : t("approval.pairedRepairBody")}
          </AlertDescription>
        </Alert>
      )}
      {(approvalError || approve.error || reject.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {approvalError || (approve.error ?? reject.error)?.message}
          </AlertDescription>
        </Alert>
      )}
      <form
        className="grid gap-4"
        onSubmit={(event) => void form.handleSubmit(requestApproval)(event)}
      >
        <FormField
          id="screenName"
          label={t("approval.nameLabel")}
          error={form.formState.errors.name?.message}
          {...form.register("name")}
        />
        <LocationPicker
          locations={locations.data?.items ?? []}
          value={form.watch("locationId")}
          onChange={(locationId) =>
            form.setValue("locationId", locationId, { shouldDirty: true })
          }
        />
        <div className="screen-room-fields">
          <FormField
            id="screenRoomName"
            label={t("approval.roomName")}
            placeholder={t("approval.roomNamePlaceholder")}
            {...form.register("roomName")}
          />
          <FormField
            id="screenRoomNumber"
            label={t("approval.roomNumber")}
            placeholder={t("approval.roomNumberPlaceholder")}
            {...form.register("roomNumber")}
          />
        </div>
        <Field>
          <FieldLabel htmlFor="screenDescription">
            {t("approval.description")}
          </FieldLabel>
          <Textarea id="screenDescription" {...form.register("description")} />
        </Field>
        <div className="mt-3 flex flex-wrap items-center justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            onClick={() => reject.mutate()}
            disabled={reject.isPending || approve.isPending}
          >
            {t("approval.reject")}
          </Button>
          <Button
            type="submit"
            disabled={approve.isPending || reject.isPending}
          >
            {approve.isPending
              ? t("approval.approving")
              : pairingApprovalLabel(request, t, destination)}
          </Button>
        </div>
      </form>
    </div>
  );
}

export function ScreenDetailPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const { t } = useTranslation(["screens", "common"]);
  const formatLocale = useFormatLocale();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [pendingDestination, setPendingDestination] =
    useState<ScreenTabDestination | null>(null);
  const [selectedPresentation, setSelectedPresentation] = useState("");
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
    queryKey: ["screens", id],
    queryFn: () => api.screen(id),
    refetchInterval: 10_000,
  });
  const screens = useQuery({
    queryKey: ["screens"],
    queryFn: api.screens,
    refetchInterval: 10_000,
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
    if (!query.data || editingDetails) return;
    detailsForm.reset({
      name: query.data.name,
      locationId: query.data.locationId,
      roomName: query.data.roomName ?? "",
      roomNumber: query.data.roomNumber ?? "",
      description: query.data.description,
    });
  }, [detailsForm, editingDetails, query.data]);
  const updateDetails = useMutation({
    mutationFn: (values: ApprovalForm) =>
      api.updateScreen(id, values, auth.status?.csrfToken ?? ""),
    onSuccess: async (updated) => {
      toast.add({ title: "Screen details saved.", type: "success" });
      queryClient.setQueryData(["screens", id], updated);
      setEditingDetails(false);
      await queryClient.invalidateQueries({ queryKey: ["screens"] });
    },
  });
  const assignment = useQuery({
    queryKey: ["screens", id, "playlist-assignment"],
    queryFn: () => api.playlistAssignment(id),
    refetchInterval: 10_000,
  });
  const playlists = useQuery({
    queryKey: ["playlists", "assignment-picker"],
    queryFn: () => api.playlists(),
    enabled: canManageScreens(auth.status?.user),
  });
  const layouts = useQuery({
    queryKey: ["layouts", "assignment-picker"],
    queryFn: () => api.layouts(""),
    enabled: canManageScreens(auth.status?.user),
  });
  useEffect(() => {
    setSelectedPresentation(
      assignment.data?.layoutId
        ? `layout:${assignment.data.layoutId}`
        : assignment.data?.playlistId
          ? `playlist:${assignment.data.playlistId}`
          : "",
    );
  }, [assignment.data?.layoutId, assignment.data?.playlistId]);
  const assign = useMutation({
    mutationFn: () => {
      const [type, presentationId] = selectedPresentation.split(":");
      if (type === "layout" && presentationId)
        return api.assignLayout(
          id,
          presentationId,
          auth.status?.csrfToken ?? "",
        );
      if (type === "playlist" && presentationId)
        return api.assignPlaylist(
          id,
          presentationId,
          auth.status?.csrfToken ?? "",
        );
      return api.unassignPlaylist(id, auth.status?.csrfToken ?? "");
    },
    onSuccess: async () => {
      toast.add({ title: "Presentation assignment updated.", type: "success" });
      await queryClient.invalidateQueries({
        queryKey: ["screens", id, "playlist-assignment"],
      });
    },
  });
  const stateMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setScreenEnabled(id, enabled, auth.status?.csrfToken ?? ""),
    onSuccess: async (_result, enabled) => {
      toast.add({
        title: enabled ? "Screen enabled." : "Screen disabled.",
        type: "success",
      });
      await queryClient.invalidateQueries({ queryKey: ["screens"] });
    },
  });
  const revoke = useMutation({
    mutationFn: () =>
      api.revokeScreen(
        id,
        "Revoked in Tilecast Studio",
        auth.status?.csrfToken ?? "",
      ),
    onSuccess: async () => {
      toast.add({ title: "Player credential revoked.", type: "success" });
      setConfirmRevoke(false);
      await queryClient.invalidateQueries({ queryKey: ["screens"] });
    },
  });
  const commands = useQuery({
    queryKey: ["screens", id, "commands"],
    queryFn: () => api.screenCommands(id),
    refetchInterval: 5_000,
    enabled: true,
  });
  const reliability = useQuery({
    queryKey: ["screens", id, "reliability"],
    queryFn: () => api.screenReliability(id),
    refetchInterval: 10_000,
  });
  const playerHistory = useQuery({
    queryKey: ["screens", id, "player-history"],
    queryFn: () => api.screenPlayerHistory(id),
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
      type: string;
      payload: Record<string, unknown>;
    }) =>
      api.createScreenCommand(id, type, payload, auth.status?.csrfToken ?? ""),
    onSuccess: (_result, action) => {
      toast.add({
        title: `Player command queued: ${action.type.replaceAll("_", " ")}.`,
        type: "success",
      });
      void queryClient.invalidateQueries({
        queryKey: ["screens", id, "commands"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["screens", id, "reliability"],
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
  const displayCapabilities =
    reliability.data?.displayControlCapabilities ?? {};
  const hasDisplayControl = Object.keys(displayCapabilities).length > 0;
  const requestedTab = searchParams.get("tab") ?? "overview";
  const requestedSection = searchParams.get("section");
  const tab = normalizeScreenDetailTab(requestedTab, requestedSection);
  const manageSection = normalizeScreenManageSection(
    requestedTab,
    requestedSection,
  );
  const commitDestination = (destination: ScreenTabDestination) => {
    const next = new URLSearchParams(searchParams);
    if (destination.tab === "overview") next.delete("tab");
    else next.set("tab", destination.tab);
    next.delete("section");
    if (
      destination.tab === "device" &&
      destination.section &&
      destination.section !== "device"
    ) {
      next.set("section", destination.section);
    }
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
  return (
    <div className="w-full min-w-0 space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-semibold tracking-tight">
              {screen.name}
            </h1>
            <StatusLabel status={screen.status} />
          </div>
          <p className="text-sm text-muted-foreground">
            {[
              platformLabel(screen.platform, t),
              [screen.deviceManufacturer, screen.deviceModel]
                .filter(Boolean)
                .join(" "),
              screen.playerVersion
                ? t("detail.playerVersion", {
                    version: screen.playerVersion,
                  })
                : t("detail.playerVersionMissing"),
              [screen.location, roomLabel(screen, t)]
                .filter(Boolean)
                .join(" · ") || t("detail.noLocation"),
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
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
                command.mutate({ type: "restart_player_process", payload: {} })
              }
            >
              <RefreshCw aria-hidden="true" /> {t("list.restart")}
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon-sm" />}
              aria-label={t("detail.moreActions")}
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canManageScreens(auth.status?.user) && (
                <DropdownMenuItem onClick={() => setEditingDetails(true)}>
                  <Pencil aria-hidden="true" /> {t("grid.editDetails")}
                </DropdownMenuItem>
              )}
              {canManageScreens(auth.status?.user) &&
                screen.platform.toLowerCase() === "linux" && (
                  <DropdownMenuItem onClick={() => setAirplayOpen(true)}>
                    <Airplay aria-hidden="true" /> {t("detail.airplay")}
                  </DropdownMenuItem>
                )}
              <DropdownMenuItem onClick={() => selectTab("content")}>
                <Monitor aria-hidden="true" /> {t("detail.viewContent")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
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
                  {updateDetails.error.message}
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
        <TabsList
          aria-label={t("detail.tabsLabel")}
          variant="line"
          className="min-h-10 w-full justify-start gap-4 overflow-x-auto rounded-none border-b border-border p-0"
        >
          <TabsTrigger value="overview" className="flex-none px-2">
            {t("detail.tabOverview")}
          </TabsTrigger>
          <TabsTrigger value="content" className="flex-none px-2">
            {t("detail.tabContent")}
          </TabsTrigger>
          <TabsTrigger value="activity" className="flex-none px-2">
            {t("detail.tabActivity")}
          </TabsTrigger>
          <TabsTrigger value="device" className="flex-none px-2">
            {t("detail.tabDevice")}
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex-none px-2">
            {t("detail.tabSettings")}{" "}
            {policyDirty && (
              <Badge variant="secondary">{t("detail.unsavedBadge")}</Badge>
            )}
          </TabsTrigger>
        </TabsList>

        {tab === "overview" && (
          <TabsContent
            value="overview"
            className="min-w-0 space-y-4 outline-none"
          >
            <section
              className="space-y-4"
              aria-labelledby="screen-overview-title"
            >
              <header>
                <h2
                  id="screen-overview-title"
                  className="text-base font-semibold"
                >
                  {t("detail.tabOverview")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("detail.overviewBody")}
                </p>
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
              <dl className="grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-4">
                <OverviewFact
                  label={t("detail.factConnection")}
                  value={<StatusLabel status={screen.status} />}
                />
                <OverviewFact
                  label={t("grid.nowPlaying")}
                  value={
                    assignment.data?.layoutName ??
                    assignment.data?.playlistName ??
                    t("detail.factNoContent")
                  }
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
                  value={formatContact(screen.lastContactAt, t, formatLocale)}
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
                    reliability.data?.effectiveMode?.replaceAll("_", " ") ??
                    t("shared.notReported")
                  }
                />
                <OverviewFact
                  label={t("detail.factNextChange")}
                  value={
                    assignment.data?.nextTransitionAt
                      ? new Date(
                          assignment.data.nextTransitionAt,
                        ).toLocaleString(formatLocale)
                      : t("detail.noneScheduled")
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
                        count: Object.keys(screenPolicy.data?.values ?? {})
                          .length,
                      })}
                    </Link>
                  }
                />
              </dl>
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => selectTab("content")}
                >
                  {t("detail.viewContent")}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("activity")}
                >
                  {t("detail.viewActivity")}
                </Button>
              </div>
              <section
                className="space-y-2"
                aria-labelledby="screen-hardware-history-title"
              >
                <header>
                  <h3
                    id="screen-hardware-history-title"
                    className="text-sm font-semibold"
                  >
                    {t("detail.hwTitle")}
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    {t("detail.hwBody")}
                  </p>
                </header>
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
              </section>
            </section>
          </TabsContent>
        )}

        {tab === "content" && (
          <TabsContent value="content" className="min-w-0 outline-none">
            <section
              className="min-w-0 space-y-5 rounded-xl border border-border p-4 sm:p-5"
              aria-labelledby="screen-playback-title"
            >
              <header>
                <h2
                  id="screen-playback-title"
                  className="text-base font-semibold"
                >
                  {t("detail.playbackTitle")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("detail.playbackBody")}
                </p>
              </header>
              {assignment.data?.groups?.[0] && (
                <Alert>
                  <Monitor aria-hidden="true" />
                  <AlertTitle>{t("detail.managedTitle")}</AlertTitle>
                  <AlertDescription>
                    <Trans
                      i18nKey="detail.managedBody"
                      ns="screens"
                      values={{ name: assignment.data.groups[0].name }}
                      components={{
                        groupLink: (
                          <Link
                            to={`/groups/${assignment.data.groups[0].id}`}
                          />
                        ),
                      }}
                    />
                  </AlertDescription>
                </Alert>
              )}
              {canManageScreens(auth.status?.user) ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
                  <div className="min-w-0 flex-1">
                    <Select
                      items={[
                        {
                          value: "__none__",
                          label: t("detail.noPresentation"),
                        },
                        ...(playlists.data?.items ?? []).map((playlist) => ({
                          value: `playlist:${playlist.id}`,
                          label: playlist.name,
                        })),
                        ...(layouts.data?.items ?? []).map((layout) => ({
                          value: `layout:${layout.id}`,
                          label: layout.name,
                        })),
                      ]}
                      value={selectedPresentation || "__none__"}
                      onValueChange={(value) =>
                        setSelectedPresentation(
                          value === "__none__" ? "" : (value ?? ""),
                        )
                      }
                    >
                      <SelectTrigger
                        aria-label={t("detail.assignedLabel")}
                        className="w-full"
                      >
                        <SelectValue placeholder={t("detail.noPresentation")} />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          {t("detail.noPresentation")}
                        </SelectItem>
                        <SelectGroup>
                          <SelectLabel>
                            {t("detail.playlistsGroup")}
                          </SelectLabel>
                          {playlists.data?.items?.map((playlist) => (
                            <SelectItem
                              key={playlist.id}
                              value={`playlist:${playlist.id}`}
                            >
                              {playlist.name}
                            </SelectItem>
                          ))}
                        </SelectGroup>
                        <SelectGroup>
                          <SelectLabel>{t("detail.layoutsGroup")}</SelectLabel>
                          {layouts.data?.items
                            .filter((layout) => layout.publishedRevision)
                            .map((layout) => (
                              <SelectItem
                                key={layout.id}
                                value={`layout:${layout.id}`}
                              >
                                {layout.name}
                              </SelectItem>
                            ))}
                        </SelectGroup>
                      </SelectContent>
                    </Select>
                  </div>
                  <Button
                    disabled={
                      assign.isPending ||
                      selectedPresentation ===
                        (assignment.data?.layoutId
                          ? `layout:${assignment.data.layoutId}`
                          : assignment.data?.playlistId
                            ? `playlist:${assignment.data.playlistId}`
                            : "")
                    }
                    onClick={() => assign.mutate()}
                  >
                    {assign.isPending
                      ? t("groups.detail.applying")
                      : assignment.data?.groups?.[0]
                        ? t("groups.detail.apply")
                        : t("detail.applyAssignment")}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {assignment.data?.layoutName ??
                    assignment.data?.playlistName ??
                    t("detail.noPresentation")}
                </p>
              )}
              <ScreenContentChain assignment={assignment.data} />
              <dl className="grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-3">
                <OverviewFact
                  label={t("detail.directFallback")}
                  value={
                    assignment.data?.layoutName ??
                    assignment.data?.playlistName ??
                    t("detail.noFallbackAssigned")
                  }
                />
                <OverviewFact
                  label={t("detail.currentSelection")}
                  value={selectionSummary(assignment.data, t)}
                />
                <OverviewFact
                  label={t("detail.nextScheduledChange")}
                  value={
                    assignment.data?.nextTransitionAt
                      ? new Date(
                          assignment.data.nextTransitionAt,
                        ).toLocaleString(formatLocale)
                      : t("shared.noneReported")
                  }
                />
                <OverviewFact
                  label={t("list.groupFilter")}
                  value={
                    (assignment.data?.groups ?? [])
                      .map((group) => group.name)
                      .join(", ") || t("detail.notGrouped")
                  }
                />
                <OverviewFact
                  label={t("detail.relevantSchedules")}
                  value={
                    (assignment.data?.relevantSchedules ?? [])
                      .map(
                        (schedule) => `${schedule.name} (${schedule.priority})`,
                      )
                      .join(", ") || t("detail.noSchedules")
                  }
                />
              </dl>
              <Collapsible className="border-t border-border pt-3">
                <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  {t("detail.diagnostics")}
                  <ChevronDown size={16} aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
                    <OverviewFact
                      label={t("detail.factServerManifest")}
                      value={t("detail.manifestVersion", {
                        version: assignment.data?.manifestVersion ?? 1,
                      })}
                    />
                    <OverviewFact
                      label={t("detail.factPlayerConfig")}
                      value={
                        assignment.data?.activeConfigRevision != null
                          ? t("detail.configRevision", {
                              revision: assignment.data.activeConfigRevision,
                            })
                          : t("shared.notReported")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factPlayerManifest")}
                      value={
                        assignment.data?.playerActiveManifestVersion != null
                          ? t("detail.manifestVersion", {
                              version:
                                assignment.data.playerActiveManifestVersion,
                            })
                          : t("shared.notReported")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factSynchronization")}
                      value={
                        assignment.data?.synchronizationStatus?.replaceAll(
                          "_",
                          " ",
                        ) ?? t("shared.notReported")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factClockDifference")}
                      value={
                        assignment.data?.deviceClockOffsetSeconds != null
                          ? t("detail.clockOffset", {
                              count: Math.abs(
                                assignment.data.deviceClockOffsetSeconds,
                              ),
                            })
                          : t("shared.notReported")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factDownloads")}
                      value={
                        assignment.data?.downloadQueueCount != null
                          ? t("detail.downloads", {
                              queued: assignment.data.downloadQueueCount,
                              downloaded: assignment.data.downloadedBytes ?? 0,
                              required: assignment.data.requiredBytes ?? 0,
                            })
                          : t("shared.notReported")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factWebsite")}
                      value={
                        assignment.data?.websiteState
                          ? `${assignment.data.websiteState?.replaceAll("_", " ") ?? t("shared.notReported")}${assignment.data.websiteCurrentHost ? ` · ${assignment.data.websiteCurrentHost}` : ""}`
                          : t("detail.websiteInactive")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factBlockedNavigation")}
                      value={
                        assignment.data?.websiteBlockedNavigationCount ??
                        t("shared.notReported")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factPlayback")}
                      value={
                        assignment.data?.playbackState ??
                        t("shared.notReported")
                      }
                    />
                    <OverviewFact
                      label={t("takeover.title")}
                      value={
                        assignment.data?.activeTakeoverId
                          ? t("detail.takeoverProgress", {
                              state: assignment.data.takeoverState ?? "pending",
                              progress:
                                assignment.data.takeoverPreparationProgress ??
                                0,
                            })
                          : t("detail.noTakeover")
                      }
                    />
                    <OverviewFact
                      label={t("detail.factCache")}
                      value={
                        assignment.data?.cacheUsedBytes != null
                          ? t("detail.cacheUsage", {
                              used: assignment.data.cacheUsedBytes,
                              limit: assignment.data.cacheLimitBytes ?? 0,
                            })
                          : t("shared.notReported")
                      }
                    />
                  </dl>
                </CollapsibleContent>
              </Collapsible>
              {assignment.error && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{t("detail.assignLoadError")}</AlertTitle>
                  <AlertDescription>
                    {assignment.error.message}
                  </AlertDescription>
                </Alert>
              )}
              {(
                [
                  ["sync", assignment.data?.lastSynchronizationError],
                  ["playback", assignment.data?.lastPlaybackError],
                  ["config", assignment.data?.configurationError],
                ] as const
              ).map(
                ([kind, message]) =>
                  message && (
                    <Alert key={kind} variant="destructive">
                      <CircleAlert aria-hidden="true" />
                      <AlertTitle>
                        {t("detail.categorizedError", {
                          kind: t(`detail.errorKind.${kind}`),
                        })}
                      </AlertTitle>
                      <AlertDescription>{message}</AlertDescription>
                    </Alert>
                  ),
              )}
              {Math.abs(assignment.data?.deviceClockOffsetSeconds ?? 0) >
                (assignment.data?.clockSkewWarningSeconds ?? 300) && (
                <Alert>
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{t("detail.clockTitle")}</AlertTitle>
                  <AlertDescription>{t("detail.clockBody")}</AlertDescription>
                </Alert>
              )}
              {assignment.data?.scheduleEvaluationError && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>{t("detail.scheduleEvalTitle")}</AlertTitle>
                  <AlertDescription>
                    {assignment.data.scheduleEvaluationError}
                  </AlertDescription>
                </Alert>
              )}
              {assignment.data?.websiteFailureCategory &&
                ["failed", "timed_out", "blocked", "showing_fallback"].includes(
                  assignment.data.websiteState ?? "",
                ) && (
                  <Alert variant="destructive">
                    <CircleAlert aria-hidden="true" />
                    <AlertTitle>{t("detail.websiteTitle")}</AlertTitle>
                    <AlertDescription>
                      {assignment.data.websiteFailureCategory?.replaceAll(
                        "_",
                        " ",
                      ) ?? t("detail.websiteUnknown")}
                    </AlertDescription>
                  </Alert>
                )}
            </section>
          </TabsContent>
        )}

        {tab === "activity" && (
          <TabsContent value="activity" className="min-w-0 outline-none">
            <ScreenActivityPanel screenId={id} />
          </TabsContent>
        )}

        {tab === "device" && (
          <TabsContent
            value="device"
            className="min-w-0 space-y-4 outline-none"
          >
            <section className="space-y-3" aria-labelledby="device-heading">
              <header>
                <h2 id="device-heading" className="text-base font-semibold">
                  {t("detail.tabDevice")}
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  {t("detail.deviceBody")}
                </p>
              </header>
              <nav
                aria-label={t("detail.deviceNav")}
                className="flex flex-wrap gap-1 border-b border-border"
              >
                {(
                  [
                    ["device", t("detail.sectionDevice")],
                    ["health", t("detail.sectionHealth")],
                    ["maintenance", t("detail.sectionMaintenance")],
                  ] as const
                ).map(([section, label]) => (
                  <Link
                    key={section}
                    to={
                      section === "device"
                        ? "?tab=device"
                        : `?tab=device&section=${section}`
                    }
                    aria-current={
                      manageSection === section ? "page" : undefined
                    }
                    className={`border-b-2 px-2 py-2 text-sm ${manageSection === section ? "border-primary font-medium text-foreground" : "border-transparent text-muted-foreground hover:text-foreground"}`}
                  >
                    {label}
                  </Link>
                ))}
              </nav>
            </section>

            {manageSection === "health" && (
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
                          : formatBytes(screen.availableStorageBytes)}
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
                          {t("detail.revokeTitle")}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {t("detail.revokeBody")}
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        onClick={() => setConfirmRevoke(true)}
                        disabled={!screen.hasActiveCredential}
                      >
                        {t("detail.revokeAction")}
                      </Button>
                    </div>
                  </section>
                )}
              </>
            )}
          </TabsContent>
        )}

        {tab === "settings" && (
          <TabsContent value="settings" className="min-w-0 outline-none">
            <PlayerPolicyEditor
              target="screen"
              id={id}
              onDirtyChange={setPolicyDirty}
            />
          </TabsContent>
        )}
      </Tabs>
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
      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("detail.revokeConfirmTitle", { name: screen.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("detail.revokeConfirmBody")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              {t("common:actions.cancel")}
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {t("detail.revokeAction")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
