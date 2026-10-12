import { useCallback, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { useTranslation } from "react-i18next";
import { MoreHorizontal, RefreshCw, Rocket, Upload } from "lucide-react";
import { api } from "../../api/client";
import type {
  PlayerRelease,
  PlayerReleaseList,
  Screen,
  ScreenGroup,
  UpdateDeployment,
} from "../../api/types";
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
import { families, familyLabel } from "./model";
import { screenUpdateMeaning } from "../playerUpdateStates";

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
  const [deploymentId, setDeploymentId] = useState<string>();
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
  const familyScreens = (screens.data?.items ?? []).filter(
    (s) => screenUpdateTab(s) === family,
  );
  async function showDeployment(id: string, name: string) {
    if (
      await openNative({
        path: presentationPath("update-deployment", id),
        title: name,
        size: "full",
      })
    )
      return;
    setDeploymentId(id);
  }
  const inventoryError = screens.error ?? groups.error;
  function changeFamily(value: string) {
    if (!value || value === family) return;
    const next = new URLSearchParams(params);
    if (value === "android") next.delete("platform");
    else next.set("platform", value);
    setParams(next);
  }
  return (
    <div className="grid min-w-0 gap-6">
      {manageable && inventoryError && (
        <InventoryAlert
          error={inventoryError}
          onRetry={() => {
            void screens.refetch();
            void groups.refetch();
          }}
        />
      )}
      <PlayerUpdatesTabs
        view={view}
        actions={
          <PlayerUpdateActions
            manageable={manageable}
            owner={owner}
            inventoryReady={!!screens.data && !!groups.data}
            syncPending={sync.isPending}
            onDeploy={() => setDraft({})}
            onSync={() => sync.mutate()}
            onUpload={() => setUpload(true)}
            onConfigure={() => setSource(true)}
          />
        }
        familySwitch={
          <PlayerFamilySwitch
            family={family}
            fleetCount={familyScreens.length}
            onChange={changeFamily}
          />
        }
        deploymentsPending={deployments.isPending}
        deploymentsError={deployments.error}
        deploymentsReady={!!deployments.data}
        deploymentItems={deploymentItems}
        releasesPending={releases.isPending}
        releasesError={releases.error}
        catalog={releases.data}
        releaseItems={releaseItems}
        owner={owner}
        manageable={manageable}
        syncError={sync.error}
        onViewChange={changeView}
        onRetryDeployments={() => void deployments.refetch()}
        onRetryReleases={() => void releases.refetch()}
        onOpenDeployment={(item) =>
          void showDeployment(item.id, item.versionName)
        }
        onDeploy={(id) => setDraft({ releaseId: id })}
        onConfigure={() => setSource(true)}
      />
      <PlayerUpdateOverlays
        draft={draft}
        source={source}
        upload={upload}
        deploymentId={deploymentId}
        family={family}
        owner={owner}
        manageable={manageable}
        releaseItems={releaseItems}
        catalog={releases.data}
        screens={screens.data?.items ?? []}
        groups={groups.data?.items ?? []}
        onCloseDraft={() => setDraft(undefined)}
        onCreated={(id) => {
          setDraft(undefined);
          changeView("deployments");
          void client.invalidateQueries({ queryKey: ["update-deployments"] });
          void showDeployment(id, t("updates.deploymentTitle"));
        }}
        onCloseSource={closeSource}
        onCloseUpload={() => setUpload(false)}
        onImported={() => {
          setUpload(false);
          changeView("releases");
        }}
        onCloseDeployment={() => setDeploymentId(undefined)}
      />
    </div>
  );
}

function PlayerUpdateActions({
  manageable,
  owner,
  inventoryReady,
  syncPending,
  onDeploy,
  onSync,
  onUpload,
  onConfigure,
}: {
  manageable: boolean;
  owner: boolean;
  inventoryReady: boolean;
  syncPending: boolean;
  onDeploy: () => void;
  onSync: () => void;
  onUpload: () => void;
  onConfigure: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div className="flex flex-wrap items-center gap-2 pb-2">
      {manageable && (
        <Button disabled={!inventoryReady} onClick={onDeploy}>
          <Rocket aria-hidden="true" />
          {t("updates.panel.deployAction")}
        </Button>
      )}
      {owner && (
        <Button variant="outline" disabled={syncPending} onClick={onSync}>
          {syncPending ? <Spinner /> : <RefreshCw aria-hidden="true" />}
          {t("updates.console.sync")}
        </Button>
      )}
      {owner && (
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
            <DropdownMenuItem onClick={onUpload}>
              <Upload aria-hidden="true" />
              {t("updates.panel.uploadRelease")}
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onConfigure}>
              {t("updates.console.configureSource")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      )}
    </div>
  );
}

function InventoryAlert({
  error,
  onRetry,
}: {
  error: unknown;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <Alert variant="destructive">
      <AlertDescription>
        {apiErrorMessage(error)}
        <Button variant="outline" size="sm" onClick={onRetry}>
          {t("common:actions.retry")}
        </Button>
      </AlertDescription>
    </Alert>
  );
}

function PlayerFamilySwitch({
  family,
  fleetCount,
  onChange,
}: {
  family: UpdateFamilyTab;
  fleetCount: number;
  onChange: (value: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg bg-muted/40 px-3 py-2">
      <p className="text-sm text-muted-foreground">
        {t("updates.console.fleetCount", { count: fleetCount })}
      </p>
      <Select
        items={families.map((value) => ({
          value,
          label: familyLabel(value, t),
        }))}
        value={family}
        onValueChange={(value) => onChange(value ?? "")}
      >
        <SelectTrigger
          aria-label={t("updates.console.playerFamily")}
          className="min-w-44"
        >
          <SelectValue />
        </SelectTrigger>
        <SelectContent align="end">
          {families.map((value) => (
            <SelectItem key={value} value={value}>
              {familyLabel(value, t)}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function PlayerUpdatesTabs({
  view,
  actions,
  familySwitch,
  deploymentsPending,
  deploymentsError,
  deploymentsReady,
  deploymentItems,
  releasesPending,
  releasesError,
  catalog,
  releaseItems,
  owner,
  manageable,
  syncError,
  onViewChange,
  onRetryDeployments,
  onRetryReleases,
  onOpenDeployment,
  onDeploy,
  onConfigure,
}: {
  view: "deployments" | "releases";
  actions: ReactNode;
  familySwitch: ReactNode;
  deploymentsPending: boolean;
  deploymentsError: unknown;
  deploymentsReady: boolean;
  deploymentItems: UpdateDeployment[];
  releasesPending: boolean;
  releasesError: unknown;
  catalog?: PlayerReleaseList;
  releaseItems: PlayerRelease[];
  owner: boolean;
  manageable: boolean;
  syncError?: unknown;
  onViewChange: (value: string) => void;
  onRetryDeployments: () => void;
  onRetryReleases: () => void;
  onOpenDeployment: (item: UpdateDeployment) => void;
  onDeploy: (id: string) => void;
  onConfigure: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <Tabs
      value={view}
      onValueChange={(value) => onViewChange(String(value))}
      className="gap-4"
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b">
        <TabsList
          variant="line"
          aria-label={t("updates.console.workspaceViews")}
        >
          <TabsTrigger value="deployments">
            {t("updates.console.deployments")}
          </TabsTrigger>
          <TabsTrigger value="releases">
            {t("updates.console.releases")}
          </TabsTrigger>
        </TabsList>
        {actions}
      </div>
      {familySwitch}
      <TabsContent value="deployments">
        {deploymentsPending ? (
          <LoadingRows />
        ) : (
          <>
            {deploymentsError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {t("updates.panel.historyLoadError")}{" "}
                  {apiErrorMessage(deploymentsError)}
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={onRetryDeployments}
                  >
                    {t("common:actions.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {deploymentsReady && (
              <DeploymentList
                items={deploymentItems}
                onOpen={onOpenDeployment}
              />
            )}
          </>
        )}
      </TabsContent>
      <TabsContent value="releases">
        {releasesPending ? (
          <LoadingRows />
        ) : (
          <>
            {releasesError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {apiErrorMessage(releasesError)}
                  <Button variant="outline" size="sm" onClick={onRetryReleases}>
                    {t("common:actions.retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {catalog && (
              <ReleaseLibrary
                items={releaseItems}
                catalog={catalog}
                owner={owner}
                manageable={manageable}
                syncError={syncError}
                onDeploy={onDeploy}
                onConfigure={onConfigure}
              />
            )}
          </>
        )}
      </TabsContent>
    </Tabs>
  );
}

function PlayerUpdateOverlays({
  draft,
  source,
  upload,
  deploymentId,
  family,
  owner,
  manageable,
  releaseItems,
  catalog,
  screens,
  groups,
  onCloseDraft,
  onCreated,
  onCloseSource,
  onCloseUpload,
  onImported,
  onCloseDeployment,
}: {
  draft?: { releaseId?: string };
  source: boolean;
  upload: boolean;
  deploymentId?: string;
  family: UpdateFamilyTab;
  owner: boolean;
  manageable: boolean;
  releaseItems: PlayerRelease[];
  catalog?: PlayerReleaseList;
  screens: Screen[];
  groups: ScreenGroup[];
  onCloseDraft: () => void;
  onCreated: (id: string) => void;
  onCloseSource: () => void;
  onCloseUpload: () => void;
  onImported: () => void;
  onCloseDeployment: () => void;
}) {
  return (
    <>
      {draft && manageable && (
        <DeployUpdateSheet
          releases={releaseItems}
          screens={screens}
          groups={groups}
          preselected={draft.releaseId}
          onClose={onCloseDraft}
          onCreated={onCreated}
        />
      )}
      {source && owner && catalog && (
        <ReleaseSourceDialog
          github={catalog.githubAuth}
          onClose={onCloseSource}
        />
      )}
      {upload && owner && (
        <ReleaseUploadDialog
          family={family}
          onClose={onCloseUpload}
          onImported={onImported}
        />
      )}
      {deploymentId && (
        <UpdateDeploymentDetail
          key={deploymentId}
          deploymentId={deploymentId}
          screens={screens}
          manageable={manageable}
          open
          onOpenChange={(open) => !open && onCloseDeployment()}
        />
      )}
    </>
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
