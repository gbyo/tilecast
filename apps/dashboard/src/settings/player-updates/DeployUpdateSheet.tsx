import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { api } from "../../api/client";
import type {
  PlayerRelease,
  Screen,
  ScreenGroup,
  UpdateDeploymentMode,
  UpdateDeploymentPreview,
} from "../../api/types";
import { useAuth } from "../../auth/AuthProvider";
import { toast } from "../../components/ui/toast";
import { UpdateSurface } from "./UpdateSurface";
import {
  DeployAlerts,
  DeployFooter,
  DeployReleaseStage,
  DeployRolloutStage,
  DeployStageIntro,
  DeployTargetStage,
  type TargetChoice,
} from "./DeployUpdateStages";
import { artifactIdentity, deployable } from "./model";

function invalidCanarySelection(
  enabled: boolean,
  size: number,
  preview?: UpdateDeploymentPreview,
) {
  return (
    enabled &&
    (!Number.isInteger(size) ||
      size < 1 ||
      size > 50 ||
      size >= (preview?.eligibleCount ?? 0) ||
      (preview?.alreadyCurrentCount ?? 0) > 0)
  );
}

function invalidMaintenanceWindow(
  mode: UpdateDeploymentMode,
  windowStart: string,
) {
  if (mode !== "maintenance_window") return false;
  const instant = Date.parse(windowStart);
  return (
    !windowStart || !Number.isFinite(instant) || instant <= Date.now()
  );
}

export function DeployUpdateSheet({
  releases,
  screens,
  groups,
  preselected,
  onClose,
  onCreated,
}: {
  releases: PlayerRelease[];
  screens: Screen[];
  groups: ScreenGroup[];
  preselected?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const csrf = useAuth().status?.csrfToken ?? "";
  const [stage, setStage] = useState(1);
  const [releaseId, setReleaseId] = useState(preselected ?? "");
  const [selected, setSelected] = useState<TargetChoice[]>([]);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<UpdateDeploymentMode>("install_now");
  const [windowStart, setWindowStart] = useState("");
  const [canary, setCanary] = useState(false);
  const [canarySize, setCanarySize] = useState(1);

  const release = releases.find((item) => item.id === releaseId);
  const screenIds = useMemo(() => screens.map((screen) => screen.id), [screens]);
  const choices = useMemo<TargetChoice[]>(
    () => [
      ...screens.map((screen) => ({
        value: screen.id,
        label: screen.name,
        type: "screen" as const,
      })),
      ...groups.map((group) => ({
        value: group.id,
        label: group.name,
        type: "group" as const,
      })),
    ],
    [screens, groups],
  );
  const selection = useMemo(
    () => ({
      releaseId,
      screenIds: selected
        .filter((item) => item.type === "screen")
        .map((item) => item.value),
      groupIds: selected
        .filter((item) => item.type === "group")
        .map((item) => item.value),
    }),
    [releaseId, selected],
  );

  const candidates = useQuery({
    queryKey: ["update-candidates", releaseId, screenIds],
    queryFn: () =>
      api.previewUpdateDeployment(
        { releaseId, screenIds, groupIds: [] },
        csrf,
      ),
    enabled: !!release && screenIds.length > 0,
    staleTime: 0,
    refetchInterval: 10_000,
  });
  const preview = useQuery({
    queryKey: ["update-preview", selection],
    queryFn: () => api.previewUpdateDeployment(selection, csrf),
    enabled: !!release && selected.length > 0,
    staleTime: 0,
    refetchInterval: 5_000,
  });

  const result = preview.data;
  const candidateById = useMemo(
    () =>
      new Map(
        candidates.data?.screens.map((screen) => [screen.screenId, screen]) ??
          [],
      ),
    [candidates.data?.screens],
  );
  const blocked = useMemo(
    () =>
      result?.screens.filter((screen) => screen.outcome === "incompatible") ??
      [],
    [result?.screens],
  );
  const invalidCanary = invalidCanarySelection(canary, canarySize, result);
  const invalidWindow = invalidMaintenanceWindow(mode, windowStart);
  const releaseReady = !!release && deployable(release);
  const targetsReady =
    !!result?.targetCount &&
    !result.blockedCount &&
    !preview.isFetching &&
    !preview.isError;
  const rolloutReady =
    releaseReady &&
    targetsReady &&
    !invalidCanary &&
    !invalidWindow &&
    (result?.eligibleCount ?? 0) > 0;

  const deploy = useMutation({
    mutationFn: () =>
      api.createUpdateDeployment(
        {
          ...selection,
          name: release
            ? `${artifactIdentity(release, t)} ${release.versionName}`
            : "",
          mode,
          canarySize: canary ? canarySize : 0,
          maintenanceWindowStart:
            mode === "maintenance_window"
              ? new Date(windowStart).toISOString()
              : undefined,
        },
        csrf,
      ),
    onSuccess: (created) => {
      toast.add({
        title: t("updates.panel.deployCreatedOther", {
          count: created.targetCount,
        }),
        type: "success",
      });
      onCreated(created.id);
    },
  });

  const stageKey =
    stage === 1 ? "release" : stage === 2 ? "targets" : "rollout";
  const description = t("updates.console.step", {
    stage,
    title: t(`updates.console.steps.${stageKey}`),
  });

  function chooseRelease(value: string) {
    if (value === releaseId) return;
    setReleaseId(value);
    setSelected([]);
  }

  function goBack() {
    if (stage === 1) onClose();
    else setStage((current) => current - 1);
  }

  return (
    <UpdateSurface
      open
      onOpenChange={(open) => !open && !deploy.isPending && onClose()}
      title={t("updates.panel.deployAction")}
      description={description}
      footer={
        <DeployFooter
          stage={stage}
          pending={deploy.isPending}
          releaseReady={releaseReady}
          targetsReady={targetsReady}
          rolloutReady={rolloutReady}
          onBack={goBack}
          onContinue={() => setStage((current) => current + 1)}
          onDeploy={() => deploy.mutate()}
        />
      }
    >
      <DeployStageIntro stage={stage} stageKey={stageKey} />
      {stage === 1 && (
        <DeployReleaseStage
          releases={releases}
          releaseId={releaseId}
          onReleaseChange={chooseRelease}
        />
      )}
      {stage === 2 && (
        <DeployTargetStage
          release={release}
          screens={screens}
          groups={groups}
          choices={choices}
          selected={selected}
          search={search}
          candidateById={candidateById}
          candidatesFetching={candidates.isFetching}
          candidatesError={candidates.error}
          candidatesReady={!!candidates.data}
          previewFetching={preview.isFetching}
          result={result}
          onSelectedChange={setSelected}
          onSearchChange={setSearch}
        />
      )}
      {stage === 3 && (
        <DeployRolloutStage
          release={release}
          result={result}
          mode={mode}
          windowStart={windowStart}
          canary={canary}
          canarySize={canarySize}
          invalidWindow={invalidWindow}
          invalidCanary={invalidCanary}
          onModeChange={setMode}
          onWindowStartChange={setWindowStart}
          onCanaryChange={setCanary}
          onCanarySizeChange={setCanarySize}
        />
      )}
      <DeployAlerts
        stage={stage}
        previewError={preview.error}
        candidatesError={candidates.error}
        blocked={blocked}
        result={result}
        deployError={deploy.error}
        onRetry={() => {
          void preview.refetch();
          void candidates.refetch();
        }}
      />
    </UpdateSurface>
  );
}
