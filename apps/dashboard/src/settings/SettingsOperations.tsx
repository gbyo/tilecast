import { useConfirm } from "../components/ConfirmDialog";
import { StatusDot } from "../components/StatusDot";
import { ViewTabs } from "../components/ViewTabs";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Button as RheaButton, buttonVariants } from "../components/ui/button";
import { Checkbox as RheaCheckbox } from "../components/ui/checkbox";
import {
  Dialog as RheaDialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  Select as RheaSelect,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  CheckCircle2,
  Download,
  ExternalLink,
  Github,
  ListChecks,
  LogOut,
  RefreshCw,
  Rocket,
  Search,
  Trash2,
  Upload,
} from "lucide-react";
import { api } from "../api/client";
import { screenPlatformFamily } from "../playerPlatform";
import type {
  GitHubDeviceStart,
  PlayerPlatform,
  PlayerRelease,
  UpdateDeployment,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import {
  DeploymentMeter,
  UpdateDeploymentDrawer,
} from "./UpdateDeploymentDrawer";
import { deploymentHeadline, screenUpdateMeaning } from "./playerUpdateStates";

const maintenanceActions = [
  {
    id: "expired-upload-cleanup",
    label: "Clean up expired uploads",
    description:
      "Removes expired temporary upload data according to retention policy.",
    confirm: true,
  },
  {
    id: "completed-command-cleanup",
    label: "Clean up command history",
    description:
      "Removes completed commands older than the configured retention period.",
    confirm: true,
  },
  {
    id: "retention-cleanup",
    label: "Run retention cleanup",
    description:
      "Applies configured retention policies to eligible operational records.",
    confirm: true,
  },
  {
    id: "reconcile-config",
    label: "Reconcile player configuration",
    description:
      "Asks connected players to retrieve their current effective configuration.",
    confirm: false,
  },
  {
    id: "validate-media",
    label: "Validate media storage",
    description:
      "Checks media storage and processing-tool availability without changing content.",
    confirm: false,
  },
];
export function SystemPanel({ canManage }: { canManage: boolean }) {
  const auth = useAuth();
  const client = useQueryClient();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const query = useQuery({
    queryKey: ["system-status"],
    queryFn: api.systemStatus,
    enabled: canManage,
    refetchInterval: 30_000,
  });
  const maintenance = useMutation({
    mutationFn: (action: string) =>
      api.runMaintenance(action, auth.status?.csrfToken ?? ""),
    onSuccess: () => client.invalidateQueries({ queryKey: ["system-status"] }),
  });
  if (!canManage)
    return (
      <Alert role="status">
        <AlertDescription>
          Owner or Administrator access is required.
        </AlertDescription>
      </Alert>
    );
  const s = query.data;
  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Diagnostics</h3>
            <p className="text-sm text-muted-foreground">
              Runtime status without secrets or sensitive paths.
            </p>
          </header>
          {query.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                System diagnostics could not be loaded. {query.error.message}
              </AlertDescription>
            </Alert>
          ) : !s ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              Loading diagnostics…
            </p>
          ) : (
            <dl className="my-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Item
                label="Tilecast"
                value={`${s.tilecastVersion} · ${s.buildCommit}`}
              />
              <Item label="Uptime" value={formatDuration(s.uptimeSeconds)} />
              <Item
                label="Database"
                value={`${s.database.status} · migration ${s.database.migrationVersion}`}
              />
              <Item label="PostgreSQL" value={s.database.postgresVersion} />
              <Item
                label="Media storage"
                value={
                  typeof s.media.status === "string"
                    ? s.media.status
                    : "unknown"
                }
              />
              <Item
                label="Connected screens"
                value={String(s.connectedScreens)}
              />
              <Item
                label="Pending commands"
                value={String(s.pendingCommands)}
              />
              <Item
                label="Processing jobs"
                value={String(s.activeProcessingJobs)}
              />
              <Item label="Server timezone" value={s.serverTimezone} />
            </dl>
          )}
        </section>
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Maintenance</h3>
            <p className="text-sm text-muted-foreground">
              Run approved maintenance tasks.
            </p>
          </header>
          <div className="grid gap-2">
            {maintenanceActions.map((action) => (
              <div
                key={action.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-3"
              >
                <span className="grid gap-0.5">
                  <strong className="text-sm font-semibold">
                    {action.label}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {action.description}
                  </small>
                </span>
                <RheaButton
                  variant="ghost"

                  disabled={maintenance.isPending}
                  onClick={() => {
                    if (!action.confirm) {
                      maintenance.mutate(action.id);
                      return;
                    }
                    void confirm({
                      title: `${action.label}?`,
                      action: "Run",
                    }).then((ok) => {
                      if (ok) maintenance.mutate(action.id);
                    });
                  }}
                >
                  {maintenance.isPending && maintenance.variables === action.id
                    ? "Running…"
                    : "Run"}
                </RheaButton>
              </div>
            ))}
          </div>
          {maintenance.isSuccess && (
            <Alert role="status">
              <AlertDescription>Maintenance action completed.</AlertDescription>
            </Alert>
          )}
          {maintenance.error && (
            <Alert variant="destructive">
              <AlertDescription>{maintenance.error.message}</AlertDescription>
            </Alert>
          )}
        </section>
      </div>
    </>
  );
}
function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-0.5 rounded-xl border border-border p-3">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium break-all">{value}</dd>
    </div>
  );
}

export function ImportExportPanel({ owner }: { owner: boolean }) {
  const auth = useAuth();
  const { confirm, dialog: confirmDialog } = useConfirm();
  const [document, setDocument] = useState<unknown>();
  const [preview, setPreview] = useState<{
    changedKeys: string[];
    groupPolicyCount: number;
    screenPolicyCount: number;
  } | null>(null);
  const previewMutation = useMutation({
    mutationFn: () =>
      api.previewSettingsImport(document, auth.status?.csrfToken ?? ""),
    onSuccess: setPreview,
  });
  const apply = useMutation({
    mutationFn: () =>
      api.applySettingsImport(document, auth.status?.csrfToken ?? ""),
  });
  if (!owner)
    return (
      <Alert role="status">
        <AlertDescription>
          Only the Owner may import or export settings.
        </AlertDescription>
      </Alert>
    );
  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid content-start gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Export settings</h3>
            <p className="text-sm text-muted-foreground">
              Download organization settings and policy metadata without
              credentials, secrets, or media files.
            </p>
          </header>
          <div>
            <RheaButton
              variant="default"

              onClick={() => void exportSettings()}
            >
              Export non-secret settings
            </RheaButton>
          </div>
        </section>
        <section className="grid content-start gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">Import settings</h3>
            <p className="text-sm text-muted-foreground">
              Tilecast validates the document and shows a preview before
              anything changes.
            </p>
          </header>
          <label className="grid gap-1 text-sm font-medium">
            Settings file
            <input
              type="file"
              accept="application/json"
              className="text-sm font-normal"
              onChange={(event) =>
                void (async () => {
                  const file = event.target.files?.[0];
                  if (!file) return;
                  setDocument(JSON.parse(await file.text()));
                  setPreview(null);
                })
              }
            />
          </label>
          <div>
            <RheaButton
              variant="ghost"

              disabled={!document || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending
                ? "Validating…"
                : "Validate and preview"}
            </RheaButton>
          </div>
          {preview && (
            <Alert role="status">
              <AlertDescription className="grid gap-2">
                <strong>
                  {preview.changedKeys.length} setting keys are valid.
                </strong>
                <p>
                  {preview.groupPolicyCount} group policies and{" "}
                  {preview.screenPolicyCount} screen policies are present.
                </p>
                <div>
                  <RheaButton
                    variant="default"

                    disabled={apply.isPending}
                    onClick={() => {
                      void confirm({
                        title: "Apply this validated settings document?",
                        action: "Apply",
                      }).then((ok) => {
                        if (ok) apply.mutate();
                      });
                    }}
                  >
                    Apply imported settings
                  </RheaButton>
                </div>
              </AlertDescription>
            </Alert>
          )}
        </section>
      </div>
    </>
  );
}
async function exportSettings() {
  const data = await api.exportSettings();
  const blob = new Blob([JSON.stringify(data, null, 2)], {
    type: "application/json",
  });
  const link = Object.assign(window.document.createElement("a"), {
    href: URL.createObjectURL(blob),
    download: `tilecast-settings-${new Date().toISOString().slice(0, 10)}.json`,
  });
  link.click();
  URL.revokeObjectURL(link.href);
}

const defaultVisibleReleaseCount = 5;

export function PlayerUpdatesPanel({
  owner,
  manageable,
}: {
  owner: boolean;
  manageable: boolean;
}) {
  const auth = useAuth();
  const client = useQueryClient();
  const releases = useQuery({
    queryKey: ["player-releases"],
    queryFn: api.playerReleases,
    refetchInterval: (query) =>
      query.state.data?.items.some((item) => item.cacheStatus === "downloading")
        ? 1_000
        : 10_000,
  });
  const deployments = useQuery({
    queryKey: ["update-deployments"],
    queryFn: api.updateDeployments,
    // A rollout in flight changes its counts every few seconds; a history of
    // finished ones does not, and polling it at that rate buys nothing.
    refetchInterval: (query) =>
      query.state.data?.items.some(
        (item) => item.status === "active" || item.status === "paused",
      )
        ? 3_000
        : 15_000,
  });
  const screens = useQuery({ queryKey: ["screens"], queryFn: api.screens });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
  });
  // The chosen platform lives in the URL, not in component state, so a reload,
  // a bookmark, or the back button all keep the fleet the operator was looking
  // at instead of silently returning to Android.
  const [searchParams, setSearchParams] = useSearchParams();
  const platform: PlayerPlatform =
    searchParams.get("platform") === "linux" ? "linux" : "android";
  const [releaseId, setReleaseId] = useState("");
  const [screenIds, setScreenIds] = useState<string[]>([]);
  const [groupIds, setGroupIds] = useState<string[]>([]);
  const [mode, setMode] = useState("download_only");
  const [canarySize, setCanarySize] = useState(0);
  const [windowStart, setWindowStart] = useState("");
  const [targetSearch, setTargetSearch] = useState("");
  const [showUpload, setShowUpload] = useState(false);
  const [showAllReleases, setShowAllReleases] = useState(false);
  const [confirmDeploy, setConfirmDeploy] = useState(false);
  const [purging, setPurging] = useState<PlayerRelease>();
  const [openDeployment, setOpenDeployment] = useState<string>();
  const [purgeNotice, setPurgeNotice] = useState("");
  const [deploySuccess, setDeploySuccess] = useState("");
  const [githubFlow, setGitHubFlow] = useState<
    (GitHubDeviceStart & { retryAfterSeconds: number }) | null
  >(null);
  const [githubAuthMessage, setGitHubAuthMessage] = useState("");
  const check = useMutation({
    mutationFn: () => api.checkPlayerReleases(auth.status?.csrfToken ?? ""),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["player-releases"] }),
  });
  const cache = useMutation({
    mutationFn: (id: string) =>
      api.cachePlayerRelease(id, auth.status?.csrfToken ?? ""),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["player-releases"] }),
  });
  const purge = useMutation({
    mutationFn: (release: PlayerRelease) =>
      api.deletePlayerRelease(release.id, auth.status?.csrfToken ?? ""),
    onMutate: () => setPurgeNotice(""),
    onSuccess: async (result) => {
      setPurging(undefined);
      setPurgeNotice(
        result.deleted
          ? "Release deleted and its cached file freed."
          : "Cached file freed. The release stays listed for its deployment history.",
      );
      await client.invalidateQueries({ queryKey: ["player-releases"] });
    },
  });
  const startGitHubAuth = useMutation({
    mutationFn: () =>
      api.startGitHubDeviceAuthorization(auth.status?.csrfToken ?? ""),
    onMutate: () => setGitHubAuthMessage(""),
    onSuccess: (flow) =>
      setGitHubFlow({
        ...flow,
        retryAfterSeconds: flow.pollIntervalSeconds,
      }),
    onError: (error) => setGitHubAuthMessage(error.message),
  });
  const disconnectGitHub = useMutation({
    mutationFn: () => api.disconnectGitHub(auth.status?.csrfToken ?? ""),
    onMutate: () => setGitHubAuthMessage(""),
    onSuccess: async () => {
      setGitHubFlow(null);
      setGitHubAuthMessage("GitHub account disconnected.");
      await client.invalidateQueries({ queryKey: ["player-releases"] });
    },
    onError: (error) => setGitHubAuthMessage(error.message),
  });
  useEffect(() => {
    if (!githubFlow) return;
    let cancelled = false;
    const timeout = window.setTimeout(() => {
      void api
        .pollGitHubDeviceAuthorization(
          githubFlow.flowId,
          auth.status?.csrfToken ?? "",
        )
        .then(async (result) => {
          if (cancelled) return;
          if (result.status === "connected") {
            setGitHubFlow(null);
            setGitHubAuthMessage(
              `Connected to GitHub as @${result.login ?? "authorized user"}.`,
            );
            await client.invalidateQueries({
              queryKey: ["player-releases"],
            });
            return;
          }
          if (result.status === "denied" || result.status === "expired") {
            setGitHubFlow(null);
            setGitHubAuthMessage(
              result.status === "denied"
                ? "GitHub authorization was declined."
                : "The GitHub authorization code expired. Start again for a new code.",
            );
            return;
          }
          setGitHubFlow((current) =>
            current?.flowId === githubFlow.flowId
              ? {
                  ...current,
                  retryAfterSeconds:
                    result.retryAfterSeconds ?? current.pollIntervalSeconds,
                }
              : current,
          );
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setGitHubFlow(null);
          setGitHubAuthMessage(
            error instanceof Error
              ? error.message
              : "GitHub authorization could not be completed.",
          );
        });
    }, githubFlow.retryAfterSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [auth.status?.csrfToken, client, githubFlow]);
  const deploy = useMutation({
    mutationFn: () =>
      api.createUpdateDeployment(
        {
          releaseId,
          name: `Tilecast Player ${releases.data?.items?.find((item) => item.id === releaseId)?.versionName ?? "update"}`,
          mode,
          screenIds,
          groupIds,
          canarySize,
          maintenanceWindowStart:
            mode === "maintenance_window" && windowStart
              ? new Date(windowStart).toISOString()
              : undefined,
        },
        auth.status?.csrfToken ?? "",
      ),
    onMutate: () => {
      setConfirmDeploy(false);
      setDeploySuccess("");
    },
    onSuccess: async (created) => {
      setScreenIds([]);
      setGroupIds([]);
      await client.invalidateQueries({ queryKey: ["update-deployments"] });
      setDeploySuccess(
        `Deployment created for ${created.targetCount} ${created.targetCount === 1 ? "screen" : "screens"}.`,
      );
    },
  });
  const targetSet = new Set(screenIds);
  for (const group of groups.data?.items ?? [])
    if (groupIds.includes(group.id))
      for (const screen of group.screens) targetSet.add(screen.id);
  const selectedScreens = (screens.data?.items ?? []).filter(
    (screen) =>
      targetSet.has(screen.id) &&
      screenPlatformFamily(screen.platform) === platform,
  );
  const releaseItems = [...(releases.data?.items ?? [])]
    .filter((item) => item.platform === platform)
    .sort(
      (left, right) =>
        Date.parse(right.publishedAt) - Date.parse(left.publishedAt) ||
        right.versionCode - left.versionCode,
    );
  const visibleReleaseItems = showAllReleases
    ? releaseItems
    : releaseItems.slice(0, defaultVisibleReleaseCount);
  const deployableReleases = releaseItems.filter(
    (item) =>
      item.verificationStatus === "verified" && item.cacheStatus === "cached",
  );
  const platformLabel = platform === "android" ? "Android" : "Linux";
  const query = targetSearch.toLowerCase();
  const platformScreens = (screens.data?.items ?? []).filter(
    (item) => screenPlatformFamily(item.platform) === platform,
  );
  const matchingScreens = platformScreens.filter((item) =>
    item.name.toLowerCase().includes(query),
  );
  const matchingGroups = (groups.data?.items ?? []).filter((item) =>
    item.name.toLowerCase().includes(query),
  );
  const platformDeployments = (deployments.data?.items ?? []).filter(
    (item) => item.platform === platform,
  );
  const offlineTargets = selectedScreens.filter(
    (screen) => screen.status === "offline",
  ).length;
  const selectionCount = screenIds.length + groupIds.length;
  const windowMissing = mode === "maintenance_window" && !windowStart;
  return (
    <div className="grid gap-4">
      <ViewTabs
        label="Player platform"
        value={platform}
        items={[
          { value: "android", label: "Android" },
          { value: "linux", label: "Linux" },
        ]}
        onValueChange={(value) => {
          if (value === platform) return;
          const next = new URLSearchParams(searchParams);
          if (value === "android") next.delete("platform");
          else next.set("platform", value);
          setSearchParams(next);
          // Selections do not carry across platforms.
          setReleaseId("");
          setScreenIds([]);
          setGroupIds([]);
          setShowUpload(false);
          setShowAllReleases(false);
          setOpenDeployment(undefined);
        }}
      />
      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="grid gap-1">
            <h3 className="text-base font-semibold">
              Available {platformLabel} releases
            </h3>
            <p className="text-sm text-muted-foreground">
              Upload a signed release directly or optionally synchronize from{" "}
              <code>Gibsonmb71/tilecast</code>.
            </p>
          </div>
          {owner && (
            <div className="flex flex-wrap items-center justify-end gap-2">
              <RheaButton
                variant="secondary"
                disabled={check.isPending}
                onClick={() => check.mutate()}
              >
                {check.isPending ? (
                  <Spinner />
                ) : (
                  <RefreshCw size={16} aria-hidden="true" />
                )}
                {check.isPending ? "Synchronizing…" : "Sync from GitHub"}
              </RheaButton>
              <RheaButton
                variant="default"
                aria-expanded={showUpload}
                onClick={() => setShowUpload((visible) => !visible)}
              >
                <Upload size={16} aria-hidden="true" />
                Upload release
              </RheaButton>
            </div>
          )}
        </header>
        {releases.data && (
          <div className="grid gap-3 rounded-xl border border-border p-4">
            <div className="flex items-center gap-3">
              <Github size={20} aria-hidden="true" />
              <div className="grid gap-0.5">
                <strong className="text-sm font-semibold">
                  GitHub connection
                </strong>
                <span className="text-sm text-muted-foreground">
                  {releases.data.githubAuth.connected
                    ? releases.data.githubAuth.login
                      ? `Authorized as @${releases.data.githubAuth.login}`
                      : "Authorized with a server-managed token"
                    : "Anonymous API access"}
                </span>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <StatusDot
                tone={
                  releases.data.githubAuth.connected ? "success" : "neutral"
                }
                label={
                  releases.data.githubAuth.connected
                    ? "Connected"
                    : "Not connected"
                }
              />
              {owner &&
                !githubFlow &&
                (releases.data.githubAuth.canDisconnect ? (
                  <RheaButton
                    variant="ghost"
                    disabled={disconnectGitHub.isPending}
                    onClick={() => disconnectGitHub.mutate()}
                  >
                    {disconnectGitHub.isPending ? (
                      <Spinner />
                    ) : (
                      <LogOut size={16} aria-hidden="true" />
                    )}
                    {disconnectGitHub.isPending
                      ? "Disconnecting…"
                      : "Disconnect"}
                  </RheaButton>
                ) : !releases.data.githubAuth.connected ? (
                  <RheaButton
                    variant="secondary"
                    disabled={
                      !releases.data.githubAuth.available ||
                      startGitHubAuth.isPending
                    }
                    onClick={() => startGitHubAuth.mutate()}
                  >
                    {startGitHubAuth.isPending ? (
                      <Spinner />
                    ) : (
                      <Github size={16} aria-hidden="true" />
                    )}
                    {startGitHubAuth.isPending ? "Starting…" : "Connect GitHub"}
                  </RheaButton>
                ) : null)}
            </div>
            {githubFlow && (
              <div className="flex flex-wrap items-center gap-3" role="status">
                <div className="grid gap-0.5">
                  <span className="text-sm text-muted-foreground">
                    One-time code
                  </span>
                  <strong className="font-mono text-sm">
                    {githubFlow.userCode}
                  </strong>
                </div>
                <a
                  className={buttonVariants({ variant: "default" })}
                  href={githubFlow.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} aria-hidden="true" />
                  Open GitHub
                </a>
                <RheaButton variant="ghost" onClick={() => setGitHubFlow(null)}>
                  Cancel
                </RheaButton>
                <small className="text-xs text-muted-foreground">
                  Waiting for authorization…
                </small>
              </div>
            )}
            {!releases.data.githubAuth.available &&
              !releases.data.githubAuth.connected && (
                <small className="text-xs text-muted-foreground">
                  Configure <code>TILECAST_GITHUB_CLIENT_ID</code> with a
                  device-flow-enabled GitHub OAuth App to enable sign-in.
                </small>
              )}
            {githubAuthMessage && (
              <small className="text-xs text-muted-foreground" role="status">
                {githubAuthMessage}
              </small>
            )}
          </div>
        )}
        {showUpload && (
          <PlayerReleaseUpload
            platform={platform}
            csrfToken={auth.status?.csrfToken ?? ""}
            onImported={() => {
              void client.invalidateQueries({ queryKey: ["player-releases"] });
            }}
          />
        )}
        <div className="mt-4 grid gap-3">
          {releases.data && !releases.data.manifestKeyConfigured && (
            <Alert variant="destructive">
              <AlertTitle>
                Player update verification is not configured.
              </AlertTitle>
              <AlertDescription>
                Set <code>TILECAST_UPDATE_MANIFEST_PUBLIC_KEY</code> on the
                Tilecast server to the public Ed25519 key used by the Player
                release workflow, then restart the server.
              </AlertDescription>
            </Alert>
          )}
          {(check.error || releases.data?.providerError) && (
            <Alert variant="destructive">
              <AlertTitle>
                GitHub releases could not be synchronized.
              </AlertTitle>
              <AlertDescription>
                {check.error?.message ?? releases.data?.providerError}
              </AlertDescription>
            </Alert>
          )}
          {cache.error && (
            <Alert variant="destructive">
              <AlertTitle>The release could not be cached.</AlertTitle>
              <AlertDescription>{mutationError(cache.error)}</AlertDescription>
            </Alert>
          )}
          {purge.error && (
            <Alert variant="destructive">
              <AlertTitle>The release could not be removed.</AlertTitle>
              <AlertDescription>{mutationError(purge.error)}</AlertDescription>
            </Alert>
          )}
          {purgeNotice && (
            <Alert role="status">
              <AlertDescription>{purgeNotice}</AlertDescription>
            </Alert>
          )}
        </div>
        {releaseItems.length === 0 ? (
          <div className="mt-4 rounded-xl border border-border bg-muted p-6 text-center text-sm text-muted-foreground">
            {releases.isLoading
              ? "Loading releases…"
              : releases.error
                ? `Releases could not be loaded. ${mutationError(releases.error)}`
                : `No ${platformLabel} Player releases have been imported. Tilecast checks GitHub automatically; use Sync from GitHub to retry immediately.`}
          </div>
        ) : (
          <>
            <div className="overflow-x-auto rounded-xl border border-border">
              <table className="w-full min-w-[48rem] text-sm">
                <caption className="sr-only">
                  Available {platformLabel} Player releases
                </caption>
                <thead>
                  <tr className="border-b border-border text-left text-xs text-muted-foreground">
                    <th scope="col" className="px-3 py-2 font-medium">
                      Version
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Source
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Published
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Size
                    </th>
                    <th scope="col" className="px-3 py-2 font-medium">
                      Status
                    </th>
                    {owner && (
                      <th
                        scope="col"
                        aria-label="Actions"
                        className="px-3 py-2"
                      />
                    )}
                  </tr>
                </thead>
                <tbody id="player-releases-table-body">
                  {visibleReleaseItems.map((release) => {
                    const readiness = releaseReadiness(release);
                    return (
                      <tr
                        key={release.id}
                        className="border-b border-border last:border-0"
                      >
                        <th
                          scope="row"
                          className="px-3 py-2 text-left font-normal"
                        >
                          <span className="flex flex-wrap items-center gap-2">
                            <strong className="font-semibold">
                              {release.versionName}
                            </strong>
                            <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
                              {release.channel === "beta" ? "Beta" : "Stable"}
                            </span>
                          </span>
                          <small className="font-mono text-xs text-muted-foreground">
                            Code {release.versionCode}
                          </small>
                        </th>
                        <td className="px-3 py-2">
                          {release.source === "upload"
                            ? "Direct upload"
                            : "GitHub"}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap">
                          {new Date(release.publishedAt).toLocaleDateString()}
                        </td>
                        <td className="px-3 py-2 whitespace-nowrap tabular-nums">
                          {formatBytes(release.apkSizeBytes)}
                        </td>
                        <td className="px-3 py-2">
                          <StatusDot
                            tone={readiness.tone}
                            label={readiness.label}
                          />
                          {release.cacheStatus === "downloading" && (
                            <span className="player-release-cache-progress grid gap-1">
                              <progress
                                aria-label={`Caching ${release.versionName}: ${formatBytes(
                                  release.downloadedBytes,
                                )} of ${formatBytes(release.apkSizeBytes)} downloaded`}
                                value={Math.min(
                                  release.downloadedBytes,
                                  release.apkSizeBytes,
                                )}
                                max={release.apkSizeBytes}
                                className="w-full"
                              />
                              <small className="text-xs text-muted-foreground">
                                {formatBytes(release.downloadedBytes)} of{" "}
                                {formatBytes(release.apkSizeBytes)}
                              </small>
                            </span>
                          )}
                          {readiness.detail && (
                            <small className="text-xs text-muted-foreground">
                              {readiness.detail}
                            </small>
                          )}
                        </td>
                        {owner && (
                          <td className="px-3 py-2">
                            <div className="flex flex-wrap items-center gap-2">
                              {readiness.cacheable && (
                                <ReleaseCacheButton
                                  downloading={
                                    cache.isPending &&
                                    cache.variables === release.id
                                  }
                                  onDownload={() => cache.mutate(release.id)}
                                />
                              )}
                              {purgeAction(release) && (
                                <RheaButton
                                  variant="ghost"
                                  size="sm"
                                  title={
                                    purgeAction(release) === "delete"
                                      ? "Delete this release and free its cached file"
                                      : "Free the cached file and keep the deployment history"
                                  }
                                  disabled={
                                    purge.isPending &&
                                    purge.variables?.id === release.id
                                  }
                                  onClick={() => setPurging(release)}
                                >
                                  {purge.isPending &&
                                  purge.variables?.id === release.id ? (
                                    <Spinner />
                                  ) : (
                                    <Trash2 size={15} aria-hidden="true" />
                                  )}
                                  {purgeAction(release) === "delete"
                                    ? "Delete"
                                    : "Free file"}
                                </RheaButton>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {releaseItems.length > defaultVisibleReleaseCount && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-sm text-muted-foreground">
                  Showing {visibleReleaseItems.length} of {releaseItems.length}{" "}
                  releases, newest first.
                </span>
                <RheaButton
                  variant="ghost"
                  size="sm"
                  aria-controls="player-releases-table-body"
                  aria-expanded={showAllReleases}
                  onClick={() => setShowAllReleases((visible) => !visible)}
                >
                  {showAllReleases
                    ? "Show fewer releases"
                    : `Show all ${releaseItems.length} releases`}
                </RheaButton>
              </div>
            )}
          </>
        )}
        <RheaDialog
          open={Boolean(purging)}
          onOpenChange={(open) => {
            if (!open) setPurging(undefined);
          }}
        >
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>
                {purging && purgeAction(purging) === "delete"
                  ? "Delete this release?"
                  : "Free this cached file?"}
              </DialogTitle>
            </DialogHeader>
            {purging && (
              <div className="grid gap-3 text-sm">
                <p>
                  {purging.versionName} ({purging.versionCode}) frees{" "}
                  {formatBytes(purging.apkSizeBytes)} of server storage.
                </p>
                {purgeAction(purging) === "delete" ? (
                  <p>
                    It has never been deployed, so the release and its cached
                    file are both removed.
                  </p>
                ) : (
                  <p>
                    {purging.deploymentCount}{" "}
                    {purging.deploymentCount === 1
                      ? "deployment references"
                      : "deployments reference"}{" "}
                    this release, so it stays listed for that history and only
                    the cached file is removed.
                  </p>
                )}
                {purgeAction(purging) === "free" &&
                  purging.source === "upload" && (
                    <Alert role="status">
                      <AlertTitle>
                        This release was uploaded directly.
                      </AlertTitle>
                      <AlertDescription>
                        Tilecast cannot download it again. Deploying it later
                        requires uploading the same signed release once more.
                      </AlertDescription>
                    </Alert>
                  )}
              </div>
            )}
            <DialogFooter>
              <RheaButton variant="ghost" onClick={() => setPurging(undefined)}>
                Cancel
              </RheaButton>
              {purging && (
                <RheaButton
                  variant="destructive"
                  disabled={purge.isPending}
                  onClick={() => purge.mutate(purging)}
                >
                  {purge.isPending ? (
                    <Spinner />
                  ) : (
                    <Trash2 size={16} aria-hidden="true" />
                  )}
                  {purgeAction(purging) === "delete"
                    ? "Delete release"
                    : "Free cached file"}
                </RheaButton>
              )}
            </DialogFooter>
          </DialogContent>
        </RheaDialog>
      </section>
      {manageable && (
        <section className="grid gap-4 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">New deployment</h3>
            <p className="text-sm text-muted-foreground">
              Choose a cached, verified release and target {platformLabel}{" "}
              screens or Display Groups.
            </p>
          </header>
          <div className="grid gap-4 border-b border-border pb-4 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="deployment-release">
                Verified release
              </FieldLabel>
              <RheaSelect
                name="release"
                value={releaseId || "none"}
                onValueChange={(next) =>
                  setReleaseId(!next || next === "none" ? "" : next)
                }
                disabled={!deployableReleases.length}
              >
                <SelectTrigger
                  id="deployment-release"
                  aria-label="Verified release"
                >
                  <SelectValue>
                    {releaseId
                      ? (() => {
                          const selected = deployableReleases.find(
                            (item) => item.id === releaseId,
                          );
                          return selected
                            ? `${selected.versionName} · ${selected.channel}`
                            : releaseId;
                        })()
                      : deployableReleases.length
                        ? "Select a release"
                        : "No release is ready to deploy"}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="none">
                    {deployableReleases.length
                      ? "Select a release"
                      : "No release is ready to deploy"}
                  </SelectItem>
                  {deployableReleases.map((item) => (
                    <SelectItem key={item.id} value={item.id}>
                      {item.versionName} · {item.channel}
                    </SelectItem>
                  ))}
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="deployment-mode">Deployment mode</FieldLabel>
              <RheaSelect
                name="mode"
                value={mode}
                onValueChange={(next) => {
                  if (next) setMode(next);
                }}
              >
                <SelectTrigger
                  id="deployment-mode"
                  aria-label="Deployment mode"
                >
                  <SelectValue>
                    {mode === "download_only"
                      ? "Download only"
                      : mode === "install_now"
                        ? "Download and request installation"
                        : mode === "maintenance_window"
                          ? "Maintenance window"
                          : mode}
                  </SelectValue>
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="download_only">Download only</SelectItem>
                  <SelectItem value="install_now">
                    Download and request installation
                  </SelectItem>
                  <SelectItem value="maintenance_window">
                    Maintenance window
                  </SelectItem>
                </SelectContent>
              </RheaSelect>
            </Field>
            <Field>
              <FieldLabel htmlFor="deployment-canary">
                Canary screens
              </FieldLabel>
              <Input
                id="deployment-canary"
                type="number"
                min="0"
                max="50"
                value={canarySize}
                onChange={(event) =>
                  setCanarySize(Math.max(0, Number(event.target.value)))
                }
              />
              <small className="text-xs text-muted-foreground">
                Remaining targets wait until every canary reconnects. Use 0 to
                deploy to all targets at once.
              </small>
            </Field>
            {mode === "maintenance_window" && (
              <Field>
                <FieldLabel htmlFor="deployment-window">
                  Maintenance window
                </FieldLabel>
                <Input
                  id="deployment-window"
                  type="datetime-local"
                  value={windowStart}
                  onChange={(event) => setWindowStart(event.target.value)}
                />
                <small className="text-xs text-muted-foreground">
                  Players install at or after this local time on each screen.
                </small>
              </Field>
            )}
          </div>
          <div className="grid gap-2 overflow-hidden rounded-xl border border-border bg-card p-4">
            <label className="grid gap-1">
              <span className="text-sm font-medium">
                Target screens and Display Groups
              </span>
              <span className="flex items-center gap-2 rounded-2xl border border-transparent bg-input/50 px-3 py-2">
                <Search
                  size={16}
                  aria-hidden="true"
                  className="shrink-0 text-muted-foreground"
                />
                <Input
                  type="search"
                  value={targetSearch}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder="Search by name"
                  className="border-0 bg-transparent p-0"
                />
              </span>
            </label>
            <div
              className="grid gap-4 sm:grid-cols-2"
              role="group"
              aria-label="Deployment targets"
            >
              <div className="grid content-start gap-2">
                <h4 className="text-sm font-semibold">
                  {platformLabel} screens{" "}
                  <span className="font-normal text-muted-foreground">
                    {matchingScreens.length}
                  </span>
                </h4>
                <div className="grid max-h-64 gap-1 overflow-y-auto">
                  {matchingScreens.map((screen) => (
                    <Target
                      key={screen.id}
                      checked={screenIds.includes(screen.id)}
                      label={screen.name}
                      detail={`${screen.playerVersion} · ${screen.status}`}
                      onChange={(checked) =>
                        setScreenIds(
                          checked
                            ? [...screenIds, screen.id]
                            : screenIds.filter((id) => id !== screen.id),
                        )
                      }
                    />
                  ))}
                  {!matchingScreens.length && (
                    <p className="text-sm text-muted-foreground">
                      {platformScreens.length
                        ? "No screen matches this search."
                        : `No ${platformLabel} screens are enrolled.`}
                    </p>
                  )}
                </div>
              </div>
              <div className="grid content-start gap-2">
                <h4 className="text-sm font-semibold">
                  Display Groups{" "}
                  <span className="font-normal text-muted-foreground">
                    {matchingGroups.length}
                  </span>
                </h4>
                <div className="grid max-h-64 gap-1 overflow-y-auto">
                  {matchingGroups.map((group) => (
                    <Target
                      key={group.id}
                      checked={groupIds.includes(group.id)}
                      label={group.name}
                      detail={`${group.membershipCount} screens`}
                      onChange={(checked) =>
                        setGroupIds(
                          checked
                            ? [...groupIds, group.id]
                            : groupIds.filter((id) => id !== group.id),
                        )
                      }
                    />
                  ))}
                  {!matchingGroups.length && (
                    <p className="text-sm text-muted-foreground">
                      {groups.data?.items?.length
                        ? "No Display Group matches this search."
                        : "No Display Groups exist yet."}
                    </p>
                  )}
                </div>
              </div>
            </div>
          </div>
          {(deploy.error || deploySuccess) && (
            <div className="mt-4 grid gap-3">
              <Alert
                variant={deploy.error ? "destructive" : "default"}
                role={deploy.error ? undefined : "status"}
              >
                <AlertDescription>
                  {deploy.error ? mutationError(deploy.error) : deploySuccess}
                </AlertDescription>
              </Alert>
            </div>
          )}
          <div className="mt-3 flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
            <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
              <strong className="text-sm font-semibold text-foreground">
                {selectedScreens.length}{" "}
                {selectedScreens.length === 1 ? "screen" : "screens"} selected
              </strong>
              {offlineTargets > 0 && (
                <span className="text-sm text-muted-foreground">
                  {offlineTargets} offline
                </span>
              )}
              {selectionCount > 0 && (
                <RheaButton
                  variant="ghost"
                  size="sm"
                  onClick={() => {
                    setScreenIds([]);
                    setGroupIds([]);
                  }}
                >
                  Clear selection
                </RheaButton>
              )}
            </div>
            <RheaButton
              variant="default"
              disabled={
                !releaseId ||
                !selectedScreens.length ||
                windowMissing ||
                deploy.isPending
              }
              onClick={() => setConfirmDeploy(true)}
            >
              {deploy.isPending ? (
                <Spinner />
              ) : (
                <Rocket size={16} aria-hidden="true" />
              )}
              {deploy.isPending ? "Creating deployment…" : "Deploy update"}
            </RheaButton>
          </div>
          <RheaDialog
            open={confirmDeploy}
            onOpenChange={(open) => {
              if (!open) setConfirmDeploy(false);
            }}
          >
            <DialogContent className="max-w-md">
              <DialogHeader>
                <DialogTitle>Deploy this Player update?</DialogTitle>
              </DialogHeader>
              <div className="grid gap-3 text-sm">
                <p>
                  {selectedScreens.length}{" "}
                  {selectedScreens.length === 1 ? "screen" : "screens"} will
                  receive{" "}
                  {releaseItems.find((item) => item.id === releaseId)
                    ?.versionName ?? "this release"}{" "}
                  using {humanize(mode).toLowerCase()}.
                </p>
                <p>
                  {platform === "android"
                    ? "Android may require installation approval on each TV."
                    : "Each Linux player restarts into the new version."}
                </p>
                {offlineTargets > 0 && (
                  <p>
                    {offlineTargets} selected{" "}
                    {offlineTargets === 1 ? "screen is" : "screens are"} offline
                    and will update after reconnecting.
                  </p>
                )}
              </div>
              <DialogFooter>
                <RheaButton
                  variant="ghost"
                  onClick={() => setConfirmDeploy(false)}
                >
                  Cancel
                </RheaButton>
                <RheaButton
                  variant="default"
                  disabled={deploy.isPending}
                  onClick={() => deploy.mutate()}
                >
                  {deploy.isPending ? (
                    <Spinner />
                  ) : (
                    <Rocket size={16} aria-hidden="true" />
                  )}
                  Deploy update
                </RheaButton>
              </DialogFooter>
            </DialogContent>
          </RheaDialog>
        </section>
      )}
      <section className="grid gap-3 rounded-xl border border-border p-4">
        <header className="grid gap-1">
          <h3 className="text-base font-semibold">Deployment history</h3>
          <p className="text-sm text-muted-foreground">
            Open a deployment to read the status of each screen it reaches.
            Waiting for approval means the TV still needs someone to accept the
            installer; it is not a failure.
          </p>
        </header>
        {deployments.error && (
          <div className="mt-4 grid gap-3">
            <Alert variant="destructive">
              <AlertTitle>Deployment history could not be loaded.</AlertTitle>
              <AlertDescription>
                {mutationError(deployments.error)}
              </AlertDescription>
            </Alert>
          </div>
        )}
        <div className="overflow-x-auto rounded-xl border border-border">
          <table className="w-full min-w-[48rem] text-sm">
            <caption className="sr-only">
              {platformLabel} Player deployment history
            </caption>
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted-foreground">
                <th scope="col" className="px-3 py-2 font-medium">
                  Deployment
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Status
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  Screens
                </th>
                <th scope="col" className="px-3 py-2 font-medium">
                  What this needs
                </th>
              </tr>
            </thead>
            <tbody>
              {platformDeployments.map((item) => {
                const headline = deploymentHeadline(item);
                const needsAttention =
                  item.failedCount > 0 ||
                  item.waitingForUserCount > 0 ||
                  item.status === "paused";
                return (
                  <tr
                    key={item.id}
                    className="border-b border-border last:border-0"
                  >
                    <th scope="row" className="px-3 py-2 text-left font-normal">
                      <strong className="font-semibold">{item.name}</strong>
                      <small className="block font-mono text-xs text-muted-foreground">
                        {item.versionName} ({item.versionCode}) ·{" "}
                        {humanize(item.mode)}
                      </small>
                    </th>
                    <td className="px-3 py-2">
                      <UpdateStatus value={item.status} />
                      <small className="block text-xs text-muted-foreground">
                        {rolloutSummary(item)}
                      </small>
                    </td>
                    <td className="px-3 py-2">
                      <DeploymentMeter compact {...item} />
                      <small className="text-xs text-muted-foreground">
                        {outstandingSummary(item)}
                      </small>
                    </td>
                    <td className="px-3 py-2">
                      <span
                        className={
                          needsAttention
                            ? "text-xs font-semibold text-destructive"
                            : "text-sm"
                        }
                      >
                        {headline}
                      </span>
                      {item.lastFailure && (
                        <small className="block text-xs text-muted-foreground">
                          Last failure: {item.lastFailure}
                        </small>
                      )}
                      {/* The way in sits with the sentence that gives a reason
                          to take it, which also keeps this table at four
                          columns: a column of its own for one button forced a
                          horizontal scroll in a narrow settings pane. */}
                      <RheaButton
                        variant="secondary"
                        size="sm"
                        onClick={() => setOpenDeployment(item.id)}
                      >
                        <ListChecks size={15} aria-hidden="true" />
                        {item.targetCount}{" "}
                        {item.targetCount === 1 ? "screen" : "screens"}
                      </RheaButton>
                    </td>
                  </tr>
                );
              })}
              {!deployments.isLoading &&
                !deployments.error &&
                platformDeployments.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-4 text-center">
                      <span className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                        <CheckCircle2 size={18} aria-hidden="true" />
                        No {platformLabel} Player deployments have been created.
                      </span>
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </div>
      </section>
      {openDeployment && (
        <UpdateDeploymentDrawer
          deploymentId={openDeployment}
          screens={screens.data?.items ?? []}
          manageable={manageable}
          onClose={() => setOpenDeployment(undefined)}
        />
      )}
    </div>
  );
}

// A release that was never deployed can be removed outright. Once deployment
// history points at it the record has to stay, so the only thing left to
// reclaim is the cached artifact — and nothing at all once that is gone.
function purgeAction(release: PlayerRelease): "delete" | "free" | undefined {
  if (
    release.activeDeploymentCount > 0 ||
    release.cacheStatus === "downloading"
  )
    return undefined;
  if (release.deploymentCount === 0) return "delete";
  return release.cacheStatus === "missing" ? undefined : "free";
}

function ReleaseCacheButton({
  downloading,
  onDownload,
}: {
  downloading: boolean;
  onDownload: () => void;
}) {
  return (
    <RheaButton
      variant="ghost"
      size="sm"
      title="Download and verify this release"
      disabled={downloading}
      onClick={onDownload}
    >
      {downloading ? <Spinner /> : <Download size={15} aria-hidden="true" />}
      {downloading ? "Downloading…" : "Download"}
    </RheaButton>
  );
}

type ReleaseReadiness = {
  tone: "success" | "info" | "warning" | "danger" | "neutral";
  label: string;
  detail: string;
  cacheable: boolean;
};

// One column replaces the former Verification and Cache pair. A release is only
// deployable once its manifest signature is verified and the artifact is cached,
// so the leading status reports that combined truth and the detail line keeps
// both underlying values visible.
function releaseReadiness(release: PlayerRelease): ReleaseReadiness {
  if (release.verificationStatus === "failed")
    return {
      tone: "danger",
      label: "Verification failed",
      detail: release.verificationError ?? "Download and verify again.",
      cacheable: true,
    };
  if (release.cacheStatus === "failed")
    return {
      tone: "danger",
      label: "Download failed",
      detail: "Manifest verified. The artifact could not be cached.",
      cacheable: true,
    };
  if (release.cacheStatus === "downloading")
    return {
      tone: "info",
      label: "Downloading",
      detail: "Verification finishes once the artifact is cached.",
      cacheable: false,
    };
  if (release.cacheStatus !== "cached")
    return {
      tone: "warning",
      label: "Not cached",
      detail:
        release.verificationStatus === "verified_manifest"
          ? "Manifest signature verified. Download to deploy."
          : "Download to make this release deployable.",
      cacheable: true,
    };
  if (release.verificationStatus !== "verified")
    return {
      tone: "info",
      label: "Verifying",
      detail: "Artifact cached. Full verification has not finished.",
      cacheable: true,
    };
  // "Ready to deploy" already states both underlying facts, so no detail line is
  // added and healthy rows stay one line tall.
  return {
    tone: "success",
    label: "Ready to deploy",
    detail: "",
    cacheable: false,
  };
}

function rolloutSummary(item: UpdateDeployment) {
  const rollout =
    item.rolloutMode === "canary"
      ? `${item.canarySize ?? 0} canaries · ${humanize(item.rolloutPhase ?? "canary")}`
      : "All screens at once";
  return item.pauseReason ? `${rollout} · ${item.pauseReason}` : rollout;
}

function outstandingSummary(item: UpdateDeployment) {
  return `${item.succeededCount} of ${item.targetCount} updated`;
}

const RELEASE_FILE_NAMES: Record<PlayerPlatform, readonly string[]> = {
  android: [
    "tilecast-player.apk",
    "tilecast-player-update.json",
    "tilecast-player-update.json.sig",
  ],
  linux: [
    "tilecast-player.AppImage",
    "tilecast-player-update-linux.json",
    "tilecast-player-update-linux.json.sig",
  ],
};

function PlayerReleaseUpload({
  platform,
  csrfToken,
  onImported,
}: {
  platform: PlayerPlatform;
  csrfToken: string;
  onImported: () => void;
}) {
  const releaseFileNames = RELEASE_FILE_NAMES[platform];
  const manifestName = releaseFileNames[1];
  const artifactLabel = platform === "android" ? "APK" : "AppImage";
  const [files, setFiles] = useState<Record<string, File>>({});
  const [progress, setProgress] = useState(0);
  const [phase, setPhase] = useState<
    "selecting" | "uploading" | "verifying" | "complete"
  >("selecting");
  const [clientError, setClientError] = useState("");
  const upload = useMutation({
    mutationFn: () =>
      api.uploadPlayerRelease(
        releaseFileNames
          .map((name) => files[name])
          .filter((file): file is File => Boolean(file)),
        csrfToken,
        (value) => {
          setProgress(value);
          if (value >= 100) setPhase("verifying");
        },
      ),
    onMutate: () => {
      setProgress(0);
      setPhase("uploading");
    },
    onSuccess: () => {
      setPhase("complete");
      onImported();
    },
    onError: () => setPhase("selecting"),
  });
  const selectFiles = (selected: FileList | File[]) => {
    const next = { ...files };
    let error = "";
    for (const file of Array.from(selected)) {
      if (!releaseFileNames.includes(file.name)) {
        error = `Unexpected file: ${file.name}. Choose only the three signed release files.`;
        continue;
      }
      if (file.name === manifestName && file.size > 128 * 1024)
        error = "The update manifest must not exceed 128 KB.";
      else if (file.name.endsWith(".sig") && file.size > 4 * 1024)
        error = "The manifest signature must not exceed 4 KB.";
      else next[file.name] = file;
    }
    setClientError(error);
    setFiles(next);
    setPhase("selecting");
    upload.reset();
  };
  const ready = releaseFileNames.every((name) => files[name]) && !clientError;
  return (
    <div className="grid gap-3 rounded-xl border border-border p-4">
      <div className="grid gap-1">
        <h4 className="text-sm font-semibold">
          Upload signed {platform === "android" ? "Android" : "Linux"} release
        </h4>
        <p className="text-sm text-muted-foreground">
          All three files are verified before the {artifactLabel} enters
          Tilecast&apos;s private update cache.
        </p>
      </div>
      <label
        className="grid gap-1 rounded-xl border border-dashed border-border p-4 text-center"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          selectFiles(event.dataTransfer.files);
        }}
      >
        <strong className="text-sm font-semibold">
          Drop the release files here
        </strong>
        <span className="text-sm text-muted-foreground">
          or choose all three files
        </span>
        <input
          type="file"
          multiple
          onChange={(event) =>
            event.target.files && selectFiles(event.target.files)
          }
          disabled={upload.isPending}
        />
      </label>
      <div className="grid gap-1" aria-label="Release file validation">
        {releaseFileNames.map((name) => (
          <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
            <span aria-hidden="true">{files[name] ? "✓" : "○"}</span>
            <strong className="font-mono text-xs">{name}</strong>
            <small className="text-xs text-muted-foreground">
              {files[name] ? formatBytes(files[name].size) : "Required"}
            </small>
          </div>
        ))}
      </div>
      {(clientError || upload.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {clientError || (upload.error as Error).message}
          </AlertDescription>
        </Alert>
      )}
      {phase !== "selecting" && (
        <div className="grid gap-1" aria-live="polite">
          <div className="grid gap-0.5">
            <strong className="text-sm font-semibold">
              {phase === "uploading"
                ? `Uploading… ${progress}%`
                : phase === "verifying"
                  ? platform === "android"
                    ? "Verifying signature, APK, and package metadata…"
                    : "Verifying signature and AppImage hash…"
                  : "Release verified and cached"}
            </strong>
            {upload.data && (
              <span className="text-sm text-muted-foreground">
                Version {upload.data.versionName} ·{" "}
                {upload.data.channel === "beta" ? "Beta" : "Stable"} ·{" "}
                {formatBytes(upload.data.apkSizeBytes)}
              </span>
            )}
          </div>
          {phase !== "complete" && (
            <progress
              value={phase === "verifying" ? undefined : progress}
              max="100"
              className="w-full"
            />
          )}
          {upload.data?.releaseNotes && (
            <p className="text-sm text-muted-foreground">
              {upload.data.releaseNotes}
            </p>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <RheaButton
          variant="default"

          disabled={!ready || upload.isPending || phase === "complete"}
          onClick={() => upload.mutate()}
        >
          {upload.isPending ? "Importing release…" : "Upload and verify"}
        </RheaButton>
        <RheaButton
          variant="ghost"

          disabled={upload.isPending}
          onClick={() => {
            setFiles({});
            setClientError("");
            setPhase("selecting");
            upload.reset();
          }}
        >
          Clear files
        </RheaButton>
      </div>
    </div>
  );
}
function Target({
  checked,
  label,
  detail,
  onChange,
}: {
  checked: boolean;
  label: string;
  detail: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    // The wrapping label names the checkbox; no extra aria-label.
    <label className="flex cursor-pointer items-start gap-2 rounded-xl border border-border p-2 text-sm">
      <RheaCheckbox
        checked={checked}
        onCheckedChange={(next) => onChange(next === true)}
      />
      <span className="grid gap-0.5">
        <strong className="font-medium">{label}</strong>
        <small className="text-xs text-muted-foreground">{detail}</small>
      </span>
    </label>
  );
}
function UpdateStatus({ value }: { value: string }) {
  const tone = ["verified", "cached", "completed", "succeeded"].includes(value)
    ? "success"
    : ["failed", "error"].includes(value)
      ? "danger"
      : ["active", "pending", "downloading", "verified_manifest"].includes(
            value,
          )
        ? "info"
        : value === "paused"
          ? "warning"
          : "neutral";
  return <StatusDot tone={tone} label={humanize(value)} />;
}
function mutationError(error: unknown) {
  return error instanceof Error ? error.message : "The request failed.";
}
// One vocabulary for a screen's update state, shared with the deployment drawer
// so a state never reads one way in a table and another way in a detail view.
export function playerUpdateStateLabel(state: string) {
  const meaning = screenUpdateMeaning(state);
  return meaning.detail
    ? `${meaning.label} — ${meaning.detail}`
    : meaning.label;
}
export function canDeployPlayerUpdates(role: string | undefined) {
  return role === "owner" || role === "administrator";
}
function humanize(value: string) {
  return value
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
function formatBytes(value: number) {
  return value >= 1024 ** 3
    ? `${(value / 1024 ** 3).toFixed(1)} GB`
    : `${(value / 1024 ** 2).toFixed(1)} MB`;
}
function formatDuration(seconds: number) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return (
    [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`]
      .filter(Boolean)
      .join(" ") || "Less than a minute"
  );
}
