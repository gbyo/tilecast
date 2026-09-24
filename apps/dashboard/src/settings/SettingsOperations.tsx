import { useConfirm } from "../components/ConfirmDialog";
import { DateTimeInput } from "../components/date-picker";
import { Alert, AlertDescription, AlertTitle } from "../components/ui/alert";
import { Badge } from "../components/ui/badge";
import { Button, buttonVariants } from "../components/ui/button";
import { Checkbox } from "../components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/ui/dialog";
import { Field, FieldLabel } from "../components/ui/field";
import { Input } from "../components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "../components/ui/input-group";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select";
import { Spinner } from "../components/ui/spinner";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { toast } from "../components/ui/toast";
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "../components/ui/tabs";
import { useEffect, useState } from "react";
import { Trans, useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
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
import { apiErrorMessage } from "../i18n";
import { screenPlatformFamily } from "../playerPlatform";
import type {
  GitHubDeviceStart,
  PlayerPlatform,
  PlayerRelease,
  UpdateDeployment,
} from "../api/types";
import { useAuth } from "../auth/AuthProvider";
import { useFormatLocale } from "../i18n";
import {
  DeploymentMeter,
  UpdateDeploymentDrawer,
} from "./UpdateDeploymentDrawer";
import { deploymentHeadline, screenUpdateMeaning } from "./playerUpdateStates";

type MaintenanceActionKey =
  | "operations.system.actions.expired-upload-cleanup.label"
  | "operations.system.actions.expired-upload-cleanup.description"
  | "operations.system.actions.completed-command-cleanup.label"
  | "operations.system.actions.completed-command-cleanup.description"
  | "operations.system.actions.retention-cleanup.label"
  | "operations.system.actions.retention-cleanup.description"
  | "operations.system.actions.reconcile-config.label"
  | "operations.system.actions.reconcile-config.description"
  | "operations.system.actions.validate-media.label"
  | "operations.system.actions.validate-media.description";

// Action names hold translation keys, never rendered text. Labels resolve
// with t() at render so the panel follows language changes.
const maintenanceActions: {
  id: string;
  labelKey: MaintenanceActionKey;
  descriptionKey: MaintenanceActionKey;
  confirm: boolean;
}[] = [
  {
    id: "expired-upload-cleanup",
    labelKey: "operations.system.actions.expired-upload-cleanup.label",
    descriptionKey:
      "operations.system.actions.expired-upload-cleanup.description",
    confirm: true,
  },
  {
    id: "completed-command-cleanup",
    labelKey: "operations.system.actions.completed-command-cleanup.label",
    descriptionKey:
      "operations.system.actions.completed-command-cleanup.description",
    confirm: true,
  },
  {
    id: "retention-cleanup",
    labelKey: "operations.system.actions.retention-cleanup.label",
    descriptionKey: "operations.system.actions.retention-cleanup.description",
    confirm: true,
  },
  {
    id: "reconcile-config",
    labelKey: "operations.system.actions.reconcile-config.label",
    descriptionKey: "operations.system.actions.reconcile-config.description",
    confirm: false,
  },
  {
    id: "validate-media",
    labelKey: "operations.system.actions.validate-media.label",
    descriptionKey: "operations.system.actions.validate-media.description",
    confirm: false,
  },
];
export function SystemPanel({ canManage }: { canManage: boolean }) {
  const { t } = useTranslation(["settings", "common"]);
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
    onSuccess: () => {
      toast.add({
        title: t("operations.system.completed"),
        type: "success",
      });
      return client.invalidateQueries({ queryKey: ["system-status"] });
    },
  });
  if (!canManage)
    return (
      <Alert role="status">
        <AlertDescription>{t("operations.system.ownerOnly")}</AlertDescription>
      </Alert>
    );
  const s = query.data;
  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.system.diagnosticsTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.system.diagnosticsHint")}
            </p>
          </header>
          {query.error ? (
            <Alert variant="destructive">
              <AlertDescription>
                {t("operations.system.diagnosticsError", {
                  error: query.error.message,
                })}
              </AlertDescription>
            </Alert>
          ) : !s ? (
            <p className="flex items-center gap-2 text-sm text-muted-foreground">
              <Spinner aria-hidden="true" />
              {t("operations.system.loadingDiagnostics")}
            </p>
          ) : (
            <dl className="my-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              <Item
                label={t("operations.system.fieldTilecast")}
                value={`${s.tilecastVersion} · ${s.buildCommit}`}
              />
              <Item
                label={t("operations.system.fieldUptime")}
                value={formatDuration(s.uptimeSeconds, t)}
              />
              <Item
                label={t("operations.system.fieldDatabase")}
                value={`${s.database.status} · migration ${s.database.migrationVersion}`}
              />
              <Item
                label={t("operations.system.fieldPostgres")}
                value={s.database.postgresVersion}
              />
              <Item
                label={t("operations.system.fieldMediaStorage")}
                value={
                  typeof s.media.status === "string"
                    ? s.media.status
                    : t("operations.system.unknownValue")
                }
              />
              <Item
                label={t("operations.system.fieldConnectedScreens")}
                value={String(s.connectedScreens)}
              />
              <Item
                label={t("operations.system.fieldPendingCommands")}
                value={String(s.pendingCommands)}
              />
              <Item
                label={t("operations.system.fieldProcessingJobs")}
                value={String(s.activeProcessingJobs)}
              />
              <Item
                label={t("operations.system.fieldServerTimezone")}
                value={s.serverTimezone}
              />
            </dl>
          )}
        </section>
        <section className="grid gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.system.maintenanceTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.system.maintenanceHint")}
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
                    {t(action.labelKey)}
                  </strong>
                  <small className="text-xs text-muted-foreground">
                    {t(action.descriptionKey)}
                  </small>
                </span>
                <Button
                  variant="ghost"

                  disabled={maintenance.isPending}
                  onClick={() => {
                    if (!action.confirm) {
                      maintenance.mutate(action.id);
                      return;
                    }
                    void confirm({
                      title: t("operations.system.runConfirmTitle", {
                        label: t(action.labelKey),
                      }),
                      action: t("operations.system.run"),
                    }).then((ok) => {
                      if (ok) maintenance.mutate(action.id);
                    });
                  }}
                >
                  {maintenance.isPending && maintenance.variables === action.id
                    ? t("operations.system.running")
                    : t("operations.system.run")}
                </Button>
              </div>
            ))}
          </div>
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
  const { t } = useTranslation(["settings", "common"]);
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
    onSuccess: () => {
      toast.add({
        title: t("operations.importExport.imported"),
        type: "success",
      });
    },
  });
  if (!owner)
    return (
      <Alert role="status">
        <AlertDescription>
          {t("operations.importExport.ownerOnly")}
        </AlertDescription>
      </Alert>
    );
  return (
    <>
      {confirmDialog}
      <div className="grid gap-4">
        <section className="grid content-start gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.importExport.exportTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.importExport.exportHint")}
            </p>
          </header>
          <div>
            <Button
              variant="default"

              onClick={() => void exportSettings()}
            >
              {t("operations.importExport.exportAction")}
            </Button>
          </div>
        </section>
        <section className="grid content-start gap-3 rounded-xl border border-border p-4">
          <header className="grid gap-1">
            <h3 className="text-base font-semibold">
              {t("operations.importExport.importTitle")}
            </h3>
            <p className="text-sm text-muted-foreground">
              {t("operations.importExport.importHint")}
            </p>
          </header>
          <Field>
            <FieldLabel htmlFor="settings-import-file">
              {t("operations.importExport.fileLabel")}
            </FieldLabel>
            <Input
              id="settings-import-file"
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
          </Field>
          <div>
            <Button
              variant="ghost"

              disabled={!document || previewMutation.isPending}
              onClick={() => previewMutation.mutate()}
            >
              {previewMutation.isPending
                ? t("operations.importExport.validating")
                : t("operations.importExport.validatePreview")}
            </Button>
          </div>
          {preview && (
            <Alert role="status">
              <AlertDescription className="grid gap-2">
                <strong>
                  {t("operations.importExport.validKeys", {
                    count: preview.changedKeys.length,
                  })}
                </strong>
                <p>
                  {t("operations.importExport.policiesPresent", {
                    group: preview.groupPolicyCount,
                    screen: preview.screenPolicyCount,
                  })}
                </p>
                <div>
                  <Button
                    variant="default"

                    disabled={apply.isPending}
                    onClick={() => {
                      void confirm({
                        title: t("operations.importExport.applyTitle"),
                        action: t("operations.importExport.apply"),
                      }).then((ok) => {
                        if (ok) apply.mutate();
                      });
                    }}
                  >
                    {t("operations.importExport.applyAction")}
                  </Button>
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
  const { t } = useTranslation(["settings", "common"]);
  const { t: tErrors } = useTranslation("errors");
  const locale = useFormatLocale();
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
  const [deploymentDrawerOpen, setDeploymentDrawerOpen] = useState(false);
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
      toast.add({
        title: result.deleted
          ? t("updates.panel.purgeDeleted")
          : t("updates.panel.purgeFreed"),
        type: "success",
      });
      setPurgeNotice(
        result.deleted
          ? t("updates.panel.purgeDeleted")
          : t("updates.panel.purgeFreed"),
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
      setGitHubAuthMessage(t("updates.panel.githubDisconnected"));
      toast.add({
        title: t("updates.panel.githubDisconnected"),
        type: "success",
      });
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
              t("updates.panel.githubConnected", {
                login: result.login ?? t("updates.panel.defaultLogin"),
              }),
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
                ? t("updates.panel.githubDeclined")
                : t("updates.panel.githubExpired"),
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
              : t("updates.panel.githubIncomplete"),
          );
        });
    }, githubFlow.retryAfterSeconds * 1000);
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
    };
  }, [auth.status?.csrfToken, client, githubFlow, t]);
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
        created.targetCount === 1
          ? t("updates.panel.deployCreatedOne", {
              count: created.targetCount,
            })
          : t("updates.panel.deployCreatedOther", {
              count: created.targetCount,
            }),
      );
      toast.add({
        title:
          created.targetCount === 1
            ? t("updates.panel.deployCreatedOne", {
                count: created.targetCount,
              })
            : t("updates.panel.deployCreatedOther", {
                count: created.targetCount,
              }),
        type: "success",
      });
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
  // Deployment modes read from the server as slugs; known slugs resolve to
  // translated names and anything unknown falls back to a readable form.
  const modeName = (value: string) =>
    value === "download_only"
      ? t("updates.panel.modeNameDownloadOnly")
      : value === "install_now"
        ? t("updates.panel.modeNameInstallNow")
        : value === "maintenance_window"
          ? t("updates.panel.modeNameMaintenanceWindow")
          : humanize(value);
  const modeDisplayName = modeName(mode);
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
      <Tabs
        value={platform}
        onValueChange={(value: string) => {
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
          setDeploymentDrawerOpen(false);
          setOpenDeployment(undefined);
        }}
        className="grid gap-4"
      >
        <TabsList variant="line" aria-label={t("updates.panel.platformLabel")}>
          {/* i18n-ignore: Android and Linux are platform names, not language text */}
          <TabsTrigger value="android">Android</TabsTrigger>
          {/* i18n-ignore: Android and Linux are platform names, not language text */}
          <TabsTrigger value="linux">Linux</TabsTrigger>
        </TabsList>
        <TabsContent value={platform} className="grid gap-4">
          <section className="grid gap-3 rounded-xl border border-border p-4">
            <header className="flex flex-wrap items-start justify-between gap-3">
              <div className="grid gap-1">
                <h3 className="text-base font-semibold">
                  {t("updates.panel.releasesTitle", {
                    platform: platformLabel,
                  })}
                </h3>
                <p className="text-sm text-muted-foreground">
                  <Trans
                    i18nKey="updates.panel.releasesHint"
                    ns="settings"
                    components={{
                      // i18n-ignore: repository name is a constant, not language text
                      repo: <code>Gibsonmb71/tilecast</code>, // i18n-ignore
                    }}
                  />
                </p>
              </div>
              {owner && (
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    disabled={check.isPending}
                    onClick={() => check.mutate()}
                  >
                    {check.isPending ? (
                      <Spinner />
                    ) : (
                      <RefreshCw size={16} aria-hidden="true" />
                    )}
                    {check.isPending
                      ? t("updates.panel.syncing")
                      : t("updates.panel.sync")}
                  </Button>
                  <Button
                    variant="default"
                    aria-expanded={showUpload}
                    onClick={() => setShowUpload((visible) => !visible)}
                  >
                    <Upload size={16} aria-hidden="true" />
                    {t("updates.panel.uploadRelease")}
                  </Button>
                </div>
              )}
            </header>
            {releases.data && (
              <div className="grid gap-3 rounded-xl border border-border p-4">
                <div className="flex items-center gap-3">
                  <Github size={20} aria-hidden="true" />
                  <div className="grid gap-0.5">
                    <strong className="text-sm font-semibold">
                      {t("updates.panel.githubTitle")}
                    </strong>
                    <span className="text-sm text-muted-foreground">
                      {releases.data.githubAuth.connected
                        ? releases.data.githubAuth.login
                          ? t("updates.panel.authorizedAs", {
                              login: releases.data.githubAuth.login,
                            })
                          : t("updates.panel.authorizedToken")
                        : t("updates.panel.anonymous")}
                    </span>
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Badge
                    {...statusBadgeAppearance(
                      releases.data.githubAuth.connected
                        ? "success"
                        : "neutral",
                    )}
                  >
                    {releases.data.githubAuth.connected
                      ? t("updates.panel.connected")
                      : t("updates.panel.notConnected")}
                  </Badge>
                  {owner &&
                    !githubFlow &&
                    (releases.data.githubAuth.canDisconnect ? (
                      <Button
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
                          ? t("updates.panel.disconnecting")
                          : t("updates.panel.disconnect")}
                      </Button>
                    ) : !releases.data.githubAuth.connected ? (
                      <Button
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
                        {startGitHubAuth.isPending
                          ? t("updates.panel.starting")
                          : t("updates.panel.connect")}
                      </Button>
                    ) : null)}
                </div>
                {githubFlow && (
                  <div
                    className="flex flex-wrap items-center gap-3"
                    role="status"
                  >
                    <div className="grid gap-0.5">
                      <span className="text-sm text-muted-foreground">
                        {t("updates.panel.oneTimeCode")}
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
                      {t("updates.panel.openGitHub")}
                    </a>
                    <Button variant="ghost" onClick={() => setGitHubFlow(null)}>
                      {t("common:actions.cancel")}
                    </Button>
                    <small className="text-xs text-muted-foreground">
                      {t("updates.panel.waitingAuth")}
                    </small>
                  </div>
                )}
                {!releases.data.githubAuth.available &&
                  !releases.data.githubAuth.connected && (
                    <small className="text-xs text-muted-foreground">
                      <Trans
                        i18nKey="updates.panel.setupHint"
                        ns="settings"
                        components={{
                          // i18n-ignore: environment variable name is a constant
                          clientId: <code>TILECAST_GITHUB_CLIENT_ID</code>, // i18n-ignore
                        }}
                      />
                    </small>
                  )}
                {githubAuthMessage && (
                  <small
                    className="text-xs text-muted-foreground"
                    role="status"
                  >
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
                  void client.invalidateQueries({
                    queryKey: ["player-releases"],
                  });
                }}
              />
            )}
            <div className="mt-4 grid gap-3">
              {releases.data && !releases.data.manifestKeyConfigured && (
                <Alert variant="destructive">
                  <AlertTitle>
                    {t("updates.panel.verificationTitle")}
                  </AlertTitle>
                  <AlertDescription>
                    <Trans
                      i18nKey="updates.panel.verificationHint"
                      ns="settings"
                      components={{
                        // i18n-ignore: environment variable name is a constant
                        key: <code>TILECAST_UPDATE_MANIFEST_PUBLIC_KEY</code>, // i18n-ignore
                      }}
                    />
                  </AlertDescription>
                </Alert>
              )}
              {(check.error || releases.data?.providerError) && (
                <Alert variant="destructive">
                  <AlertTitle>{t("updates.panel.syncErrorTitle")}</AlertTitle>
                  <AlertDescription>
                    {check.error?.message ?? releases.data?.providerError}
                  </AlertDescription>
                </Alert>
              )}
              {cache.error && (
                <Alert variant="destructive">
                  <AlertTitle>{t("updates.panel.cacheErrorTitle")}</AlertTitle>
                  <AlertDescription>
                    {mutationError(cache.error, tErrors)}
                  </AlertDescription>
                </Alert>
              )}
              {purge.error && (
                <Alert variant="destructive">
                  <AlertTitle>{t("updates.panel.removeErrorTitle")}</AlertTitle>
                  <AlertDescription>
                    {mutationError(purge.error, tErrors)}
                  </AlertDescription>
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
                  ? t("updates.panel.loadingReleases")
                  : releases.error
                    ? t("updates.panel.loadError", {
                        error: mutationError(releases.error, tErrors),
                      })
                    : t("updates.panel.emptyReleases", {
                        platform: platformLabel,
                      })}
              </div>
            ) : (
              <>
                <div className="overflow-x-auto rounded-xl border border-border">
                  <Table className="w-full min-w-[48rem] text-sm">
                    <caption className="sr-only">
                      {t("updates.panel.releasesCaption", {
                        platform: platformLabel,
                      })}
                    </caption>
                    <TableHeader>
                      <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
                        <TableHead
                          scope="col"
                          className="px-3 py-2 font-medium"
                        >
                          {t("updates.panel.version")}
                        </TableHead>
                        <TableHead
                          scope="col"
                          className="px-3 py-2 font-medium"
                        >
                          {t("updates.panel.source")}
                        </TableHead>
                        <TableHead
                          scope="col"
                          className="px-3 py-2 font-medium"
                        >
                          {t("updates.panel.published")}
                        </TableHead>
                        <TableHead
                          scope="col"
                          className="px-3 py-2 font-medium"
                        >
                          {t("updates.panel.size")}
                        </TableHead>
                        <TableHead
                          scope="col"
                          className="px-3 py-2 font-medium"
                        >
                          {t("updates.panel.status")}
                        </TableHead>
                        {owner && (
                          <TableHead
                            scope="col"
                            aria-label={t("updates.panel.actionsColumn")}
                            className="px-3 py-2"
                          />
                        )}
                      </TableRow>
                    </TableHeader>
                    <TableBody id="player-releases-table-body">
                      {visibleReleaseItems.map((release) => {
                        const readiness = releaseReadiness(release, t);
                        return (
                          <TableRow
                            key={release.id}
                            className="border-b border-border last:border-0"
                          >
                            <TableHead
                              scope="row"
                              className="px-3 py-2 text-left font-normal"
                            >
                              <span className="flex flex-wrap items-center gap-2">
                                <strong className="font-semibold">
                                  {release.versionName}
                                </strong>
                                <Badge variant="secondary">
                                  {release.channel === "beta"
                                    ? t("updates.panel.channelBeta")
                                    : t("updates.panel.channelStable")}
                                </Badge>
                              </span>
                              <small className="font-mono text-xs text-muted-foreground">
                                {t("updates.panel.code", {
                                  code: release.versionCode,
                                })}
                              </small>
                            </TableHead>
                            <TableCell className="px-3 py-2">
                              {release.source === "upload"
                                ? t("updates.panel.sourceUpload")
                                : t("updates.panel.sourceGitHub")}
                            </TableCell>
                            <TableCell className="px-3 py-2 whitespace-nowrap">
                              {new Date(release.publishedAt).toLocaleDateString(
                                locale,
                              )}
                            </TableCell>
                            <TableCell className="px-3 py-2 whitespace-nowrap tabular-nums">
                              {formatBytes(release.apkSizeBytes)}
                            </TableCell>
                            <TableCell className="px-3 py-2">
                              <Badge {...statusBadgeAppearance(readiness.tone)}>
                                {readiness.label}
                              </Badge>
                              {release.cacheStatus === "downloading" && (
                                <span className="player-release-cache-progress grid gap-1">
                                  <progress
                                    aria-label={t(
                                      "updates.panel.cachingLabel",
                                      {
                                        version: release.versionName,
                                        downloaded: formatBytes(
                                          release.downloadedBytes,
                                        ),
                                        total: formatBytes(
                                          release.apkSizeBytes,
                                        ),
                                      },
                                    )}
                                    value={Math.min(
                                      release.downloadedBytes,
                                      release.apkSizeBytes,
                                    )}
                                    max={release.apkSizeBytes}
                                    className="w-full"
                                  />
                                  <small className="text-xs text-muted-foreground">
                                    {t("updates.panel.downloadProgress", {
                                      downloaded: formatBytes(
                                        release.downloadedBytes,
                                      ),
                                      total: formatBytes(release.apkSizeBytes),
                                    })}
                                  </small>
                                </span>
                              )}
                              {readiness.detail && (
                                <small className="text-xs text-muted-foreground">
                                  {readiness.detail}
                                </small>
                              )}
                            </TableCell>
                            {owner && (
                              <TableCell className="px-3 py-2">
                                <div className="flex flex-wrap items-center gap-2">
                                  {readiness.cacheable && (
                                    <ReleaseCacheButton
                                      downloading={
                                        cache.isPending &&
                                        cache.variables === release.id
                                      }
                                      onDownload={() =>
                                        cache.mutate(release.id)
                                      }
                                    />
                                  )}
                                  {purgeAction(release) && (
                                    <Button
                                      variant="ghost"
                                      size="sm"
                                      title={
                                        purgeAction(release) === "delete"
                                          ? t("updates.panel.purgeDeleteTitle")
                                          : t("updates.panel.purgeFreeTitle")
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
                                        ? t("updates.panel.rowDelete")
                                        : t("updates.panel.rowFree")}
                                    </Button>
                                  )}
                                </div>
                              </TableCell>
                            )}
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>
                {releaseItems.length > defaultVisibleReleaseCount && (
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-sm text-muted-foreground">
                      {t("updates.panel.showing", {
                        shown: visibleReleaseItems.length,
                        total: releaseItems.length,
                      })}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-controls="player-releases-table-body"
                      aria-expanded={showAllReleases}
                      onClick={() => setShowAllReleases((visible) => !visible)}
                    >
                      {showAllReleases
                        ? t("updates.panel.showFewer")
                        : t("updates.panel.showAll", {
                            total: releaseItems.length,
                          })}
                    </Button>
                  </div>
                )}
              </>
            )}
            <Dialog
              open={Boolean(purging)}
              onOpenChange={(open) => {
                if (!open) setPurging(undefined);
              }}
            >
              <DialogContent className="max-w-md">
                <DialogHeader>
                  <DialogTitle>
                    {purging && purgeAction(purging) === "delete"
                      ? t("updates.panel.purgeDeleteHeading")
                      : t("updates.panel.purgeFreeHeading")}
                  </DialogTitle>
                </DialogHeader>
                {purging && (
                  <div className="grid gap-3 text-sm">
                    <p>
                      {t("updates.panel.freesStorage", {
                        version: purging.versionName,
                        code: purging.versionCode,
                        size: formatBytes(purging.apkSizeBytes),
                      })}
                    </p>
                    {purgeAction(purging) === "delete" ? (
                      <p>{t("updates.panel.neverDeployed")}</p>
                    ) : (
                      <p>
                        {t("updates.panel.historyHint", {
                          count: purging.deploymentCount,
                          ref:
                            purging.deploymentCount === 1
                              ? t("updates.panel.historyRefOne")
                              : t("updates.panel.historyRefOther"),
                        })}
                      </p>
                    )}
                    {purgeAction(purging) === "free" &&
                      purging.source === "upload" && (
                        <Alert role="status">
                          <AlertTitle>
                            {t("updates.panel.directTitle")}
                          </AlertTitle>
                          <AlertDescription>
                            {t("updates.panel.directHint")}
                          </AlertDescription>
                        </Alert>
                      )}
                  </div>
                )}
                <DialogFooter>
                  <Button variant="ghost" onClick={() => setPurging(undefined)}>
                    {t("common:actions.cancel")}
                  </Button>
                  {purging && (
                    <Button
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
                        ? t("updates.panel.confirmDelete")
                        : t("updates.panel.confirmFree")}
                    </Button>
                  )}
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </section>
          {manageable && (
            <section className="grid gap-4 rounded-xl border border-border p-4">
              <header className="grid gap-1">
                <h3 className="text-base font-semibold">
                  {t("updates.panel.deployTitle")}
                </h3>
                <p className="text-sm text-muted-foreground">
                  {t("updates.panel.deployHint", { platform: platformLabel })}
                </p>
              </header>
              <div className="grid gap-4 border-b border-border pb-4 sm:grid-cols-2">
                <Field>
                  <FieldLabel htmlFor="deployment-release">
                    {t("updates.panel.releaseLabel")}
                  </FieldLabel>
                  <Select
                    items={[
                      {
                        value: "none",
                        label: deployableReleases.length
                          ? t("updates.panel.selectRelease")
                          : t("updates.panel.noRelease"),
                      },
                      ...deployableReleases.map((item) => ({
                        value: item.id,
                        label: `${item.versionName} · ${item.channel}`,
                      })),
                    ]}
                    name="release"
                    value={releaseId || "none"}
                    onValueChange={(next) =>
                      setReleaseId(!next || next === "none" ? "" : next)
                    }
                    disabled={!deployableReleases.length}
                  >
                    <SelectTrigger
                      id="deployment-release"
                      aria-label={t("updates.panel.releaseLabel")}
                    >
                      <SelectValue>
                        {releaseId
                          ? (() => {
                              const selected = deployableReleases.find(
                                (item) => item.id === releaseId,
                              );
                              return selected
                                ? `${selected.versionName} · ${
                                    selected.channel === "beta"
                                      ? t("updates.panel.channelBeta")
                                      : t("updates.panel.channelStable")
                                  }`
                                : releaseId;
                            })()
                          : deployableReleases.length
                            ? t("updates.panel.selectRelease")
                            : t("updates.panel.noRelease")}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="none">
                        {deployableReleases.length
                          ? t("updates.panel.selectRelease")
                          : t("updates.panel.noRelease")}
                      </SelectItem>
                      {deployableReleases.map((item) => (
                        <SelectItem key={item.id} value={item.id}>
                          {item.versionName} ·{" "}
                          {item.channel === "beta"
                            ? t("updates.panel.channelBeta")
                            : t("updates.panel.channelStable")}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-mode">
                    {t("updates.panel.modeLabel")}
                  </FieldLabel>
                  <Select
                    items={[
                      {
                        value: "download_only",
                        label: t("updates.panel.modeDownloadOnly"),
                      },
                      {
                        value: "install_now",
                        label: t("updates.panel.modeInstallNow"),
                      },
                      {
                        value: "maintenance_window",
                        label: t("updates.panel.modeMaintenanceWindow"),
                      },
                    ]}
                    name="mode"
                    value={mode}
                    onValueChange={(next) => {
                      if (next) setMode(next);
                    }}
                  >
                    <SelectTrigger
                      id="deployment-mode"
                      aria-label={t("updates.panel.modeLabel")}
                    >
                      <SelectValue>
                        {mode === "download_only"
                          ? t("updates.panel.modeDownloadOnly")
                          : mode === "install_now"
                            ? t("updates.panel.modeInstallNow")
                            : mode === "maintenance_window"
                              ? t("updates.panel.modeMaintenanceWindow")
                              : mode}
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="download_only">
                        {t("updates.panel.modeDownloadOnly")}
                      </SelectItem>
                      <SelectItem value="install_now">
                        {t("updates.panel.modeInstallNow")}
                      </SelectItem>
                      <SelectItem value="maintenance_window">
                        {t("updates.panel.modeMaintenanceWindow")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field>
                  <FieldLabel htmlFor="deployment-canary">
                    {t("updates.panel.canaryLabel")}
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
                    {t("updates.panel.canaryHint")}
                  </small>
                </Field>
                {mode === "maintenance_window" && (
                  <Field>
                    <FieldLabel htmlFor="deployment-window">
                      {t("updates.panel.windowLabel")}
                    </FieldLabel>
                    <DateTimeInput
                      id="deployment-window"
                      aria-label={t("updates.panel.windowLabel")}
                      timeLabel={t("updates.panel.windowTimeLabel")}
                      value={windowStart}
                      onChange={setWindowStart}
                    />
                    <small className="text-xs text-muted-foreground">
                      {t("updates.panel.windowHint")}
                    </small>
                  </Field>
                )}
              </div>
              <div className="grid gap-2 overflow-hidden rounded-xl border border-border bg-card p-4">
                <Field className="gap-1">
                  <FieldLabel htmlFor="deployment-target-search">
                    {t("updates.panel.targetsLabel")}
                  </FieldLabel>
                  <InputGroup>
                    <InputGroupAddon>
                      <Search aria-hidden="true" />
                    </InputGroupAddon>
                    <InputGroupInput
                      id="deployment-target-search"
                      type="search"
                      value={targetSearch}
                      onChange={(event) => setTargetSearch(event.target.value)}
                      placeholder={t("updates.panel.searchPlaceholder")}
                    />
                  </InputGroup>
                </Field>
                <div
                  className="grid gap-4 sm:grid-cols-2"
                  role="group"
                  aria-label={t("updates.panel.targetsGroup")}
                >
                  <div className="grid content-start gap-2">
                    <h4 className="text-sm font-semibold">
                      {t("updates.panel.screensHeading", {
                        platform: platformLabel,
                      })}{" "}
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
                            ? t("updates.panel.noScreenMatch")
                            : t("updates.panel.noScreensEnrolled", {
                                platform: platformLabel,
                              })}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="grid content-start gap-2">
                    <h4 className="text-sm font-semibold">
                      {t("updates.panel.groupsHeading")}{" "}
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
                          detail={t("updates.panel.groupSize", {
                            count: group.membershipCount,
                          })}
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
                            ? t("updates.panel.noGroupMatch")
                            : t("updates.panel.noGroups")}
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
                      {deploy.error
                        ? mutationError(deploy.error, tErrors)
                        : deploySuccess}
                    </AlertDescription>
                  </Alert>
                </div>
              )}
              <div className="mt-3 flex min-h-14 flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <strong className="text-sm font-semibold text-foreground">
                    {selectedScreens.length === 1
                      ? t("updates.panel.selectedOne", {
                          count: selectedScreens.length,
                        })
                      : t("updates.panel.selectedOther", {
                          count: selectedScreens.length,
                        })}
                  </strong>
                  {offlineTargets > 0 && (
                    <span className="text-sm text-muted-foreground">
                      {t("updates.panel.offlineCount", {
                        count: offlineTargets,
                      })}
                    </span>
                  )}
                  {selectionCount > 0 && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => {
                        setScreenIds([]);
                        setGroupIds([]);
                      }}
                    >
                      {t("updates.panel.clearSelection")}
                    </Button>
                  )}
                </div>
                <Button
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
                  {deploy.isPending
                    ? t("updates.panel.creating")
                    : t("updates.panel.deployAction")}
                </Button>
              </div>
              <Dialog
                open={confirmDeploy}
                onOpenChange={(open) => {
                  if (!open) setConfirmDeploy(false);
                }}
              >
                <DialogContent className="max-w-md">
                  <DialogHeader>
                    <DialogTitle>{t("updates.panel.confirmTitle")}</DialogTitle>
                  </DialogHeader>
                  <div className="grid gap-3 text-sm">
                    <p>
                      {selectedScreens.length === 1
                        ? t("updates.panel.confirmSummaryOne", {
                            count: selectedScreens.length,
                            version:
                              releaseItems.find((item) => item.id === releaseId)
                                ?.versionName ??
                              t("updates.panel.versionFallback"),
                            mode: modeDisplayName.toLowerCase(),
                          })
                        : t("updates.panel.confirmSummaryOther", {
                            count: selectedScreens.length,
                            version:
                              releaseItems.find((item) => item.id === releaseId)
                                ?.versionName ??
                              t("updates.panel.versionFallback"),
                            mode: modeDisplayName.toLowerCase(),
                          })}
                    </p>
                    <p>
                      {platform === "android"
                        ? t("updates.panel.androidNote")
                        : t("updates.panel.linuxNote")}
                    </p>
                    {offlineTargets > 0 && (
                      <p>
                        {offlineTargets === 1
                          ? t("updates.panel.offlineNoteOne", {
                              count: offlineTargets,
                            })
                          : t("updates.panel.offlineNoteOther", {
                              count: offlineTargets,
                            })}
                      </p>
                    )}
                  </div>
                  <DialogFooter>
                    <Button
                      variant="ghost"
                      onClick={() => setConfirmDeploy(false)}
                    >
                      {t("common:actions.cancel")}
                    </Button>
                    <Button
                      variant="default"
                      disabled={deploy.isPending}
                      onClick={() => deploy.mutate()}
                    >
                      {deploy.isPending ? (
                        <Spinner />
                      ) : (
                        <Rocket size={16} aria-hidden="true" />
                      )}
                      {t("updates.panel.deployAction")}
                    </Button>
                  </DialogFooter>
                </DialogContent>
              </Dialog>
            </section>
          )}
          <section className="grid gap-3 rounded-xl border border-border p-4">
            <header className="grid gap-1">
              <h3 className="text-base font-semibold">
                {t("updates.panel.historyTitle")}
              </h3>
              <p className="text-sm text-muted-foreground">
                {t("updates.panel.historyHint")}
              </p>
            </header>
            {deployments.error && (
              <div className="mt-4 grid gap-3">
                <Alert variant="destructive">
                  <AlertTitle>{t("updates.panel.historyLoadError")}</AlertTitle>
                  <AlertDescription>
                    {mutationError(deployments.error, tErrors)}
                  </AlertDescription>
                </Alert>
              </div>
            )}
            <div className="overflow-x-auto rounded-xl border border-border">
              <Table className="w-full min-w-[48rem] text-sm">
                <caption className="sr-only">
                  {t("updates.panel.historyCaption", {
                    platform: platformLabel,
                  })}
                </caption>
                <TableHeader>
                  <TableRow className="border-b border-border text-left text-xs text-muted-foreground">
                    <TableHead scope="col" className="px-3 py-2 font-medium">
                      {t("updates.panel.colDeployment")}
                    </TableHead>
                    <TableHead scope="col" className="px-3 py-2 font-medium">
                      {t("updates.panel.colStatus")}
                    </TableHead>
                    <TableHead scope="col" className="px-3 py-2 font-medium">
                      {t("updates.panel.colScreens")}
                    </TableHead>
                    <TableHead scope="col" className="px-3 py-2 font-medium">
                      {t("updates.panel.colNeeds")}
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {platformDeployments.map((item) => {
                    const headline = deploymentHeadline(item);
                    const needsAttention =
                      item.failedCount > 0 ||
                      item.waitingForUserCount > 0 ||
                      item.status === "paused";
                    return (
                      <TableRow
                        key={item.id}
                        className="border-b border-border last:border-0"
                      >
                        <TableHead
                          scope="row"
                          className="px-3 py-2 text-left font-normal"
                        >
                          <strong className="font-semibold">{item.name}</strong>
                          <small className="block font-mono text-xs text-muted-foreground">
                            {item.versionName} ({item.versionCode}) ·{" "}
                            {modeName(item.mode)}
                          </small>
                        </TableHead>
                        <TableCell className="px-3 py-2">
                          <UpdateStatus value={item.status} />
                          <small className="block text-xs text-muted-foreground">
                            {rolloutSummary(item, t)}
                          </small>
                        </TableCell>
                        <TableCell className="px-3 py-2">
                          <DeploymentMeter compact {...item} />
                          <small className="text-xs text-muted-foreground">
                            {outstandingSummary(item, t)}
                          </small>
                        </TableCell>
                        <TableCell className="px-3 py-2">
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
                              {t("updates.panel.lastFailure", {
                                error: item.lastFailure,
                              })}
                            </small>
                          )}
                          {/* The way in sits with the sentence that gives a reason
                          to take it, which also keeps this table at four
                          columns: a column of its own for one button forced a
                          horizontal scroll in a narrow settings pane. */}
                          <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => {
                              setOpenDeployment(item.id);
                              setDeploymentDrawerOpen(true);
                            }}
                          >
                            <ListChecks size={15} aria-hidden="true" />
                            {item.targetCount}{" "}
                            {item.targetCount === 1 ? "screen" : "screens"}
                          </Button>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                  {!deployments.isLoading &&
                    !deployments.error &&
                    platformDeployments.length === 0 && (
                      <TableRow>
                        <TableCell
                          colSpan={4}
                          className="px-3 py-4 text-center"
                        >
                          <span className="flex items-center justify-center gap-2 text-sm text-muted-foreground">
                            <CheckCircle2 size={18} aria-hidden="true" />
                            {t("updates.panel.historyEmpty", {
                              platform: platformLabel,
                            })}
                          </span>
                        </TableCell>
                      </TableRow>
                    )}
                </TableBody>
              </Table>
            </div>
          </section>
          {openDeployment && (
            <UpdateDeploymentDrawer
              deploymentId={openDeployment}
              screens={screens.data?.items ?? []}
              manageable={manageable}
              open={deploymentDrawerOpen}
              onOpenChange={setDeploymentDrawerOpen}
              onOpenChangeComplete={(open) => {
                if (!open) setOpenDeployment(undefined);
              }}
            />
          )}
        </TabsContent>
      </Tabs>
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
  const { t } = useTranslation(["settings", "common"]);
  return (
    <Button
      variant="ghost"
      size="sm"
      title={t("updates.panel.cacheTitle")}
      disabled={downloading}
      onClick={onDownload}
    >
      {downloading ? <Spinner /> : <Download size={15} aria-hidden="true" />}
      {downloading
        ? t("updates.panel.cacheDownloading")
        : t("updates.panel.cacheDownload")}
    </Button>
  );
}

type ReleaseReadiness = {
  tone: "success" | "info" | "warning" | "danger" | "neutral";
  label: string;
  detail: string;
  cacheable: boolean;
};

function statusBadgeAppearance(tone: ReleaseReadiness["tone"]) {
  const variants = {
    success: "secondary",
    info: "outline",
    warning: "outline",
    danger: "destructive",
    neutral: "outline",
  } as const;
  const colors = {
    success: "text-[var(--tc-status-success)]",
    info: "text-[var(--tc-status-info)]",
    warning: "text-[var(--tc-status-warning)]",
    danger: "",
    neutral: "text-[var(--tc-status-neutral)]",
  } as const;
  return { variant: variants[tone], className: colors[tone] };
}

// One column replaces the former Verification and Cache pair. A release is only
// deployable once its manifest signature is verified and the artifact is cached,
// so the leading status reports that combined truth and the detail line keeps
// both underlying values visible.
function releaseReadiness(
  release: PlayerRelease,
  t: TFunction<["settings", "common"]>,
): ReleaseReadiness {
  if (release.verificationStatus === "failed")
    return {
      tone: "danger",
      label: t("updates.panel.readinessVerificationFailed"),
      detail:
        release.verificationError ?? t("updates.panel.readinessVerifyAgain"),
      cacheable: true,
    };
  if (release.cacheStatus === "failed")
    return {
      tone: "danger",
      label: t("updates.panel.readinessDownloadFailed"),
      detail: t("updates.panel.readinessCacheDetail"),
      cacheable: true,
    };
  if (release.cacheStatus === "downloading")
    return {
      tone: "info",
      label: t("updates.panel.readinessDownloading"),
      detail: t("updates.panel.readinessDownloadingDetail"),
      cacheable: false,
    };
  if (release.cacheStatus !== "cached")
    return {
      tone: "warning",
      label: t("updates.panel.readinessNotCached"),
      detail:
        release.verificationStatus === "verified_manifest"
          ? t("updates.panel.readinessManifestDetail")
          : t("updates.panel.readinessDeployableDetail"),
      cacheable: true,
    };
  if (release.verificationStatus !== "verified")
    return {
      tone: "info",
      label: t("updates.panel.readinessVerifying"),
      detail: t("updates.panel.readinessVerifyingDetail"),
      cacheable: true,
    };
  // "Ready to deploy" already states both underlying facts, so no detail line is
  // added and healthy rows stay one line tall.
  return {
    tone: "success",
    label: t("updates.panel.readinessReady"),
    detail: "",
    cacheable: false,
  };
}

function rolloutSummary(
  item: UpdateDeployment,
  t: TFunction<["settings", "common"]>,
) {
  const rollout =
    item.rolloutMode === "canary"
      ? t("updates.panel.rolloutCanary", {
          size: item.canarySize ?? 0,
          phase:
            item.rolloutPhase === "canary" || !item.rolloutPhase
              ? t("updates.panel.phaseCanary")
              : humanize(item.rolloutPhase),
        })
      : t("updates.panel.rolloutAll");
  return item.pauseReason ? `${rollout} · ${item.pauseReason}` : rollout;
}

function outstandingSummary(
  item: UpdateDeployment,
  t: TFunction<["settings", "common"]>,
) {
  return t("updates.panel.updatedCount", {
    succeeded: item.succeededCount,
    target: item.targetCount,
  });
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
  const { t } = useTranslation(["settings", "common"]);
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
      toast.add({
        title: t("updates.panel.releaseUploaded"),
        type: "success",
      });
      onImported();
    },
    onError: () => setPhase("selecting"),
  });
  const selectFiles = (selected: FileList | File[]) => {
    const next = { ...files };
    let error = "";
    for (const file of Array.from(selected)) {
      if (!releaseFileNames.includes(file.name)) {
        error = t("updates.panel.unexpectedFile", { name: file.name });
        continue;
      }
      if (file.name === manifestName && file.size > 128 * 1024)
        error = t("updates.panel.manifestTooBig");
      else if (file.name.endsWith(".sig") && file.size > 4 * 1024)
        error = t("updates.panel.sigTooBig");
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
          {t("updates.panel.uploadTitle", {
            platform: platform === "android" ? "Android" : "Linux",
          })}
        </h4>
        <p className="text-sm text-muted-foreground">
          {t("updates.panel.uploadHint", { artifact: artifactLabel })}
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
          {t("updates.panel.dropTitle")}
        </strong>
        <span className="text-sm text-muted-foreground">
          {t("updates.panel.dropHint")}
        </span>
        <Input
          type="file"
          multiple
          className="mx-auto max-w-sm"
          onChange={(event) =>
            event.target.files && selectFiles(event.target.files)
          }
          disabled={upload.isPending}
        />
      </label>
      <div
        className="grid gap-1"
        aria-label={t("updates.panel.validationLabel")}
      >
        {releaseFileNames.map((name) => (
          <div key={name} className="flex flex-wrap items-center gap-2 text-sm">
            <span aria-hidden="true">{files[name] ? "✓" : "○"}</span>
            <strong className="font-mono text-xs">{name}</strong>
            <small className="text-xs text-muted-foreground">
              {files[name]
                ? formatBytes(files[name].size)
                : t("updates.panel.fileRequired")}
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
                ? t("updates.panel.uploading", { progress })
                : phase === "verifying"
                  ? platform === "android"
                    ? t("updates.panel.verifyingAndroid")
                    : t("updates.panel.verifyingLinux")
                  : t("updates.panel.uploadComplete")}
            </strong>
            {upload.data && (
              <span className="text-sm text-muted-foreground">
                {t("updates.panel.uploadedVersion", {
                  version: upload.data.versionName,
                  channel:
                    upload.data.channel === "beta"
                      ? t("updates.panel.channelBeta")
                      : t("updates.panel.channelStable"),
                  size: formatBytes(upload.data.apkSizeBytes),
                })}
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
        <Button
          variant="default"

          disabled={!ready || upload.isPending || phase === "complete"}
          onClick={() => upload.mutate()}
        >
          {upload.isPending
            ? t("updates.panel.importing")
            : t("updates.panel.uploadVerify")}
        </Button>
        <Button
          variant="ghost"

          disabled={upload.isPending}
          onClick={() => {
            setFiles({});
            setClientError("");
            setPhase("selecting");
            upload.reset();
          }}
        >
          {t("updates.panel.clearFiles")}
        </Button>
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
      <Checkbox
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
  const { t } = useTranslation(["settings", "common"]);
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
  // Deployment statuses read from the server as slugs; known slugs resolve to
  // translated labels and anything unknown falls back to a readable form.
  const label =
    value === "active"
      ? t("updates.panel.statusActive")
      : value === "paused"
        ? t("updates.panel.statusPaused")
        : value === "completed"
          ? t("updates.panel.statusCompleted")
          : value === "cancelled"
            ? t("updates.panel.statusCancelled")
            : value === "failed"
              ? t("updates.panel.statusFailed")
              : humanize(value);
  return <Badge {...statusBadgeAppearance(tone)}>{label}</Badge>;
}
function mutationError(error: unknown, t: TFunction<"errors">): string {
  return error instanceof Error
    ? apiErrorMessage(error)
    : t("fallback.requestFailed");
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
function formatDuration(seconds: number, t: TFunction<["settings", "common"]>) {
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return (
    [days && `${days}d`, hours && `${hours}h`, minutes && `${minutes}m`]
      .filter(Boolean)
      .join(" ") || t("operations.system.lessThanMinute")
  );
}
