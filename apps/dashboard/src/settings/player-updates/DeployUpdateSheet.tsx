import { useTranslation } from "react-i18next";
import type { PlayerRelease, Screen, ScreenGroup } from "../../api/types";
import { UpdateSurface } from "./UpdateSurface";
import {
  DeployAlerts,
  DeployFooter,
  DeployReleaseStage,
  DeployRolloutStage,
  DeployStageIntro,
  DeployTargetStage,
} from "./DeployUpdateStages";
import { useDeployUpdateModel } from "./DeployUpdateModel";

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
  const model = useDeployUpdateModel({
    releases,
    screens,
    groups,
    preselected,
    onClose,
    onCreated,
  });
  const description = t("updates.console.step", {
    stage: model.stage,
    title: t(`updates.console.steps.${model.stageKey}`),
  });

  return (
    <UpdateSurface
      open
      onOpenChange={(open) => !open && !model.deploy.isPending && onClose()}
      title={t("updates.panel.deployAction")}
      description={description}
      footer={
        <DeployFooter
          stage={model.stage}
          pending={model.deploy.isPending}
          releaseReady={model.releaseReady}
          targetsReady={model.targetsReady}
          rolloutReady={model.rolloutReady}
          onBack={model.goBack}
          onContinue={model.continue}
          onDeploy={() => model.deploy.mutate()}
        />
      }
      presentation="dialog"
    >
      <DeployStageIntro stage={model.stage} stageKey={model.stageKey} />
      {model.stage === 1 && (
        <DeployReleaseStage
          releases={releases}
          releaseId={model.releaseId}
          onReleaseChange={model.chooseRelease}
        />
      )}
      {model.stage === 2 && (
        <DeployTargetStage
          release={model.release}
          screens={screens}
          groups={groups}
          choices={model.choices}
          selected={model.selected}
          search={model.search}
          candidateById={model.candidateById}
          candidatesFetching={model.candidates.isFetching}
          candidatesError={model.candidates.error}
          candidatesReady={!!model.candidates.data}
          previewFetching={model.preview.isFetching}
          result={model.result}
          onSelectedChange={model.setSelected}
          onSearchChange={model.setSearch}
        />
      )}
      {model.stage === 3 && (
        <DeployRolloutStage
          release={model.release}
          result={model.result}
          mode={model.mode}
          windowStart={model.windowStart}
          canary={model.canary}
          canarySize={model.canarySize}
          invalidWindow={model.invalidWindow}
          invalidCanary={model.invalidCanary}
          onModeChange={model.setMode}
          onWindowStartChange={model.setWindowStart}
          onCanaryChange={model.setCanary}
          onCanarySizeChange={model.setCanarySize}
        />
      )}
      <DeployAlerts
        stage={model.stage}
        previewError={model.preview.error}
        candidatesError={model.candidates.error}
        blocked={model.blocked}
        result={model.result}
        deployError={model.deploy.error}
        onRetry={() => {
          void model.preview.refetch();
          void model.candidates.refetch();
        }}
      />
    </UpdateSurface>
  );
}
