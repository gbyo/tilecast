import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import type {
  PlayerRelease,
  Screen,
  ScreenGroup,
  UpdateDeploymentMode,
  UpdateDeploymentPreview,
} from "../../api/types";
import { apiErrorMessage, useFormatLocale } from "../../i18n";
import { formatBytes } from "../../lib/formatBytes";
import { releaseUpdateTab } from "../../playerPlatform";
import { DateTimeInput } from "../../components/date-picker";
import { Alert, AlertTitle, AlertDescription } from "../../components/ui/alert";
import { Badge } from "../../components/ui/badge";
import { Button } from "../../components/ui/button";
import {
  Combobox,
  ComboboxInput,
  ComboboxContent,
  ComboboxList,
  ComboboxItem,
  ComboboxGroup,
  ComboboxLabel,
  ComboboxEmpty,
} from "../../components/ui/combobox";
import {
  Field,
  FieldSet,
  FieldLegend,
  FieldGroup,
  FieldLabel,
  FieldDescription,
  FieldContent,
  FieldError,
} from "../../components/ui/field";
import { Input } from "../../components/ui/input";
import { RadioGroup, RadioGroupItem } from "../../components/ui/radio-group";
import { ScrollArea } from "../../components/ui/scroll-area";
import { Switch } from "../../components/ui/switch";
import { Spinner } from "../../components/ui/spinner";
import { artifactIdentity, deployable, modeLabel } from "./model";

export type TargetChoice = {
  value: string;
  label: string;
  type: "screen" | "group";
};
type PreviewScreen = UpdateDeploymentPreview["screens"][number];

export function DeployStageIntro({
  stage,
  stageKey,
}: {
  stage: number;
  stageKey: "release" | "targets" | "rollout";
}) {
  const { t } = useTranslation(["settings", "common"]);
  return (
    <>
      <h2 className="text-sm font-semibold">
        {t(`updates.console.steps.${stageKey}`)}
      </h2>
      <p className="text-sm text-muted-foreground">
        {t(`updates.console.stepHints.${stageKey}`)}
      </p>
      <span className="sr-only">
        {t("updates.console.step", {
          stage,
          title: t(`updates.console.steps.${stageKey}`),
        })}
      </span>
    </>
  );
}

export function DeployReleaseStage({
  releases,
  releaseId,
  onReleaseChange,
}: {
  releases: PlayerRelease[];
  releaseId: string;
  onReleaseChange: (value: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  return (
    <FieldSet>
      <FieldLegend variant="label" className="sr-only">
        {t("updates.panel.releaseLabel")}
      </FieldLegend>
      {!releases.some(deployable) && (
        <Alert>
          <AlertDescription>{t("updates.console.noReadyRelease")}</AlertDescription>
        </Alert>
      )}
      <RadioGroup
        value={releaseId}
        onValueChange={(value) => onReleaseChange(String(value))}
        aria-label={t("updates.panel.releaseLabel")}
      >
        {releases.map((release) => (
          <Field
            key={release.id}
            orientation="horizontal"
            className="gap-3 border-b pb-3"
          >
            <RadioGroupItem
              id={`release-${release.id}`}
              aria-label={`${release.versionName} · ${artifactIdentity(release, t)} · ${release.channel === "beta" ? t("updates.panel.channelBeta") : t("updates.panel.channelStable")}`}
              value={release.id}
              disabled={!deployable(release)}
            />
            <FieldContent>
              <FieldLabel
                htmlFor={`release-${release.id}`}
                className="flex flex-wrap gap-2"
              >
                {release.versionName}
                <Badge variant="outline">
                  {release.channel === "beta"
                    ? t("updates.panel.channelBeta")
                    : t("updates.panel.channelStable")}
                </Badge>
                <span className="basis-full text-sm font-medium">
                  {artifactIdentity(release, t)}
                </span>
              </FieldLabel>
              <FieldDescription>
                {formatBytes(release.apkSizeBytes, locale)} ·{" "}
                {new Date(release.publishedAt).toLocaleDateString(locale)}
                {!deployable(release) &&
                  ` · ${t("updates.console.prepareFirst")}`}
              </FieldDescription>
            </FieldContent>
          </Field>
        ))}
      </RadioGroup>
    </FieldSet>
  );
}

export function DeployTargetStage({
  release,
  screens,
  groups,
  choices,
  selected,
  search,
  candidateById,
  candidatesFetching,
  candidatesError,
  candidatesReady,
  previewFetching,
  result,
  onSelectedChange,
  onSearchChange,
}: {
  release?: PlayerRelease;
  screens: Screen[];
  groups: ScreenGroup[];
  choices: TargetChoice[];
  selected: TargetChoice[];
  search: string;
  candidateById: Map<string, PreviewScreen>;
  candidatesFetching: boolean;
  candidatesError: unknown;
  candidatesReady: boolean;
  previewFetching: boolean;
  result?: UpdateDeploymentPreview;
  onSelectedChange: (value: TargetChoice[]) => void;
  onSearchChange: (value: string) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const normalizedSearch = search.toLowerCase();
  const screenById = useMemo(
    () => new Map(screens.map((screen) => [screen.id, screen])),
    [screens],
  );
  const groupById = useMemo(
    () => new Map(groups.map((group) => [group.id, group])),
    [groups],
  );
  const eligible = choices.filter((choice) => {
    if (choice.type !== "screen") return false;
    const candidate = candidateById.get(choice.value);
    return (
      candidate !== undefined &&
      candidate.outcome !== "incompatible" &&
      candidate.outcome !== "already_current"
    );
  });
  return (
    <>
      <p className="text-sm font-medium">
        {release?.versionName} · {release && artifactIdentity(release, t)}
      </p>
      <Field>
        <FieldLabel htmlFor="update-target-search">
          {t("updates.panel.targetsLabel")}
        </FieldLabel>
        <Combobox
          multiple
          items={choices}
          value={selected}
          onValueChange={onSelectedChange}
          itemToStringLabel={(item: TargetChoice) => item.label}
          isItemEqualToValue={(a: TargetChoice, b: TargetChoice) =>
            a.value === b.value && a.type === b.type
          }
          inputValue={search}
          onInputValueChange={onSearchChange}
        >
          <ComboboxInput
            id="update-target-search"
            placeholder={t("updates.panel.searchPlaceholder")}
          />
          <ComboboxContent>
            <ComboboxEmpty>{t("updates.console.noTargetMatch")}</ComboboxEmpty>
            <ComboboxList>
              {(["screen", "group"] as const).map((type) => (
                <ComboboxGroup key={type}>
                  <ComboboxLabel>
                    {type === "screen"
                      ? t("updates.console.screens")
                      : t("updates.panel.groupsHeading")}
                  </ComboboxLabel>
                  {choices
                    .filter(
                      (item) =>
                        item.type === type &&
                        item.label.toLowerCase().includes(normalizedSearch),
                    )
                    .map((choice) => (
                      <TargetChoiceRow
                        key={`${type}-${choice.value}`}
                        choice={choice}
                        screen={screenById.get(choice.value)}
                        group={groupById.get(choice.value)}
                        candidate={candidateById.get(choice.value)}
                        candidateById={candidateById}
                        candidatesError={candidatesError}
                      />
                    ))}
                </ComboboxGroup>
              ))}
            </ComboboxList>
          </ComboboxContent>
        </Combobox>
      </Field>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          size="sm"
          disabled={candidatesFetching || !!candidatesError || !candidatesReady}
          onClick={() => onSelectedChange(eligible)}
        >
          {t("updates.console.selectEligible")}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => onSelectedChange([])}>
          {t("updates.panel.clearSelection")}
        </Button>
      </div>
      <p role="status" className="text-sm font-medium">
        {previewFetching
          ? t("updates.console.checkingCompatibility")
          : t("updates.console.selectedCount", {
              count: result?.targetCount ?? 0,
            })}
      </p>
      <SelectedTargets
        selected={selected}
        onSelectedChange={onSelectedChange}
      />
    </>
  );
}

function TargetChoiceRow({
  choice,
  screen,
  group,
  candidate,
  candidateById,
  candidatesError,
}: {
  choice: TargetChoice;
  screen?: Screen;
  group?: ScreenGroup;
  candidate?: PreviewScreen;
  candidateById: Map<string, PreviewScreen>;
  candidatesError: unknown;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const { t: screenT } = useTranslation("screens");
  const disabled =
    choice.type === "screen" &&
    (!candidate || candidate.outcome === "incompatible" || !!candidatesError);
  const eligibleGroupMembers =
    group?.screens.filter((member) => {
      const resolved = candidateById.get(member.id);
      return resolved && resolved.outcome !== "incompatible";
    }).length ?? 0;
  return (
    <ComboboxItem
      value={choice}
      disabled={disabled}
      className="items-start data-disabled:opacity-100"
    >
      <div className="grid min-w-0 gap-0.5">
        <span className="font-medium">{choice.label}</span>
        {screen && (
          <span className="text-xs text-muted-foreground">
            {screen.playerVersion} · {screenT(`status.${screen.status}`)}
            {screen.playerArchitecture && ` · ${screen.playerArchitecture}`}
          </span>
        )}
        {group && (
          <span className="text-xs text-muted-foreground">
            {t("updates.console.groupMembers", {
              count: group.membershipCount,
              eligible: eligibleGroupMembers,
            })}
          </span>
        )}
        {candidate?.reason && (
          <span className="text-xs text-destructive">{candidate.reason}</span>
        )}
        {disabled && !candidate && (
          <span className="text-xs text-muted-foreground">
            {t("updates.console.checkingCompatibility")}
          </span>
        )}
      </div>
    </ComboboxItem>
  );
}

function SelectedTargets({
  selected,
  onSelectedChange,
}: {
  selected: TargetChoice[];
  onSelectedChange: (value: TargetChoice[]) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  if (!selected.length) return null;
  return (
    <ScrollArea className="max-h-32">
      <div className="grid gap-1">
        {selected.map((item) => (
          <div
            key={`${item.type}-${item.value}`}
            className="flex items-center justify-between gap-2 text-sm"
          >
            <span>{item.label}</span>
            <Button
              size="sm"
              variant="ghost"
              aria-label={t("updates.console.removeTarget", {
                name: item.label,
              })}
              onClick={() =>
                onSelectedChange(selected.filter((candidate) => candidate !== item))
              }
            >
              {t("common:actions.remove")}
            </Button>
          </div>
        ))}
      </div>
    </ScrollArea>
  );
}

export function DeployRolloutStage({
  release,
  result,
  mode,
  windowStart,
  canary,
  canarySize,
  invalidWindow,
  invalidCanary,
  onModeChange,
  onWindowStartChange,
  onCanaryChange,
  onCanarySizeChange,
}: {
  release?: PlayerRelease;
  result?: UpdateDeploymentPreview;
  mode: UpdateDeploymentMode;
  windowStart: string;
  canary: boolean;
  canarySize: number;
  invalidWindow: boolean;
  invalidCanary: boolean;
  onModeChange: (value: UpdateDeploymentMode) => void;
  onWindowStartChange: (value: string) => void;
  onCanaryChange: (value: boolean) => void;
  onCanarySizeChange: (value: number) => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const locale = useFormatLocale();
  const family = releaseUpdateTab(release ?? { platform: "android" });
  const noteKey =
    family === "android"
      ? "updates.panel.androidNote"
      : family === "edge"
        ? "updates.panel.edgeNote"
        : family === "windows"
          ? "updates.panel.windowsNote"
          : "updates.panel.linuxNote";
  return (
    <>
      <FieldGroup className="gap-5">
        <FieldSet>
          <FieldLegend variant="label">{t("updates.panel.modeLabel")}</FieldLegend>
          <RadioGroup
            value={mode}
            onValueChange={(value) =>
              onModeChange(value as UpdateDeploymentMode)
            }
          >
            {(["install_now", "download_only", "maintenance_window"] as const).map(
              (value) => (
                <Field key={value} orientation="horizontal">
                  <RadioGroupItem id={value} value={value} />
                  <FieldContent>
                    <FieldLabel htmlFor={value}>{modeLabel(value, t)}</FieldLabel>
                    <FieldDescription>
                      {t(`updates.console.modeHints.${value}`)}
                    </FieldDescription>
                  </FieldContent>
                </Field>
              ),
            )}
          </RadioGroup>
        </FieldSet>
        {mode === "maintenance_window" && (
          <Field>
            <FieldLabel htmlFor="update-window">
              {t("updates.panel.windowLabel")}
            </FieldLabel>
            <DateTimeInput
              id="update-window"
              value={windowStart}
              onChange={onWindowStartChange}
            />
            <FieldDescription>{t("updates.console.windowHint")}</FieldDescription>
            {invalidWindow && (
              <FieldError>{t("updates.console.futureWindow")}</FieldError>
            )}
          </Field>
        )}
        <Field orientation="horizontal">
          <Switch
            id="update-canary"
            checked={canary}
            onCheckedChange={onCanaryChange}
          />
          <FieldContent>
            <FieldLabel htmlFor="update-canary">
              {t("updates.console.canaryRollout")}
            </FieldLabel>
            <FieldDescription>{t("updates.console.canaryHint")}</FieldDescription>
          </FieldContent>
        </Field>
        {canary && (
          <Field>
            <FieldLabel htmlFor="update-canary-count">
              {t("updates.panel.canaryLabel")}
            </FieldLabel>
            <Input
              id="update-canary-count"
              type="number"
              min={1}
              max={Math.min(50, (result?.eligibleCount ?? 0) - 1)}
              value={canarySize}
              onChange={(event) => onCanarySizeChange(Number(event.target.value))}
            />
            {invalidCanary && (
              <FieldError>{t("updates.console.invalidCanary")}</FieldError>
            )}
          </Field>
        )}
      </FieldGroup>
      <section
        className="grid gap-1 border-t pt-4"
        aria-label={t("updates.console.review")}
      >
        <h3 className="mb-1 text-sm font-semibold">
          {t("updates.console.review")}
        </h3>
        <strong className="text-sm">{release?.versionName}</strong>
        <p className="text-sm">{release && artifactIdentity(release, t)}</p>
        <p className="text-sm">
          {t("updates.console.targetCount", {
            count: result?.targetCount ?? 0,
          })}{" "}
          · {modeLabel(mode, t)}
          {canary &&
            ` · ${t("updates.console.canarySummary", { count: canarySize })}`}
        </p>
        {mode === "maintenance_window" && windowStart && (
          <p className="text-sm">
            {new Date(windowStart).toLocaleString(locale)}
          </p>
        )}
      </section>
      <p className="text-sm text-muted-foreground">{t(noteKey)}</p>
    </>
  );
}

export function DeployAlerts({
  stage,
  previewError,
  candidatesError,
  blocked,
  result,
  deployError,
  onRetry,
}: {
  stage: number;
  previewError: unknown;
  candidatesError: unknown;
  blocked: PreviewScreen[];
  result?: UpdateDeploymentPreview;
  deployError: unknown;
  onRetry: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const requestError = previewError ?? candidatesError;
  return (
    <>
      {requestError && stage > 1 && (
        <Alert variant="destructive">
          <AlertDescription>
            {apiErrorMessage(requestError)}
            <Button variant="outline" size="sm" onClick={onRetry}>
              {t("common:actions.retry")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {stage > 1 && blocked.length > 0 && (
        <Alert variant="destructive">
          <AlertTitle>{t("updates.console.blockedTitle")}</AlertTitle>
          <AlertDescription>
            <ul>
              {blocked.map((screen) => (
                <li key={screen.screenId}>
                  <strong>{screen.screenName}</strong>: {screen.reason}
                </li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      )}
      {stage > 1 && !!result?.offlineCount && (
        <Alert>
          <AlertDescription>
            {t("updates.console.offlineWarning", {
              count: result.offlineCount,
            })}
          </AlertDescription>
        </Alert>
      )}
      {stage > 1 && !!result?.alreadyCurrentCount && (
        <Alert>
          <AlertDescription>
            {t("updates.console.currentWarning", {
              count: result.alreadyCurrentCount,
            })}
          </AlertDescription>
        </Alert>
      )}
      {deployError && (
        <Alert variant="destructive">
          <AlertDescription>{apiErrorMessage(deployError)}</AlertDescription>
        </Alert>
      )}
    </>
  );
}

export function DeployFooter({
  stage,
  pending,
  releaseReady,
  targetsReady,
  rolloutReady,
  onBack,
  onContinue,
  onDeploy,
}: {
  stage: number;
  pending: boolean;
  releaseReady: boolean;
  targetsReady: boolean;
  rolloutReady: boolean;
  onBack: () => void;
  onContinue: () => void;
  onDeploy: () => void;
}) {
  const { t } = useTranslation(["settings", "common"]);
  const canContinue =
    stage === 1 ? releaseReady : stage === 2 ? targetsReady : rolloutReady;
  return (
    <div className="flex w-full flex-wrap items-center justify-between gap-2">
      <Button variant="ghost" disabled={pending} onClick={onBack}>
        {stage === 1 ? t("common:actions.cancel") : t("common:actions.back")}
      </Button>
      <Button
        disabled={pending || !canContinue}
        onClick={stage === 3 ? onDeploy : onContinue}
      >
        {pending && <Spinner />}
        {stage === 3
          ? t("updates.panel.deployAction")
          : t("updates.console.continue")}
      </Button>
    </div>
  );
}
