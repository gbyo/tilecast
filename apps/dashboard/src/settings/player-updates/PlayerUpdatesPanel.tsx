import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, RefreshCw, Rocket, Upload } from "lucide-react";
import { api } from "../../api/client";
import { useAuth } from "../../auth/AuthProvider";
import { apiErrorMessage } from "../../i18n";
import { screenQueries } from "../../data/screens";
import {
  releaseUpdateTab,
  screenUpdateTab,
  type UpdateFamilyTab,
} from "../../playerPlatform";
import {
  presentationPath,
  useOpenNativePresentation,
} from "../../native-presentation/openNativePresentation";
import { Alert, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "../../components/ui/dropdown-menu";
import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from "../../components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select";
import { Spinner } from "../../components/ui/spinner";
import { toast } from "../../components/ui/toast";
import { DeploymentList } from "./DeploymentList";
import { DeployUpdateSheet } from "./DeployUpdateSheet";
import { ReleaseLibrary } from "./ReleaseLibrary";
import { ReleaseSourceDialog } from "./ReleaseSourceDialog";
import { ReleaseUploadDialog } from "./ReleaseUploadDialog";
import { LoadingRows, UpdateDeploymentDetail } from "./UpdateDeploymentDetail";
import { deploymentNeedsAttention, families, familyLabel } from "./model";
import {
  screenUpdateMeaning,
  type ScreenFilter,
} from "../playerUpdateStates";

export function PlayerUpdatesPanel(props: {
  owner: boolean;
  manageable: boolean;
}) {
  const [params] = useSearchParams();
  const value = params.get("platform");
  const family: UpdateFamilyTab =
    value === "linux" || value === "edge" || value === "windows"
      ? value
      : "android";
  // A URL change (including back/forward) discards every transient overlay and
  // draft. No target or artifact selection can cross a family boundary.
  return <PlayerUpdatesWorkspace key={family} family={family} {...props} />;
}
function PlayerUpdatesWorkspace({
  family,
  owner,
  manageable,
}: {
  family: UpdateFamilyTab;
  owner: boolean;
  manageable: boolean;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const [params, setParams] = useSearchParams();
  const view = params.get("view") === "releases" ? "releases" : "deployments";
  const auth = useAuth();
  const client = useQueryClient();
  const [draft, setDraft] = useState<{ releaseId?: string }>();
  const [source, setSource] = useState(false);
  const [upload, setUpload] = useState(false);
  const [deployment, setDeployment] = useState<{
    id: string;
    filter: ScreenFilter;
  }>();
  const openNative = useOpenNativePresentation();
  const releases = useQuery({
    queryKey: ["player-releases"],
    queryFn: api.playerReleases,
    refetchInterval: (q) =>
      q.state.data?.items.some((r) => r.cacheStatus === "downloading")
        ? 1_000
        : 10_000,
  });
  const deployments = useQuery({
    queryKey: ["update-deployments"],
    queryFn: api.updateDeployments,
    refetchInterval: (q) =>
      q.state.data?.items.some(
        (d) => d.status === "active" || d.status === "paused",
      )
        ? 3_000
        : 15_000,
  });
  const screens = useQuery({
    ...screenQueries.list(),
    refetchInterval: 10_000,
  });
  const groups = useQuery({
    queryKey: ["screen-groups"],
    queryFn: () => api.screenGroups(),
  });
  const sync = useMutation({
    mutationFn: () => api.checkPlayerReleases(auth.status?.csrfToken ?? ""),
    onSuccess: () => {
      toast.add({ title: t("updates.console.synced"), type: "success" });
      return client.invalidateQueries({ queryKey: ["player-releases"] });
    },
    onError: () => changeView("releases"),
  });
  function changeView(value: string) {
    const next = new URLSearchParams(params);
    if (value === "deployments") next.delete("view");
    else next.set("view", "releases");
    setParams(next);
  }
  const closeSource = useCallback(() => setSource(false), []);
  const releaseItems = (releases.data?.items ?? []).filter(
    (r) => releaseUpdateTab(r) === family,
  );
  const deploymentItems = (deployments.data?.items ?? []).filter(
    (d) => releaseUpdateTab(d) === family,
  );
  const screenItems = screens.data?.items ?? [];
  const familyScreens = screenItems.filter(
    (screen) => screenUpdateTab(screen) === family,
  );
  const familyOptions = families.map((value) => {
    const count = screenItems.filter(
      (screen) => screenUpdateTab(screen) === value,
    ).length;
    return {
      value,
      label: `${familyLabel(value, t)} · ${t("updates.console.fleetCount", {
        count,
      })}`,
    };
  });
  const attentionDeployments = deploymentItems.filter(
    (item) =>
      (item.status === "active" || item.status === "paused") &&
      deploymentNeedsAttention(item),
  ).length;
  async function showDeployment(
    id: string,
    name: string,
    filter: ScreenFilter = "all",
  ) {
    if (
      await openNative({
        path: presentationPath("update-deployment", id),
        title: name,
        size: "full",
      })
    )
      return;
    setDeployment({ id, filter });
  }
  return (
    <div className="grid min-w-0 gap-6">
      {manageable && (screens.error || groups.error) && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(screens.error ?? groups.error)}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                void screens.refetch();
                void groups.refetch();
              }}
            >
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      <Tabs
        value={view}
        onValueChange={(value) => changeView(String(value))}
        className="gap-4"
      >
        <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-2">
          <div className="flex flex-wrap items-center gap-3">
            <TabsList
              variant="line"
              aria-label={t("updates.console.workspaceViews")}
            >
              <TabsTrigger value="deployments">
                {t("updates.console.deployments")}
                {attentionDeployments > 0 && (
                  <Badge
                    variant="destructive"
                    className="ml-1 h-5 min-w-5 rounded-full px-1.5 text-[10px]"
                  >
                    {attentionDeployments}
                  </Badge>
                )}
              </TabsTrigger>
              <TabsTrigger value="releases">
                {t("updates.console.releases")}
              </TabsTrigger>
            </TabsList>
            <Select
              items={familyOptions}
              value={family}
              onValueChange={(value) => {
                if (!value || value === family) return;
                const next = new URLSearchParams(params);
                if (value === "android") next.delete("platform");
                else next.set("platform", value);
                setParams(next);
              }}
            >
              <SelectTrigger
                aria-label={t("updates.console.playerFamily")}
                className="h-8 min-w-52"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {familyOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {manageable && (
              <Button
                disabled={!screens.data || !groups.data}
                onClick={() => setDraft({})}
              >
                <Rocket aria-hidden="true" />
                {t("updates.panel.deployAction")}
              </Button>
            )}
            {owner && view === "releases" && (
              <Button
                variant="outline"
                disabled={sync.isPending}
                onClick={() => sync.mutate()}
              >
                {sync.isPending ? (
                  <Spinner />
                ) : (
                  <RefreshCw aria-hidden="true" />
                )}
                {t("updates.console.sync")}
              </Button>
            )}
            {owner && view === "releases" && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t("updates.console.more")}
                    />
                  }
                >
                  <MoreHorizontal aria-hidden="true" />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem onClick={() => setUpload(true)}>
                    <Upload aria-hidden="true" />
                    {t("updates.panel.uploadRelease")}
                  </DropdownMenuItem>
                  <DropdownMenuItem onClick={() => setSource(true)}>
                    {t("updates.console.configureSource")}
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        </div>
        <TabsContent value="deployments">
          {deployments.isPending ? (
            <LoadingRows />
          ) : (
            <>
              {deployments.error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {t("updates.panel.historyLoadError")}{" "}
                    {apiErrorMessage(deployments.error)}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void deployments.refetch()}
                    >
                      {t("common:actions.retry")}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {deployments.data && (
                <DeploymentList
                  items={deploymentItems}
                  onOpen={(item, focus = "all") =>
                    void showDeployment(item.id, item.versionName, focus)
                  }
                />
              )}
            </>
          )}
        </TabsContent>
        <TabsContent value="releases">
          {releases.isPending ? (
            <LoadingRows />
          ) : (
            <>
              {releases.error && (
                <Alert variant="destructive">
                  <AlertDescription>
                    {apiErrorMessage(releases.error)}
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => void releases.refetch()}
                    >
                      {t("common:actions.retry")}
                    </Button>
                  </AlertDescription>
                </Alert>
              )}
              {releases.data && (
                <ReleaseLibrary
                  items={releaseItems}
                  catalog={releases.data}
                  owner={owner}
                  manageable={manageable}
                  syncError={sync.error}
                  onDeploy={(id) => setDraft({ releaseId: id })}
                  onConfigure={() => setSource(true)}
                />
              )}
            </>
          )}
        </TabsContent>
      </Tabs>
      {draft && manageable && (
        <DeployUpdateSheet
          releases={releases.data?.items ?? []}
          screens={screens.data?.items ?? []}
          groups={groups.data?.items ?? []}
          initialFamily={family}
          preselected={draft.releaseId}
          onClose={() => setDraft(undefined)}
          onCreated={(id, createdFamily) => {
            setDraft(undefined);
            void client.invalidateQueries({ queryKey: ["update-deployments"] });
            if (createdFamily !== family) {
              const next = new URLSearchParams(params);
              next.delete("view");
              if (createdFamily === "android") next.delete("platform");
              else next.set("platform", createdFamily);
              setParams(next);
              return;
            }
            changeView("deployments");
            void showDeployment(id, t("updates.deploymentTitle"));
          }}
        />
      )}
      {source && owner && releases.data && (
        <ReleaseSourceDialog
          github={releases.data.githubAuth}
          onClose={closeSource}
        />
      )}
      {upload && owner && (
        <ReleaseUploadDialog
          family={family}
          onClose={() => setUpload(false)}
          onImported={() => {
            setUpload(false);
            changeView("releases");
            void client.invalidateQueries({ queryKey: ["player-releases"] });
          }}
        />
      )}
      {deployment && (
        <UpdateDeploymentDetail
          key={deployment.id}
          deploymentId={deployment.id}
          screens={screens.data?.items ?? []}
          manageable={manageable}
          initialFilter={deployment.filter}
          open
          onOpenChange={(open) => !open && setDeployment(undefined)}
        />
      )}
    </div>
  );
}
export function canDeployPlayerUpdates(role: string | undefined) {
  return role === "owner" || role === "administrator";
}
export function playerUpdateStateLabel(state: string) {
  const meaning = screenUpdateMeaning(state);
  return meaning.detail
    ? `${meaning.label} — ${meaning.detail}`
    : meaning.label;
}
