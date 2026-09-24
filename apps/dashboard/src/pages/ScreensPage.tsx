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
import { z } from "zod";
import { api } from "../api/client";
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
  fallback = "Not reported",
) =>
  typeof value === "string" && value.trim()
    ? value.replaceAll("_", " ")
    : fallback;
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
export const autostartSummary = (status?: ReliabilityStatus): string => {
  const target = status?.autostartTarget ? ` · ${status.autostartTarget}` : "";
  switch (status?.autostartState) {
    case "installed":
      return status?.bootLaunchVerified
        ? `Installed${target} · verified at boot`
        : `Installed${target} · not yet seen at boot`;
    case "not_installed":
      return "Not installed";
    case "needs_attention":
      return `Needs attention${status?.autostartError ? ` · ${status.autostartError}` : ""}`;
    case "unsupported":
      return `Unsupported${status?.autostartError ? ` · ${status.autostartError}` : ""}`;
    case "unknown":
      // The probe itself failed. Distinct from a device that reports nothing:
      // there is a device, it tried, and it carries the reason.
      return `Could not determine${status?.autostartError ? ` · ${status.autostartError}` : ""}`;
    default:
      return "Not reported";
  }
};

/**
 * What still stands between this screen and an unattended boot. The player
 * owns its own service; it cannot create the graphical session that service
 * renders into, so those gaps are named rather than implied.
 */
export const autostartWarning = (status?: ReliabilityStatus) => {
  if (!reportsAutostart(status)) return undefined;
  if (status?.autostartState === "not_installed")
    return "Autostart is not installed; this screen will not return on its own after a reboot or a player update.";
  if (status?.autostartState === "needs_attention")
    return "A service unit is present but systemd does not report it as enabled.";
  if (status?.autostartState === "unknown")
    return `Autostart state could not be determined on the device${status.autostartError ? `: ${status.autostartError}` : ""}. Treat this screen as not set up until it reports again.`;
  if (
    status?.autostartState === "installed" &&
    status.autostartTarget === "default.target" &&
    status.autostartLingerEnabled === false
  )
    return "Autostart is enabled against default.target without lingering; run `loginctl enable-linger` on the device as root so the service survives logout.";
  return undefined;
};

export const reliabilityCapabilityWarning = (status?: ReliabilityStatus) => {
  if (
    status?.configuredMode === "managed_kiosk" &&
    status.effectiveMode !== "managed_kiosk"
  )
    return "Managed Kiosk was requested but Android has not confirmed active lock-task capability.";
  if (status?.accessibilityServiceState === "policy_enabled_service_disabled")
    return "Accessibility Control is requested but must be enabled locally.";
  if (status?.sleepCapability === "black_screen_only")
    return "Device sleep is unavailable; the player will use black-screen fallback.";
  return undefined;
};
export const zeroTouchReadiness = (
  status?: ReliabilityStatus,
): "Ready" | "Partially ready" | "Needs setup" | "Unsupported" => {
  if (!status || !status.commissioningState) return "Needs setup";
  if (status.bootRecoveryResult === "unsupported") return "Unsupported";
  if (status.commissioningState !== "complete") return "Needs setup";
  if (
    status.accessibilityServiceState === "enabled" &&
    status.bootLaunchVerified &&
    status.immersiveModeActive &&
    status.keepScreenOn &&
    status.updateReadiness === "ready" &&
    !status.safeMode
  )
    return "Ready";
  return "Partially ready";
};
const codeSchema = z.object({
  code: z.string().trim().min(6, "Enter the six-character code").max(9),
});
const approvalSchema = z.object({
  name: z.string().trim().min(2, "Enter a screen name").max(120),
  locationId: z.string().optional(),
  roomName: z.string().max(120),
  roomNumber: z.string().max(80),
  description: z.string().max(1000),
});
type CodeForm = z.infer<typeof codeSchema>;
type ApprovalForm = z.infer<typeof approvalSchema>;
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
  destination: PairingDestination = "automatic",
) =>
  destination === "replace_hardware"
    ? "Replace hardware"
    : destination === "credential_repair" ||
        (destination === "automatic" &&
          request.previouslyPaired &&
          request.hasActiveCredential)
      ? "Repair and replace credential"
      : "Approve and pair";

function LocationPicker({
  locations,
  value,
  onChange,
}: {
  locations: Location[];
  value?: string;
  onChange: (value?: string) => void;
}) {
  const selected = locations.find((location) => location.id === value);
  const items = [
    { value: "__unassigned__", label: "Unassigned" },
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
        Location (optional)
      </FieldLabel>
      <Select
        items={items}
        value={value ?? "__unassigned__"}
        onValueChange={(next) =>
          onChange(next === "__unassigned__" || !next ? undefined : next)
        }
      >
        <SelectTrigger id="screen-location" className="w-full">
          <SelectValue placeholder="Unassigned" />
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
        Create new location
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
  { label: string; Icon: typeof Wifi }
> = {
  online: { label: "Online", Icon: Wifi },
  recent: { label: "Recently online", Icon: Wifi },
  stale: { label: "Stale", Icon: CircleAlert },
  offline: { label: "Offline", Icon: WifiOff },
  disabled: { label: "Disabled", Icon: ShieldOff },
  revoked: { label: "Pairing revoked", Icon: ShieldOff },
};

export function ScreensWorkspacePage() {
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
          <h1 className="text-2xl font-semibold tracking-tight">Screens</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            {archive
              ? "Review players whose pairings were revoked."
              : screens.isLoading
                ? "Loading screen inventory…"
                : screenInventorySummary(screens.data?.items ?? [])}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {manageable && (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              to="/screens/pair"
            >
              <Plus aria-hidden="true" /> Pair screen
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
              <AlertTitle>Takeover active — {item.name}</AlertTitle>
              <AlertDescription>
                {item.playlistName} is overriding scheduled and fallback content
                until {new Date(item.expiresAt).toLocaleString()}.
              </AlertDescription>
              <ul className="flex flex-wrap gap-x-4 gap-y-1 pt-1 text-xs text-muted-foreground">
                <li>{item.activeCount} playing</li>
                <li>{item.preparingCount} preparing</li>
                <li>{item.failedCount} failed</li>
                <li>{item.affectedCount} targeted</li>
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
                End takeover
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
              <DialogTitle>End takeover for {canceling?.name}?</DialogTitle>
              <DialogDescription>
                Scheduled or fallback playback will resume. Add an optional
                reason to the cancellation record.
              </DialogDescription>
            </DialogHeader>
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-cancel-reason"
                className="text-sm font-medium"
              >
                Cancellation reason (optional)
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
                Keep takeover active
              </Button>
              <Button
                variant="destructive"
                type="submit"
                disabled={!canceling || cancel.isPending}
              >
                {cancel.isPending ? "Ending…" : "End takeover"}
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

function TakeoverAction({ screens }: { screens: Screen[] }) {
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
        Takeover
        {activeCount > 0 && (
          <Badge variant="secondary">{activeCount} active</Badge>
        )}
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-h-[min(90vh,54rem)] max-w-3xl overflow-y-auto">
          <DialogHeader>
            <DialogTitle>Takeover</DialogTitle>
            <DialogDescription>
              Temporarily override schedules and fallback content on the
              selected screens. Existing overlapping takeovers are replaced.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-4">
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-name"
                className="text-sm font-medium"
              >
                Takeover name
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
                Playlist
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
                  <SelectValue placeholder="Select playlist" />
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
                Expires in
              </FieldLabel>
              <Select
                items={[
                  { value: "15", label: "15 minutes" },
                  { value: "60", label: "1 hour" },
                  { value: "240", label: "4 hours" },
                  { value: "1440", label: "24 hours" },
                ]}
                value={String(minutes)}
                onValueChange={(value) => {
                  if (value) setMinutes(Number(value));
                }}
              >
                <SelectTrigger id="takeover-duration" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="15">15 minutes</SelectItem>
                  <SelectItem value="60">1 hour</SelectItem>
                  <SelectItem value="240">4 hours</SelectItem>
                  <SelectItem value="1440">24 hours</SelectItem>
                </SelectContent>
              </Select>
            </Field>
            <fieldset className="grid gap-3 border-t border-border pt-4">
              <legend className="text-sm font-semibold">Target screens</legend>
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
                  All screens
                </Button>
                <span className="text-sm text-muted-foreground">
                  {screens.length} screen{screens.length === 1 ? "" : "s"} in
                  the fleet
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
                        {statusLabel(item.status)}
                      </small>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="grid gap-3 border-t border-border pt-4">
              <legend className="text-sm font-semibold">
                Target Display Groups
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
                        {group.membershipCount} screens
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
              <AlertTitle>Takeover could not be activated</AlertTitle>
              <AlertDescription>{activate.error.message}</AlertDescription>
            </Alert>
          )}
          <DialogFooter className="border-t border-border pt-4 sm:justify-between">
            <p className="text-sm text-muted-foreground sm:mr-auto">
              {everyScreenSelected ? (
                <strong>
                  Every screen in the fleet ({screens.length}) is selected
                </strong>
              ) : (
                `${screenIds.length} screen${screenIds.length === 1 ? "" : "s"} selected`
              )}{" "}
              and {groupIds.length} Display Group
              {groupIds.length === 1 ? "" : "s"} selected
              {offlineSelected > 0
                ? ` · ${offlineSelected} selected screen${offlineSelected === 1 ? " is" : "s are"} not online`
                : ""}
              .
            </p>
            <div className="flex flex-wrap justify-end gap-2">
              <Button
                variant="outline"
                type="button"
                onClick={() => setOpen(false)}
              >
                Cancel
              </Button>
              {everyScreenSelected ? (
                <FleetHoldButton
                  holdMs={3000}
                  disabled={!ready || activate.isPending}
                  holdingLabel="Keep holding…"
                  hint="Hold for 3 seconds to take over every screen."
                  onHoldComplete={() => beginActivation(true)}
                >
                  {activate.isPending
                    ? "Activating…"
                    : "Hold to activate takeover"}
                </FleetHoldButton>
              ) : (
                <Button
                  variant="destructive"
                  type="button"
                  disabled={!ready || activate.isPending}
                  onClick={() => beginActivation(false)}
                >
                  {activate.isPending ? "Activating…" : "Activate takeover"}
                </Button>
              )}
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmationOpen} onOpenChange={setConfirmationOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Activate this takeover?</AlertDialogTitle>
            <AlertDialogDescription>
              The selected playlist will replace overlapping schedules and
              fallback content for the selected screens and groups.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Review targets</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                setConfirmationOpen(false);
                continueActivation();
              }}
            >
              Activate takeover
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
              <DialogTitle>Confirm your password</DialogTitle>
              <DialogDescription>
                This installation requires your current password before a
                takeover can start.
              </DialogDescription>
            </DialogHeader>
            <Field className="gap-2">
              <FieldLabel
                htmlFor="takeover-current-password"
                className="text-sm font-medium"
              >
                Current password
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
                <AlertTitle>Takeover could not be activated</AlertTitle>
                <AlertDescription>{activate.error.message}</AlertDescription>
              </Alert>
            )}
            <DialogFooter>
              <Button
                variant="outline"
                type="button"
                onClick={() => setPasswordOpen(false)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                disabled={!activationPassword || activate.isPending}
              >
                {activate.isPending ? "Activating…" : "Confirm takeover"}
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
    () => buildScreenGroups(filtered, groupBy, sort),
    [filtered, groupBy, sort],
  );
  // Only the filters put away inside "More filters" are chipped. Search, status,
  // location, platform, and now playing each show their own value in the toolbar
  // directly above, so chipping them restated the whole row back to the reader.
  const chippedFilters: { facet: string; value: string; remove: () => void }[] =
    [];
  if (syncGroup)
    chippedFilters.push({
      facet: "Display Group",
      value: syncGroupFilterLabel(syncGroup, screens),
      remove: () => setSyncGroup(""),
    });
  if (orientation)
    chippedFilters.push({
      facet: "Orientation",
      value: orientation === "portrait" ? "Portrait" : "Landscape",
      remove: () => setOrientation(""),
    });
  if (update)
    chippedFilters.push({
      facet: "Software update",
      value: updateLabel(update),
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
      <div className="space-y-2" aria-label="Loading screens">
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
            No screens paired
          </EmptyTitle>
          <EmptyDescription>
            Install Tilecast Player on a TV device and enter the pairing code
            shown on the player.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          {canManage ? (
            <Link
              className={buttonVariants({ variant: "default", size: "sm" })}
              to="/screens/pair"
            >
              Pair screen
            </Link>
          ) : (
            <p className="text-sm text-muted-foreground">
              An Owner or Administrator can approve new screens.
            </p>
          )}
        </EmptyContent>
      </Empty>
    );
  return (
    <section className="min-w-0 space-y-4" aria-label="Paired screens">
      <ScreenSummary screens={screens} status={status} onStatus={setStatus} />
      <div className="space-y-3">
        <div
          className="flex flex-wrap items-center gap-2"
          role="group"
          aria-label="Filter screens"
        >
          <DashboardSearch
            value={search}
            onValueChange={setSearch}
            label="Search screens"
            placeholder="Search screens…"
          />
          <FleetFilterSelect
            label="Status"
            value={status}
            onChange={setStatus}
            options={[
              { value: "", label: "All statuses" },
              { value: "online", label: "Online" },
              { value: "offline", label: "Offline" },
              { value: "attention", label: "Needs attention" },
              { value: "updating", label: "Updating" },
              { value: "syncing", label: "Syncing" },
            ]}
          />
          <FleetFilterSelect
            label="Location"
            value={location}
            onChange={setLocation}
            options={[
              { value: "", label: "All locations" },
              ...locationItems.map((item) => ({
                value: item.id,
                label: item.name,
              })),
            ]}
          />
          <FleetFilterSelect
            label="Platform"
            value={platform}
            onChange={setPlatform}
            options={[
              { value: "", label: "All platforms" },
              ...[...new Set(screens.map((item) => item.platform))]
                .sort()
                .map((item) => ({ value: item, label: platformLabel(item) })),
            ]}
          />
          <FleetFilterSelect
            label="Now playing"
            value={playing}
            onChange={setPlaying}
            options={[
              { value: "", label: "Any content" },
              { value: "presentation", label: "Presentation" },
              { value: "playlist", label: "Playlist" },
              { value: "nothing", label: "Nothing assigned" },
            ]}
          />
          <Popover>
            <PopoverTrigger
              render={<Button variant="outline" />}
              aria-label={`More screen filters${advancedFilterCount ? `, ${advancedFilterCount} active` : ""}`}
            >
              <SlidersHorizontal aria-hidden="true" /> More filters
              {advancedFilterCount > 0 && (
                <Badge variant="secondary">{advancedFilterCount}</Badge>
              )}
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 gap-3">
              <h3 className="text-sm font-medium">More filters</h3>
              <FleetFilterSelect
                label="Display Group"
                value={syncGroup}
                onChange={setSyncGroup}
                className="w-full"
                options={[
                  { value: "", label: "All screens" },
                  { value: "any", label: "In any Display Group" },
                  { value: "none", label: "Not in a Display Group" },
                  ...[
                    ...new Map(
                      screens
                        .filter((item) => item.syncGroupId)
                        .map(
                          (item) =>
                            [
                              item.syncGroupId ?? "",
                              item.syncGroupName ?? "Display Group",
                            ] as const,
                        ),
                    ).entries(),
                  ].map(([id, name]) => ({ value: id, label: name })),
                ]}
              />
              <FleetFilterSelect
                label="Orientation"
                value={orientation}
                onChange={setOrientation}
                className="w-full"
                options={[
                  { value: "", label: "Any orientation" },
                  { value: "landscape", label: "Landscape" },
                  { value: "portrait", label: "Portrait" },
                ]}
              />
              <FleetFilterSelect
                label="Software update"
                value={update}
                onChange={setUpdate}
                className="w-full"
                options={[
                  { value: "", label: "Any update status" },
                  { value: "current", label: "Current" },
                  { value: "downloading", label: "Downloading" },
                  { value: "attention", label: "Needs attention" },
                ]}
              />
            </PopoverContent>
          </Popover>
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2">
          {anyFilterActive ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="mr-1 text-xs text-muted-foreground">
                {filtered.length} of {screens.length} screens
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
                    aria-label={`Remove filter ${filter.facet}: ${filter.value}`}
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
                Clear filters
              </Button>
            </div>
          ) : (
            <span />
          )}

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <FleetFilterSelect
              label="Group by"
              value={groupBy}
              onChange={setGroupBy}
              options={[
                { value: "location", label: "Location" },
                { value: "status", label: "Status" },
                { value: "sync", label: "Display Group" },
                { value: "none", label: "No grouping" },
              ]}
            />
            <FleetFilterSelect
              label="Sort screens"
              className="w-52 max-sm:flex-1"
              value={sort}
              onChange={setSort}
              options={[
                { value: "name-asc", label: "Name · A–Z" },
                { value: "name-desc", label: "Name · Z–A" },
                { value: "location-asc", label: "Location · A–Z" },
                { value: "status-asc", label: "Status" },
                { value: "contact-desc", label: "Last contact · newest" },
                { value: "contact-asc", label: "Last contact · oldest" },
                { value: "added-desc", label: "Date added · newest" },
                { value: "platform-asc", label: "Platform" },
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
              aria-label="Screen view"
              variant="outline"
              spacing={0}
            >
              <ToggleGroupItem value="table" aria-label="Table view">
                <List aria-hidden="true" />
              </ToggleGroupItem>
              <ToggleGroupItem value="grid" aria-label="Preview grid view">
                <Grid2X2 aria-hidden="true" />
              </ToggleGroupItem>
            </ToggleGroup>
          </div>
        </div>
      </div>
      {view === "grid" && (
        <p className="text-xs text-muted-foreground">
          Previews show the latest snapshot reported by each player and refresh
          about every 30 seconds.
        </p>
      )}
      {selected.size > 0 && canManage && (
        <div className="flex flex-wrap items-center gap-2 border-l-2 border-primary bg-muted/50 px-3 py-2">
          <strong className="mr-2 text-sm">{selected.size} selected</strong>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void restartSelected()}
          >
            <RefreshCw aria-hidden="true" /> Restart
          </Button>
          <FleetFilterSelect
            label="Move selected screens to location"
            value={bulkLocation}
            onChange={setBulkLocation}
            options={[
              { value: "", label: "Unassigned" },
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
            Move to location
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setSelected(new Set())}
          >
            Clear selection
          </Button>
        </div>
      )}
      {locationsError && (
        <Alert variant="destructive">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>Locations could not be loaded</AlertTitle>
          <AlertDescription>
            Screen names and player details remain available.
          </AlertDescription>
        </Alert>
      )}
      {filtered.length === 0 ? (
        <Empty className="min-h-48 border-y border-dashed px-4 py-7">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Search aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>No screens match these filters</EmptyTitle>
            <EmptyDescription>
              Clear one or more filters to see the fleet again.
            </EmptyDescription>
          </EmptyHeader>
          <EmptyContent>
            <Button variant="outline" size="sm" onClick={clearFilters}>
              Clear filters
            </Button>
          </EmptyContent>
        </Empty>
      ) : visibleGroups.every((group) => collapsed.has(group.key)) ? (
        <Empty className="min-h-40 border-y border-dashed py-6">
          <EmptyHeader>
            <EmptyTitle>All groups are collapsed</EmptyTitle>
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
              Expand all groups
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
                      aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.label}`}
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
                        aria-label={`Select all screens in ${group.label}`}
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
  const online = screens.filter((item) => item.status === "online").length;
  const attention = screens.filter(needsAttention).length;
  const locations = new Set(
    screens.map((item) => item.locationId).filter(Boolean),
  ).size;
  return (
    <div
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-y border-border py-2"
      role="group"
      aria-label="Fleet summary"
    >
      <span className="mr-2 text-sm text-muted-foreground">
        {screens.length} screen{screens.length === 1 ? "" : "s"} · {locations}{" "}
        location{locations === 1 ? "" : "s"}
      </span>
      <Button
        variant={status === "online" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={status === "online"}
        onClick={() => onStatus(status === "online" ? "" : "online")}
      >
        <strong className="tabular-nums">{online}</strong> Online
      </Button>
      <Button
        variant={status === "attention" ? "secondary" : "ghost"}
        size="sm"
        aria-pressed={status === "attention"}
        onClick={() => onStatus(status === "attention" ? "" : "attention")}
      >
        <strong className="tabular-nums">{attention}</strong> Needs attention
      </Button>
    </div>
  );
}

function GroupHealth({ screens }: { screens: Screen[] }) {
  const online = screens.filter((item) => item.status === "online").length;
  const attention = screens.filter(needsAttention).length;
  const syncGroups = new Set(
    screens.map((item) => item.syncGroupName).filter(Boolean),
  );
  return (
    <span className="flex flex-wrap items-center justify-end gap-1.5">
      <Badge variant={online === screens.length ? "outline" : "secondary"}>
        {online} of {screens.length} online
      </Badge>
      {attention > 0 && (
        <Badge variant="destructive">
          <CircleAlert aria-hidden="true" />
          {attention} {attention === 1 ? "needs" : "need"} attention
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

function syncGroupFilterLabel(value: string, screens: Screen[]) {
  if (value === "any") return "In any Display Group";
  if (value === "none") return "Not in a Display Group";
  return (
    screens.find((item) => item.syncGroupId === value)?.syncGroupName ??
    "Selected"
  );
}

function screenInventorySummary(screens: Screen[]) {
  const locationCount = new Set(
    screens
      .map((screen) => screen.locationId || screen.location)
      .filter(Boolean),
  ).size;
  return `${screens.length} player${screens.length === 1 ? "" : "s"} across ${locationCount} location${locationCount === 1 ? "" : "s"}`;
}

function updateLabel(value: string) {
  if (value === "current") return "Current";
  if (value === "attention") return "Needs attention";
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function platformLabel(value: string) {
  const normalized = value.toLowerCase();
  if (normalized === "linux") return "Linux";
  if (normalized.includes("fire")) return "Fire TV";
  if (normalized.includes("google")) return "Google TV";
  if (normalized.includes("android")) return "Android TV";
  return value || "Unknown platform";
}

function statusLabel(value: string) {
  if (value === "attention") return "Needs attention";
  if (value === "updating") return "Updating";
  if (value === "syncing") return "Syncing";
  return statusContent[value as ScreenStatus]?.label ?? value;
}

function needsAttention(screen: Screen) {
  return (
    ["stale", "offline", "disabled", "revoked"].includes(screen.status) ||
    Boolean(screen.updateError)
  );
}

function roomLabel(screen: Screen) {
  if (screen.roomName && screen.roomNumber)
    return `${screen.roomName} · Room ${screen.roomNumber}`;
  if (screen.roomName) return screen.roomName;
  if (screen.roomNumber) return `Room ${screen.roomNumber}`;
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
            ? platformLabel(left.platform)
            : left.name;
    const b =
      field === "location"
        ? right.location
        : field === "status"
          ? right.status
          : field === "platform"
            ? platformLabel(right.platform)
            : right.name;
    return a.localeCompare(b, undefined, { sensitivity: "base" }) * descending;
  });
  if (groupBy === "none")
    return [{ key: "all", label: "All screens", screens: sorted }];
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
        ? statusContent[screen.status].label
        : groupBy === "sync"
          ? (screen.syncGroupName ?? "Not in a Display Group")
          : screen.location || "Unassigned";
    const description =
      groupBy === "location"
        ? formatLocationAddress(screen.locationDetails)
        : undefined;
    const existing = map.get(key);
    if (existing) existing.screens.push(screen);
    else map.set(key, { key, label, description, screens: [screen] });
  }
  return [...map.values()].sort((a, b) =>
    a.label.localeCompare(b.label, undefined, { sensitivity: "base" }),
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
    ? previewAge(preview.data.capturedAt, now)
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
        aria-label={`Open ${screen.name}`}
        className="block outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset"
      >
        <AspectRatio
          ratio={(screen.screenWidth || 16) / (screen.screenHeight || 9)}
          className={`grid max-h-52 w-full place-items-center overflow-hidden bg-slate-950 ${portrait ? "mx-auto my-3 w-[min(45%,8rem)] rounded-xl" : ""}`}
        >
          {preview.isLoading && visible ? (
            <Skeleton
              className="absolute inset-0 min-h-32"
              aria-label="Loading preview"
            />
          ) : image ? (
            <>
              <img
                className="h-full w-full object-contain"
                src={image}
                alt={`Latest preview from ${screen.name}`}
              />
              {age && (
                <Badge
                  variant="secondary"
                  className="pointer-events-none absolute right-2 bottom-2 border-white/10 bg-black/60 text-white"
                  aria-label={`Snapshot captured ${age.label}`}
                  title={`Captured ${new Date(
                    preview.data?.capturedAt ?? "",
                  ).toLocaleString()}`}
                >
                  {age.label}
                </Badge>
              )}
            </>
          ) : (
            <span className="grid min-h-32 place-items-center gap-1 text-center text-xs text-slate-300">
              <Monitor className="size-6" aria-hidden="true" />
              {screen.status === "offline"
                ? "Screen offline"
                : "Preview unavailable"}
            </span>
          )}
        </AspectRatio>
      </Link>
      <div className="grid gap-3 p-3">
        <header className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2">
          {canManage && (
            <Checkbox
              aria-label={`Select ${screen.name}`}
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
              {[showLocation ? screen.location : "", roomLabel(screen)]
                .filter(Boolean)
                .join(" · ") || "Unassigned"}
            </small>
          </span>
          <div className="shrink-0">
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon-sm" />}
                aria-label={`Actions for ${screen.name}`}
              >
                <MoreHorizontal aria-hidden="true" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem
                  render={<Link to={`/screens/${screen.id}`} />}
                >
                  <Monitor aria-hidden="true" /> Open screen
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
                      <RefreshCw aria-hidden="true" /> Restart player
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      render={
                        <Link to={`/screens/${screen.id}?edit=details`} />
                      }
                    >
                      <Pencil aria-hidden="true" /> Edit details
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      render={<Link to={`/screens/${screen.id}?tab=content`} />}
                    >
                      Assign content
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      render={<Link to={`/screens/${screen.id}?present=1`} />}
                    >
                      <Play aria-hidden="true" /> Show now
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
                        ? "Open Display Group"
                        : "Add to Display Group"}
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
            {formatContact(screen.lastContactAt)}
          </span>
        </div>
        <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-2 text-xs">
          <dt className="text-muted-foreground">Now playing</dt>
          <dd className="truncate font-medium">
            {screen.nowPlayingName || "Nothing assigned"}
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
  if (requests.length === 0) return null;
  return (
    <section className="space-y-2" aria-label="Pending pairing requests">
      <Alert>
        <RefreshCw aria-hidden="true" />
        <AlertTitle className="flex items-center gap-2">
          Waiting for approval{" "}
          <Badge variant="secondary">{requests.length}</Badge>
        </AlertTitle>
        <AlertDescription>
          {requests.length} player{requests.length === 1 ? "" : "s"} requested
          pairing.
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
                {platformLabel(request.metadata.platform)} ·{" "}
                {request.metadata.screenWidth}×{request.metadata.screenHeight} ·
                Expires{" "}
                {new Date(request.expiresAt).toLocaleTimeString([], {
                  hour: "numeric",
                  minute: "2-digit",
                })}
              </ItemDescription>
            </ItemContent>
            {canManage && (
              <ItemActions>
                <Link
                  className={buttonVariants({ variant: "outline", size: "sm" })}
                  to={`/screens/pair/request/${request.id}`}
                >
                  Review
                </Link>
              </ItemActions>
            )}
          </Item>
        ))}
      </ItemGroup>
    </section>
  );
}

export function PairScreenPage() {
  const { code, requestId } = useParams();
  const auth = useAuth();
  const navigate = useNavigate();
  const [request, setRequest] = useState<PairingRequest>();
  const [error, setError] = useState<string>();
  const form = useForm<CodeForm>({
    resolver: zodResolver(codeSchema),
    defaultValues: { code: code ?? "" },
  });
  const lookup = async (value: CodeForm) => {
    setError(undefined);
    try {
      setRequest(await api.resolvePairing(value.code));
    } catch (reason) {
      setError(
        reason instanceof Error
          ? reason.message
          : "Pairing code could not be resolved.",
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
  if (!canManageScreens(auth.status?.user))
    return (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            Screen approval requires administrator access.
          </EmptyTitle>
          <EmptyDescription>
            Editors and Viewers can monitor screens but cannot approve or reject
            pairing requests.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Link
            className={buttonVariants({ variant: "outline", size: "sm" })}
            to="/screens"
          >
            Return to screens
          </Link>
        </EmptyContent>
      </Empty>
    );
  if (request)
    return (
      <ApprovalPanel
        request={request}
        onDone={(screenId) =>
          void navigate(screenId ? `/screens/${screenId}` : "/screens")
        }
      />
    );
  return (
    <section className="pair-card">
      <header>
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          <Link2 className="size-5" aria-hidden="true" />
        </span>
        <div>
          <h2>Pair a screen</h2>
          <p>Enter the six-character code displayed by Tilecast Player.</p>
        </div>
      </header>
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
      <form onSubmit={(event) => void form.handleSubmit(lookup)(event)}>
        <FormField
          id="pairingCode"
          label="Pairing code"
          autoComplete="off"
          autoFocus
          className="pair-code-input"
          placeholder="ABC234"
          error={form.formState.errors.code?.message}
          {...form.register("code")}
        />
        <Button type="submit">Find player</Button>
        <Link className={buttonVariants({ variant: "ghost" })} to="/screens">
          Cancel
        </Link>
      </form>
      <div className="pair-help">
        <strong>On the TV</strong>
        <p>
          Open Tilecast Player, connect to this server, and leave the pairing
          code visible while you approve it.
        </p>
      </div>
    </section>
  );
}

function ApprovalPanel({
  request,
  onDone,
}: {
  request: PairingRequest;
  onDone: (screenId?: string) => void;
}) {
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
    resolver: zodResolver(approvalSchema),
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
        throw new Error(
          "Choose the existing screen whose hardware is being replaced.",
        );
      if (destination === "replace_hardware") {
        const target = screens.data?.items.find(
          (screen) => screen.id === replacementScreenId,
        );
        if (!target)
          throw new Error("The replacement screen could not be found.");
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
        title: `Repair pairing for “${request.existingScreenName}”?`,
        description:
          "This preserves the existing screen. Its previous device credential is replaced after the new player completes enrollment.",
      });
      return;
    }
    if (destination === "replace_hardware") {
      const target = screens.data?.items.find(
        (screen) => screen.id === replacementScreenId,
      );
      if (!target) {
        setApprovalError(
          "Choose the existing screen whose hardware is being replaced.",
        );
        return;
      }
      setApprovalConfirmation({
        values,
        title: `Replace hardware for “${target.name}”?`,
        description:
          "The logical screen, Display Group membership, content assignments, schedules, policies, and history will stay in place. The old credential is retired only after enrollment succeeds.",
      });
      return;
    }
    approve.mutate(values);
  };
  const eligibleScreens = (screens.data?.items ?? []).filter(
    (screen) => screen.id !== request.existingScreenId,
  );
  const selectedReplacementScreen = eligibleScreens.find(
    (screen) => screen.id === replacementScreenId,
  );
  const metadata = request.metadata;
  return (
    <section className="approval-card">
      <header>
        <div>
          <p className="step-label">Pairing request</p>
          <h2>Review this player</h2>
          <p>
            Confirm the device details before granting it an individual Tilecast
            credential.
          </p>
        </div>
        <span className="expiry-label">
          Expires{" "}
          {new Date(request.expiresAt).toLocaleTimeString([], {
            hour: "numeric",
            minute: "2-digit",
          })}
        </span>
      </header>
      <dl className="device-facts">
        <div>
          <dt>Device</dt>
          <dd>
            {metadata.manufacturer} {metadata.model}
          </dd>
        </div>
        <div>
          <dt>Platform</dt>
          <dd>{metadata.platform}</dd>
        </div>
        <div>
          <dt>Android</dt>
          <dd>{metadata.androidVersion}</dd>
        </div>
        <div>
          <dt>Player</dt>
          <dd>{metadata.playerVersion}</dd>
        </div>
        <div>
          <dt>Resolution</dt>
          <dd>
            {metadata.screenWidth} × {metadata.screenHeight}
          </dd>
        </div>
        <div>
          <dt>Locale / timezone</dt>
          <dd>
            {metadata.locale} · {metadata.timezone}
          </dd>
        </div>
        {metadata.approximateAddress && (
          <div>
            <dt>Network address</dt>
            <dd>{metadata.approximateAddress}</dd>
          </div>
        )}
      </dl>
      <FieldSet className="grid gap-3 rounded-xl border border-border p-4">
        <FieldLegend variant="label" className="mb-0">
          Pairing destination
        </FieldLegend>
        <RadioGroup
          aria-label="Pairing destination"
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
                Create new screen
              </FieldLabel>
              <FieldDescription>
                Create a new logical screen from this player.
              </FieldDescription>
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
                  Repair existing credential
                </FieldLabel>
                <FieldDescription>
                  Keep this player installation on “{request.existingScreenName}
                  ”.
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
                Replace hardware for an existing screen
              </FieldLabel>
              <FieldDescription>
                Keep the logical screen, Display Group, content, schedules,
                policies, and history.
              </FieldDescription>
            </FieldContent>
          </Field>
        </RadioGroup>
        {destination === "replace_hardware" && (
          <Field>
            <FieldLabel htmlFor="pairing-existing-screen">
              Existing screen
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
                aria-label="Existing screen"
                placeholder="Search screens…"
                showClear
                className="w-full"
              />
              <ComboboxContent>
                <ComboboxEmpty>
                  {screens.isLoading
                    ? "Loading screens…"
                    : screens.isError
                      ? "Screens could not be loaded."
                      : "No matching eligible screens."}
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
            <FieldDescription>
              The old credential is retired only after this player successfully
              enrolls.
            </FieldDescription>
          </Field>
        )}
      </FieldSet>
      {request.previouslyPaired && (
        <Alert role="status">
          <AlertTitle>
            This device was previously paired as “{request.existingScreenName}.”
          </AlertTitle>
          <AlertDescription>
            {destination === "replace_hardware"
              ? "Choose the logical screen above; its identity and configuration are preserved."
              : "Repairing the pairing will preserve this screen and its content assignments. The previous device credential will be revoked only after this player completes enrollment."}
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
        onSubmit={(event) => void form.handleSubmit(requestApproval)(event)}
      >
        <FormField
          id="screenName"
          label="Screen name"
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
            label="Room name (optional)"
            placeholder="Library"
            {...form.register("roomName")}
          />
          <FormField
            id="screenRoomNumber"
            label="Room number (optional)"
            placeholder="204"
            {...form.register("roomNumber")}
          />
        </div>
        <Field>
          <FieldLabel htmlFor="screenDescription">
            Description (optional)
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
            Reject
          </Button>
          <Button
            type="submit"
            disabled={approve.isPending || reject.isPending}
          >
            {approve.isPending
              ? "Approving…"
              : pairingApprovalLabel(request, destination)}
          </Button>
        </div>
      </form>
      <AlertDialog
        open={approvalConfirmation !== null}
        onOpenChange={(open) => {
          if (!open) setApprovalConfirmation(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {approvalConfirmation?.title ?? "Confirm pairing change"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {approvalConfirmation?.description ??
                "Review this pairing change before continuing."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={approve.isPending}>
              Go back
            </AlertDialogCancel>
            <AlertDialogAction
              disabled={!approvalConfirmation || approve.isPending}
              onClick={() => {
                if (!approvalConfirmation) return;
                approve.mutate(approvalConfirmation.values);
                setApprovalConfirmation(null);
              }}
            >
              Confirm pairing
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}

export function ScreenDetailPage() {
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
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
    resolver: zodResolver(approvalSchema),
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
        setScreenCommandError("Enter a value before continuing.");
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
            `Enter a whole number from ${screenCommandAction.input.min ?? "−∞"} to ${screenCommandAction.input.max ?? "∞"}.`,
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
        <p className="text-sm text-muted-foreground">Loading screen…</p>
      </div>
    );
  if (!screen)
    return (
      <Alert variant="destructive">
        <AlertDescription>Screen could not be loaded.</AlertDescription>
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
              platformLabel(screen.platform),
              [screen.deviceManufacturer, screen.deviceModel]
                .filter(Boolean)
                .join(" "),
              screen.playerVersion
                ? `Player ${screen.playerVersion}`
                : "Player version not reported",
              [screen.location, roomLabel(screen)]
                .filter(Boolean)
                .join(" · ") || "No location set",
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {canManageScreens(auth.status?.user) && (
            <Button size="sm" onClick={() => setQuickPresentOpen(true)}>
              <Play aria-hidden="true" /> Present
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
              <RefreshCw aria-hidden="true" /> Restart
            </Button>
          )}
          <DropdownMenu>
            <DropdownMenuTrigger
              render={<Button variant="outline" size="icon-sm" />}
              aria-label="More screen actions"
            >
              <MoreHorizontal aria-hidden="true" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {canManageScreens(auth.status?.user) && (
                <DropdownMenuItem onClick={() => setEditingDetails(true)}>
                  <Pencil aria-hidden="true" /> Edit screen details
                </DropdownMenuItem>
              )}
              {canManageScreens(auth.status?.user) &&
                screen.platform.toLowerCase() === "linux" && (
                  <DropdownMenuItem onClick={() => setAirplayOpen(true)}>
                    <Airplay aria-hidden="true" /> AirPlay
                  </DropdownMenuItem>
                )}
              <DropdownMenuItem onClick={() => selectTab("content")}>
                <Monitor aria-hidden="true" /> View content
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
              <DialogTitle>Edit screen details</DialogTitle>
              <DialogDescription>
                Update the name and location shown throughout Tilecast Studio.
              </DialogDescription>
            </DialogHeader>
            {updateDetails.error && (
              <Alert variant="destructive">
                <CircleAlert aria-hidden="true" />
                <AlertTitle>Screen details could not be saved</AlertTitle>
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
                Screen name
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
                  Room name (optional)
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
                  Room number (optional)
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
                Description (optional)
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
                Cancel
              </Button>
              <Button type="submit" disabled={updateDetails.isPending}>
                {updateDetails.isPending ? "Saving…" : "Save details"}
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
          aria-label="Screen details"
          variant="line"
          className="min-h-10 w-full justify-start gap-4 overflow-x-auto rounded-none border-b border-border p-0"
        >
          <TabsTrigger value="overview" className="flex-none px-2">
            Overview
          </TabsTrigger>
          <TabsTrigger value="content" className="flex-none px-2">
            Content
          </TabsTrigger>
          <TabsTrigger value="activity" className="flex-none px-2">
            Activity
          </TabsTrigger>
          <TabsTrigger value="device" className="flex-none px-2">
            Device
          </TabsTrigger>
          <TabsTrigger value="settings" className="flex-none px-2">
            Settings {policyDirty && <Badge variant="secondary">Unsaved</Badge>}
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
                  Overview
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Current playback, connection, and player reliability.
                </p>
              </header>
              {reliability.data?.externalPresentationState &&
                reliability.data.externalPresentationState !== "none" && (
                  <Alert>
                    <Airplay aria-hidden="true" />
                    <AlertTitle>External presentation active</AlertTitle>
                    <AlertDescription>
                      {reliability.data.airplayConnected
                        ? "This screen is receiving mirrored video."
                        : "This screen is waiting for a sender."}{" "}
                      Preview capture is disabled while AirPlay is active.
                    </AlertDescription>
                  </Alert>
                )}
              <dl className="grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-4">
                <OverviewFact
                  label="Connection"
                  value={<StatusLabel status={screen.status} />}
                />
                <OverviewFact
                  label="Now playing"
                  value={
                    assignment.data?.layoutName ??
                    assignment.data?.playlistName ??
                    "No content assigned"
                  }
                />
                <OverviewFact
                  label="Location"
                  value={
                    [screen.location, roomLabel(screen)]
                      .filter(Boolean)
                      .join(" · ") || "Not set"
                  }
                />
                <OverviewFact
                  label="Last contact"
                  value={formatContact(screen.lastContactAt)}
                />
                <OverviewFact
                  label="Player update"
                  value={
                    screen.updateError
                      ? "Update failed"
                      : (screen.updateState?.replaceAll("_", " ") ??
                        "No active deployment")
                  }
                />
                <OverviewFact
                  label="Reliability"
                  value={
                    reliability.data?.effectiveMode?.replaceAll("_", " ") ??
                    "Not reported"
                  }
                />
                <OverviewFact
                  label="Next schedule change"
                  value={
                    assignment.data?.nextTransitionAt
                      ? new Date(
                          assignment.data.nextTransitionAt,
                        ).toLocaleString()
                      : "None scheduled"
                  }
                />
                <OverviewFact
                  label="Player settings"
                  value={
                    <Link
                      to="?tab=settings"
                      className="underline underline-offset-4"
                    >
                      {Object.keys(screenPolicy.data?.values ?? {}).length}{" "}
                      overrides · Settings
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
                  View content
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => selectTab("activity")}
                >
                  View activity
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
                    Hardware history
                  </h3>
                  <p className="text-sm text-muted-foreground">
                    The logical screen stays stable when hardware is replaced.
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
                            {hardware.screenWidth}×{hardware.screenHeight} ·
                            Paired{" "}
                            {new Date(hardware.pairedAt).toLocaleDateString()}
                            {hardware.retiredAt
                              ? ` · Retired ${new Date(hardware.retiredAt).toLocaleDateString()}`
                              : " · Current hardware"}
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
                    No hardware history recorded.
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
                  Playback and scheduling
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Review the content assigned to this screen and the schedule
                  that currently selects it.
                </p>
              </header>
              {assignment.data?.groups?.[0] && (
                <Alert>
                  <Monitor aria-hidden="true" />
                  <AlertTitle>Managed by a Display Group</AlertTitle>
                  <AlertDescription>
                    This player belongs to the{" "}
                    <Link to={`/groups/${assignment.data.groups[0].id}`}>
                      {assignment.data.groups[0].name}
                    </Link>{" "}
                    Display Group. Content and schedules apply to every member.
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
                          label: "No presentation assigned",
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
                        aria-label="Assigned presentation"
                        className="w-full"
                      >
                        <SelectValue placeholder="No presentation assigned" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="__none__">
                          No presentation assigned
                        </SelectItem>
                        <SelectGroup>
                          <SelectLabel>Playlists</SelectLabel>
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
                          <SelectLabel>Published layouts</SelectLabel>
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
                      ? "Applying…"
                      : assignment.data?.groups?.[0]
                        ? "Apply to Display Group"
                        : "Apply assignment"}
                  </Button>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {assignment.data?.layoutName ??
                    assignment.data?.playlistName ??
                    "No presentation assigned"}
                </p>
              )}
              <ScreenContentChain assignment={assignment.data} />
              <dl className="grid gap-x-6 gap-y-4 border-y border-border py-4 sm:grid-cols-2 xl:grid-cols-3">
                <OverviewFact
                  label="Direct fallback"
                  value={
                    assignment.data?.layoutName ??
                    assignment.data?.playlistName ??
                    "No fallback assigned"
                  }
                />
                <OverviewFact
                  label="Current selection"
                  value={
                    assignment.data?.selectionSource === "takeover"
                      ? "Takeover"
                      : assignment.data?.selectionSource === "schedule"
                        ? `Scheduled${assignment.data.currentScheduleId ? ` · ${(assignment.data.relevantSchedules ?? []).find((s) => s.id === assignment.data?.currentScheduleId)?.name ?? "schedule"}` : ""}`
                        : assignment.data?.selectionSource === "direct_fallback"
                          ? "Direct fallback"
                          : "No content"
                  }
                />
                <OverviewFact
                  label="Next scheduled change"
                  value={
                    assignment.data?.nextTransitionAt
                      ? new Date(
                          assignment.data.nextTransitionAt,
                        ).toLocaleString()
                      : "None reported"
                  }
                />
                <OverviewFact
                  label="Display Group"
                  value={
                    (assignment.data?.groups ?? [])
                      .map((group) => group.name)
                      .join(", ") || "Not grouped"
                  }
                />
                <OverviewFact
                  label="Relevant schedules"
                  value={
                    (assignment.data?.relevantSchedules ?? [])
                      .map(
                        (schedule) => `${schedule.name} (${schedule.priority})`,
                      )
                      .join(", ") || "No schedules"
                  }
                />
              </dl>
              <Collapsible className="border-t border-border pt-3">
                <CollapsibleTrigger className="flex w-full cursor-pointer items-center justify-between gap-2 text-left text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Playback diagnostics
                  <ChevronDown size={16} aria-hidden="true" />
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <dl className="mt-4 grid gap-x-6 gap-y-4 sm:grid-cols-2 xl:grid-cols-3">
                    <OverviewFact
                      label="Server manifest"
                      value={`Version ${assignment.data?.manifestVersion ?? 1}`}
                    />
                    <OverviewFact
                      label="Player configuration"
                      value={
                        assignment.data?.activeConfigRevision != null
                          ? `Revision ${assignment.data.activeConfigRevision}`
                          : "Not reported"
                      }
                    />
                    <OverviewFact
                      label="Player manifest"
                      value={
                        assignment.data?.playerActiveManifestVersion != null
                          ? `Version ${assignment.data.playerActiveManifestVersion}`
                          : "Not reported"
                      }
                    />
                    <OverviewFact
                      label="Synchronization"
                      value={
                        assignment.data?.synchronizationStatus?.replaceAll(
                          "_",
                          " ",
                        ) ?? "Not reported"
                      }
                    />
                    <OverviewFact
                      label="Device clock difference"
                      value={
                        assignment.data?.deviceClockOffsetSeconds != null
                          ? `${Math.abs(assignment.data.deviceClockOffsetSeconds)} seconds`
                          : "Not reported"
                      }
                    />
                    <OverviewFact
                      label="Downloads"
                      value={
                        assignment.data?.downloadQueueCount != null
                          ? `${assignment.data.downloadQueueCount} queued · ${assignment.data.downloadedBytes ?? 0} of ${assignment.data.requiredBytes ?? 0} bytes`
                          : "Not reported"
                      }
                    />
                    <OverviewFact
                      label="Website playback"
                      value={
                        assignment.data?.websiteState
                          ? `${assignment.data.websiteState?.replaceAll("_", " ") ?? "Not reported"}${assignment.data.websiteCurrentHost ? ` · ${assignment.data.websiteCurrentHost}` : ""}`
                          : "Not active"
                      }
                    />
                    <OverviewFact
                      label="Blocked website navigation"
                      value={
                        assignment.data?.websiteBlockedNavigationCount ??
                        "Not reported"
                      }
                    />
                    <OverviewFact
                      label="Playback"
                      value={assignment.data?.playbackState ?? "Not reported"}
                    />
                    <OverviewFact
                      label="Takeover"
                      value={
                        assignment.data?.activeTakeoverId
                          ? `${assignment.data.takeoverState ?? "pending"} · ${assignment.data.takeoverPreparationProgress ?? 0}% prepared`
                          : "No active takeover"
                      }
                    />
                    <OverviewFact
                      label="Cache"
                      value={
                        assignment.data?.cacheUsedBytes != null
                          ? `${assignment.data.cacheUsedBytes} of ${assignment.data.cacheLimitBytes ?? 0} bytes`
                          : "Not reported"
                      }
                    />
                  </dl>
                </CollapsibleContent>
              </Collapsible>
              {assignment.error && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>
                    Playback assignment could not be loaded
                  </AlertTitle>
                  <AlertDescription>
                    {assignment.error.message}
                  </AlertDescription>
                </Alert>
              )}
              {[
                ["Synchronization", assignment.data?.lastSynchronizationError],
                ["Playback", assignment.data?.lastPlaybackError],
                ["Configuration", assignment.data?.configurationError],
              ].map(
                ([label, message]) =>
                  message && (
                    <Alert key={label} variant="destructive">
                      <CircleAlert aria-hidden="true" />
                      <AlertTitle>{label} error</AlertTitle>
                      <AlertDescription>{message}</AlertDescription>
                    </Alert>
                  ),
              )}
              {Math.abs(assignment.data?.deviceClockOffsetSeconds ?? 0) >
                (assignment.data?.clockSkewWarningSeconds ?? 300) && (
                <Alert>
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>
                    Player clock is outside the warning threshold
                  </AlertTitle>
                  <AlertDescription>
                    The player clock differs from server time by more than five
                    minutes. Offline schedule changes may occur at the wrong
                    time.
                  </AlertDescription>
                </Alert>
              )}
              {assignment.data?.scheduleEvaluationError && (
                <Alert variant="destructive">
                  <CircleAlert aria-hidden="true" />
                  <AlertTitle>Schedule evaluation failed</AlertTitle>
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
                    <AlertTitle>Website playback issue</AlertTitle>
                    <AlertDescription>
                      {assignment.data.websiteFailureCategory?.replaceAll(
                        "_",
                        " ",
                      ) ?? "Unknown website failure"}
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
                  Device
                </h2>
                <p className="mt-1 text-sm text-muted-foreground">
                  Player health, device details, and operational controls.
                </p>
              </header>
              <nav
                aria-label="Device sections"
                className="flex flex-wrap gap-1 border-b border-border"
              >
                {(
                  [
                    ["device", "Device details"],
                    ["health", "Health"],
                    ["maintenance", "Maintenance"],
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
                  Health &amp; recovery
                </h3>
                <p className="text-sm text-muted-foreground">
                  Configured behavior is reported separately from capabilities
                  confirmed by this device. Platform-specific controls appear
                  only when the player reports support.
                </p>
                <section className="min-w-0 space-y-3 rounded-xl border border-border border-l-4 border-l-primary bg-muted/20">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border p-4">
                    <div className="min-w-0 space-y-1">
                      <h4 className="text-sm font-semibold">
                        Zero-Touch Readiness
                      </h4>
                      <p className="text-sm text-muted-foreground">
                        Commissioning and current device capabilities required
                        for unattended recovery.
                      </p>
                    </div>
                    <Badge variant="outline">
                      {zeroTouchReadiness(reliability.data)}
                    </Badge>
                  </div>
                  <dl className="grid gap-3 px-4 pb-4 sm:grid-cols-2 [&_dd]:mt-1 [&_dd]:break-words [&_dd]:text-sm [&_dt]:text-xs [&_dt]:text-muted-foreground">
                    <div>
                      <dt>Commissioning</dt>
                      <dd>
                        {formatReportedStatus(
                          reliability.data?.commissioningState,
                          "Not started",
                        )}
                        {typeof reliability.data?.commissioningStep ===
                          "string" && reliability.data.commissioningStep.trim()
                          ? ` · ${formatReportedStatus(reliability.data.commissioningStep, "")}`
                          : ""}
                      </dd>
                    </div>
                    <div>
                      <dt>Accessibility return</dt>
                      <dd>
                        {formatReportedStatus(
                          reliability.data?.accessibilityServiceState,
                        )}
                      </dd>
                    </div>
                    <div>
                      <dt>Launch after boot</dt>
                      <dd>
                        {reliability.data?.bootLaunchVerified
                          ? "Verified"
                          : reportsAutostart(reliability.data)
                            ? // Linux has no boot-attempt counter; the autostart row
                              // below carries the detail.
                              "Not yet verified"
                            : `${formatReportedCount(reliability.data?.bootAttemptCount)} attempts · not verified`}
                      </dd>
                    </div>
                    {reportsAutostart(reliability.data) && (
                      <div>
                        <dt>Autostart (systemd)</dt>
                        <dd>{autostartSummary(reliability.data)}</dd>
                      </div>
                    )}
                    <div>
                      <dt>Cached fallback</dt>
                      <dd>
                        {reliability.data?.cachedFallbackAvailable
                          ? "Available"
                          : "Not confirmed"}
                      </dd>
                    </div>
                    {isAndroidScreen(screen.platform) && (
                      <div>
                        <dt>Install permission</dt>
                        <dd>
                          {formatReportedStatus(screen.installPermissionStatus)}
                        </dd>
                      </div>
                    )}
                    <div>
                      <dt>Free storage</dt>
                      <dd>
                        {screen.availableStorageBytes == null
                          ? "Not reported"
                          : formatBytes(screen.availableStorageBytes)}
                      </dd>
                    </div>
                    <div>
                      <dt>Last healthy playback</dt>
                      <dd>
                        {reliability.data?.lastHealthyPlaybackAt
                          ? new Date(
                              reliability.data.lastHealthyPlaybackAt,
                            ).toLocaleString()
                          : "Not reported"}
                      </dd>
                    </div>
                    <div>
                      <dt>Update readiness</dt>
                      <dd>
                        {formatReportedStatus(
                          reliability.data?.updateReadiness,
                        )}
                      </dd>
                    </div>
                    {screen.platform.toLowerCase() === "linux" && (
                      <>
                        <div>
                          <dt>Display Control</dt>
                          <dd>
                            {reliability.data?.displayControlProvider
                              ? `${reliability.data.displayControlProvider} · ${Object.keys(reliability.data.displayControlCapabilities ?? {}).length} capabilities`
                              : "Not reported"}
                          </dd>
                        </div>
                        <div>
                          <dt>Display state</dt>
                          <dd>
                            {formatReportedStatus(
                              reliability.data?.displayPowerState,
                            )}
                            {reliability.data
                              ?.displayControlLastCommandResult ===
                              "display_command_sent" &&
                            reliability.data?.displayPowerStateConfirmed ===
                              false
                              ? " · command sent, not confirmed"
                              : ""}
                            {reliability.data?.displayControlPolicyState ===
                            "powered_off_by_policy"
                              ? " · powered off by policy"
                              : ""}
                          </dd>
                        </div>
                        <div>
                          <dt>Last display command</dt>
                          <dd>
                            {reliability.data?.displayControlLastCommandState
                              ? `${formatReportedStatus(reliability.data.displayControlLastCommandState)}${reliability.data.displayControlLastCommandResult ? ` · ${reliability.data.displayControlLastCommandResult}` : ""}`
                              : "Not reported"}
                          </dd>
                        </div>
                        <div>
                          <dt>AirPlay Present</dt>
                          <dd>
                            {reliability.data?.airplaySupported
                              ? `Ready · ${reliability.data.airplayMaxProfile ?? "profile pending"}`
                              : "Not ready"}
                          </dd>
                        </div>
                        <div>
                          <dt>AirPlay decoder</dt>
                          <dd>
                            {reliability.data?.airplayDecoder ?? "Not reported"}
                            {reliability.data?.airplayHardwareDecode
                              ? " · hardware"
                              : " · software-limited"}
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
                    <dt>Reliability mode</dt>
                    <dd>
                      {formatReportedStatus(reliability.data?.configuredMode)}{" "}
                      configured ·{" "}
                      {formatReportedStatus(reliability.data?.effectiveMode)}{" "}
                      effective
                    </dd>
                  </div>
                  <div>
                    <dt>Foreground</dt>
                    <dd>
                      {formatReportedStatus(reliability.data?.foregroundState)}
                    </dd>
                  </div>
                  <div>
                    <dt>Boot recovery</dt>
                    <dd>
                      {formatReportedStatus(
                        reliability.data?.bootRecoveryResult,
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Immersive / keep awake</dt>
                    <dd>
                      {reliability.data?.immersiveModeActive
                        ? "Immersive"
                        : "Not immersive"}{" "}
                      ·{" "}
                      {reliability.data?.keepScreenOn
                        ? "Kept awake"
                        : "Wake lock released"}
                    </dd>
                  </div>
                  {isAndroidScreen(screen.platform) && (
                    <>
                      <div>
                        <dt>Managed Kiosk</dt>
                        <dd>
                          {formatReportedStatus(
                            reliability.data?.managedKioskCapability,
                          )}{" "}
                          · lock task{" "}
                          {formatReportedStatus(
                            reliability.data?.lockTaskState,
                            "unknown",
                          )}
                        </dd>
                      </div>
                      <div>
                        <dt>Accessibility Control</dt>
                        <dd>
                          {formatReportedStatus(
                            reliability.data?.accessibilityServiceState,
                          )}
                        </dd>
                      </div>
                    </>
                  )}
                  <div>
                    <dt>Active hours</dt>
                    <dd>
                      {formatReportedStatus(reliability.data?.activeHoursState)}
                    </dd>
                  </div>
                  <div>
                    <dt>Sleep support</dt>
                    <dd>
                      {formatReportedStatus(reliability.data?.sleepCapability)}
                    </dd>
                  </div>
                  <div>
                    <dt>Recovery</dt>
                    <dd>
                      Level{" "}
                      {formatReportedCount(reliability.data?.recoveryLevel)} ·{" "}
                      {formatReportedCount(reliability.data?.recoveryCount)}{" "}
                      recent · safe mode{" "}
                      {reliability.data?.safeMode ? "active" : "inactive"}
                    </dd>
                  </div>
                  <div>
                    <dt>Maintenance session</dt>
                    <dd>
                      {reliability.data?.maintenanceSessionExpiresAt
                        ? `Until ${new Date(reliability.data.maintenanceSessionExpiresAt).toLocaleString()}`
                        : "Inactive"}
                    </dd>
                  </div>
                </dl>
                {reliabilityCapabilityWarning(reliability.data) && (
                  <Alert>
                    <AlertDescription>
                      {reliabilityCapabilityWarning(reliability.data)}
                    </AlertDescription>
                  </Alert>
                )}
                {autostartWarning(reliability.data) && (
                  <Alert>
                    <AlertDescription>
                      {autostartWarning(reliability.data)}
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
                            Player controls
                          </h4>
                          <p className="text-sm text-muted-foreground">
                            Run a focused recovery action without leaving this
                            screen.
                          </p>
                        </div>
                        {command.isPending && <Badge>Sending…</Badge>}
                      </header>
                      <div className="grid gap-3 p-4 md:grid-cols-2">
                        {isAndroidScreen(screen.platform) && (
                          <div className="space-y-3 rounded-xl border border-border p-4">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                Power Assist
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                Test Android sleep and wake behavior.
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
                                Test sleep
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
                                Test wake
                              </Button>
                            </div>
                          </div>
                        )}
                        <div className="space-y-3 rounded-xl border border-border p-4">
                          <div className="space-y-0.5">
                            <h5 className="text-sm font-medium">Recovery</h5>
                            <p className="text-sm text-muted-foreground">
                              Retry recovery or leave safe mode after resolving
                              a fault.
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
                              Retry recovery
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
                              Exit safe mode
                            </Button>
                          </div>
                        </div>
                        {reportsAutostart(reliability.data) && (
                          <div className="space-y-3 rounded-xl border border-border p-4">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                Linux autostart
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                Installs the player's own systemd user service
                                so it starts with the graphical session and
                                restarts after any exit. Setting up is safe
                                while the player is running: Tilecast captures
                                this AppImage's display, data directory, and
                                server address, writes and enables the service,
                                and does not start a duplicate process. The
                                current manual process keeps running until the
                                next controlled restart, session restart, or
                                reboot, when systemd takes ownership. A service
                                file you wrote yourself is never overwritten. A
                                graphical session that begins at boot
                                (auto-login or a kiosk compositor) remains
                                operating-system setup.
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
                                Set up autostart
                              </Button>
                              <Button
                                variant="outline"
                                disabled={command.isPending}
                                onClick={() =>
                                  requestScreenCommand({
                                    kind: "confirm",
                                    title: "Remove player autostart?",
                                    description:
                                      "This screen will keep playing now, but will not return on its own after a reboot or a player update.",
                                    confirmLabel: "Remove autostart",
                                    destructive: true,
                                    commandType: "remove_autostart",
                                    payload: {},
                                  })
                                }
                              >
                                Remove autostart
                              </Button>
                            </div>
                          </div>
                        )}
                        {screen.platform.toLowerCase() === "linux" && (
                          <div className="space-y-3 rounded-xl border border-border p-4 md:col-span-2">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                Display Control
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                Player connectivity and display power are
                                separate states. Controls appear only for
                                capabilities reported by this player; provider
                                commands have a bounded timeout and may report
                                sent without a confirmed panel state.
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
                                    Power on display
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
                                    Power off display
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
                                      title: "Set display input",
                                      description:
                                        "Enter the CEC physical address reported by the display, for example 1.0.0.0.",
                                      confirmLabel: "Set input",
                                      input: {
                                        label: "CEC physical address",
                                        type: "text",
                                        placeholder: "1.0.0.0",
                                      },
                                      commandType: "display_set_input",
                                      createPayload: (input) => ({ input }),
                                    })
                                  }
                                >
                                  Set display input
                                </Button>
                              )}
                              {displayCapabilities.volume && (
                                <Button
                                  variant="outline"
                                  disabled={command.isPending}
                                  onClick={() =>
                                    requestScreenCommand({
                                      kind: "input",
                                      title: "Set display volume",
                                      description:
                                        "Choose a whole-number volume from 0 to 100.",
                                      confirmLabel: "Set volume",
                                      input: {
                                        label: "Volume",
                                        type: "number",
                                        min: 0,
                                        max: 100,
                                      },
                                      commandType: "display_set_volume",
                                      createPayload: (volume) => ({ volume }),
                                    })
                                  }
                                >
                                  Set display volume
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
                                    Mute display
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
                                    Unmute display
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
                                      title: "Set display brightness",
                                      description:
                                        "Choose a whole-number brightness from 0 to 100.",
                                      confirmLabel: "Set brightness",
                                      input: {
                                        label: "Brightness",
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
                                  Set display brightness
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
                                Probe display capabilities
                              </Button>
                              {!hasDisplayControl && (
                                <span className="text-sm text-muted-foreground">
                                  No HDMI-CEC or DDC/CI capability is currently
                                  reported.
                                </span>
                              )}
                            </div>
                          </div>
                        )}
                        {screen.platform.toLowerCase() === "linux" && (
                          <div className="space-y-3 rounded-xl border border-border p-4">
                            <div className="space-y-0.5">
                              <h5 className="text-sm font-medium">
                                AirPlay diagnostics
                              </h5>
                              <p className="text-sm text-muted-foreground">
                                Probe UxPlay, GStreamer, VA-API, audio, and
                                local Avahi support without advertising a
                                receiver.
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
                                Test AirPlay support
                              </Button>
                            </div>
                          </div>
                        )}
                        <div className="space-y-3 rounded-xl border border-border p-4 md:col-span-2">
                          <div className="space-y-0.5">
                            <h5 className="text-sm font-medium">
                              Playback and player
                            </h5>
                            <p className="text-sm text-muted-foreground">
                              Use the least disruptive action that matches the
                              problem.
                            </p>
                          </div>
                          <div className="grid grid-cols-2 gap-2 max-sm:grid-cols-1 lg:grid-cols-4 [&_button]:h-auto [&_button]:min-h-10 [&_button]:whitespace-normal [&_button]:py-2 [&_button]:text-center">
                            {(
                              [
                                ["retry_current_item", "Retry item"],
                                ["skip_current_item", "Skip item"],
                                ["recreate_renderer", "Recreate renderer"],
                                [
                                  "recreate_playback_session",
                                  "Recreate session",
                                ],
                                ["restart_activity", "Restart activity"],
                                ["restart_player_process", "Restart player"],
                                ["resynchronize_player", "Resynchronize"],
                                ["run_player_self_test", "Run self-test"],
                              ] as const
                            ).map(([type, label]) => (
                              <Button
                                variant="outline"
                                key={type}
                                disabled={command.isPending}
                                onClick={() =>
                                  command.mutate({ type, payload: {} })
                                }
                              >
                                {label}
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
                  <h3 className="text-sm font-semibold">Maintenance</h3>
                  <p className="text-sm text-muted-foreground">
                    Commands remain pending during brief disconnections and
                    expire automatically.
                  </p>
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="outline"
                      onClick={() =>
                        command.mutate({ type: "sync_now", payload: {} })
                      }
                    >
                      Sync now
                    </Button>
                    <Button
                      variant="outline"
                      onClick={() =>
                        command.mutate({ type: "reload_playback", payload: {} })
                      }
                    >
                      Reload playback
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
                      Identify screen
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        requestScreenCommand({
                          kind: "confirm",
                          title: "Clear unprotected media?",
                          description:
                            "Tilecast will remove cached media that active or pending playback does not protect.",
                          confirmLabel: "Clear media cache",
                          destructive: true,
                          commandType: "clear_media_cache",
                          payload: {},
                        })
                      }
                    >
                      Clear media cache
                    </Button>
                    <Button
                      variant="destructive"
                      onClick={() =>
                        requestScreenCommand({
                          kind: "confirm",
                          title: "Clear website data?",
                          description:
                            "This clears cookies, cache, DOM storage, and WebView state for this player.",
                          confirmLabel: "Clear website data",
                          destructive: true,
                          commandType: "clear_website_data",
                          payload: {},
                        })
                      }
                    >
                      Clear website data
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
                            title: "Disable ordinary playback?",
                            description:
                              "The player will remain paired and connected, but ordinary scheduled playback will stop.",
                            confirmLabel: "Disable playback",
                            destructive: true,
                            commandType: "disable_playback",
                            payload: {},
                          });
                        }
                      }}
                    >
                      {assignment.data?.playbackDisabled
                        ? "Enable playback"
                        : "Disable playback"}
                    </Button>
                  </div>
                  {command.isSuccess && (
                    <p className="text-sm text-muted-foreground">
                      Command queued; this does not mean it has completed.
                    </p>
                  )}
                  <div className="grid gap-2">
                    {commands.data?.items?.map((c) => (
                      <div
                        key={c.id}
                        className="space-y-0.5 rounded-lg border border-border px-3 py-2"
                      >
                        <p className="text-sm font-medium">
                          {c.type?.replaceAll("_", " ") ?? "Unknown command"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {c.state} · {new Date(c.createdAt).toLocaleString()}
                        </p>
                        <p className="text-xs text-muted-foreground">
                          {c.resultCode?.replaceAll("_", " ") ??
                            "No result yet"}
                        </p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            {manageSection === "maintenance" &&
              !canManageScreens(auth.status?.user) && (
                <section className="space-y-3">
                  <h3 className="text-sm font-semibold">Recent operations</h3>
                  {commands.isLoading ? (
                    <div className="space-y-2">
                      <Skeleton className="h-4 w-56" />
                      <p className="text-sm text-muted-foreground">
                        Loading operations…
                      </p>
                    </div>
                  ) : (commands.data?.items?.length ?? 0) === 0 ? (
                    <p>
                      No maintenance commands have been sent to this screen. An
                      Owner or Administrator can send them.
                    </p>
                  ) : (
                    <div className="grid gap-2">
                      {commands.data?.items?.map((c) => (
                        <div
                          key={c.id}
                          className="space-y-0.5 rounded-lg border border-border px-3 py-2"
                        >
                          <p className="text-sm font-medium">
                            {c.type?.replaceAll("_", " ") ?? "Unknown command"}
                          </p>
                          <p className="text-sm text-muted-foreground">
                            {c.state} · {new Date(c.createdAt).toLocaleString()}
                          </p>
                          <p className="text-xs text-muted-foreground">
                            {c.resultCode?.replaceAll("_", " ") ??
                              "No result yet"}
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
                      Device details
                    </h3>
                    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                      <OverviewFact
                        label="Hardware"
                        value={
                          `${screen.deviceManufacturer ?? ""} ${screen.deviceModel ?? ""}`.trim() ||
                          "Not reported"
                        }
                      />
                      <OverviewFact
                        label="Platform"
                        value={
                          screen.platform === "linux"
                            ? "Linux"
                            : `${formatReportedStatus(screen.platform)} ${screen.androidVersion ?? ""}`.trim()
                        }
                      />
                      <OverviewFact
                        label="Player version"
                        value={`${screen.playerVersion ?? "Not reported"}${screen.playerVersionCode ? ` (code ${screen.playerVersionCode})` : ""}`}
                      />
                      {isAndroidScreen(screen.platform) && (
                        <>
                          <OverviewFact
                            label="Android SDK"
                            value={screen.androidSdk ?? "Not reported"}
                          />
                          <OverviewFact
                            label="Installer source"
                            value={screen.installerSource ?? "Not reported"}
                          />
                          <OverviewFact
                            label="Install permission"
                            value={
                              screen.installPermissionStatus?.replaceAll(
                                "_",
                                " ",
                              ) ?? "Unknown"
                            }
                          />
                        </>
                      )}
                      <OverviewFact
                        label="Player update"
                        value={`${screen.updateState?.replaceAll("_", " ") ?? "No active deployment"}${screen.updateExpectedBytes ? ` · ${Math.round(((screen.updateDownloadedBytes ?? 0) / screen.updateExpectedBytes) * 100)}%` : ""}${screen.updateError ? ` · ${screen.updateError}` : ""}`}
                      />
                      <OverviewFact
                        label="Resolution"
                        value={`${screen.screenWidth ?? "Not reported"} × ${screen.screenHeight ?? "Not reported"}`}
                      />
                      <OverviewFact
                        label="Locale"
                        value={screen.locale || "Not reported"}
                      />
                      <OverviewFact
                        label="Timezone"
                        value={screen.timezone || "Not reported"}
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
                      Connection
                    </h3>
                    <dl className="grid gap-x-5 gap-y-4 sm:grid-cols-2">
                      <OverviewFact
                        label="Status"
                        value={<StatusLabel status={screen.status} />}
                      />
                      <OverviewFact
                        label="Last contact"
                        value={formatContact(screen.lastContactAt)}
                      />
                      <OverviewFact
                        label="Network address"
                        value={screen.lastKnownIp || "Not reported"}
                      />
                      <OverviewFact
                        label="Credential"
                        value={
                          screen.hasActiveCredential ? "Active" : "Revoked"
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
                        Player access
                      </h3>
                      <p className="mt-1 text-sm text-muted-foreground">
                        Control whether this player may operate and whether its
                        credential remains valid.
                      </p>
                    </header>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div>
                        <p className="text-sm font-medium">
                          {screen.enabled
                            ? "Screen enabled"
                            : "Screen disabled"}
                        </p>
                        <p className="text-sm text-muted-foreground">
                          {screen.enabled
                            ? "Disabling temporarily blocks operation and keeps the pairing."
                            : "Enabling allows the paired player to reconnect."}
                        </p>
                      </div>
                      <Button
                        variant="outline"
                        onClick={() => stateMutation.mutate(!screen.enabled)}
                        disabled={stateMutation.isPending}
                      >
                        {stateMutation.isPending
                          ? "Saving…"
                          : screen.enabled
                            ? "Disable"
                            : "Enable"}
                      </Button>
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-4">
                      <div>
                        <p className="text-sm font-medium">Revoke pairing</p>
                        <p className="text-sm text-muted-foreground">
                          Permanently invalidates the device credential. The
                          player must pair again.
                        </p>
                      </div>
                      <Button
                        variant="destructive"
                        onClick={() => setConfirmRevoke(true)}
                        disabled={!screen.hasActiveCredential}
                      >
                        Revoke pairing
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
            <DialogTitle>Discard unsaved screen settings?</DialogTitle>
            <DialogDescription>
              Your screen policy edits have not been saved. Discard them and
              continue?
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setPendingDestination(null)}
            >
              Keep editing
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (pendingDestination) commitDestination(pendingDestination);
              }}
            >
              Discard changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Revoke pairing for {screen.name}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              The player will disconnect immediately and cannot reconnect
              without a new pairing approval.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={revoke.isPending}>
              Cancel
            </AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              Revoke pairing
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
                : "Confirm action"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {screenCommandAction?.kind === "confirm"
                ? screenCommandAction.description
                : "Review this action before continuing."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={command.isPending}>
              Cancel
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
                : "Continue"}
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
                  Cancel
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
  const { label, Icon } = statusContent[status] ?? {
    label: "Unknown",
    Icon: CircleAlert,
  };
  const variant =
    status === "offline" || status === "stale"
      ? "destructive"
      : status === "recent"
        ? "secondary"
        : "outline";
  return (
    <Badge variant={variant} className="gap-1.5">
      <Icon aria-hidden="true" />
      {label}
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

function formatContact(value?: string) {
  if (!value) return "Never";
  const seconds = Math.max(
    0,
    Math.round((Date.now() - new Date(value).getTime()) / 1000),
  );
  if (seconds < 60) return "Just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} hr ago`;
  return new Date(value).toLocaleDateString();
}
