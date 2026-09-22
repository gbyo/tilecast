import {
  Button,
  ContextMenu,
  Dialog,
  HoldButton,
  Notice,
  PageHeader,
  Popover,
  Select,
  ToggleGroup,
  ViewTabs,
  useContextMenu,
  type ContextMenuItem,
} from "../components/ui";
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
  RefreshCw,
  ShieldAlert,
  ShieldOff,
  Search,
  SlidersHorizontal,
  TriangleAlert,
  Wifi,
  WifiOff,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useForm } from "react-hook-form";
import { Link, useNavigate, useParams, useSearchParams } from "react-router";
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
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
import { ScreenContentChain } from "../content/ScreenContentChain";
import { AirPlayPresentDialog } from "../components/AirPlayPresentDialog";
import { ScreenPresentationNetworkPanel } from "../components/ScreenPresentationNetworkPanel";
import { QuickPresentDialog } from "../components/QuickPresentDialog";
import { FormField } from "../components/FormField";
import { FireTvAccessibilityAdbPanel } from "../components/FireTvAccessibilityAdbPanel";
import { ScreenManagementTabs } from "../components/ScreenManagementTabs";
import { PlayerPolicyEditor } from "../settings/PlayerPolicyEditor";
import { formatLocationAddress } from "../settings/LocationsPanel";
import { isAndroidScreen } from "../playerPlatform";
import { previewApi } from "../api/previews";
import { previewAge } from "../components/livePreviewState";

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
  if (requestedTab === "player-settings") return "settings";
  if (requestedTab === "reliability") return "health";
  if (requestedTab === "commands") return "maintenance";
  return screenManageSections.includes(requestedSection as ScreenManageSection)
    ? (requestedSection as ScreenManageSection)
    : "settings";
}

export type ScreenDetailTab =
  "overview" | "snapshots" | "content" | "activity" | "manage";

const screenDetailTabs: readonly ScreenDetailTab[] = [
  "overview",
  "snapshots",
  "content",
  "activity",
  "manage",
];

// Legacy tabs collapsed into Manage; each maps to a section via
// normalizeScreenManageSection.
const legacyManageTabs = ["player-settings", "reliability", "commands"];

export function normalizeScreenDetailTab(
  requestedTab: string | null,
): ScreenDetailTab {
  if (!requestedTab) return "overview";
  if (legacyManageTabs.includes(requestedTab)) return "manage";
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
  return (
    <label className="field">
      <span className="field__label">Location (optional)</span>
      <Select
        value={value ?? ""}
        onChange={(event) => onChange(event.target.value || undefined)}
      >
        <option value="">Unassigned</option>
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name}
            {formatLocationAddress(location)
              ? ` — ${formatLocationAddress(location)}`
              : ""}
          </option>
        ))}
      </Select>
      {selected && formatLocationAddress(selected) && (
        <small>{formatLocationAddress(selected)}</small>
      )}
      <Link
        className="text-link location-picker__create"
        to="/settings/locations"
      >
        Create new location
      </Link>
    </label>
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
    <div className="screens-page">
      <PageHeader
        title="Screens"
        description="Pair and monitor the players driving every screen in this installation."
        actions={
          manageable && <TakeoverAction screens={screens.data?.items ?? []} />
        }
      />
      <ScreenManagementTabs current="screens" />
      <ActiveTakeoverBanners canManage={manageable} />
      {screens.isError && (
        <div className="notice notice--error">{screens.error.message}</div>
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
  const { confirm, prompt } = useSpectrumDialogs();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const takeovers = useTakeovers();
  const cancel = useMutation({
    mutationFn: ({ id, reason }: { id: string; reason: string }) =>
      api.cancelTakeover(id, reason, auth.status?.csrfToken ?? ""),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["takeovers"] }),
  });
  const active = (takeovers.data?.items ?? []).filter(
    (item) => item.status === "active",
  );
  if (active.length === 0) return null;
  return (
    <div className="takeover-banners">
      {active.map((item) => (
        <Notice
          key={item.id}
          variant="danger"
          title={`Takeover active — ${item.name}`}
          action={
            canManage ? (
              <button
                className="button button--danger"
                type="button"
                onClick={async () => {
                  if (!(await confirm({
                    title: "End this takeover?",
                    description:
                      "Scheduled or fallback playback will resume on the targeted screens.",
                    confirmLabel: "End takeover",
                    tone: "negative",
                  }))) return;
                  const reason = (await prompt({
                    title: "Cancellation reason",
                    description: "Optionally record why this takeover ended.",
                    label: "Reason",
                    confirmLabel: "End takeover",
                  })) ?? "";
                  cancel.mutate({ id: item.id, reason });
                }}
              >
                End takeover
              </button>
            ) : undefined
          }
        >
          {item.playlistName} is overriding scheduled and fallback content until{" "}
          {new Date(item.expiresAt).toLocaleString()}.
          <ul className="takeover-banner__counts">
            <li>{item.activeCount} playing</li>
            <li>{item.preparingCount} preparing</li>
            <li>{item.failedCount} failed</li>
            <li>{item.affectedCount} targeted</li>
          </ul>
        </Notice>
      ))}
    </div>
  );
}

function TakeoverAction({ screens }: { screens: Screen[] }) {
  const { confirm, prompt } = useSpectrumDialogs();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
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
      setOpen(false);
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
  const beginActivation = async (confirmed: boolean) => {
    const requiresPassword = Boolean(
      runtimeSettings.data?.values["takeover.reauthentication_required"],
    );
    const password = requiresPassword
      ? (await prompt({
          title: "Confirm your current password",
          description:
            "Your password is required by the installation's takeover policy.",
          label: "Current password",
          type: "password",
          confirmLabel: "Continue",
        })) ?? ""
      : "";
    if (requiresPassword && !password) return;
    // A completed three-second hold already is the confirmation, so it does not
    // also raise a dialog.
    if (
      confirmed ||
      await confirm({
        title: "Activate this takeover?",
        description:
          "The selected playlist will replace existing overlapping takeovers for these targets.",
        confirmLabel: "Activate takeover",
        tone: "negative",
      })
    )
      activate.mutate(password);
  };
  return (
    <>
      <button
        className="button button--danger-quiet takeover-trigger"
        type="button"
        aria-haspopup="dialog"
        onClick={() => setOpen(true)}
      >
        <ShieldAlert size={16} aria-hidden="true" />
        Takeover
        {activeCount > 0 && (
          <span className="takeover-trigger__count">{activeCount} active</span>
        )}
      </button>
      <Dialog
        open={open}
        title="Takeover"
        className="takeover-dialog"
        onClose={() => setOpen(false)}
      >
        <p className="takeover-dialog__lede">
          Temporarily override schedules and fallback content on the selected
          screens. Existing overlapping takeovers are replaced.
        </p>
        <div className="takeover-form">
          <label className="field">
            <span className="field__label">Takeover name</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              maxLength={180}
            />
          </label>
          <label className="field">
            <span className="field__label">Playlist</span>
            <Select
              value={playlistId}
              onChange={(event) => setPlaylistId(event.target.value)}
            >
              <option value="">Select playlist</option>
              {playlists.data?.items?.map((playlist) => (
                <option key={playlist.id} value={playlist.id}>
                  {playlist.name}
                </option>
              ))}
            </Select>
          </label>
          <label className="field">
            <span className="field__label">Expires in</span>
            <Select
              value={minutes}
              onChange={(event) => setMinutes(Number(event.target.value))}
            >
              <option value={15}>15 minutes</option>
              <option value={60}>1 hour</option>
              <option value={240}>4 hours</option>
              <option value={1440}>24 hours</option>
            </Select>
          </label>
          <fieldset className="takeover-form__targets">
            <legend>Target screens</legend>
            <div className="takeover-form__targets-actions">
              <button
                className="button button--quiet button--compact"
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
              </button>
              <span>
                {screens.length} screen{screens.length === 1 ? "" : "s"} in the
                fleet
              </span>
            </div>
            <div>
              {screens.map((item) => (
                <label className="checkbox-control" key={item.id}>
                  <input
                    type="checkbox"
                    checked={screenIds.includes(item.id)}
                    onChange={(event) =>
                      setScreenIds((ids) =>
                        event.target.checked
                          ? [...ids, item.id]
                          : ids.filter((id) => id !== item.id),
                      )
                    }
                  />
                  <span>
                    {item.name}
                    <small>{statusLabel(item.status)}</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <fieldset className="takeover-form__targets">
            <legend>Target Display Groups</legend>
            <div>
              {groups.data?.items?.map((group) => (
                <label className="checkbox-control" key={group.id}>
                  <input
                    type="checkbox"
                    checked={groupIds.includes(group.id)}
                    onChange={(event) =>
                      setGroupIds((ids) =>
                        event.target.checked
                          ? [...ids, group.id]
                          : ids.filter((id) => id !== group.id),
                      )
                    }
                  />
                  <span>
                    {group.name}
                    <small>{group.membershipCount} screens</small>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
        </div>
        <footer className="takeover-dialog__footer">
          <p>
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
          <div className="takeover-dialog__actions">
            <button
              className="button button--quiet"
              type="button"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
            {everyScreenSelected ? (
              <HoldButton
                className="button--danger"
                holdMs={3000}
                disabled={!ready || activate.isPending}
                holdingLabel="Keep holding…"
                hint="Hold for 3 seconds to take over every screen."
                onHoldComplete={() => beginActivation(true)}
              >
                {activate.isPending
                  ? "Activating…"
                  : "Hold to activate takeover"}
              </HoldButton>
            ) : (
              <button
                className="button button--danger"
                type="button"
                disabled={!ready || activate.isPending}
                onClick={() => beginActivation(false)}
              >
                {activate.isPending ? "Activating…" : "Activate takeover"}
              </button>
            )}
          </div>
        </footer>
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
  const navigate = useNavigate();
  const menu = useContextMenu<Screen>();
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
    await Promise.all(
      [...selected].map((id) =>
        api.createScreenCommand(id, "restart_player_process", {}, csrfToken),
      ),
    );
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
  const actionsFor = (screen: Screen): ContextMenuItem[] => [
    {
      label: "Preview",
      icon: <Monitor size={15} />,
      onSelect: () => void navigate(`/screens/${screen.id}`),
    },
    {
      label: "Open details",
      onSelect: () => void navigate(`/screens/${screen.id}`),
    },
    ...(canManage
      ? [
          {
            label: "Restart player",
            onSelect: () =>
              void api.createScreenCommand(
                screen.id,
                "restart_player_process",
                {},
                csrfToken,
              ),
          },
          {
            label: "Edit",
            icon: <Pencil size={15} />,
            onSelect: () => navigate(`/screens/${screen.id}?edit=details`),
          },
          {
            label: "Assign content",
            onSelect: () => navigate(`/screens/${screen.id}?tab=content`),
          },
          {
            label: "Show now",
            onSelect: () => navigate(`/screens/${screen.id}?present=1`),
          },
          {
            label: screen.syncGroupId
              ? "Open Display Group"
              : "Add to Display Group",
            onSelect: () =>
              navigate(
                screen.syncGroupId
                  ? `/groups/${screen.syncGroupId}`
                  : "/groups",
              ),
          },
        ]
      : []),
  ];
  if (loading) return <div className="table-loading">Loading screens…</div>;
  if (screens.length === 0)
    return (
      <section className="screen-empty">
        <span className="empty-illustration">
          <Monitor size={29} />
        </span>
        <h3>No screens paired</h3>
        <p>
          Install Tilecast Player on a TV device, connect it to this server,
          then enter the pairing code shown on the TV.
        </p>
        {canManage ? (
          <Link className="button button--primary" to="/screens/pair">
            Pair your first screen
          </Link>
        ) : (
          <p className="permission-note">
            An Owner or Administrator can approve new screens.
          </p>
        )}
      </section>
    );
  return (
    <section className="screen-workspace" aria-label="Paired screens">
      <ScreenSummary screens={screens} status={status} onStatus={setStatus} />
      {/* One controls block, three deliberate bands: filters on the left, presentation
          utilities right-aligned, then the active-filter chips underneath. Filtering and
          presentation used to be interleaved, which is why the row order matters here. */}
      <div className="screen-controls">
        <div
          className="screen-toolbar"
          role="group"
          aria-label="Filter screens"
        >
          <label className="screen-search">
            <Search size={16} aria-hidden="true" />
            <span className="visually-hidden">Filter screens</span>
            <input
              type="search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Name, room, location, or content"
            />
          </label>
          <FilterSelect label="Status" value={status} onChange={setStatus}>
            <option value="">All statuses</option>
            <option value="online">Online</option>
            <option value="offline">Offline</option>
            <option value="attention">Needs attention</option>
            <option value="updating">Updating</option>
            <option value="syncing">Syncing</option>
          </FilterSelect>
          <FilterSelect
            label="Location"
            value={location}
            onChange={setLocation}
          >
            <option value="">All locations</option>
            {locationItems.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </FilterSelect>
          <FilterSelect
            label="Platform"
            value={platform}
            onChange={setPlatform}
          >
            <option value="">All platforms</option>
            {[...new Set(screens.map((item) => item.platform))]
              .sort()
              .map((item) => (
                <option value={item} key={item}>
                  {platformLabel(item)}
                </option>
              ))}
          </FilterSelect>
          <FilterSelect
            label="Now playing"
            value={playing}
            onChange={setPlaying}
          >
            <option value="">Any content</option>
            <option value="presentation">Presentation</option>
            <option value="playlist">Playlist</option>
            <option value="nothing">Nothing assigned</option>
          </FilterSelect>
          <Popover
            label="More screen filters"
            className="screen-more-filters"
            width="16rem"
            align="end"
            trigger={(props) => (
              <button
                type="button"
                className="signal-popover__filter-trigger"
                {...props}
              >
                <SlidersHorizontal size={15} aria-hidden="true" />
                More filters
                {advancedFilterCount > 0 && (
                  <span className="signal-popover__count">
                    {advancedFilterCount}
                  </span>
                )}
              </button>
            )}
          >
            <FilterSelect
              label="Display Group"
              value={syncGroup}
              onChange={setSyncGroup}
              block
            >
              <option value="">All screens</option>
              <option value="any">In any Display Group</option>
              <option value="none">Not in a Display Group</option>
              {[
                ...new Map(
                  screens
                    .filter((item) => item.syncGroupId)
                    .map((item) => [item.syncGroupId, item.syncGroupName]),
                ).entries(),
              ].map(([id, name]) => (
                <option value={id} key={id}>
                  {name}
                </option>
              ))}
            </FilterSelect>
            <FilterSelect
              label="Orientation"
              value={orientation}
              onChange={setOrientation}
              block
            >
              <option value="">Any orientation</option>
              <option value="landscape">Landscape</option>
              <option value="portrait">Portrait</option>
            </FilterSelect>
            <FilterSelect
              label="Software update"
              value={update}
              onChange={setUpdate}
              block
            >
              <option value="">Any update status</option>
              <option value="current">Current</option>
              <option value="downloading">Downloading</option>
              <option value="attention">Needs attention</option>
            </FilterSelect>
          </Popover>
        </div>
        {anyFilterActive && (
          <div className="screen-filter-chips">
            <span className="screen-filter-chips__label">
              {filtered.length} of {screens.length} screens
            </span>
            {chippedFilters.map((filter) => (
              <button
                type="button"
                className="filter-chip"
                key={filter.facet}
                aria-label={`Remove filter ${filter.facet}: ${filter.value}`}
                onClick={filter.remove}
              >
                <strong>{filter.facet}:</strong>
                <span>{filter.value}</span>
                <X size={13} aria-hidden="true" />
              </button>
            ))}
            <button
              type="button"
              className="screen-filter-clear"
              onClick={clearFilters}
            >
              Clear all
            </button>
          </div>
        )}
        <div
          className="screen-view-controls"
          role="group"
          aria-label="Presentation"
        >
          <FilterSelect label="Group by" value={groupBy} onChange={setGroupBy}>
            <option value="location">Group by location</option>
            <option value="status">Group by status</option>
            <option value="sync">Group by Display Group</option>
            <option value="none">No grouping</option>
          </FilterSelect>
          <FilterSelect label="Sort" value={sort} onChange={setSort}>
            <option value="name-asc">Screen name · A–Z</option>
            <option value="name-desc">Screen name · Z–A</option>
            <option value="location-asc">Location · A–Z</option>
            <option value="status-asc">Status</option>
            <option value="contact-desc">Last contact · newest</option>
            <option value="contact-asc">Last contact · oldest</option>
            <option value="added-desc">Date added · newest</option>
            <option value="platform-asc">Platform</option>
          </FilterSelect>
          <ToggleGroup
            label="Screen view"
            value={view}
            onValueChange={setView}
            items={[
              {
                value: "table",
                label: (
                  <>
                    <List size={16} aria-hidden="true" /> Table
                  </>
                ),
              },
              {
                value: "grid",
                label: (
                  <>
                    <Grid2X2 size={16} aria-hidden="true" /> Previews
                  </>
                ),
              },
            ]}
          />
        </div>
      </div>
      {view === "grid" && (
        <p className="screen-results-hint">
          Previews show the latest snapshot reported by each player and refresh
          about every 30 seconds.
        </p>
      )}
      {selected.size > 0 && canManage && (
        <div className="screen-bulk-bar">
          <strong>{selected.size} selected</strong>
          <button type="button" onClick={() => void restartSelected()}>
            Restart
          </button>
          <FilterSelect
            label="Move selected screens to location"
            value={bulkLocation}
            onChange={setBulkLocation}
          >
            <option value="">Unassigned</option>
            {locationItems.map((item) => (
              <option value={item.id} key={item.id}>
                {item.name}
              </option>
            ))}
          </FilterSelect>
          <button type="button" onClick={() => void changeSelectedLocation()}>
            Change location
          </button>
          <button type="button" onClick={() => setSelected(new Set())}>
            Clear selection
          </button>
        </div>
      )}
      {locationsError && (
        <div className="notice notice--error">
          Location data failed to load. Screen names remain available.
        </div>
      )}
      {filtered.length === 0 ? (
        <div className="screen-empty screen-empty--compact">
          <Search size={24} />
          <h3>No screens match the current filters</h3>
          <p>Remove one or more filters to see screens again.</p>
          <button
            className="button button--quiet"
            type="button"
            onClick={clearFilters}
          >
            Clear filters
          </button>
        </div>
      ) : visibleGroups.every((group) => collapsed.has(group.key)) ? (
        <div className="screen-empty screen-empty--compact">
          <h3>All groups are collapsed</h3>
          <button
            className="button button--quiet"
            type="button"
            onClick={() => {
              setCollapsed(new Set());
              storageSet("session", "tilecast.screens.collapsed", "[]");
            }}
          >
            Expand all groups
          </button>
        </div>
      ) : (
        <div className={`screen-results screen-results--${view}`}>
          {visibleGroups.map((group) => {
            const isCollapsed = collapsed.has(group.key);
            const groupSelected = group.screens.every((screen) =>
              selected.has(screen.id),
            );
            return (
              <section className="screen-location-group" key={group.key}>
                {groupBy !== "none" && (
                  <header className="screen-group-header">
                    {/* The disclosure comes first so the chevron reads as "open this
                        group" rather than as a menu or a sort control on the title. */}
                    <button
                      className="screen-group-header__disclosure"
                      type="button"
                      aria-expanded={!isCollapsed}
                      aria-label={`${isCollapsed ? "Expand" : "Collapse"} ${group.label}`}
                      onClick={() => toggleCollapsed(group.key)}
                    >
                      {isCollapsed ? (
                        <ChevronRight size={16} aria-hidden="true" />
                      ) : (
                        <ChevronDown size={16} aria-hidden="true" />
                      )}
                    </button>
                    {canManage && (
                      <input
                        type="checkbox"
                        aria-label={`Select all screens in ${group.label}`}
                        checked={groupSelected}
                        onChange={(event) => {
                          const next = new Set(selected);
                          for (const screen of group.screens) {
                            if (event.target.checked) next.add(screen.id);
                            else next.delete(screen.id);
                          }
                          setSelected(next);
                        }}
                      />
                    )}
                    <span className="screen-group-header__title">
                      <strong>{group.label}</strong>
                      <span className="screen-group-header__count">
                        {group.screens.length}
                        <span className="visually-hidden">
                          {" "}
                          screen{group.screens.length === 1 ? "" : "s"}
                        </span>
                      </span>
                      {group.description && <small>{group.description}</small>}
                    </span>
                    <GroupHealth screens={group.screens} />
                  </header>
                )}
                {!isCollapsed && view === "table" && (
                  <div className="screen-table">
                    {/* "Actions" and the selection column carry visually hidden
                        labels: their text used to be wider than the columns that
                        hold them, which clipped the heading at desktop width. */}
                    <div className="screen-table__header">
                      <span>
                        <span className="visually-hidden">Select</span>
                      </span>
                      <span>Screen</span>
                      <span>Now playing</span>
                      <span>Status</span>
                      <span>
                        <span className="visually-hidden">Actions</span>
                      </span>
                    </div>
                    {group.screens.map((screen) => (
                      <ScreenTableRow
                        key={screen.id}
                        screen={screen}
                        selected={selected.has(screen.id)}
                        canManage={canManage}
                        showLocation={groupBy !== "location"}
                        onSelect={(checked) => {
                          const next = new Set(selected);
                          if (checked) next.add(screen.id);
                          else next.delete(screen.id);
                          setSelected(next);
                        }}
                        onOpen={() => void navigate(`/screens/${screen.id}`)}
                        onMenu={(event) => menu.open(event, screen)}
                      />
                    ))}
                  </div>
                )}
                {!isCollapsed && view === "grid" && (
                  <div className="screen-grid">
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
                        onOpen={() => void navigate(`/screens/${screen.id}`)}
                        onMenu={(event) => menu.open(event, screen)}
                      />
                    ))}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      )}
      {menu.anchor && (
        <ContextMenu
          x={menu.anchor.x}
          y={menu.anchor.y}
          label={`Actions for ${menu.anchor.target.name}`}
          items={actionsFor(menu.anchor.target)}
          onClose={menu.close}
        />
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

function FilterSelect({
  label,
  value,
  onChange,
  block,
  children,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  block?: boolean;
  children: ReactNode;
}) {
  return (
    <Select
      className={`screen-filter-select${block ? " screen-filter-select--block" : ""}`}
      aria-label={label}
      value={value}
      onChange={(event) => onChange(event.target.value)}
    >
      {children}
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
  // .summary-bar is the shared segmented metric readout. In a tile the count reads
  // as a measure rather than the sentence "0 need attention" ever did.
  return (
    <div
      className="summary-bar screen-summary"
      role="group"
      aria-label="Fleet summary"
    >
      <div className="summary-bar__item">
        <strong>{screens.length}</strong> <span>Screens</span>
      </div>
      <button
        className="summary-bar__item"
        type="button"
        aria-pressed={status === "online"}
        onClick={() => onStatus(status === "online" ? "" : "online")}
      >
        <strong>{online}</strong> <span>Online</span>
      </button>
      <button
        className={`summary-bar__item${attention > 0 ? " summary-bar__item--urgent" : ""}`}
        type="button"
        aria-pressed={status === "attention"}
        onClick={() => onStatus(status === "attention" ? "" : "attention")}
      >
        <strong>{attention}</strong> <span>Needs attention</span>
      </button>
      <div className="summary-bar__item">
        <strong>{locations}</strong>{" "}
        <span>Location{locations === 1 ? "" : "s"}</span>
      </div>
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
    <span className="screen-group-header__health">
      <span
        className={`screen-group-health screen-group-health--${online === screens.length ? "healthy" : "partial"}`}
      >
        {online} of {screens.length} online
      </span>
      {attention > 0 && (
        <span className="screen-group-health screen-group-health--attention">
          <CircleAlert size={13} aria-hidden="true" />
          {attention} {attention === 1 ? "needs" : "need"} attention
        </span>
      )}
      {syncGroups.size === 1 && (
        <span className="screen-group-health">
          <Link2 size={13} aria-hidden="true" />
          {[...syncGroups][0]}
        </span>
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

function screenMetadata(screen: Screen, showLocation: boolean) {
  return [
    showLocation ? screen.location : "",
    roomLabel(screen),
    platformLabel(screen.platform),
    `${screen.screenWidth}×${screen.screenHeight}`,
  ]
    .filter(Boolean)
    .join(" · ");
}

function ScreenTableRow({
  screen,
  selected,
  canManage,
  showLocation,
  onSelect,
  onOpen,
  onMenu,
}: {
  screen: Screen;
  selected: boolean;
  canManage: boolean;
  showLocation: boolean;
  onSelect: (checked: boolean) => void;
  onOpen: () => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
  return (
    <article
      className={`screen-row${needsAttention(screen) ? " screen-row--attention" : ""}`}
      onClick={onOpen}
      onContextMenu={onMenu}
    >
      <span onClick={(event) => event.stopPropagation()}>
        {canManage && (
          <input
            type="checkbox"
            aria-label={`Select ${screen.name}`}
            checked={selected}
            onChange={(event) => onSelect(event.target.checked)}
          />
        )}
      </span>
      {/* Only the name is a link. The metadata line used to sit inside the anchor,
          so location, platform, and resolution all rendered underlined as if each
          were separately clickable. */}
      <span className="screen-identity">
        <span className="screen-icon" aria-hidden="true">
          <Monitor size={16} />
        </span>
        <span className="screen-identity__copy">
          <Link
            className="screen-name"
            to={`/screens/${screen.id}`}
            onClick={(event) => event.stopPropagation()}
          >
            {screen.name}
          </Link>
          <small>{screenMetadata(screen, showLocation)}</small>
        </span>
        {screen.syncGroupName && (
          <span className="screen-sync-chip">
            <Link2 size={12} aria-hidden="true" />
            {screen.syncGroupName}
          </span>
        )}
      </span>
      <span className="screen-row__playing">
        <strong>{screen.nowPlayingName || "Nothing assigned"}</strong>
        <small>
          {screen.nowPlayingName
            ? screen.nowPlayingType === "playlist"
              ? "Playlist"
              : "Presentation"
            : "No fallback content"}
        </small>
      </span>
      {/* Status and last contact are one column: apart, each left a wide empty
          cell and the reader had to join them up anyway. */}
      <span className="screen-row__status">
        <StatusLabel status={screen.status} />
        <small>{formatContact(screen.lastContactAt)}</small>
        {screen.updateError && (
          <span className="screen-row__flag">
            <TriangleAlert size={12} aria-hidden="true" />
            Update failed
          </span>
        )}
      </span>
      <span
        className="screen-row__actions"
        onClick={(event) => event.stopPropagation()}
      >
        <button
          type="button"
          aria-label={`Actions for ${screen.name}`}
          onClick={(event) => onMenu(event)}
        >
          <MoreHorizontal size={17} />
        </button>
      </span>
    </article>
  );
}

export function ScreenGridCard({
  screen,
  csrfToken,
  selected,
  canManage,
  showLocation,
  onSelect,
  onOpen,
  onMenu,
}: {
  screen: Screen;
  csrfToken: string;
  selected: boolean;
  canManage: boolean;
  showLocation: boolean;
  onSelect: (checked: boolean) => void;
  onOpen: () => void;
  onMenu: (event: ReactMouseEvent<HTMLElement>) => void;
}) {
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
      className={`screen-card${needsAttention(screen) ? " screen-card--attention" : ""}`}
      role="link"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
      onContextMenu={onMenu}
    >
      <div
        className={`screen-card__preview${portrait ? " screen-card__preview--portrait" : ""}`}
        style={{
          aspectRatio: `${screen.screenWidth || 16} / ${screen.screenHeight || 9}`,
        }}
      >
        {preview.isLoading && visible ? (
          <span
            className="screen-preview-skeleton"
            aria-label="Loading preview"
          />
        ) : image ? (
          <>
            <img src={image} alt={`Latest preview from ${screen.name}`} />
            {age && (
              <span
                className={`screen-card__preview-age screen-card__preview-age--${age.tone}`}
                aria-label={`Snapshot captured ${age.label}`}
                title={`Captured ${new Date(
                  preview.data?.capturedAt ?? "",
                ).toLocaleString()}`}
              >
                {age.label}
              </span>
            )}
          </>
        ) : (
          <span className="screen-preview-empty">
            <Monitor size={24} />
            {screen.status === "offline"
              ? "Screen offline"
              : "Preview unavailable"}
          </span>
        )}
      </div>
      <div className="screen-card__body">
        <header>
          {canManage && (
            <input
              type="checkbox"
              aria-label={`Select ${screen.name}`}
              checked={selected}
              onClick={(event) => event.stopPropagation()}
              onChange={(event) => onSelect(event.target.checked)}
            />
          )}
          <span>
            <strong>{screen.name}</strong>
            <small>
              {[showLocation ? screen.location : "", roomLabel(screen)]
                .filter(Boolean)
                .join(" · ") || "Unassigned"}
            </small>
          </span>
          <button
            type="button"
            aria-label={`Actions for ${screen.name}`}
            onClick={(event) => onMenu(event)}
          >
            <MoreHorizontal size={17} />
          </button>
        </header>
        <div className="screen-card__facts">
          <StatusLabel status={screen.status} />
          <span>{formatContact(screen.lastContactAt)}</span>
        </div>
        <dl className="screen-card__meta">
          <dt>Now playing</dt>
          <dd>{screen.nowPlayingName || "Nothing assigned"}</dd>
        </dl>
        {screen.syncGroupName && (
          <span className="screen-card__sync">
            <Link2 size={12} aria-hidden="true" />
            {screen.syncGroupName}
          </span>
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
    <section className="pending-panel">
      <header>
        <span className="pending-panel__icon" aria-hidden="true">
          <RefreshCw size={16} />
        </span>
        <div>
          <h3>Waiting for approval</h3>
          <p>
            {requests.length} player{requests.length === 1 ? "" : "s"} requested
            pairing.
          </p>
        </div>
      </header>
      {requests.map((request) => (
        <div className="pending-row" key={request.id}>
          <span>
            <strong>
              {request.metadata.manufacturer} {request.metadata.model}
            </strong>
            <small>
              {platformLabel(request.metadata.platform)} ·{" "}
              {request.metadata.screenWidth}×{request.metadata.screenHeight}
            </small>
          </span>
          <span className="pending-row__expiry">
            Expires{" "}
            {new Date(request.expiresAt).toLocaleTimeString([], {
              hour: "numeric",
              minute: "2-digit",
            })}
          </span>
          {canManage && (
            <Link
              className="button button--quiet"
              to={`/screens/pair/request/${request.id}`}
            >
              Review
            </Link>
          )}
        </div>
      ))}
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
      <section className="empty-state">
        <span className="empty-state__index">Restricted</span>
        <h2>Screen approval requires administrator access.</h2>
        <p>
          Editors and Viewers can monitor screens but cannot approve or reject
          pairing requests.
        </p>
        <Link className="text-link" to="/screens">
          Return to screens
        </Link>
      </section>
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
        <span className="empty-illustration">
          <Link2 size={24} />
        </span>
        <div>
          <h2>Pair a screen</h2>
          <p>Enter the six-character code displayed by Tilecast Player.</p>
        </div>
      </header>
      {error && (
        <div className="notice notice--error" role="alert">
          {error}
        </div>
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
        <button className="button button--primary" type="submit">
          Find player
        </button>
        <Link className="button button--quiet" to="/screens">
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
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const defaultDestination: PairingDestination =
    request.previouslyPaired && request.hasActiveCredential
      ? "credential_repair"
      : "new_screen";
  const [destination, setDestination] =
    useState<PairingDestination>(defaultDestination);
  const [replacementScreenId, setReplacementScreenId] = useState("");
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
    onSuccess: () => onDone(),
  });
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
      <fieldset className="pairing-destination">
        <legend>Pairing destination</legend>
        <label className="radio-control">
          <input
            type="radio"
            name="pairingDestination"
            value="new_screen"
            checked={destination === "new_screen"}
            onChange={() => setDestination("new_screen")}
          />
          <span>
            <strong>Create new screen</strong>
            <small>Create a new logical screen from this player.</small>
          </span>
        </label>
        {request.previouslyPaired && request.hasActiveCredential && (
          <label className="radio-control">
            <input
              type="radio"
              name="pairingDestination"
              value="credential_repair"
              checked={destination === "credential_repair"}
              onChange={() => setDestination("credential_repair")}
            />
            <span>
              <strong>Repair existing credential</strong>
              <small>
                Keep this player installation on “{request.existingScreenName}”.
              </small>
            </span>
          </label>
        )}
        <label className="radio-control">
          <input
            type="radio"
            name="pairingDestination"
            value="replace_hardware"
            checked={destination === "replace_hardware"}
            onChange={() => setDestination("replace_hardware")}
          />
          <span>
            <strong>Replace hardware for an existing screen</strong>
            <small>
              Keep the logical screen, Display Group, content, schedules,
              policies, and history.
            </small>
          </span>
        </label>
        {destination === "replace_hardware" && (
          <label className="field pairing-destination__picker">
            <span className="field__label">Existing screen</span>
            <Select
              value={replacementScreenId}
              onChange={(event) => setReplacementScreenId(event.target.value)}
            >
              <option value="">Choose a screen</option>
              {(screens.data?.items ?? [])
                .filter((screen) => screen.id !== request.existingScreenId)
                .map((screen) => (
                  <option key={screen.id} value={screen.id}>
                    {screen.name}
                    {screen.location ? ` — ${screen.location}` : ""}
                  </option>
                ))}
            </Select>
            <small>
              The old credential is retired only after this player successfully
              enrolls.
            </small>
          </label>
        )}
      </fieldset>
      {request.previouslyPaired && (
        <div className="notice notice--warning" role="status">
          <strong>
            This device was previously paired as “{request.existingScreenName}.”
          </strong>
          <p>
            {destination === "replace_hardware"
              ? "Choose the logical screen above; its identity and configuration are preserved."
              : "Repairing the pairing will preserve this screen and its content assignments. The previous device credential will be revoked only after this player completes enrollment."}
          </p>
        </div>
      )}
      {(approve.error || reject.error) && (
        <div className="notice notice--error">
          {(approve.error ?? reject.error)?.message}
        </div>
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void form.handleSubmit(async (values) => {
            if (destination === "credential_repair" && !(await confirm({
              title: `Repair pairing for “${request.existingScreenName}”?`,
              description:
                "The player's credential will be replaced after enrollment completes.",
              confirmLabel: "Repair pairing",
              tone: "negative",
            }))) return;
            if (destination === "replace_hardware") {
              const target = screens.data?.items.find(
                (screen) => screen.id === replacementScreenId,
              );
              if (!target) {
                form.setError("root", {
                  type: "manual",
                  message: "Choose the existing screen whose hardware is being replaced.",
                });
                return;
              }
              if (!(await confirm({
                title: `Replace the hardware for “${target.name}”?`,
                description:
                  "Its name, group membership, assignments, schedules, policies, and history will stay on the same logical screen.",
                confirmLabel: "Replace hardware",
                tone: "negative",
              }))) return;
            }
            await approve.mutateAsync(values);
          })(event);
        }}
      >
        {form.formState.errors.root?.message && (
          <div className="notice notice--error" role="alert">
            {form.formState.errors.root.message}
          </div>
        )}
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
        <label className="field" htmlFor="screenDescription">
          <span className="field__label">Description (optional)</span>
          <textarea id="screenDescription" {...form.register("description")} />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="button button--danger-quiet"
            onClick={() => reject.mutate()}
            disabled={reject.isPending || approve.isPending}
          >
            Reject
          </button>
          <button
            type="submit"
            className="button button--primary"
            disabled={approve.isPending || reject.isPending}
          >
            {approve.isPending
              ? "Approving…"
              : pairingApprovalLabel(request, destination)}
          </button>
        </div>
      </form>
    </section>
  );
}

export function ScreenDetailPage() {
  const { confirm, prompt } = useSpectrumDialogs();
  const { id = "" } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const auth = useAuth();
  const queryClient = useQueryClient();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [editingDetails, setEditingDetails] = useState(false);
  const [policyDirty, setPolicyDirty] = useState(false);
  const [selectedPresentation, setSelectedPresentation] = useState("");
  const [airplayOpen, setAirplayOpen] = useState(false);
  const [quickPresentOpen, setQuickPresentOpen] = useState(
    () => searchParams.get("present") === "1",
  );
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
      await queryClient.invalidateQueries({
        queryKey: ["screens", id, "playlist-assignment"],
      });
    },
  });
  const stateMutation = useMutation({
    mutationFn: (enabled: boolean) =>
      api.setScreenEnabled(id, enabled, auth.status?.csrfToken ?? ""),
    onSuccess: async () => {
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
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["screens", id, "commands"],
      });
      void queryClient.invalidateQueries({
        queryKey: ["screens", id, "reliability"],
      });
    },
  });
  const listedScreen = screens.data?.items?.find((screen) => screen.id === id);
  const screen = resolveScreenDetail(query.data, listedScreen);
  if (query.isLoading && !screen)
    return <div className="table-loading">Loading screen…</div>;
  if (!screen)
    return (
      <div className="notice notice--error">Screen could not be loaded.</div>
    );
  const displayCapabilities =
    reliability.data?.displayControlCapabilities ?? {};
  const hasDisplayControl = Object.keys(displayCapabilities).length > 0;
  const requestedTab = searchParams.get("tab") ?? "overview";
  const tab = normalizeScreenDetailTab(requestedTab);
  const manageSection = normalizeScreenManageSection(
    requestedTab,
    searchParams.get("section"),
  );
  const selectTab = async (nextTab: string) => {
    if (policyDirty && tab === "manage") {
      if (!(await confirm({
        title: "Leave Manage without saving your changes?",
        description: "Your player policy edits will be lost.",
        confirmLabel: "Discard changes",
      }))) return;
      setPolicyDirty(false);
    }
    const next = new URLSearchParams(searchParams);
    if (nextTab === "overview") next.delete("tab");
    else next.set("tab", nextTab);
    if (nextTab !== "manage") next.delete("section");
    setSearchParams(next);
  };
  const selectManageSection = async (nextSection: ScreenManageSection) => {
    if (
      policyDirty &&
      manageSection === "settings" &&
      nextSection !== "settings"
    ) {
      if (!(await confirm({
        title: "Leave Player Settings without saving your changes?",
        description: "Your player policy edits will be lost.",
        confirmLabel: "Discard changes",
      }))) return;
      setPolicyDirty(false);
    }
    const next = new URLSearchParams(searchParams);
    next.set("tab", "manage");
    if (nextSection === "settings") next.delete("section");
    else next.set("section", nextSection);
    setSearchParams(next);
  };
  return (
    <div
      className={`screen-detail${tab === "manage" ? " screen-detail--manage" : ""}`}
    >
      <PageHeader
        className="screen-detail__page-header"
        title={
          <span className="screen-detail__title">
            <span>{screen.name}</span>
            <StatusLabel status={screen.status} />
          </span>
        }
        description={
          [screen.location, roomLabel(screen)].filter(Boolean).join(" · ") ||
          "No location set"
        }
        actions={
          <>
            {canManageScreens(auth.status?.user) && (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setEditingDetails((editing) => !editing)}
              >
                <Pencil size={15} aria-hidden="true" />
                {editingDetails ? "Close editor" : "Edit details"}
              </button>
            )}
            {canManageScreens(auth.status?.user) &&
              screen.platform.toLowerCase() === "linux" && (
                <button
                  type="button"
                  className="button button--primary"
                  onClick={() => setAirplayOpen(true)}
                >
                  <Airplay size={15} aria-hidden="true" />
                  AirPlay
                </button>
              )}
            {canManageScreens(auth.status?.user) && (
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setQuickPresentOpen(true)}
              >
                Show now
              </button>
            )}
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
      {editingDetails && (
        <section
          className="screen-details-editor"
          aria-labelledby="screen-details-editor-title"
        >
          <header>
            <div>
              <h3 id="screen-details-editor-title">Player details</h3>
            </div>
          </header>
          {updateDetails.error && (
            <div className="notice notice--error" role="alert">
              {updateDetails.error.message}
            </div>
          )}
          <form
            onSubmit={(event) =>
              void detailsForm.handleSubmit((values) =>
                updateDetails.mutateAsync(values),
              )(event)
            }
          >
            <FormField
              id="editScreenName"
              label="Screen name"
              autoFocus
              error={detailsForm.formState.errors.name?.message}
              {...detailsForm.register("name")}
            />
            <LocationPicker
              locations={locations.data?.items ?? []}
              value={detailsForm.watch("locationId")}
              onChange={(locationId) =>
                detailsForm.setValue("locationId", locationId, {
                  shouldDirty: true,
                })
              }
            />
            <div className="screen-room-fields">
              <FormField
                id="editScreenRoomName"
                label="Room name (optional)"
                {...detailsForm.register("roomName")}
              />
              <FormField
                id="editScreenRoomNumber"
                label="Room number (optional)"
                {...detailsForm.register("roomNumber")}
              />
            </div>
            <label
              className="field screen-details-editor__description"
              htmlFor="editScreenDescription"
            >
              <span className="field__label">Description (optional)</span>
              <textarea
                id="editScreenDescription"
                {...detailsForm.register("description")}
              />
              {detailsForm.formState.errors.description?.message && (
                <span className="field__error">
                  {detailsForm.formState.errors.description.message}
                </span>
              )}
            </label>
            <div className="screen-details-editor__actions">
              <button
                type="button"
                className="button button--secondary"
                onClick={() => setEditingDetails(false)}
              >
                Cancel
              </button>
              <button
                type="submit"
                className="button button--primary"
                disabled={updateDetails.isPending}
              >
                {updateDetails.isPending ? "Saving…" : "Save details"}
              </button>
            </div>
          </form>
        </section>
      )}
      <ViewTabs
        className="screen-detail-tabs"
        label="Screen details"
        value={tab}
        onValueChange={selectTab}
        items={[
          { value: "overview", label: "Overview" },
          { value: "snapshots", label: "Snapshots" },
          { value: "content", label: "Content" },
          { value: "activity", label: "Activity" },
          {
            value: "manage",
            label: "Manage",
            marker: policyDirty ? "Unsaved" : undefined,
          },
        ]}
      />

      {tab === "overview" && (
        <section
          className="screen-overview"
          aria-labelledby="screen-overview-title"
        >
          <header>
            <h3 id="screen-overview-title">Screen overview</h3>
            <p>Current player state and the settings that affect it.</p>
          </header>
          {reliability.data?.externalPresentationState &&
            reliability.data.externalPresentationState !== "none" && (
              <div className="notice notice--info">
                <strong>AIRPLAY ACTIVE</strong> · This screen is showing an
                external presentation
                {reliability.data.airplayConnected
                  ? " and is receiving mirrored video."
                  : "; it is waiting for a sender."}{" "}
                Preview capture is disabled while AirPlay is active.
              </div>
            )}
          <dl className="screen-overview__grid">
            <div>
              <dt>Online status</dt>
              <dd>
                <StatusLabel status={screen.status} />
              </dd>
            </div>
            <div>
              <dt>Current content</dt>
              <dd>
                {assignment.data?.playbackState ??
                  assignment.data?.playlistName ??
                  "No content"}
              </dd>
            </div>
            <div>
              <dt>Synchronization</dt>
              <dd>
                {assignment.data?.synchronizationStatus?.replaceAll("_", " ") ??
                  "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Player version</dt>
              <dd>{screen.playerVersion || "Not reported"}</dd>
            </div>
            <div>
              <dt>Reliability mode</dt>
              <dd>
                {reliability.data?.effectiveMode?.replaceAll("_", " ") ??
                  "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Active hours</dt>
              <dd>
                {reliability.data?.activeHoursState?.replaceAll("_", " ") ??
                  "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Player-setting overrides</dt>
              <dd>
                <Link to={`?tab=manage`}>
                  {Object.keys(screenPolicy.data?.values ?? {}).length}{" "}
                  configured · Manage screen
                </Link>
              </dd>
            </div>
          </dl>
          <div className="screen-overview__links">
            <button type="button" onClick={() => selectTab("content")}>
              View content
            </button>
            <button type="button" onClick={() => selectTab("manage")}>
              Manage screen
            </button>
          </div>
          <section
            className="screen-hardware-history"
            aria-labelledby="screen-hardware-history-title"
          >
            <header>
              <h3 id="screen-hardware-history-title">Hardware history</h3>
              <p>The logical screen stays stable when hardware is replaced.</p>
            </header>
            {playerHistory.data?.items.length ? (
              <div className="screen-hardware-history__list">
                {playerHistory.data.items.map((hardware) => (
                  <article
                    key={hardware.id}
                    className={
                      hardware.retiredAt
                        ? "screen-hardware-history__item screen-hardware-history__item--retired"
                        : "screen-hardware-history__item"
                    }
                  >
                    <div className="screen-hardware-history__identity">
                      <strong>
                        {hardware.manufacturer} {hardware.model}
                      </strong>
                      <span className="screen-hardware-history__specs">
                        {hardware.platform} · {hardware.playerVersion} ·{" "}
                        {hardware.screenWidth}×{hardware.screenHeight}
                      </span>
                    </div>
                    <div className="screen-hardware-history__lifecycle">
                      <span className="screen-hardware-history__state">
                        <span aria-hidden="true" />
                        {hardware.retiredAt
                          ? `Retired ${new Date(hardware.retiredAt).toLocaleDateString()}`
                          : "Current hardware"}
                      </span>
                      <small className="screen-hardware-history__meta">
                        <span>
                          Paired{" "}
                          {new Date(hardware.pairedAt).toLocaleDateString()}
                        </span>
                        {hardware.retirementReason ? (
                          <>
                            <span aria-hidden="true">·</span>
                            <span>{hardware.retirementReason}</span>
                          </>
                        ) : null}
                      </small>
                    </div>
                  </article>
                ))}
              </div>
            ) : playerHistory.isLoading ? (
              <p className="table-loading">Loading hardware history…</p>
            ) : (
              <p className="empty-state__message">
                No hardware history recorded.
              </p>
            )}
          </section>
        </section>
      )}

      {tab === "content" && (
        <section className="detail-card assignment-card">
          <h3>Playback and scheduling</h3>
          {assignment.data?.groups?.[0] && (
            <div className="notice notice--info">
              This player belongs to the{" "}
              <Link to={`/groups/${assignment.data.groups[0].id}`}>
                {assignment.data.groups[0].name}
              </Link>{" "}
              Display Group. Content and schedules apply to every member.
            </div>
          )}
          {canManageScreens(auth.status?.user) ? (
            <div className="assignment-controls">
              <Select
                aria-label="Assigned presentation"
                value={selectedPresentation}
                onChange={(event) =>
                  setSelectedPresentation(event.target.value)
                }
              >
                <option value="">No presentation assigned</option>
                <optgroup label="Playlists">
                  {playlists.data?.items?.map((playlist) => (
                    <option key={playlist.id} value={`playlist:${playlist.id}`}>
                      {playlist.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Published Layouts">
                  {layouts.data?.items
                    .filter((layout) => layout.publishedRevision)
                    .map((layout) => (
                      <option key={layout.id} value={`layout:${layout.id}`}>
                        {layout.name}
                      </option>
                    ))}
                </optgroup>
              </Select>
              <button
                className="button button--primary"
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
                {assignment.data?.groups?.[0]
                  ? "Apply to Display Group"
                  : "Apply assignment"}
              </button>
            </div>
          ) : (
            <p>{assignment.data?.playlistName ?? "No playlist assigned"}</p>
          )}
          <ScreenContentChain assignment={assignment.data} />
          <dl className="detail-list">
            <div>
              <dt>Direct fallback</dt>
              <dd>
                {assignment.data?.layoutName ??
                  assignment.data?.playlistName ??
                  "No fallback assigned"}
              </dd>
            </div>
            <div>
              <dt>Current selection</dt>
              <dd>
                {assignment.data?.selectionSource === "takeover"
                  ? "Takeover"
                  : assignment.data?.selectionSource === "schedule"
                    ? `Scheduled${assignment.data.currentScheduleId ? ` · ${(assignment.data.relevantSchedules ?? []).find((s) => s.id === assignment.data?.currentScheduleId)?.name ?? "schedule"}` : ""}`
                    : assignment.data?.selectionSource === "direct_fallback"
                      ? "Direct fallback"
                      : "No content"}
              </dd>
            </div>
            <div>
              <dt>Next scheduled change</dt>
              <dd>
                {assignment.data?.nextTransitionAt
                  ? new Date(assignment.data.nextTransitionAt).toLocaleString()
                  : "None reported"}
              </dd>
            </div>
            <div>
              <dt>Server manifest</dt>
              <dd>Version {assignment.data?.manifestVersion ?? 1}</dd>
            </div>
            <div>
              <dt>Player configuration</dt>
              <dd>
                {assignment.data?.activeConfigRevision != null
                  ? `Revision ${assignment.data.activeConfigRevision}`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Player manifest</dt>
              <dd>
                {assignment.data?.playerActiveManifestVersion != null
                  ? `Version ${assignment.data.playerActiveManifestVersion}`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Synchronization</dt>
              <dd>
                {assignment.data?.synchronizationStatus?.replaceAll("_", " ") ??
                  "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Display Group</dt>
              <dd>
                {(assignment.data?.groups ?? [])
                  .map((g) => g.name)
                  .join(", ") || "Not grouped"}
              </dd>
            </div>
            <div>
              <dt>Relevant schedules</dt>
              <dd>
                {(assignment.data?.relevantSchedules ?? [])
                  .map((s) => `${s.name} (${s.priority})`)
                  .join(", ") || "No schedules"}
              </dd>
            </div>
            <div>
              <dt>Device clock difference</dt>
              <dd>
                {assignment.data?.deviceClockOffsetSeconds != null
                  ? `${Math.abs(assignment.data.deviceClockOffsetSeconds)} seconds`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Downloads</dt>
              <dd>
                {assignment.data?.downloadQueueCount != null
                  ? `${assignment.data.downloadQueueCount} queued · ${assignment.data.downloadedBytes ?? 0} of ${assignment.data.requiredBytes ?? 0} bytes`
                  : "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Website playback</dt>
              <dd>
                {assignment.data?.websiteState
                  ? `${assignment.data.websiteState?.replaceAll("_", " ") ?? "Not reported"}${assignment.data.websiteCurrentHost ? ` · ${assignment.data.websiteCurrentHost}` : ""}`
                  : "Not active"}
              </dd>
            </div>
            <div>
              <dt>Blocked website navigation</dt>
              <dd>
                {assignment.data?.websiteBlockedNavigationCount ??
                  "Not reported"}
              </dd>
            </div>
            <div>
              <dt>Playback</dt>
              <dd>{assignment.data?.playbackState ?? "Not reported"}</dd>
            </div>
            <div>
              <dt>Takeover</dt>
              <dd>
                {assignment.data?.activeTakeoverId
                  ? `${assignment.data.takeoverState ?? "pending"} · ${assignment.data.takeoverPreparationProgress ?? 0}% prepared`
                  : "No active takeover"}
              </dd>
            </div>
            <div>
              <dt>Cache</dt>
              <dd>
                {assignment.data?.cacheUsedBytes != null
                  ? `${assignment.data.cacheUsedBytes} of ${assignment.data.cacheLimitBytes ?? 0} bytes`
                  : "Not reported"}
              </dd>
            </div>
          </dl>
          {assignment.data?.lastSynchronizationError && (
            <div className="notice notice--error">
              Synchronization: {assignment.data.lastSynchronizationError}
            </div>
          )}
          {assignment.data?.lastPlaybackError && (
            <div className="notice notice--error">
              Playback: {assignment.data.lastPlaybackError}
            </div>
          )}
          {assignment.data?.configurationError && (
            <div className="notice notice--error">
              Configuration: {assignment.data.configurationError}
            </div>
          )}
          {Math.abs(assignment.data?.deviceClockOffsetSeconds ?? 0) >
            (assignment.data?.clockSkewWarningSeconds ?? 300) && (
            <div className="notice notice--warning">
              The player clock differs from server time by more than five
              minutes. Offline schedule changes may occur at the wrong time.
            </div>
          )}
          {assignment.data?.scheduleEvaluationError && (
            <div className="notice notice--error">
              Schedule evaluation: {assignment.data.scheduleEvaluationError}
            </div>
          )}
          {assignment.data?.websiteFailureCategory &&
            ["failed", "timed_out", "blocked", "showing_fallback"].includes(
              assignment.data.websiteState ?? "",
            ) && (
              <div className="notice notice--error">
                Website:{" "}
                {assignment.data.websiteFailureCategory?.replaceAll("_", " ") ??
                  "Unknown website failure"}
              </div>
            )}
        </section>
      )}

      {tab === "manage" && (
        <section
          className="screen-manage__navigation"
          aria-labelledby="screen-manage-title"
        >
          <div className="screen-manage__navigation-copy">
            <div>
              <h2 id="screen-manage-title">Manage screen</h2>
              <p>Choose an area to configure, inspect, or maintain.</p>
            </div>
            <StatusLabel status={screen.status} />
          </div>
          <ViewTabs
            className="screen-manage-tabs"
            label="Manage screen sections"
            value={manageSection}
            onValueChange={selectManageSection}
            items={[
              { value: "settings", label: "Settings" },
              { value: "health", label: "Health" },
              { value: "maintenance", label: "Maintenance" },
              { value: "device", label: "Device & access" },
            ]}
          />
        </section>
      )}

      {tab === "manage" && manageSection === "settings" && (
        <PlayerPolicyEditor
          target="screen"
          id={id}
          onDirtyChange={setPolicyDirty}
        />
      )}

      {tab === "manage" && manageSection === "health" && (
        <section className="operations" aria-labelledby="reliability-heading">
          <h3 id="reliability-heading">Health &amp; recovery</h3>
          <p>
            Configured behavior is reported separately from capabilities
            confirmed by this device. Platform-specific controls appear only
            when the player reports support.
          </p>
          <div className="readiness-panel">
            <div className="readiness-panel__heading">
              <div>
                <h4>Zero-Touch Readiness</h4>
                <p>
                  Commissioning and current device capabilities required for
                  unattended recovery.
                </p>
              </div>
              <span className="status-badge">
                {zeroTouchReadiness(reliability.data)}
              </span>
            </div>
            <dl className="detail-list">
              <div>
                <dt>Commissioning</dt>
                <dd>
                  {formatReportedStatus(
                    reliability.data?.commissioningState,
                    "Not started",
                  )}
                  {typeof reliability.data?.commissioningStep === "string" &&
                  reliability.data.commissioningStep.trim()
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
                  {formatReportedStatus(reliability.data?.updateReadiness)}
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
                      {reliability.data?.displayControlLastCommandResult ===
                        "display_command_sent" &&
                      reliability.data?.displayPowerStateConfirmed === false
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
          </div>
          {screen.platform.toLowerCase() === "linux" && (
            <ScreenPresentationNetworkPanel
              screen={screen}
              canManage={canManageScreens(auth.status?.user)}
              csrfToken={auth.status?.csrfToken ?? ""}
            />
          )}
          <dl className="detail-list">
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
              <dd>{formatReportedStatus(reliability.data?.foregroundState)}</dd>
            </div>
            <div>
              <dt>Boot recovery</dt>
              <dd>
                {formatReportedStatus(reliability.data?.bootRecoveryResult)}
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
              <dd>{formatReportedStatus(reliability.data?.sleepCapability)}</dd>
            </div>
            <div>
              <dt>Recovery</dt>
              <dd>
                Level {formatReportedCount(reliability.data?.recoveryLevel)} ·{" "}
                {formatReportedCount(reliability.data?.recoveryCount)} recent ·
                safe mode {reliability.data?.safeMode ? "active" : "inactive"}
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
            <div className="notice notice--warning">
              {reliabilityCapabilityWarning(reliability.data)}
            </div>
          )}
          {autostartWarning(reliability.data) && (
            <div className="notice notice--warning">
              {autostartWarning(reliability.data)}
            </div>
          )}
          {canManageScreens(auth.status?.user) && (
            <>
              <section
                className="reliability-controls"
                aria-labelledby="reliability-controls-title"
              >
                <header className="reliability-section-heading">
                  <div>
                    <h4 id="reliability-controls-title">Player controls</h4>
                    <p>
                      Run a focused recovery action without leaving this screen.
                    </p>
                  </div>
                  {command.isPending && (
                    <span className="status-badge">Sending…</span>
                  )}
                </header>
                <div className="reliability-control-groups">
                  {isAndroidScreen(screen.platform) && (
                    <div className="reliability-control-group">
                      <div>
                        <h5>Power Assist</h5>
                        <p>Test Android sleep and wake behavior.</p>
                      </div>
                      <div className="reliability-button-grid">
                        <button
                          className="button button--secondary"
                          disabled={command.isPending}
                          onClick={() =>
                            command.mutate({
                              type: "power_assist_sleep",
                              payload: {},
                            })
                          }
                        >
                          Test sleep
                        </button>
                        <button
                          className="button button--secondary"
                          disabled={command.isPending}
                          onClick={() =>
                            command.mutate({
                              type: "power_assist_wake",
                              payload: {},
                            })
                          }
                        >
                          Test wake
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="reliability-control-group">
                    <div>
                      <h5>Recovery</h5>
                      <p>
                        Retry recovery or leave safe mode after resolving a
                        fault.
                      </p>
                    </div>
                    <div className="reliability-button-grid">
                      <button
                        className="button button--secondary"
                        disabled={command.isPending}
                        onClick={() =>
                          command.mutate({
                            type: "retry_player_recovery",
                            payload: {},
                          })
                        }
                      >
                        Retry recovery
                      </button>
                      <button
                        className="button button--secondary"
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
                      </button>
                    </div>
                  </div>
                  {reportsAutostart(reliability.data) && (
                    <div className="reliability-control-group">
                      <div>
                        <h5>Linux autostart</h5>
                        <p>
                          Installs the player's own systemd user service so it
                          starts with the graphical session and restarts after
                          any exit. Setting up is safe while the player is
                          running: Tilecast captures this AppImage's display,
                          data directory, and server address, writes and enables
                          the service, and does not start a duplicate process.
                          The current manual process keeps running until the
                          next controlled restart, session restart, or reboot,
                          when systemd takes ownership. A service file you wrote
                          yourself is never overwritten. A graphical session
                          that begins at boot (auto-login or a kiosk compositor)
                          remains operating-system setup.
                        </p>
                      </div>
                      <div className="reliability-button-grid">
                        <button
                          className="button button--secondary"
                          disabled={command.isPending}
                          onClick={() =>
                            command.mutate({
                              type: "install_autostart",
                              payload: {},
                            })
                          }
                        >
                          Set up autostart
                        </button>
                        <button
                          className="button button--secondary"
                          disabled={command.isPending}
                          onClick={async () => {
                            if (await confirm({
                              title: "Remove the autostart service?",
                              description:
                                "This screen will keep playing now, but will not return on its own after a reboot or player update.",
                              confirmLabel: "Remove service",
                              tone: "negative",
                            }))
                              command.mutate({
                                type: "remove_autostart",
                                payload: {},
                              });
                          }}
                        >
                          Remove autostart
                        </button>
                      </div>
                    </div>
                  )}
                  {screen.platform.toLowerCase() === "linux" && (
                    <div className="reliability-control-group reliability-control-group--wide">
                      <div>
                        <h5>Display Control</h5>
                        <p>
                          Player connectivity and display power are separate
                          states. Controls appear only for capabilities reported
                          by this player; provider commands have a bounded
                          timeout and may report sent without a confirmed panel
                          state.
                        </p>
                      </div>
                      <div className="reliability-button-grid reliability-button-grid--wide">
                        {displayCapabilities.power && (
                          <>
                            <button
                              className="button button--secondary"
                              disabled={command.isPending}
                              onClick={() =>
                                command.mutate({
                                  type: "display_power_on",
                                  payload: {},
                                })
                              }
                            >
                              Power on display
                            </button>
                            <button
                              className="button button--secondary"
                              disabled={command.isPending}
                              onClick={() =>
                                command.mutate({
                                  type: "display_power_off",
                                  payload: {},
                                })
                              }
                            >
                              Power off display
                            </button>
                          </>
                        )}
                        {displayCapabilities.input && (
                          <button
                            className="button button--secondary"
                            disabled={command.isPending}
                            onClick={async () => {
                              const input = await prompt({
                                title: "Set display input",
                                description:
                                  "Enter the CEC physical address reported by the display, such as 1.0.0.0.",
                                label: "CEC physical address",
                                placeholder: "1.0.0.0",
                                confirmLabel: "Set input",
                              });
                              if (input?.trim())
                                command.mutate({
                                  type: "display_set_input",
                                  payload: { input: input.trim() },
                                });
                            }}
                          >
                            Set display input
                          </button>
                        )}
                        {displayCapabilities.volume && (
                          <button
                            className="button button--secondary"
                            disabled={command.isPending}
                            onClick={async () => {
                              const value = await prompt({
                                title: "Set display volume",
                                label: "Volume (0–100)",
                                type: "number",
                                placeholder: "0–100",
                                confirmLabel: "Set volume",
                              });
                              const volume =
                                value == null ? NaN : Number(value);
                              if (
                                Number.isInteger(volume) &&
                                volume >= 0 &&
                                volume <= 100
                              )
                                command.mutate({
                                  type: "display_set_volume",
                                  payload: { volume },
                                });
                            }}
                          >
                            Set display volume
                          </button>
                        )}
                        {displayCapabilities.mute && (
                          <>
                            <button
                              className="button button--secondary"
                              disabled={command.isPending}
                              onClick={() =>
                                command.mutate({
                                  type: "display_mute",
                                  payload: {},
                                })
                              }
                            >
                              Mute display
                            </button>
                            <button
                              className="button button--secondary"
                              disabled={command.isPending}
                              onClick={() =>
                                command.mutate({
                                  type: "display_unmute",
                                  payload: {},
                                })
                              }
                            >
                              Unmute display
                            </button>
                          </>
                        )}
                        {displayCapabilities.brightness && (
                          <button
                            className="button button--secondary"
                            disabled={command.isPending}
                            onClick={async () => {
                              const value = await prompt({
                                title: "Set display brightness",
                                label: "Brightness (0–100)",
                                type: "number",
                                placeholder: "0–100",
                                confirmLabel: "Set brightness",
                              });
                              const brightness =
                                value == null ? NaN : Number(value);
                              if (
                                Number.isInteger(brightness) &&
                                brightness >= 0 &&
                                brightness <= 100
                              )
                                command.mutate({
                                  type: "display_set_brightness",
                                  payload: { brightness },
                                });
                            }}
                          >
                            Set display brightness
                          </button>
                        )}
                        <button
                          className="button button--secondary"
                          disabled={command.isPending}
                          onClick={() =>
                            command.mutate({
                              type: "display_probe",
                              payload: {},
                            })
                          }
                        >
                          Probe display capabilities
                        </button>
                        {!hasDisplayControl && (
                          <span className="field__hint">
                            No HDMI-CEC or DDC/CI capability is currently
                            reported.
                          </span>
                        )}
                      </div>
                    </div>
                  )}
                  {screen.platform.toLowerCase() === "linux" && (
                    <div className="reliability-control-group">
                      <div>
                        <h5>AirPlay diagnostics</h5>
                        <p>
                          Probe UxPlay, GStreamer, VA-API, audio, and local
                          Avahi support without advertising a receiver.
                        </p>
                      </div>
                      <div className="reliability-button-grid">
                        <button
                          className="button button--secondary"
                          disabled={command.isPending}
                          onClick={() =>
                            command.mutate({
                              type: "test_airplay_support",
                              payload: {},
                            })
                          }
                        >
                          Test AirPlay support
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="reliability-control-group reliability-control-group--wide">
                    <div>
                      <h5>Playback and player</h5>
                      <p>
                        Use the least disruptive action that matches the
                        problem.
                      </p>
                    </div>
                    <div className="reliability-button-grid reliability-button-grid--wide">
                      {(
                        [
                          ["retry_current_item", "Retry item"],
                          ["skip_current_item", "Skip item"],
                          ["recreate_renderer", "Recreate renderer"],
                          ["recreate_playback_session", "Recreate session"],
                          ["restart_activity", "Restart activity"],
                          ["restart_player_process", "Restart player"],
                          ["resynchronize_player", "Resynchronize"],
                          ["run_player_self_test", "Run self-test"],
                        ] as const
                      ).map(([type, label]) => (
                        <button
                          key={type}
                          className="button button--secondary"
                          disabled={command.isPending}
                          onClick={() => command.mutate({ type, payload: {} })}
                        >
                          {label}
                        </button>
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

      {tab === "manage" &&
        manageSection === "maintenance" &&
        canManageScreens(auth.status?.user) && (
          <section className="operations">
            <h3>Maintenance</h3>
            <p>
              Commands remain pending during brief disconnections and expire
              automatically.
            </p>
            <div className="heading-actions">
              <button
                className="button button--secondary"
                onClick={() =>
                  command.mutate({ type: "sync_now", payload: {} })
                }
              >
                Sync now
              </button>
              <button
                className="button button--secondary"
                onClick={() =>
                  command.mutate({ type: "reload_playback", payload: {} })
                }
              >
                Reload playback
              </button>
              <button
                className="button button--secondary"
                onClick={() =>
                  command.mutate({
                    type: "identify_screen",
                    payload: { durationSeconds: 30 },
                  })
                }
              >
                Identify screen
              </button>
              <button
                className="button button--danger-quiet"
                onClick={async () => {
                  if (await confirm({
                    title: "Clear media cache?",
                    description:
                      "Media protected by active or pending playback will be kept.",
                    confirmLabel: "Clear media cache",
                    tone: "negative",
                  }))
                    command.mutate({ type: "clear_media_cache", payload: {} });
                }}
              >
                Clear media cache
              </button>
              <button
                className="button button--danger-quiet"
                onClick={async () => {
                  if (await confirm({
                    title: "Clear website data?",
                    description:
                      "Cookies, cache, DOM storage, and WebView state will be cleared.",
                    confirmLabel: "Clear website data",
                    tone: "negative",
                  }))
                    command.mutate({ type: "clear_website_data", payload: {} });
                }}
              >
                Clear website data
              </button>
              <button
                className="button button--danger-quiet"
                onClick={async () => {
                  const disabling = !assignment.data?.playbackDisabled;
                  if (
                    !disabling ||
                    await confirm({
                      title: "Disable ordinary playback?",
                      description:
                        "The player will stay paired and connected, but ordinary scheduled playback will stop.",
                      confirmLabel: "Disable playback",
                      tone: "negative",
                    })
                  )
                    command.mutate({
                      type: disabling ? "disable_playback" : "enable_playback",
                      payload: {},
                    });
                }}
              >
                {assignment.data?.playbackDisabled
                  ? "Enable playback"
                  : "Disable playback"}
              </button>
            </div>
            {command.isSuccess && (
              <p>Command queued; this does not mean it has completed.</p>
            )}
            <div className="command-history">
              {commands.data?.items?.map((c) => (
                <div key={c.id}>
                  <strong>
                    {c.type?.replaceAll("_", " ") ?? "Unknown command"}
                  </strong>
                  <span>
                    {c.state} · {new Date(c.createdAt).toLocaleString()}
                  </span>
                  <small>
                    {c.resultCode?.replaceAll("_", " ") ?? "No result yet"}
                  </small>
                </div>
              ))}
            </div>
          </section>
        )}
      {tab === "manage" &&
        manageSection === "maintenance" &&
        !canManageScreens(auth.status?.user) && (
          <section className="operations">
            <h3>Recent operations</h3>
            {commands.isLoading ? (
              <div className="table-loading">Loading operations…</div>
            ) : (commands.data?.items?.length ?? 0) === 0 ? (
              <p>
                No maintenance commands have been sent to this screen. An Owner
                or Administrator can send them.
              </p>
            ) : (
              <div className="command-history">
                {commands.data?.items?.map((c) => (
                  <div key={c.id}>
                    <strong>
                      {c.type?.replaceAll("_", " ") ?? "Unknown command"}
                    </strong>
                    <span>
                      {c.state} · {new Date(c.createdAt).toLocaleString()}
                    </span>
                    <small>
                      {c.resultCode?.replaceAll("_", " ") ?? "No result yet"}
                    </small>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}
      {tab === "manage" && manageSection === "device" && (
        <>
          <section className="detail-grid">
            <div className="detail-card">
              <h3>Device</h3>
              <dl className="detail-list">
                <div>
                  <dt>Hardware</dt>
                  <dd>
                    {screen.deviceManufacturer} {screen.deviceModel}
                  </dd>
                </div>
                <div>
                  <dt>Platform</dt>
                  <dd>
                    {screen.platform === "linux"
                      ? "Linux"
                      : `${formatReportedStatus(screen.platform)} ${
                          screen.androidVersion ?? ""
                        }`.trim()}
                  </dd>
                </div>
                <div>
                  <dt>Player version</dt>
                  <dd>
                    {screen.playerVersion}
                    {screen.playerVersionCode
                      ? ` (code ${screen.playerVersionCode})`
                      : ""}
                  </dd>
                </div>
                {isAndroidScreen(screen.platform) && (
                  <>
                    <div>
                      <dt>Android SDK</dt>
                      <dd>{screen.androidSdk ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt>Installer source</dt>
                      <dd>{screen.installerSource ?? "Not reported"}</dd>
                    </div>
                    <div>
                      <dt>Install permission</dt>
                      <dd>
                        {screen.installPermissionStatus?.replaceAll("_", " ") ??
                          "Unknown"}
                      </dd>
                    </div>
                  </>
                )}
                <div>
                  <dt>Player update</dt>
                  <dd>
                    {screen.updateState?.replaceAll("_", " ") ??
                      "No active deployment"}
                    {screen.updateExpectedBytes
                      ? ` · ${Math.round(((screen.updateDownloadedBytes ?? 0) / screen.updateExpectedBytes) * 100)}%`
                      : ""}
                    {screen.updateError ? ` · ${screen.updateError}` : ""}
                  </dd>
                </div>
                <div>
                  <dt>Resolution</dt>
                  <dd>
                    {screen.screenWidth} × {screen.screenHeight}
                  </dd>
                </div>
                <div>
                  <dt>Locale</dt>
                  <dd>{screen.locale}</dd>
                </div>
                <div>
                  <dt>Timezone</dt>
                  <dd>{screen.timezone}</dd>
                </div>
              </dl>
            </div>
            <div className="detail-card">
              <h3>Connection</h3>
              <dl className="detail-list">
                <div>
                  <dt>Last contact</dt>
                  <dd>{formatContact(screen.lastContactAt)}</dd>
                </div>
                <div>
                  <dt>Network address</dt>
                  <dd>{screen.lastKnownIp || "Not reported"}</dd>
                </div>
                <div>
                  <dt>Credential</dt>
                  <dd>{screen.hasActiveCredential ? "Active" : "Revoked"}</dd>
                </div>
              </dl>
            </div>
          </section>
          {canManageScreens(auth.status?.user) && (
            <section className="danger-zone">
              <h3>Player access</h3>
              <div>
                <span>
                  <strong>
                    {screen.enabled ? "Disable screen" : "Enable screen"}
                  </strong>
                  <small>
                    {screen.enabled
                      ? "Temporarily blocks operation while retaining the pairing."
                      : "Allow the paired player to reconnect."}
                  </small>
                </span>
                <button
                  className="button button--quiet"
                  onClick={() => stateMutation.mutate(!screen.enabled)}
                >
                  {screen.enabled ? "Disable" : "Enable"}
                </button>
              </div>
              <div>
                <span>
                  <strong>Revoke pairing</strong>
                  <small>
                    Permanently invalidates the device credential. The player
                    must pair again.
                  </small>
                </span>
                <button
                  className="button button--danger"
                  onClick={() => setConfirmRevoke(true)}
                  disabled={!screen.hasActiveCredential}
                >
                  Revoke pairing
                </button>
              </div>
            </section>
          )}
        </>
      )}
      <Dialog
        open={confirmRevoke}
        title={`Revoke pairing for ${screen.name}?`}
        onClose={() => setConfirmRevoke(false)}
      >
        <p>
          The player will disconnect immediately and cannot reconnect without a
          new pairing approval.
        </p>
        <div className="form-actions">
          <Button variant="quiet" onClick={() => setConfirmRevoke(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={revoke.isPending}
            onClick={() => revoke.mutate()}
          >
            Revoke pairing
          </Button>
        </div>
      </Dialog>
    </div>
  );
}

export function StatusLabel({ status }: { status: ScreenStatus }) {
  const { label, Icon } = statusContent[status] ?? {
    label: "Unknown",
    Icon: CircleAlert,
  };
  // Every ScreenStatus has a matching tone group on the shared .status-chip, so no
  // page-local status styling is needed.
  const statusClass = statusContent[status] ? status : "unknown";
  return (
    <span className={`status-chip status-chip--${statusClass}`}>
      <Icon size={13} aria-hidden="true" />
      {label}
    </span>
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
