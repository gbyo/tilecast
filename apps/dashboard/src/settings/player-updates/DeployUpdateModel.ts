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
import {
  artifactIdentity,
  deployable,
  groupReleases,
  releaseGroupKey,
} from "./model";
import {
  releaseUpdateTab,
  screenUpdateTab,
  type UpdateFamilyTab,
} from "../../playerPlatform";
import type { TargetChoice } from "./DeployUpdateStages";

export type DeployStageKey = "release" | "targets" | "rollout";

function stageKey(stage: number): DeployStageKey {
  if (stage === 1) return "release";
  if (stage === 2) return "targets";
  return "rollout";
}

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
  return !windowStart || !Number.isFinite(instant) || instant <= Date.now();
}

function targetsReady(
  preview: UpdateDeploymentPreview | undefined,
  fetching: boolean,
  error: boolean,
) {
  return !!preview?.targetCount && !preview.blockedCount && !fetching && !error;
}

function rolloutReady(
  releaseReady: boolean,
  targetReady: boolean,
  invalidCanary: boolean,
  invalidWindow: boolean,
  preview?: UpdateDeploymentPreview,
) {
  return (
    releaseReady &&
    targetReady &&
    !invalidCanary &&
    !invalidWindow &&
    (preview?.eligibleCount ?? 0) > 0
  );
}

function automaticBuildForScreens(
  group: PlayerRelease[] | undefined,
  screens: Screen[],
) {
  if (!group?.length) return undefined;
  if (group.length === 1) return group[0];
  const matching = group.filter(
    (release) =>
      !release.architecture ||
      screens.some(
        (screen) => screen.playerArchitecture === release.architecture,
      ),
  );
  return matching.length === 1 ? matching[0] : undefined;
}

function initialDeployChoice(
  releases: PlayerRelease[],
  screens: Screen[],
  initialFamily: UpdateFamilyTab,
  preselected?: string,
) {
  const release = releases.find((item) => item.id === preselected);
  const family = release ? releaseUpdateTab(release) : initialFamily;
  const groups = groupReleases(
    releases.filter((item) => releaseUpdateTab(item) === family),
  );
  const group =
    (release
      ? groups.find((items) => items.some((item) => item.id === release.id))
      : undefined) ?? (groups.length === 1 ? groups[0] : undefined);
  const familyScreens = screens.filter(
    (screen) => screenUpdateTab(screen) === family,
  );
  const build = release ?? automaticBuildForScreens(group, familyScreens);
  return {
    family,
    groupId: group ? releaseGroupKey(group) : "",
    releaseId: build?.id ?? "",
  };
}

function buildForGroup(group: PlayerRelease[] | undefined, screens: Screen[]) {
  return automaticBuildForScreens(group, screens)?.id ?? "";
}

export function useDeployUpdateModel({
  releases,
  screens,
  groups,
  initialFamily,
  preselected,
  onClose,
  onCreated,
}: {
  releases: PlayerRelease[];
  screens: Screen[];
  groups: ScreenGroup[];
  initialFamily: UpdateFamilyTab;
  preselected?: string;
  onClose: () => void;
  onCreated: (id: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const csrf = useAuth().status?.csrfToken ?? "";
  const initialChoice = initialDeployChoice(
    releases,
    screens,
    initialFamily,
    preselected,
  );
  const [stage, setStage] = useState(1);
  const [family, setFamily] = useState(initialChoice.family);
  const [groupId, setGroupId] = useState(initialChoice.groupId);
  const [releaseId, setReleaseId] = useState(initialChoice.releaseId);
  const [selected, setSelected] = useState<TargetChoice[]>([]);
  const [search, setSearch] = useState("");
  const [mode, setMode] = useState<UpdateDeploymentMode>("install_now");
  const [windowStart, setWindowStart] = useState("");
  const [canary, setCanary] = useState(false);
  const [canarySize, setCanarySize] = useState(1);

  const familyReleases = releases.filter(
    (item) => releaseUpdateTab(item) === family,
  );
  const releaseGroups = groupReleases(familyReleases);
  const releaseGroup = releaseGroups.find(
    (items) => releaseGroupKey(items) === groupId,
  );
  const familyScreens = screens.filter(
    (screen) => screenUpdateTab(screen) === family,
  );
  const release = releases.find((item) => item.id === releaseId);
  const screenIds = useMemo(
    () => screens.map((screen) => screen.id),
    [screens],
  );
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
      api.previewUpdateDeployment({ releaseId, screenIds, groupIds: [] }, csrf),
    enabled: Boolean(release) && screenIds.length > 0,
    staleTime: 0,
    refetchInterval: 10_000,
  });
  const preview = useQuery({
    queryKey: ["update-preview", selection],
    queryFn: () => api.previewUpdateDeployment(selection, csrf),
    enabled: Boolean(release) && selected.length > 0,
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
  const releaseIsReady = Boolean(release && deployable(release));
  const targetsAreReady = targetsReady(
    result,
    preview.isFetching,
    preview.isError,
  );
  const rolloutIsReady = rolloutReady(
    releaseIsReady,
    targetsAreReady,
    invalidCanary,
    invalidWindow,
    result,
  );

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

  function chooseRelease(value: string) {
    if (value === releaseId) return;
    setReleaseId(value);
    setSelected([]);
  }

  function chooseFamily(value: UpdateFamilyTab) {
    if (value === family) return;
    const nextGroups = groupReleases(
      releases.filter((item) => releaseUpdateTab(item) === value),
    );
    const nextGroup = nextGroups.length === 1 ? nextGroups[0] : undefined;
    const nextScreens = screens.filter(
      (screen) => screenUpdateTab(screen) === value,
    );
    setFamily(value);
    setGroupId(nextGroup ? releaseGroupKey(nextGroup) : "");
    setReleaseId(buildForGroup(nextGroup, nextScreens));
    setSelected([]);
  }

  function chooseVersion(value: string) {
    if (value === groupId) return;
    const nextGroup = releaseGroups.find(
      (items) => releaseGroupKey(items) === value,
    );
    setGroupId(value);
    setReleaseId(buildForGroup(nextGroup, familyScreens));
    setSelected([]);
  }

  function goBack() {
    if (stage === 1) onClose();
    else setStage((current) => current - 1);
  }

  return {
    stage,
    stageKey: stageKey(stage),
    family,
    familyScreens,
    releaseGroups,
    groupId,
    releaseGroup,
    releaseId,
    release,
    choices,
    selected,
    setSelected,
    search,
    setSearch,
    mode,
    setMode,
    windowStart,
    setWindowStart,
    canary,
    setCanary,
    canarySize,
    setCanarySize,
    candidates,
    preview,
    result,
    candidateById,
    blocked,
    invalidCanary,
    invalidWindow,
    releaseReady: releaseIsReady,
    targetsReady: targetsAreReady,
    rolloutReady: rolloutIsReady,
    deploy,
    chooseRelease,
    chooseFamily,
    chooseVersion,
    goBack,
    continue: () => setStage((current) => current + 1),
  };
}
