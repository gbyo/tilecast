import {
  Button,
  Dialog,
  Notice,
  Select,
  StatusDot,
  TableContainer,
  ViewTabs,
} from "../components/ui";
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
import { useSpectrumDialogs } from "../dialogs/SpectrumDialogs";
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
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
  const client = useQueryClient();
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
      <div className="notice">Owner or Administrator access is required.</div>
    );
  const s = query.data;
  return (
    <div className="settings-sections">
      <section className="settings-subsection">
        <header>
          <h3>Diagnostics</h3>
          <p>Runtime status without secrets or sensitive paths.</p>
        </header>
        {query.error ? (
          <div className="notice notice--error" role="alert">
            System diagnostics could not be loaded. {query.error.message}
          </div>
        ) : !s ? (
          <div className="table-loading">Loading diagnostics…</div>
        ) : (
          <dl className="system-settings-grid">
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
                typeof s.media.status === "string" ? s.media.status : "unknown"
              }
            />
            <Item
              label="Connected screens"
              value={String(s.connectedScreens)}
            />
            <Item label="Pending commands" value={String(s.pendingCommands)} />
            <Item
              label="Processing jobs"
              value={String(s.activeProcessingJobs)}
            />
            <Item label="Server timezone" value={s.serverTimezone} />
          </dl>
        )}
      </section>
      <section className="settings-subsection">
        <header>
          <h3>Maintenance</h3>
          <p>Run approved maintenance tasks.</p>
        </header>
        <div className="maintenance-list">
          {maintenanceActions.map((action) => (
            <div key={action.id}>
              <span>
                <strong>{action.label}</strong>
                <small>{action.description}</small>
              </span>
              <button
                className="button button--quiet"
                disabled={maintenance.isPending}
                onClick={async () => {
                  if (
                    !action.confirm ||
                    await confirm({
                      title: `${action.label}?`,
                      description: action.description,
                      confirmLabel: action.label,
                    })
                  )
                    maintenance.mutate(action.id);
                }}
              >
                {maintenance.isPending && maintenance.variables === action.id
                  ? "Running…"
                  : "Run"}
              </button>
            </div>
          ))}
        </div>
        {maintenance.isSuccess && (
          <div className="notice notice--success" role="status">
            Maintenance action completed.
          </div>
        )}
        {maintenance.error && (
          <div className="notice notice--error" role="alert">
            {maintenance.error.message}
          </div>
        )}
      </section>
    </div>
  );
}
function Item({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{value}</dd>
    </div>
  );
}

export function ImportExportPanel({ owner }: { owner: boolean }) {
  const { confirm } = useSpectrumDialogs();
  const auth = useAuth();
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
      <div className="notice">
        Only the Owner may import or export settings.
      </div>
    );
  return (
    <div className="settings-sections">
      <section className="settings-subsection">
        <header>
          <h3>Export settings</h3>
          <p>
            Download organization settings and policy metadata without
            credentials, secrets, or media files.
          </p>
        </header>
        <button
          className="button button--primary"
          onClick={() => void exportSettings()}
        >
          Export non-secret settings
        </button>
      </section>
      <section className="settings-subsection">
        <header>
          <h3>Import settings</h3>
          <p>
            Tilecast validates the document and shows a preview before anything
            changes.
          </p>
        </header>
        <label className="file-input">
          Settings file
          <input
            type="file"
            accept="application/json"
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
        <button
          className="button button--quiet"
          disabled={!document || previewMutation.isPending}
          onClick={() => previewMutation.mutate()}
        >
          {previewMutation.isPending ? "Validating…" : "Validate and preview"}
        </button>
        {preview && (
          <div className="notice">
            <strong>
              {preview.changedKeys.length} setting keys are valid.
            </strong>
            <p>
              {preview.groupPolicyCount} group policies and{" "}
              {preview.screenPolicyCount} screen policies are present.
            </p>
            <button
              className="button button--primary"
              disabled={apply.isPending}
              onClick={async () => {
                if (await confirm({
                  title: "Apply this validated settings document?",
                  description:
                    "The imported values will replace the matching settings and policies in this installation.",
                  confirmLabel: "Apply settings",
                  tone: "negative",
                }))
                  apply.mutate();
              }}
            >
              Apply imported settings
            </button>
          </div>
        )}
      </section>
    </div>
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
    <div className="settings-sections player-updates">
      <ViewTabs
        className="player-updates__platform-tabs"
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
      <section className="settings-subsection player-updates__releases">
        <header className="settings-subsection__action">
          <div>
            <h3>Available {platformLabel} releases</h3>
            <p>
              Upload a signed release directly or optionally synchronize from{" "}
              <code>Gibsonmb71/tilecast</code>.
            </p>
          </div>
          {owner && (
            <div className="settings-inline-actions">
              <Button
                variant="secondary"
                loading={check.isPending}
                onClick={() => check.mutate()}
              >
                {!check.isPending && <RefreshCw size={16} aria-hidden="true" />}
                {check.isPending ? "Synchronizing…" : "Sync from GitHub"}
              </Button>
              <Button
                variant="primary"
                aria-expanded={showUpload}
                onClick={() => setShowUpload((visible) => !visible)}
              >
                <Upload size={16} aria-hidden="true" />
                Upload release
              </Button>
            </div>
          )}
        </header>
        {releases.data && (
          <div className="github-auth">
            <div className="github-auth__summary">
              <Github size={20} aria-hidden="true" />
              <div>
                <strong>GitHub connection</strong>
                <span>
                  {releases.data.githubAuth.connected
                    ? releases.data.githubAuth.login
                      ? `Authorized as @${releases.data.githubAuth.login}`
                      : "Authorized with a server-managed token"
                    : "Anonymous API access"}
                </span>
              </div>
            </div>
            <div className="github-auth__actions">
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
                  <Button
                    variant="quiet"
                    loading={disconnectGitHub.isPending}
                    onClick={() => disconnectGitHub.mutate()}
                  >
                    {!disconnectGitHub.isPending && (
                      <LogOut size={16} aria-hidden="true" />
                    )}
                    {disconnectGitHub.isPending
                      ? "Disconnecting…"
                      : "Disconnect"}
                  </Button>
                ) : !releases.data.githubAuth.connected ? (
                  <Button
                    variant="secondary"
                    disabled={!releases.data.githubAuth.available}
                    loading={startGitHubAuth.isPending}
                    onClick={() => startGitHubAuth.mutate()}
                  >
                    {!startGitHubAuth.isPending && (
                      <Github size={16} aria-hidden="true" />
                    )}
                    {startGitHubAuth.isPending ? "Starting…" : "Connect GitHub"}
                  </Button>
                ) : null)}
            </div>
            {githubFlow && (
              <div className="github-auth__device" role="status">
                <div>
                  <span>One-time code</span>
                  <strong className="technical">{githubFlow.userCode}</strong>
                </div>
                <a
                  className="button button--primary"
                  href={githubFlow.verificationUri}
                  target="_blank"
                  rel="noreferrer"
                >
                  <ExternalLink size={16} aria-hidden="true" />
                  Open GitHub
                </a>
                <Button variant="quiet" onClick={() => setGitHubFlow(null)}>
                  Cancel
                </Button>
                <small>Waiting for authorization…</small>
              </div>
            )}
            {!releases.data.githubAuth.available &&
              !releases.data.githubAuth.connected && (
                <small className="github-auth__configuration">
                  Configure <code>TILECAST_GITHUB_CLIENT_ID</code> with a
                  device-flow-enabled GitHub OAuth App to enable sign-in.
                </small>
              )}
            {githubAuthMessage && (
              <small className="github-auth__message" role="status">
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
        <div className="player-updates__notices">
          {releases.data && !releases.data.manifestKeyConfigured && (
            <Notice
              variant="danger"
              title="Player update verification is not configured."
            >
              Set <code>TILECAST_UPDATE_MANIFEST_PUBLIC_KEY</code> on the
              Tilecast server to the public Ed25519 key used by the Player
              release workflow, then restart the server.
            </Notice>
          )}
          {(check.error || releases.data?.providerError) && (
            <Notice
              variant="danger"
              title="GitHub releases could not be synchronized."
            >
              {check.error?.message ?? releases.data?.providerError}
            </Notice>
          )}
          {cache.error && (
            <Notice variant="danger" title="The release could not be cached.">
              {mutationError(cache.error)}
            </Notice>
          )}
          {purge.error && (
            <Notice variant="danger" title="The release could not be removed.">
              {mutationError(purge.error)}
            </Notice>
          )}
          {purgeNotice && <Notice variant="success">{purgeNotice}</Notice>}
        </div>
        {releaseItems.length === 0 ? (
          <div className="player-updates__empty">
            {releases.isLoading
              ? "Loading releases…"
              : releases.error
                ? `Releases could not be loaded. ${mutationError(releases.error)}`
                : `No ${platformLabel} Player releases have been imported. Tilecast checks GitHub automatically; use Sync from GitHub to retry immediately.`}
          </div>
        ) : (
          <>
            <TableContainer className="table-container player-updates-table-wrap">
              <table className="player-updates-table">
                <caption className="visually-hidden">
                  Available {platformLabel} Player releases
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Version</th>
                    <th scope="col">Source</th>
                    <th scope="col">Published</th>
                    <th scope="col">Size</th>
                    <th scope="col">Status</th>
                    {owner && <th scope="col" aria-label="Actions" />}
                  </tr>
                </thead>
                <tbody id="player-releases-table-body">
                  {visibleReleaseItems.map((release) => {
                    const readiness = releaseReadiness(release);
                    return (
                      <tr key={release.id}>
                        <th scope="row">
                          <span className="player-updates__version">
                            <strong>{release.versionName}</strong>
                            <span
                              className={`player-updates__channel player-updates__channel--${release.channel}`}
                            >
                              {release.channel === "beta" ? "Beta" : "Stable"}
                            </span>
                          </span>
                          <small className="technical">
                            Code {release.versionCode}
                          </small>
                        </th>
                        <td>
                          {release.source === "upload"
                            ? "Direct upload"
                            : "GitHub"}
                        </td>
                        <td>
                          {new Date(release.publishedAt).toLocaleDateString()}
                        </td>
                        <td>{formatBytes(release.apkSizeBytes)}</td>
                        <td>
                          <StatusDot
                            tone={readiness.tone}
                            label={readiness.label}
                          />
                          {release.cacheStatus === "downloading" && (
                            <span className="player-release-cache-progress">
                              <progress
                                aria-label={`Caching ${release.versionName}: ${formatBytes(
                                  release.downloadedBytes,
                                )} of ${formatBytes(release.apkSizeBytes)} downloaded`}
                                value={Math.min(
                                  release.downloadedBytes,
                                  release.apkSizeBytes,
                                )}
                                max={release.apkSizeBytes}
                              />
                              <small>
                                {formatBytes(release.downloadedBytes)} of{" "}
                                {formatBytes(release.apkSizeBytes)}
                              </small>
                            </span>
                          )}
                          {readiness.detail && (
                            <small>{readiness.detail}</small>
                          )}
                        </td>
                        {owner && (
                          <td>
                            <div className="player-updates__row-actions">
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
                                <Button
                                  variant="quiet"
                                  compact
                                  title={
                                    purgeAction(release) === "delete"
                                      ? "Delete this release and free its cached file"
                                      : "Free the cached file and keep the deployment history"
                                  }
                                  loading={
                                    purge.isPending &&
                                    purge.variables?.id === release.id
                                  }
                                  onClick={() => setPurging(release)}
                                >
                                  <Trash2 size={15} aria-hidden="true" />
                                  {purgeAction(release) === "delete"
                                    ? "Delete"
                                    : "Free file"}
                                </Button>
                              )}
                            </div>
                          </td>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </TableContainer>
            {releaseItems.length > defaultVisibleReleaseCount && (
              <div className="player-updates__release-list-controls">
                <span>
                  Showing {visibleReleaseItems.length} of {releaseItems.length}{" "}
                  releases, newest first.
                </span>
                <Button
                  variant="quiet"
                  compact
                  aria-controls="player-releases-table-body"
                  aria-expanded={showAllReleases}
                  onClick={() => setShowAllReleases((visible) => !visible)}
                >
                  {showAllReleases
                    ? "Show fewer releases"
                    : `Show all ${releaseItems.length} releases`}
                </Button>
              </div>
            )}
          </>
        )}
        <Dialog
          open={Boolean(purging)}
          title={
            purging && purgeAction(purging) === "delete"
              ? "Delete this release?"
              : "Free this cached file?"
          }
          onClose={() => setPurging(undefined)}
        >
          {purging && (
            <>
              <p>
                {purging.versionName} ({purging.versionCode}) frees{" "}
                {formatBytes(purging.apkSizeBytes)} of server storage.
              </p>
              {purgeAction(purging) === "delete" ? (
                <p>
                  It has never been deployed, so the release and its cached file
                  are both removed.
                </p>
              ) : (
                <p>
                  {purging.deploymentCount}{" "}
                  {purging.deploymentCount === 1
                    ? "deployment references"
                    : "deployments reference"}{" "}
                  this release, so it stays listed for that history and only the
                  cached file is removed.
                </p>
              )}
              {purgeAction(purging) === "free" &&
                purging.source === "upload" && (
                  <Notice
                    variant="warning"
                    title="This release was uploaded directly."
                  >
                    Tilecast cannot download it again. Deploying it later
                    requires uploading the same signed release once more.
                  </Notice>
                )}
              <footer className="player-updates-deploy-dialog__actions">
                <Button variant="quiet" onClick={() => setPurging(undefined)}>
                  Cancel
                </Button>
                <Button
                  variant="danger"
                  disabled={purge.isPending}
                  onClick={() => purge.mutate(purging)}
                >
                  <Trash2 size={16} aria-hidden="true" />
                  {purgeAction(purging) === "delete"
                    ? "Delete release"
                    : "Free cached file"}
                </Button>
              </footer>
            </>
          )}
        </Dialog>
      </section>
      {manageable && (
        <section className="settings-subsection player-updates__deployment">
          <header>
            <h3>New deployment</h3>
            <p>
              Choose a cached, verified release and target {platformLabel}{" "}
              screens or Display Groups.
            </p>
          </header>
          <div className="deployment-fields deployment-fields--primary">
            <label className="deployment-field deployment-field--release">
              Verified release
              <Select
                value={releaseId}
                onChange={(event) => setReleaseId(event.target.value)}
                disabled={!deployableReleases.length}
              >
                <option value="">
                  {deployableReleases.length
                    ? "Select a release"
                    : "No release is ready to deploy"}
                </option>
                {deployableReleases.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.versionName} · {item.channel}
                  </option>
                ))}
              </Select>
            </label>
            <label className="deployment-field deployment-field--mode">
              Deployment mode
              <Select
                value={mode}
                onChange={(event) => setMode(event.target.value)}
              >
                <option value="download_only">Download only</option>
                <option value="install_now">
                  Download and request installation
                </option>
                <option value="maintenance_window">Maintenance window</option>
              </Select>
            </label>
            <label className="deployment-field deployment-field--canary">
              Canary screens
              <input
                type="number"
                min="0"
                max="50"
                value={canarySize}
                onChange={(event) =>
                  setCanarySize(Math.max(0, Number(event.target.value)))
                }
              />
              <small>
                Remaining targets wait until every canary reconnects. Use 0 to
                deploy to all targets at once.
              </small>
            </label>
            {mode === "maintenance_window" && (
              <label className="deployment-field deployment-field--window">
                Maintenance window
                <input
                  type="datetime-local"
                  value={windowStart}
                  onChange={(event) => setWindowStart(event.target.value)}
                />
                <small>
                  Players install at or after this local time on each screen.
                </small>
              </label>
            )}
          </div>
          <div className="deployment-targets">
            <label className="target-search">
              <span>Target screens and Display Groups</span>
              <span className="target-search__control">
                <Search size={16} aria-hidden="true" />
                <input
                  type="search"
                  value={targetSearch}
                  onChange={(event) => setTargetSearch(event.target.value)}
                  placeholder="Search by name"
                />
              </span>
            </label>
            <div
              className="target-picker"
              role="group"
              aria-label="Deployment targets"
            >
              <div className="target-picker__column">
                <h4>
                  {platformLabel} screens <span>{matchingScreens.length}</span>
                </h4>
                <div className="target-picker__list">
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
                    <p className="target-picker__empty">
                      {platformScreens.length
                        ? "No screen matches this search."
                        : `No ${platformLabel} screens are enrolled.`}
                    </p>
                  )}
                </div>
              </div>
              <div className="target-picker__column">
                <h4>
                  Display Groups <span>{matchingGroups.length}</span>
                </h4>
                <div className="target-picker__list">
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
                    <p className="target-picker__empty">
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
            <div className="player-updates__notices">
              <Notice variant={deploy.error ? "danger" : "success"}>
                {deploy.error ? mutationError(deploy.error) : deploySuccess}
              </Notice>
            </div>
          )}
          <div className="deployment-submit">
            <div className="target-summary">
              <strong>
                {selectedScreens.length}{" "}
                {selectedScreens.length === 1 ? "screen" : "screens"} selected
              </strong>
              {offlineTargets > 0 && <span>{offlineTargets} offline</span>}
              {selectionCount > 0 && (
                <Button
                  variant="quiet"
                  compact
                  onClick={() => {
                    setScreenIds([]);
                    setGroupIds([]);
                  }}
                >
                  Clear selection
                </Button>
              )}
            </div>
            <Button
              variant="primary"
              disabled={!releaseId || !selectedScreens.length || windowMissing}
              loading={deploy.isPending}
              onClick={() => setConfirmDeploy(true)}
            >
              <Rocket size={16} aria-hidden="true" />
              {deploy.isPending ? "Creating deployment…" : "Deploy update"}
            </Button>
          </div>
          <Dialog
            className="player-updates-deploy-dialog"
            open={confirmDeploy}
            title="Deploy this Player update?"
            onClose={() => setConfirmDeploy(false)}
          >
            <p>
              {selectedScreens.length}{" "}
              {selectedScreens.length === 1 ? "screen" : "screens"} will receive{" "}
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
                {offlineTargets === 1 ? "screen is" : "screens are"} offline and
                will update after reconnecting.
              </p>
            )}
            <footer className="player-updates-deploy-dialog__actions">
              <Button variant="quiet" onClick={() => setConfirmDeploy(false)}>
                Cancel
              </Button>
              <Button
                variant="primary"
                disabled={deploy.isPending}
                onClick={() => deploy.mutate()}
              >
                <Rocket size={16} aria-hidden="true" />
                Deploy update
              </Button>
            </footer>
          </Dialog>
        </section>
      )}
      <section className="settings-subsection player-updates__history">
        <header>
          <h3>Deployment history</h3>
          <p>
            Open a deployment to read the status of each screen it reaches.
            Waiting for approval means the TV still needs someone to accept the
            installer; it is not a failure.
          </p>
        </header>
        {deployments.error && (
          <div className="player-updates__notices">
            <Notice
              variant="danger"
              title="Deployment history could not be loaded."
            >
              {mutationError(deployments.error)}
            </Notice>
          </div>
        )}
        <TableContainer className="table-container player-updates-table-wrap">
          <table className="player-updates-table">
            <caption className="visually-hidden">
              {platformLabel} Player deployment history
            </caption>
            <thead>
              <tr>
                <th scope="col">Deployment</th>
                <th scope="col">Status</th>
                <th scope="col">Screens</th>
                <th scope="col">What this needs</th>
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
                  <tr key={item.id}>
                    <th scope="row">
                      <strong>{item.name}</strong>
                      <small className="technical">
                        {item.versionName} ({item.versionCode}) ·{" "}
                        {humanize(item.mode)}
                      </small>
                    </th>
                    <td>
                      <UpdateStatus value={item.status} />
                      <small>{rolloutSummary(item)}</small>
                    </td>
                    <td>
                      <DeploymentMeter compact {...item} />
                      <small>{outstandingSummary(item)}</small>
                    </td>
                    <td>
                      <span
                        className={
                          needsAttention ? "deployment-attention" : undefined
                        }
                      >
                        {headline}
                      </span>
                      {item.lastFailure && (
                        <small>Last failure: {item.lastFailure}</small>
                      )}
                      {/* The way in sits with the sentence that gives a reason
                          to take it, which also keeps this table at four
                          columns: a column of its own for one button forced a
                          horizontal scroll in a narrow settings pane. */}
                      <Button
                        variant="secondary"
                        compact
                        onClick={() => setOpenDeployment(item.id)}
                      >
                        <ListChecks size={15} aria-hidden="true" />
                        {item.targetCount}{" "}
                        {item.targetCount === 1 ? "screen" : "screens"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
              {!deployments.isLoading &&
                !deployments.error &&
                platformDeployments.length === 0 && (
                  <tr>
                    <td colSpan={4} className="table-empty-state">
                      <CheckCircle2 size={18} aria-hidden="true" />
                      No {platformLabel} Player deployments have been created.
                    </td>
                  </tr>
                )}
            </tbody>
          </table>
        </TableContainer>
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
    <Button
      variant="quiet"
      compact
      title="Download and verify this release"
      loading={downloading}
      onClick={onDownload}
    >
      {!downloading && <Download size={15} aria-hidden="true" />}
      {downloading ? "Downloading…" : "Download"}
    </Button>
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
    <div className="player-release-upload">
      <div>
        <h4>
          Upload signed {platform === "android" ? "Android" : "Linux"} release
        </h4>
        <p>
          All three files are verified before the {artifactLabel} enters
          Tilecast&apos;s private update cache.
        </p>
      </div>
      <label
        className="player-release-dropzone"
        onDragOver={(event) => event.preventDefault()}
        onDrop={(event) => {
          event.preventDefault();
          selectFiles(event.dataTransfer.files);
        }}
      >
        <strong>Drop the release files here</strong>
        <span>or choose all three files</span>
        <input
          type="file"
          multiple
          onChange={(event) =>
            event.target.files && selectFiles(event.target.files)
          }
          disabled={upload.isPending}
        />
      </label>
      <div
        className="player-release-files"
        aria-label="Release file validation"
      >
        {releaseFileNames.map((name) => (
          <div key={name}>
            <span aria-hidden="true">{files[name] ? "✓" : "○"}</span>
            <strong>{name}</strong>
            <small>
              {files[name] ? formatBytes(files[name].size) : "Required"}
            </small>
          </div>
        ))}
      </div>
      {(clientError || upload.error) && (
        <div className="notice notice--danger" role="alert">
          {clientError || (upload.error as Error).message}
        </div>
      )}
      {phase !== "selecting" && (
        <div className="player-release-progress" aria-live="polite">
          <div>
            <strong>
              {phase === "uploading"
                ? `Uploading… ${progress}%`
                : phase === "verifying"
                  ? platform === "android"
                    ? "Verifying signature, APK, and package metadata…"
                    : "Verifying signature and AppImage hash…"
                  : "Release verified and cached"}
            </strong>
            {upload.data && (
              <span>
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
            />
          )}
          {upload.data?.releaseNotes && <p>{upload.data.releaseNotes}</p>}
        </div>
      )}
      <div className="settings-inline-actions">
        <button
          className="button button--primary"
          disabled={!ready || upload.isPending || phase === "complete"}
          onClick={() => upload.mutate()}
        >
          {upload.isPending ? "Importing release…" : "Upload and verify"}
        </button>
        <button
          className="button button--quiet"
          disabled={upload.isPending}
          onClick={() => {
            setFiles({});
            setClientError("");
            setPhase("selecting");
            upload.reset();
          }}
        >
          Clear files
        </button>
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
    <label className="target-option">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <strong>{label}</strong>
        <small>{detail}</small>
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
